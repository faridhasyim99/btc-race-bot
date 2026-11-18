# btc-race-bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/faridhasyim99/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/faridhasyim99/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A BTC trading bot for [make.fun/bounty/btc-race-24h-20261118-1444](https://make.fun/bounty/btc-race-24h-20261118-1444) — it trades Coinbase Wrapped BTC (cbBTC) against USDC, one 1-minute bar at a time, on $1,000 of paper money.

`main.ts` (Node 22, standard library only, no network) speaks agent-fun/bars-replay/v1: it reads one JSON line per minute carrying a 1-minute bar and answers with buy/sell orders. See the header comment in `main.ts` for the full design.

## Strategy

Two-tier persistent-momentum trend following, in one paragraph: momentum is the 60-bar return of closes; the strict tier buys 100% of cash only when momentum is above +50 bps and has stayed above +10 bps for 30 bars in a row (a real trend, not a spike), while the loose tier buys 50% of cash when momentum is above +30 bps for 20 bars in a row, and a loose position scales in to full size when the strict signal fires. Exits are a 150 bps trailing stop, a momentum fade (60-bar momentum below -20 bps for 10 bars), or a max hold (360 bars strict / 240 loose). A 10% drawdown guard flattens the bot and stops it trading. No overfitting: the thresholds are round numbers, every neighbouring parameter set in a sweep stayed positive, and both halves of the dev window were profitable.

## Dev-window result (kit grade-local, `--driver process`)

- Net PnL **+$11.36 USDC** (return +1.14%) — the dev gate needs > $0
- 5 trades, 0 rejected, win rate 1.00, max drawdown **0.95%** (race bar: ≤ 25%)
- Fees $1.21; at 2x fees the net PnL is still +$10.15
- Guardrails met; L1 regrade reproduced byte for byte (deterministic)
- Best kit baseline on the dev window is hold-cash at $0.00; buy-and-hold is −$31.63

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process --worktree
```

`vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim.
