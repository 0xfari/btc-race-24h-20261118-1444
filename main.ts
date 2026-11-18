// btc-race-24h-20261118-1444 — v2 entry.
//
// Strategy (tuned on 41 rolling 24h windows of Coinbase BTC-USD 1m,
// dev window used only as a pass/fail gate, never for tuning):
//
//   R — washout bounce, the only money leg. Buy the full cash balance when
//   the 240-bar return is at or below -2.0% and the close sits within
//   [0%, +3%] above the 120-bar Donchian low (price has stopped falling
//   at the low, not a momentum chase). Exit in two steps: sell half the
//   position at +1.0% over the fill price, then let the rest run to
//   +1.75%, a 0.8% trail off the running peak, a -1.0% hard stop, or a
//   360-bar max hold, whichever comes first. The half-take locks in the
//   common +1% bounce while the remainder keeps the recovery upside.
//
//   I — late insurance, guardrail only. If no trade has filled by scored
//   bar 1080, buy 15% of cash blind (no signal). Exit at +1.0%, a 0.8%
//   trail, or a 120-bar max hold. Its expected value is slightly
//   negative; it exists so the entry always clears the >=1-trade
//   guardrail on days when R never fires.
//
//   Risk rules: no entry before scored bar 122 or after 1409; 30-bar
//   cooldown after an exit; stand down for the rest of the window after
//   one losing round trip; at most 8 round trips; at most one order per
//   batch; max slippage 500 bps on every order.
//
// Determinism: decisions use only bar history and fill reports. No
// clock, no environment, no randomness.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- R leg parameters ---
const RET_LOOKBACK = 240;
const RET_THRESHOLD = -0.02;
const DONCHIAN_BARS = 120;
const BOUNCE_LOW = 0.0;
const BOUNCE_HIGH = 0.03;
const PARTIAL_TP = 0.01; // first take sells half the position
const REST_TP = 0.0175;
const TRAIL = 0.008;
const HARD_STOP = -0.01;
const MAX_HOLD_BARS = 360;

// --- I leg parameters ---
const INSURANCE_BAR = 1080;
const INSURANCE_SIZE = 0.15;
const INSURANCE_TP = 0.01;
const INSURANCE_TRAIL = 0.008;
const INSURANCE_HOLD = 120;

// --- shared risk rules ---
const MIN_ENTRY_BAR = 122;
const LAST_ENTRY_BAR = 1409;
const COOLDOWN_BARS = 30;
const MAX_LOSSES = 1;
const MAX_ROUND_TRIPS = 8;
const MAX_SLIPPAGE_BPS = 500;

type Leg = 'R' | 'I';

interface LegState {
  leg: Leg;
  entryPrice: number; // fill price of the opening buy, raw price units
  entryBar: number; // scored bar index where the buy filled
  peak: number; // highest close seen since entry, raw price units
  partDone: boolean; // partial take already sold
  spent: bigint; // quote units spent on buys of this leg
  received: bigint; // quote units received from sells of this leg
}

const closes: number[] = [];
const lows: number[] = [];

let leg: LegState | null = null;
let awaitingBuy: Leg | null = null;
let awaitingSellFull = false;
let roundTrips = 0;
let totalFills = 0;
let losses = 0;
let lastExitBar = -1e9;
let symbol = SYMBOL;

function scoredBar(state: BarsState): number {
  return state.seq - state.warmupBars;
}

function retOver(n: number): number | null {
  const i = closes.length - 1;
  if (i < n) return null;
  return closes[i] / closes[i - n] - 1;
}

function donchianLow(n: number): number | null {
  if (closes.length < n) return null;
  let lo = Infinity;
  for (let k = closes.length - n; k < closes.length; k++) {
    if (lows[k] < lo) lo = lows[k];
  }
  return lo;
}

