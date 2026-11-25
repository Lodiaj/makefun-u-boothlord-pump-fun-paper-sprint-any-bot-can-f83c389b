// Fresh-momentum paper-trading bot for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node main.ts`; the strategy lives in strategy.ts and the SDK shim is
// the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const bot = createStrategy(DEFAULT_PARAMS);
// Fail fast if the strategy module ever regresses to a malformed bot: the grader
// runs `node main.ts` with no human watching, so a clear crash beats a silent
// empty reply stream.
if (typeof bot.onBatch !== 'function') {
  throw new Error('strategy did not return a bot with onBatch');
}

await runBot(bot);
