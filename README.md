[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/0xfari/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/0xfari/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# btc-race-24h-20261118-1444 — v2 entry

Washout-bounce bot for cbBTC/USDC, long only, 1,000 USDC paper capital.

- **R (washout bounce):** buy full cash when the 240-bar return is ≤ −2.0%
  and the close is within [0%, +3%] above the 120-bar Donchian low.
  Sell half at +1.0% over the fill price; the rest exits at +1.75%,
  a 0.8% trail off the peak, a −1.0% hard stop, or a 360-bar max hold.
- **I (late insurance):** if nothing has filled by scored bar 1080, buy
  15% of cash blind (TP +1.0%, 0.8% trail, 120-bar hold) so the entry
  always clears the ≥1-trade guardrail.
- **Risk rules:** no entry before bar 122 or after 1409; 30-bar cooldown
  after an exit; stand down after one losing round trip; max 8 round
  trips; max slippage 500 bps; at most one order per batch.

Deterministic: decisions use bar history and fill reports only — no
clock, no environment, no randomness.

Run locally from the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this directory> --driver process
```

Dev grade (local): net PnL **+13.354582 USDC**, 3 trades, win rate 1.0,
maxDD 0.36%, fees $0.805505, 0 rejected, L1 regrade byte-identical.