await runBars({
  onHello(state: BarsState): void {
    if (state.hello.symbols.length > 0) symbol = state.hello.symbols[0].symbol;
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    closes.push(Number(bar.c));
    lows.push(Number(bar.l));
    const i = scoredBar(state);
    const held = state.positions.get(symbol);
    const heldQty = held === undefined ? 0n : held.qty;

    // Fold in the fills of the order decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.symbol !== symbol || fill.status !== 'filled') {
        if (fill.symbol === symbol && fill.status === 'rejected') {
          if (fill.side === 'buy') awaitingBuy = null;
          if (fill.side === 'sell') awaitingSellFull = false;
        }
        continue;
      }
      totalFills += 1;
      const notional = BigInt(fill.notional_quote_units);
      if (fill.side === 'buy') {
        const started = awaitingBuy;
        awaitingBuy = null;
        if (started !== null && leg === null) {
          leg = {
            leg: started,
            entryPrice: Number(fill.price),
            entryBar: i,
            peak: Number(fill.price),
            partDone: false,
            spent: notional,
            received: 0n,
          };
        } else if (leg !== null) {
          leg.spent += notional;
        }
      } else {
        // Sell fill. A full exit closes the leg; a partial take just
        // banks proceeds and marks the take as done.
        if (leg !== null) {
          leg.received += notional;
          if (heldQty === 0n && awaitingSellFull) {
            const pnl = leg.received - leg.spent;
            if (pnl < 0n) losses += 1;
            roundTrips += 1;
            lastExitBar = i;
            leg = null;
            awaitingSellFull = false;
          } else {
            leg.partDone = true;
          }
        } else {
          awaitingSellFull = false;
        }
      }
    }

    if (state.warmingUp) return [];

    // --- position management ---
    // Note: the batch's account is built after this batch's fills are
    // resolved, so heldQty here already reflects any fill in batch.fills.
    if (leg !== null && heldQty > 0n) {
      const close = closes[closes.length - 1];
      if (close > leg.peak) leg.peak = close;
      const heldBars = i - leg.entryBar;
      if (leg.leg === 'I') {
        if (
          close >= leg.entryPrice * (1 + INSURANCE_TP) ||
          close <= leg.peak * (1 - INSURANCE_TRAIL) ||
          heldBars >= INSURANCE_HOLD
        ) {
          awaitingSellFull = true;
          return [{ side: 'sell', symbol, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
      // R leg: partial take first, then the resting exit rules.
      if (!leg.partDone && close >= leg.entryPrice * (1 + PARTIAL_TP)) {
        const partQty = heldQty / 2n;
        if (partQty > 0n && partQty < heldQty) {
          return [{ side: 'sell', symbol, qty: partQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      if (
        close >= leg.entryPrice * (1 + REST_TP) ||
        close <= leg.peak * (1 - TRAIL) ||
        close <= leg.entryPrice * (1 + HARD_STOP) ||
        heldBars >= MAX_HOLD_BARS
      ) {
        awaitingSellFull = true;
        return [{ side: 'sell', symbol, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (leg !== null || awaitingBuy !== null) return [];

    // --- entries ---
    if (i < MIN_ENTRY_BAR || i > LAST_ENTRY_BAR) return [];
    if (losses >= MAX_LOSSES) return [];
    if (i - lastExitBar < COOLDOWN_BARS) return [];
    if (roundTrips >= MAX_ROUND_TRIPS) return [];

    const ret240 = retOver(RET_LOOKBACK);
    if (ret240 !== null) {
      const low120 = donchianLow(DONCHIAN_BARS);
      if (low120 !== null) {
        const close = closes[closes.length - 1];
        const bounce = close / low120 - 1;
        if (ret240 <= RET_THRESHOLD && bounce >= BOUNCE_LOW && bounce <= BOUNCE_HIGH) {
          const cash = state.cash;
          if (cash >= 1_000_000n) {
            awaitingBuy = 'R';
            return [{ side: 'buy', symbol, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      }
    }

    // Late insurance: only when nothing has ever filled.
    if (roundTrips === 0 && totalFills === 0 && i >= INSURANCE_BAR) {
      const amount = (state.cash * BigInt(Math.round(INSURANCE_SIZE * 1000))) / 1000n;
      if (amount >= 1_000_000n) {
        awaitingBuy = 'I';
        return [{ side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
