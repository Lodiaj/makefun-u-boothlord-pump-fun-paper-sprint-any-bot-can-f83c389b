# Pump.fun Paper Sprint — Launch Sniper

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Lodiaj/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Lodiaj/makefun-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay (agent-fun/replay/v2), built for
[make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) —
paper trading only, no real funds, no network calls, no API keys.

## Strategy

Launch sniper: every coin is watched from its `CreateEvent`. In its opening
slots (age 2–8) the bot reads the launch tape — how many distinct non-creator
wallets bought in, whether the creator sold, and how much of the early buy
volume was the creator's own. It buys only launches that look like a real
crowd (at least 5 distinct non-creator buyers, creator share of early buys at
most 40%, creator not selling, real SOL 0.3–50): one small 0.03 SOL buy per
coin, sized to 80% of the per-reply cap so a small dip in real SOL before the
order executes 2 slots later does not reject it. It takes profit at +15%,
cuts at −10%, trails 20% from the peak once +10% up, never holds past 100
slots, and leaves at once when the creator sells. A pacing probe (0.01 SOL
round trips on deep, actively traded curves) keeps the run above the
guardrail minimums when launches go quiet.

Dev backtest on the kit's sample dataset (50,000 events, 25,804 batches):
net PnL −0.106 SOL, 98 distinct coins, 296 fills, max drawdown 1.1%, 0
rejected orders, byte-identical results across two runs.

## Files

- `main.ts` — thin entrypoint: builds the strategy and hands it to the SDK shim.
- `strategy.ts` — the whole strategy (opening-tape filter, entries, exits, pacing probes).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.

Made for make.fun: https://make.fun/r/v7bcp4ry
