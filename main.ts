// BTC race bot: two-tier persistent-momentum trend follower.
//
// Reads one 1-minute bar of CBBTC per batch (agent-fun/bars-replay/v1) and
// answers each batch with buy/sell orders. Long only, no leverage, no shorts.
//
// Strategy (all BigInt arithmetic, fully deterministic — the same bars always
// produce the same orders):
//   * Momentum is the 60-bar return of closes, in basis points.
//   * Tier 1 (strict): momentum above +50 bps AND momentum above +10 bps for
//     the last 30 bars in a row. A move that has been rising steadily for half
//     an hour is a real trend, not a one-minute spike. Buys 100% of cash.
//   * Tier 2 (loose): momentum above +30 bps AND above +10 bps for the last
//     20 bars. Buys 50% of cash — a half-size probe that keeps the bot trading
//     when the strict signal has not fired yet.
//   * Scale-in: a half-size Tier 2 position upgrades to full size when the
//     strict Tier 1 signal fires while it is held, buying the remaining cash.
//   * Exits (either tier): a trailing stop 150 bps below the highest close
//     since entry; a momentum fade (60-bar momentum below -20 bps for 10 bars
//     in a row); or a max hold of 360 bars (Tier 1) / 240 bars (Tier 2).
//   * Per-trade size cap: a loose entry never risks more than half the cash;
//     full size is only ever reached on the strict signal, directly or by
//     scaling in.
//   * Drawdown guard: if equity falls more than 10% below its peak, the bot
//     flattens and stops trading for the rest of the run. The race bar allows
//     25%; this guard keeps the bot far inside it.
//
// No network, no wall clock, no files outside the repository. The only state
// is the list of closes seen so far plus a few counters, all derived from the
// bars and the account each batch carries.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- Strategy constants (basis points; 10000 bps = 100%) -----------------
const MOM_N = 60; // momentum lookback, in bars (minutes)
const PERSIST_FLOOR_BPS = 10n; // momentum must stay above this during a run
const T1_ENTRY_BPS = 50n; // strict tier: momentum now
const T1_PERSIST = 30; // strict tier: bars of momentum above the floor
const T2_ENTRY_BPS = 30n; // loose tier: momentum now
const T2_PERSIST = 20; // loose tier: bars of momentum above the floor
const EXIT_BPS = -20n; // momentum-fade exit: momentum below this ...
const EXIT_PERSIST = 10; // ... for this many bars in a row
const TRAIL_BPS = 150n; // trailing stop below the peak close since entry
const T1_MAX_HOLD = 360; // max bars held after a strict entry
const T2_MAX_HOLD = 240; // max bars held after a loose entry
const MAX_SLIPPAGE_BPS = 100; // per-order slippage cap vs the latest close
const DD_GUARD_BPS = 1000n; // flatten and stop if equity drops 10% under peak
const MIN_NOTIONAL = 1000000n; // 1 USDC in quote units (protocol minimum)

class Bot {
  closes: bigint[] = []; // close of every CBBTC bar seen, in order
  persistRun = 0; // consecutive bars with momentum above the floor
  negRun = 0; // consecutive bars with momentum below EXIT_BPS
  tier = 0; // 0 flat, 1 strict position, 2 loose position
  entryIdx = -1; // index into closes of the entry decision bar
  peakClose = 0n; // highest close since entry
  peakEquity = 0n; // highest equity seen (quote units)
  stopped = false; // drawdown guard tripped

  momentumBps(): bigint | null {
    // 60-bar return of closes in bps, or null before 61 closes.
    const n = this.closes.length;
    if (n <= MOM_N) return null;
    return (this.closes[n - 1]! * 10000n) / this.closes[n - 1 - MOM_N]! - 10000n;
  }

  maxHold(): number {
    return this.tier === 1 ? T1_MAX_HOLD : T2_MAX_HOLD;
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Warm-up bars are history only: orders decided on one are rejected.
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) {
      // No CBBTC bar this minute: no new close, nothing to decide.
      return [];
    }
    // Malformed-bar guard: a bar without a usable close must never poison
    // the momentum history. Skip the batch entirely — no close recorded,
    // no counters advanced — rather than pushing a zero or crashing on a
    // bad value. On clean replay data this never triggers.
    {
      const raw = bar.c;
      let usable = raw !== undefined && raw !== null && raw !== '';
      if (usable) {
        try {
          usable = BigInt(raw as string | number | bigint) > 0n;
        } catch {
          usable = false;
        }
      }
      if (!usable) return [];
    }
    const close = BigInt(bar.c);
    this.closes.push(close);

