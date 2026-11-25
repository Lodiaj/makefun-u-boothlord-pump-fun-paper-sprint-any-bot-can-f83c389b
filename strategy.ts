// Launch-sniper paper-trading strategy for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: every coin is watched from its CreateEvent. In its opening slots the bot reads
// the launch tape — how much the creator bought themselves, how many other wallets
// piled in, whether the creator has already sold, and how much real SOL the curve
// holds. It buys only launches that look like a real crowd rather than the creator's
// own cluster: several distinct non-creator buyers, the creator's share of early buys
// small, the creator not selling, real SOL already building. One small buy per coin,
// take profit fast, cut losers fast, never hold past a short time limit, and leave at
// once when the creator sells. A pacing probe keeps the run above the guardrail
// minimums (at least 20 distinct coins, round trips of at least 0.01 SOL) when
// launches go quiet.
//
// Everything here is paper trading: the harness replays market data, no real funds move,
// no network calls, no API keys. Deterministic by construction: no clock, no environment,
// no Math.random; iteration only over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Distinct non-creator buyers in the opening tape. */
  minBuyers: number;
  /** Opening buy SOL (all buyers) must reach at least this. */
  minOpenBuySol: number;
  /** The creator's own buys may be at most this share of opening buy SOL. */
  maxDevShare: number;
  /** Skip a launch whose price already ran up this far from its create price. */
  maxRunup: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: exit when close value reaches cost * (1 + tp). */
  tp: number;
  /** Stop loss: exit when close value falls below cost * (1 - sl). */
  sl: number;
  /** Trailing stop from the peak, armed once value reached cost * (1 + trailArm). */
  trail: number;
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Leave at once when the creator sells after entry. */
  exitOnDevSell: boolean;
  /** Most sniper positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with at least 20 coins traded. When the bot's own
   * filled coins or fills lag targetCoins / targetFills scaled by the share of paceSecs
   * elapsed (block time since the first batch), it opens tiny probe round trips (buy
   * probeSol, sell it all as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 2,
  maxAge: 8,
  stakeSol: 0.03,
  minBuySol: 0.01,
  minRqSol: 0.3,
  maxRqSol: 50,
  minBuyers: 5,
  minOpenBuySol: 0.1,
  maxDevShare: 0.4,
  maxRunup: 1.0,
  buySlipBps: 10_000,
  tp: 0.15,
  sl: 0.1,
  trail: 0.2,
  trailArm: 0.1,
  maxHold: 100,
  exitOnDevSell: true,
  maxMain: 5,
  maxExposureSol: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface OpenTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  creator: Pubkey;
  created: number;
  /** Create-time price reference (vq/vt as a pair). */
  vq0: bigint;
  vt0: bigint;
  /** Opening tape: trades within the first maxAge slots. */
  tape: OpenTrade[];
  /** The creator sold at least once. */
  devSold: boolean;
  /** Entry decided for good (bought, or aged out / filtered out). */
  decided: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  /** Opening-tape signal on a coin at slot `now`. */
  const entrySignal = (c: Coin, now: number, rqSol: number, price: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    const age = now - c.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (c.devSold) return false;
    let buySol = 0;
    let devBuySol = 0;
    const buyers = new Set<string>();
    for (const tr of c.tape) {
      if (!tr.buy) continue;
      buySol += tr.sol;
      if (tr.user === c.creator) devBuySol += tr.sol;
      else buyers.add(tr.user);
    }
    if (buySol < p.minOpenBuySol) return false;
    if (buyers.size < p.minBuyers) return false;
    if (buySol > 0 && devBuySol > p.maxDevShare * buySol) return false;
    if (c.vt0 > 0n) {
      const createPrice = Number(c.vq0) / Number(c.vt0);
      if (createPrice > 0 && price > createPrice * (1 + p.maxRunup)) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            creator: e.creator,
            created: e.slot,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            tape: [],
            devSold: false,
            decided: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          if (c !== undefined) {
            if (e.slot - c.created <= p.maxAge) {
              c.tape.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user });
            }
            if (!e.is_buy && e.user === c.creator) c.devSold = true;
          }
          traded.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          const c = coinOf(e.mint);
          if (c !== undefined) c.decided = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: sell a whole position on the first trigger.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.tp)) exit = true;
        if (!exit && value < cost * (1 - p.sl)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell) {
          const c = coinOf(mint);
          if (c !== undefined && c.devSold) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries: one small buy per launch that passes the opening-tape filter.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        void h;
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const c = coinOf(mint);
        if (c === undefined || c.decided) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const age = now - c.created;
        if (age > p.maxAge) {
          c.decided = true;
          continue;
        }
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(c, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        // Size to 80% of the per-reply cap: the order executes 2 slots later, and a
        // small dip in real SOL in between would otherwise reject a buy sized exactly
        // at the cap.
        let amount = Math.min(capSol * 0.8, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        c.decided = true;
        held.set(mint, { opened: now, peakValue: 0, exiting: false, filled: false });
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          // A probe must survive a small dip in real SOL before it executes 2 slots
          // later, so demand a curve at least twice as deep as the probe needs, and
          // size to 80% of the per-reply cap.
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 2) continue;
            const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
            const amount = Math.min(capSol * 0.8, p.probeSol);
            if (amount < p.probeSol) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= amount + tx;
          }
        }
      }
      return orders;
    },
  };
}
