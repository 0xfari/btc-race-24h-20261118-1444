// cbBTC dip-recovery bot — make.fun btc-race-24h-20261118-1444.
//
// The hello message hands us one symbol (CBBTC) and 1,000 USDC of paper
// money; from then on every batch brings one fresh one-minute bar and we
// answer with our orders for it. The idea is simple: cbBTC drops hard and
// then climbs back over the next hours, so the bot waits out the fall and
// only buys after the price has turned.
//
//   Watch: track the highest close of the last 31 bars. Once a close
//     prints 180 bps or more below that high, the dip is "primed" and we
//     start watching the lowest close since the prime.
//   Buy: when a later close bounces 5 bps or more off that low, spend
//     all cash on CBBTC.
//   Sell: take-profit at +250 bps over the buy's cost, stop-loss at
//     -100 bps, or 480 bars after the buy — whichever comes first.
//   Safety net: if bar 1200 passes with no trade at all, take one small
//     $200 trade on a 60 bps dip with the same 5 bps bounce, exiting at
//     +/-60 bps or after 100 bars, so the entry still clears the race
//     guardrail (at least one trade) with a bounded worst case.
//
// Every comparison is exact integer arithmetic on closes (price scale 5)
// and on the position's own cost basis. No wall clock, no randomness, no
// network, no files — the only input is the batch, so both graded runs
// agree byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const ASSET = 'CBBTC';
const BPS = 10_000n;

// How far the close must fall from the rolling high before we prime.
const HIGH_WINDOW = 31; // current bar plus the 30 before it
const PRIME_DROP_BPS = 180n;
const TURN_BOUNCE_BPS = 5n;

// How a main-rule trade is exited.
const WIN_BPS = 250n;
const LOSE_BPS = 100n;
const HOLD_LIMIT_BARS = 480;

// Safety-net trade, only if the window is nearly over with no trade yet.
const NET_START_BAR = 1200;
const NET_DROP_BPS = 60n;
const NET_SIZE_QUOTE = 200_000_000n; // $200, in USDC quote units (6dp)
const NET_WIN_BPS = 60n;
const NET_LOSE_BPS = 60n;
const NET_HOLD_BARS = 100;

// Fills land roughly 10 bps from the close; 300 bps never binds.
const SLIPPAGE_CAP_BPS = 300;

interface DipWatch {
  primed: boolean;
  low: bigint;
  spent: boolean;
}

interface LiveTrade {
  openedAt: number;
  winBps: bigint;
  loseBps: bigint;
  holdBars: number;
}

const history: bigint[] = [];
const mainWatch: DipWatch = { primed: false, low: 0n, spent: false };
const netWatch: DipWatch = { primed: false, low: 0n, spent: false };
let trade: LiveTrade | null = null;
let everTraded = false;

// Highest close over the trailing window, or null while history is short.
function recentHigh(): bigint | null {
  if (history.length < HIGH_WINDOW) return null;
  return history.slice(history.length - HIGH_WINDOW).reduce((a, b) => (b > a ? b : a));
}

// True when `price` sits at least `bps` below `ref`.
function downBy(price: bigint, ref: bigint, bps: bigint): boolean {
  return price * BPS <= ref * (BPS - bps);
}

// True when `price` sits at least `bps` above `ref`.
function upBy(price: bigint, ref: bigint, bps: bigint): boolean {
  return price * BPS >= ref * (BPS + bps);
}

// One dip watch step: prime on a deep enough drop, then buy on the turn.
// Returns a buy order when the bounce fires, else null.
function watchStep(
  watch: DipWatch,
  close: bigint,
  high: bigint,
  dropBps: bigint,
  sizeQuote: bigint,
  winBps: bigint,
  loseBps: bigint,
  holdBars: number,
  barIdx: number,
): OrderInput | null {
  if (watch.primed) {
    if (close <= watch.low) {
      watch.low = close;
      return null;
    }
    if (upBy(close, watch.low, TURN_BOUNCE_BPS)) {
      watch.primed = false;
      watch.spent = true;
      everTraded = true;
      trade = { openedAt: barIdx, winBps, loseBps, holdBars };
      return { side: 'buy', symbol: ASSET, notional_quote_units: sizeQuote, max_slippage_bps: SLIPPAGE_CAP_BPS };
    }
    return null;
  }
  if (downBy(close, high, dropBps)) {
    watch.primed = true;
    watch.low = close;
  }
  return null;
}

// True when a live trade has hit its take-profit, its stop-loss, or its
// time cap, measured against its own cost basis at the latest close.
function shouldExit(
  state: BarsState,
  qty: bigint,
  close: bigint,
  openTrade: LiveTrade,
): boolean {
  const held = state.positions.get(ASSET);
  if (held === undefined) return false;
  const cost = held.cost;
  const worth = state.value(ASSET, qty, close);
  const won = worth * BPS >= cost * (BPS + openTrade.winBps);
  const lost = worth * BPS <= cost * (BPS - openTrade.loseBps);
  return won || lost;
}

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  const close = state.close(ASSET);
  if (close === null) return [];
  history.push(close);
  if (state.warmingUp) return [];

  const barIdx = state.seq - state.warmupBars;
  const held = state.positions.get(ASSET);
  const heldQty = held?.qty ?? 0n;

  // We hold a position: sell on take-profit, stop-loss, or the time cap.
  if (heldQty > 0n) {
    if (trade !== null) {
      const stale = barIdx - trade.openedAt >= trade.holdBars;
      if (stale || shouldExit(state, heldQty, close, trade)) {
        trade = null;
        return [{ side: 'sell', symbol: ASSET, qty: heldQty, max_slippage_bps: SLIPPAGE_CAP_BPS }];
      }
    }
    return [];
  }

  const high = recentHigh();
  if (high === null) return [];

  // Main rule: full-size buy on a sharp dip that turns.
  const mainOrder = watchStep(
    mainWatch,
    close,
    high,
    PRIME_DROP_BPS,
    state.cash,
    WIN_BPS,
    LOSE_BPS,
    HOLD_LIMIT_BARS,
    barIdx,
  );
  if (mainOrder !== null) return [mainOrder];

  // Safety net: one small trade late in the window if nothing fired yet.
  if (!everTraded && !netWatch.spent && barIdx >= NET_START_BAR) {
    const size = state.cash < NET_SIZE_QUOTE ? state.cash : NET_SIZE_QUOTE;
    const netOrder = watchStep(
      netWatch,
      close,
      high,
      NET_DROP_BPS,
      size,
      NET_WIN_BPS,
      NET_LOSE_BPS,
      NET_HOLD_BARS,
      barIdx,
    );
    if (netOrder !== null) return [netOrder];
  }

  return [];
}

await runBars({ onBatch });
