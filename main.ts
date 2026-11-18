// SPDX-License-Identifier: MIT
// btc-race-24h-20261118-1444 — washout-bounce bot for cbBTC/USDC, 1-minute bars.
//
// Idea, in one paragraph: on 1-minute BTC almost every signal is
// negative-expectancy after the ~26 bps round-trip cost, so the bot does
// almost nothing. It waits for a genuine 4-hour washout (close 2% or more
// below the close 240 bars ago, while sitting within 3% of the 120-bar
// Donchian low), buys the whole stack once, and rides the slow mean
// reversion with a 1.5% take-profit, a 0.8% trailing stop from the running
// peak, a 1% hard stop from the blended fill, and a 360-bar max hold.
// After one losing round trip it stands down for the rest of the day:
// one bad washout is information, two is a trend. If nothing has traded
// by bar 1080 it buys 35% blind as guardrail insurance (at least one
// trade, max drawdown far under the 25% bar) with a 1% take-profit, a
// 0.8% trail and a 120-bar hold. No entry before bar 122, none in the
// last 30 bars, 30 bars of cooldown after an exit. Deterministic: the
// only state is bar history and fill reports, never the clock or the
// environment.

import { runBars } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const SLIP_BPS = 500;

// --- washout leg (R) ---
const R_RET240 = -0.02; // 240-bar return at or below -2%
const R_BOUNCE_LO = 0.0; // within [0%, 3%] above the Donchian low (120)
const R_BOUNCE_HI = 0.03;
const R_TP = 0.015;
const R_TRAIL = 0.008;
const R_SL = -0.01;
const R_HOLD = 360;

// --- late insurance leg (I) ---
const I_BAR = 1080; // only when zero trades and zero fills so far
const I_SIZE_NUM = 35n; // 35% of cash
const I_SIZE_DEN = 100n;
const I_TP = 0.01;
const I_TRAIL = 0.008;
const I_HOLD = 120;

// --- shared risk rules ---
const MIN_BAR = 122;
const LAST_ENTRY_BAR = 1409; // no entry in the last 30 bars
const COOLDOWN = 30;
const MAX_LOSSES = 1; // stand down after one losing round trip
const MAX_TRADES = 8;

const closes: number[] = []; // close per seq, as float USDC (price_scale 5)
const lows: number[] = []; // low per seq

let entryPrice = 0; // blended fill price of the open position (float)
let entryQty = 0n; // total qty filled into the open position
let entrySeq = -1; // seq of the fill bar that opened the position
let entrySpent = 0n; // total buy notional spent on the open position
let peak = 0; // highest close since entry
let leg: 'R' | 'I' | null = null;
let losses = 0;
let lastExitSeq = -100000;
let trades = 0; // closed round trips
let fills = 0; // filled orders (buys + sells)
let pendingLeg: 'R' | 'I' | null = null; // leg of the buy decided last batch

function donchianLow(n: number): number {
  let m = Infinity;
  const start = Math.max(0, lows.length - n);
  for (let i = start; i < lows.length; i++) if (lows[i] < m) m = lows[i];
  return m;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars[0];
    if (bar !== undefined) {
      closes.push(Number(bar.c) / 1e5);
      lows.push(Number(bar.l) / 1e5);
    }
    const seq = state.seq;

    // Fold in this batch's fills: buys set/extend the entry, sells close it.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      fills++;
      if (f.side === 'buy') {
        const q = BigInt(f.qty);
        const p = Number(f.price) / 1e5;
        entryPrice = entryQty === 0n ? p : (entryPrice * Number(entryQty) + p * Number(q)) / Number(entryQty + q);
        entryQty += q;
        entrySpent += BigInt(f.notional_quote_units);
        entrySeq = seq;
        peak = Math.max(peak, closes[closes.length - 1]);
        if (leg === null) leg = pendingLeg;
      } else {
        // Sell proceeds minus everything spent on this position = round-trip PnL.
        const proceeds = BigInt(f.notional_quote_units);
        if (state.positions.get(SYM) === undefined) {
          trades++;
          if (proceeds < entrySpent) losses++;
          lastExitSeq = seq;
          entryPrice = 0;
          entryQty = 0n;
          entrySpent = 0n;
          entrySeq = -1;
          peak = 0;
          leg = null;
        }
      }
    }
    pendingLeg = null;

    const pos = state.positions.get(SYM);
    const close = closes[closes.length - 1];
    if (close === undefined) return [];

    // --- holding: manage the exit ---
    if (pos !== undefined && pos.qty > 0n) {
      if (close > peak) peak = close;
      const held = seq - entrySeq;
      let exit = false;
      if (leg === 'R') {
        exit =
          close >= entryPrice * (1 + R_TP) ||
          close <= peak * (1 - R_TRAIL) ||
          close <= entryPrice * (1 + R_SL) ||
          held >= R_HOLD;
      } else {
        // leg I: take-profit, trail (which also caps a straight fall), hold
        exit = close >= entryPrice * (1 + I_TP) || close <= peak * (1 - I_TRAIL) || held >= I_HOLD;
      }
      if (exit) {
        return [{ side: 'sell', symbol: SYM, qty: pos.qty, max_slippage_bps: SLIP_BPS }];
      }
      return [];
    }

    // --- flat: entry gates ---
    if (seq < MIN_BAR || seq > LAST_ENTRY_BAR) return [];
    if (losses >= MAX_LOSSES) return [];
    if (seq - lastExitSeq < COOLDOWN) return [];
    if (trades >= MAX_TRADES) return [];

    // Washout leg: 240-bar return <= -2% with price near the Donchian low.
    // Index by closes.length, not seq: a minute with no bar must not shift
    // the lookback (the race window may miss up to 28 minutes).
    if (closes.length >= 241) {
      const ret240 = close / closes[closes.length - 241] - 1;
      const bounce = close / donchianLow(120) - 1;
      if (ret240 <= R_RET240 && bounce >= R_BOUNCE_LO && bounce <= R_BOUNCE_HI) {
        if (state.cash >= 1_000_000n) {
          pendingLeg = 'R';
          return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: SLIP_BPS }];
        }
      }
    }

    // Late insurance: no trade yet by bar 1080 -> buy 35% blind.
    if (trades === 0 && fills === 0 && seq >= I_BAR) {
      const amt = (state.cash * I_SIZE_NUM) / I_SIZE_DEN;
      if (amt >= 1_000_000n) {
        pendingLeg = 'I';
        return [{ side: 'buy', symbol: SYM, notional_quote_units: amt, max_slippage_bps: SLIP_BPS }];
      }
    }
    return [];
  },
});