    const holding = state.positions.get(SYMBOL);
    const qty = holding === undefined ? 0n : holding.qty;
    const cash = state.cash;
    const equity = state.equity;

    // Reconcile the tier with the account (authoritative): a position that
    // is gone means a sell filled or a buy was rejected.
    if (qty === 0n && this.tier !== 0) {
      this.tier = 0;
      this.entryIdx = -1;
      this.peakClose = 0n;
    } else if (qty > 0n && this.tier === 0) {
      // Holding without a tier (should not happen): adopt as strict.
      this.tier = 1;
      this.entryIdx = this.closes.length - 1;
      this.peakClose = close;
      this.negRun = 0;
    }

    if (equity > this.peakEquity) this.peakEquity = equity;

    // Momentum counters, updated on every bar with a close.
    const mom = this.momentumBps();
    if (mom === null) {
      this.persistRun = 0;
      this.negRun = 0;
    } else {
      this.persistRun = mom > PERSIST_FLOOR_BPS ? this.persistRun + 1 : 0;
      this.negRun = mom < EXIT_BPS ? this.negRun + 1 : 0;
    }

    // Drawdown guard: flatten and stop trading for the rest of the run.
    if (
      this.peakEquity > 0n &&
      equity * 10000n < this.peakEquity * (10000n - DD_GUARD_BPS)
    ) {
      this.stopped = true;
      if (qty > 0n) return [this.sell(qty)];
      return [];
    }
    if (this.stopped) return [];

    if (qty > 0n) return this.whileHolding(close, qty, cash, mom);
    return this.whileFlat(cash, mom);
  }

  whileHolding(close: bigint, qty: bigint, cash: bigint, mom: bigint | null): OrderInput[] {
    if (close > this.peakClose) this.peakClose = close;
    // Scale-in: a loose position upgrades to full size when the strict
    // signal fires, buying the rest of the cash.
    if (
      this.tier === 2 &&
      mom !== null &&
      mom > T1_ENTRY_BPS &&
      this.persistRun >= T1_PERSIST &&
      cash >= MIN_NOTIONAL
    ) {
      this.tier = 1;
      this.entryIdx = this.closes.length - 1;
      this.negRun = 0;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    // Trailing stop below the peak close since entry.
    if (close * 10000n < this.peakClose * (10000n - TRAIL_BPS)) {
      return [this.sell(qty)];
    }
    // Momentum fade: the trend that got us in has turned.
    if (this.negRun >= EXIT_PERSIST) {
      return [this.sell(qty)];
    }
    // Max hold for this tier.
    if (this.closes.length - 1 - this.entryIdx >= this.maxHold()) {
      return [this.sell(qty)];
    }
    return [];
  }

  whileFlat(cash: bigint, mom: bigint | null): OrderInput[] {
    if (mom === null) return [];
    // Strict tier: momentum strong and persistent — deploy all cash.
    if (mom > T1_ENTRY_BPS && this.persistRun >= T1_PERSIST) {
      if (cash >= MIN_NOTIONAL) {
        this.tier = 1;
        this.entryIdx = this.closes.length - 1;
        this.peakClose = this.closes[this.closes.length - 1]!;
        this.negRun = 0;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    // Loose tier: momentum decent and persistent — half-size probe.
    if (mom > T2_ENTRY_BPS && this.persistRun >= T2_PERSIST) {
      const amount = cash / 2n;
      if (amount >= MIN_NOTIONAL) {
        this.tier = 2;
        this.entryIdx = this.closes.length - 1;
        this.peakClose = this.closes[this.closes.length - 1]!;
        this.negRun = 0;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  }

  sell(qty: bigint): OrderInput {
    return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    // Never throw: on any unexpected problem, answer with no orders rather
    // than breaking the protocol (a crash fails the whole run).
    try {
      return bot.onBatch(state, batch);
    } catch (err) {
      console.error(`bot error on batch ${state.seq}:`, err);
      return [];
    }
  },
});
