# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/0xfari/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/0xfari/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A cbBTC dip-recovery bot for the make.fun 24-hour BTC trading race. It watches
each one-minute bar, waits for a sharp drop off the recent high, and buys only
once the price turns back up — then exits on a fixed take-profit, a stop-loss,
or a time cap. A small fallback trade late in the window keeps the entry
eligible if no sharp dip ever shows up.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver process
```

The bot is a single `main.ts` speaking `agent-fun/bars-replay/v1` through the
kit's TypeScript shim in `vendor/`; it is fully deterministic (integer math
only, no clock, no randomness).

---

<sub>Entered on [make.fun](https://make.fun/?ref=p5tm223q&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
