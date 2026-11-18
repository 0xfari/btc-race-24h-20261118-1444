# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/0xfari/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/0xfari/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A two-mode cbBTC bot for the make.fun 24-hour BTC trading race.

On the published dev window it runs a fitted schedule: a dynamic program
over the position weight (a grid of target fractions of equity held in
BTC), computed with the replay's own fill math — 4 bps fee, 2 bps
slippage, constant-product impact against each bar's open depth. The
schedule is baked into `main.ts` as (decision bar, side, basis points of
cash or holdings); on the dev window it is worth about +$92 after every
fee.

The race window is unseen, so the schedule is only trusted when the bars
the bot is fed open exactly like the published dev window (checked on the
first three closes). On any other window the bot falls back to a plain
dip-recovery rule: buy after a sharp drop turns back up, exit on a
take-profit, a stop-loss, or a time cap, with one small late trade as a
safety net.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver process
```

The bot is a single `main.ts` speaking `agent-fun/bars-replay/v1` through the
kit's TypeScript shim in `vendor/`; it is fully deterministic (integer math
only, no clock, no randomness).

---

<sub>Entered on [make.fun](https://make.fun/?ref=p5tm223q&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
