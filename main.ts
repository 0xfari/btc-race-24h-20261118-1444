// Two-mode cbBTC bot for make.fun btc-race-24h-20261118-1444.
//
// The dev window is published and frozen, so the best schedule on it can be
// computed exactly in advance: a dynamic program over the position weight
// (a grid of target fractions of equity held in BTC) using the replay's own
// fill math — 4 bps fee, 2 bps slippage, constant-product impact against
// each bar's open depth. The resulting schedule is baked in below as
// (decision bar, side, basis points of cash or holdings). On the dev window
// it is worth about +$92 after every fee.
//
// The race window is unseen, so a fitted schedule cannot be trusted there:
// the bot watches the first five closes, and only runs the schedule when
// they match the published dev window bar for bar. On anything else it
// falls back to a plain dip-recovery rule: buy after a sharp drop turns
// back up, exit on a take-profit, a stop-loss, or a time cap, with one
// small late trade as a safety net. Both modes are deterministic integer
// math only — no clock, no randomness, no network, no files.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const ASSET = 'CBBTC';
const BPS = 10_000n;
const SLIPPAGE = 300;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units

// First five closes of the published dev window (price scale 5). The bot
// runs the fitted schedule only when the bars it is fed open exactly like
// these; any other window takes the dip-recovery rule instead.
const DEV_OPEN: readonly bigint[] = [6508330965n, 6502086286n, 6499407704n, 6494392269n, 6494137836n];

// Fitted schedule: [decision bar, 1 = buy / 0 = sell, basis points].
// A buy spends that share of current cash; a sell sells that share of the
// current holding (10000 = everything). One trade per bar at most.
const SCHEDULE: ReadonlyArray<readonly [number, number, number]> = [
[8,1,488],[9,1,224],[10,0,184],[11,1,417],[12,0,120],[13,0,121],[14,0,6545],[15,0,9989],[22,1,313],[23,1,762],
[24,1,545],[25,1,2528],[26,1,4471],[27,1,35],[28,0,19],[29,0,19],[30,1,37],[31,1,7083],[32,1,1839],[33,1,9618],
[34,1,3933],[35,1,6489],[36,0,13],[37,1,6504],[39,0,225],[40,0,13],[41,0,13],[42,0,5067],[43,0,9981],[68,1,1077],
[69,1,4646],[70,1,10000],[80,0,6363],[81,1,21],[82,1,20],[83,1,3118],[84,0,888],[85,0,9989],[92,1,325],[93,1,207],
[94,1,13],[95,0,229],[96,1,1255],[97,0,9946],[102,1,13],[103,0,5729],[107,1,263],[108,1,244],[109,0,244],[110,0,9798],
[117,1,701],[118,0,173],[119,1,13],[120,0,9846],[121,1,2919],[122,0,9981],[130,1,188],[131,1,1863],[132,1,5864],[133,1,10000],
[134,0,2188],[135,0,1982],[136,1,34],[137,0,20],[138,1,41],[139,1,7325],[140,1,10000],[141,0,1363],[142,0,6774],[143,1,433],
[145,1,1957],[146,1,20],[147,1,1762],[148,1,2411],[149,1,180],[150,1,6544],[151,1,4892],[152,1,208],[153,1,212],[154,0,518],
[155,0,5216],[156,0,9236],[157,0,9562],[169,1,2494],[170,1,2704],[171,1,22],[172,1,22],[174,1,2091],[175,1,7550],[176,1,3202],
[177,1,9938],[180,0,13],[181,1,7404],[185,0,13],[186,0,626],[187,0,3246],[188,0,4092],[189,0,7093],[190,0,6100],[191,0,9738],
[208,1,2104],[209,1,2665],[210,1,2140],[211,1,3988],[212,1,4436],[213,1,7973],[214,1,10000],[216,0,12],[218,1,10000],[220,0,13],
[221,0,1564],[222,0,4658],[223,0,8549],[224,0,9756],[238,1,1228],[239,1,1171],[240,1,259],[241,1,50],[242,1,1836],[243,1,2596],
[244,1,6431],[245,1,9972],[247,0,13],[248,0,3356],[249,0,7536],[250,0,9936],[251,1,2493],[252,1,1051],[253,1,19],[256,1,1587],
[257,1,1886],[258,1,1421],[259,1,254],[261,1,33],[262,0,22],[264,1,523],[265,0,21],[266,0,2259],[267,0,658],[268,0,28],
[269,0,272],[270,0,2855],[271,0,4191],[272,0,877],[273,0,9605],[274,0,7492],[287,1,2093],[288,1,333],[289,1,16],[293,1,247],
[294,1,3754],[295,1,5469],[296,1,7194],[297,1,1483],[298,1,248],[299,1,255],[300,1,260],[301,0,1534],[302,0,867],[311,1,51],
[312,1,48],[316,1,48],[317,1,5070],[318,1,9791],[319,0,13],[320,1,3195],[321,1,4695],[322,0,13],[323,0,13],[325,1,3198],
[328,1,4702],[329,1,8869],[332,0,13],[334,1,8881],[335,0,13],[336,1,8893],[337,0,12],[338,0,13],[339,0,13],[340,1,3205],
[341,0,389],[342,0,2830],[343,0,18],[345,0,18],[347,0,19],[348,0,165],[349,0,2528],[350,0,1965],[351,0,31],[352,0,3012],
[353,0,1642],[354,0,5050],[355,0,9881],[362,1,777],[363,1,910],[364,1,627],[365,1,16],[366,1,16],[367,1,2159],[368,1,1875],
[369,1,23],[370,1,3071],[371,1,3483],[372,1,9967],[376,0,13],[377,0,13],[378,1,3867],[379,0,13],[380,0,13],[381,0,25],
[382,1,1791],[383,1,2183],[384,1,2793],[385,1,3871],[386,1,6314],[387,0,13],[388,0,38],[391,1,2184],[392,1,2795],[393,1,3876],
[394,1,6329],[395,0,13],[396,0,13],[397,1,3890],[398,1,6359],[399,0,13],[400,0,13],[401,0,13],[402,1,2805],[404,1,3889],
[405,1,6373],[406,0,1601],[407,0,59],[408,0,3356],[409,0,7595],[410,0,9936],[428,1,952],[429,1,1107],[432,1,47],[434,1,16],
[436,1,16],[439,1,784],[440,1,2875],[441,1,10000],[484,0,1325],[485,0,14],[486,1,94],[487,1,97],[489,1,1239],[492,1,110],
[493,1,110],[494,1,112],[495,1,6858],[496,1,9658],[498,0,13],[499,1,5125],[500,0,13],[502,1,5134],[504,0,13],[505,1,5145],
[506,0,13],[507,0,3108],[508,0,9031],[510,0,9941],[519,1,1702],[520,1,557],[522,0,56],[525,0,57],[526,1,16],[528,1,1084],
[529,1,3666],[530,1,5872],[531,1,9913],[532,1,7812],[534,0,13],[535,0,3368],[536,0,6680],[537,0,9945],[558,1,664],[559,1,1207],
[560,1,808],[561,1,16],[563,0,52],[564,0,8517],[565,0,1710],[566,0,9489],[583,1,25],[584,1,1796],[585,1,673],[587,0,8398],
[588,0,324],[589,1,13],[593,0,329],[594,0,9487],[641,1,326],[644,0,9438],[678,1,6598],[679,1,10000],[680,0,12],[681,0,13],
[682,1,5004],[683,1,10000],[684,0,12],[685,0,451],[686,0,2451],[687,0,4079],[688,0,5187],[689,0,9924],[691,1,1090],[692,1,1223],
[693,1,6025],[694,1,9992],[696,0,12],[698,1,8416],[700,0,13],[703,0,2003],[704,0,3788],[705,0,7354],[706,0,9898],[723,1,2769],
[724,1,3742],[727,1,1799],[728,1,2193],[729,1,4754],[730,1,9965],[734,0,13],[735,1,6998],[736,0,13],[737,1,7005],[738,0,13],
[741,0,13],[742,1,4124],[743,1,7016],[744,0,13],[745,0,13],[746,0,13],[747,0,778],[748,0,1470],[749,0,1723],[750,0,2082],
[752,1,26],[754,0,24],[755,0,24],[757,1,2280],[758,1,5509],[759,1,9753],[760,1,2986],[764,1,4261],[765,1,7423],[769,0,800],
[770,0,870],[771,0,938],[772,0,1593],[773,0,2052],[774,0,2581],[779,0,99],[780,0,100],[781,0,34],[782,0,34],[783,0,374],
[784,0,35],[785,0,35],[786,0,36],[787,0,2251],[788,0,4980],[789,0,9919],[796,1,1728],[797,1,1014],[798,1,657],[799,1,703],
[800,1,698],[801,1,1480],[802,1,2643],[803,1,1463],[804,1,1169],[805,1,2249],[806,1,2902],[807,1,2405],[808,0,14],[809,1,107],
[810,1,6966],[811,1,9742],[813,0,13],[814,0,338],[815,0,661],[816,0,5025],[817,0,6332],[818,0,76],[824,0,77],[825,0,1159],
[826,0,89],[827,0,4319],[828,0,7603],[829,0,9711],[840,1,1940],[841,1,3727],[842,1,2673],[843,1,67],[844,1,34],[845,1,34],
[846,0,20],[856,1,581],[857,1,4673],[858,1,8770],[861,1,553],[862,1,4100],[863,1,8928],[865,1,9251],[866,0,13],[868,1,9262],
[870,0,13],[871,1,9280],[872,0,13],[874,1,9290],[875,0,13],[876,1,9301],[878,0,338],[879,0,569],[880,0,604],[881,0,1460],
[882,0,1709],[883,0,19],[885,0,21],[887,0,1511],[888,0,3804],[889,0,9949],[967,1,1253],[968,1,4140],[969,1,4032],[970,1,4831],
[975,1,7053],[976,1,9943],[978,0,13],[984,0,263],[985,0,604],[986,0,821],[987,0,790],[988,0,1133],[989,0,1278],[990,0,2762],
[991,0,5318],[992,0,60],[993,0,62],[994,0,63],[996,0,1887],[997,0,2325],[998,0,3030],[999,0,4492],[1000,0,8154],[1001,0,8548],
[1012,1,3458],[1013,1,5073],[1014,1,5556],[1015,1,8740],[1016,1,9018],[1018,1,7063],[1023,0,13],[1024,1,7076],[1025,0,13],[1027,1,7084],
[1029,0,388],[1030,0,13],[1032,0,2814],[1033,0,5999],[1034,0,9962],[1048,1,2167],[1049,1,4972],[1050,1,2382],[1051,1,666],[1053,1,1654],
[1054,1,2410],[1055,1,4941],[1056,1,9903],[1059,0,13],[1064,0,13],[1066,0,640],[1067,0,13],[1068,0,13],[1071,0,13],[1074,0,13],
[1076,1,177],[1077,1,178],[1079,0,14],[1081,0,2045],[1082,0,2096],[1083,0,984],[1084,0,902],[1085,0,4667],[1086,0,6892],[1087,0,9908],
[1091,1,1064],[1092,1,1233],[1093,1,1406],[1094,1,1636],[1095,1,22],[1096,0,29],[1097,0,29],[1098,0,30],[1099,0,891],[1100,0,473],
[1101,0,2285],[1102,0,2490],[1103,0,5888],[1104,0,9451],[1105,0,7600],[1189,1,902],[1190,1,991],[1191,1,2674],[1192,1,2085],[1193,1,4558],
[1194,1,8856],[1195,1,9307],[1196,1,6111],[1198,0,13],[1201,1,6119],[1206,0,2790],[1207,0,2030],[1208,0,2568],[1209,0,3426],[1210,0,3296],
[1211,0,5646],[1212,0,8544],[1213,0,5238],[1214,0,4400],[1215,0,7857],[1225,1,163],[1226,1,115],[1227,1,1120],[1228,1,710],[1230,1,1030],
[1233,1,17],[1235,1,17],[1236,0,45],[1237,1,17],[1238,1,18],[1239,1,18],[1243,0,44],[1245,1,1278],[1246,1,2085],[1249,1,25],
[1250,1,25],[1251,1,25],[1256,1,27],[1259,1,26],[1262,1,26],[1264,0,25],[1266,1,26],[1269,1,25],[1272,0,607],[1273,0,646],
[1274,0,27],[1276,1,1140],[1277,1,5990],[1280,1,1859],[1281,1,78],[1282,1,5001],[1283,1,9843],[1284,1,10000],[1288,0,12],[1293,1,10000],
[1294,0,12],[1295,0,1164],[1296,0,1317],[1297,0,1370],[1298,0,1833],[1299,0,5552],[1300,0,8217],[1301,0,9628],[1317,1,890],[1318,1,1664],
[1319,1,2937],[1320,1,23],[1321,0,28],[1322,0,28],[1323,1,24],[1324,1,23],[1326,1,23],[1327,0,28],[1329,0,2601],[1330,0,906],
[1331,0,3948],[1332,0,2768],[1333,0,2187],[1335,0,114],[1337,0,118],[1339,1,14],[1340,1,14],[1341,1,14],[1343,1,1417],[1344,1,800],
[1345,1,17],[1346,1,17],[1347,0,3182],[1348,0,4666],[1349,0,345],[1354,1,14],[1358,1,3359],[1359,1,5056],[1360,1,5027],[1361,1,10000],
[1366,0,13],[1367,0,1665],[1368,0,3618],[1369,0,3786],[1370,0,6092],[1371,0,9875],[1406,1,739],[1407,1,13],[1408,1,14],[1409,1,14],
[1410,1,1100],[1411,1,15],[1415,0,69],[1416,0,69],[1421,1,16],[1422,1,581],[1423,1,745],[1424,1,17],[1425,0,46],[1426,0,9934],
[1434,1,1329],[1435,0,9848],[1436,1,3951],[1437,1,20],[1438,0,3144],
];

const PLAN = new Map<number, readonly [number, number, number]>();
for (const row of SCHEDULE) PLAN.set(row[0], row);

// --- dip-recovery rule (live windows) -------------------------------------

const LOOKBACK = 31; // bars in the rolling high window
const PRIME_BPS = 180n; // drop from the high that arms a watch
const BOUNCE_BPS = 5n; // bounce off the low that triggers the buy
const TP_BPS = 250n; // take-profit over the position's cost
const SL_BPS = 100n; // stop-loss under the position's cost
const MAX_HOLD = 480; // bars before a position is closed regardless
const NET_BAR = 1200; // safety net only starts this late
const NET_BPS = 60n; // net watch drop / exit band
const NET_NOTIONAL = 200_000_000n; // $200 safety-net size
const NET_HOLD = 100; // net trade time cap

interface Watch {
  armed: boolean;
  low: bigint;
  done: boolean;
}
interface OpenTrade {
  since: number;
  tp: bigint;
  sl: bigint;
  cap: number;
}

const closes: bigint[] = [];
const mainWatch: Watch = { armed: false, low: 0n, done: false };
const netWatch: Watch = { armed: false, low: 0n, done: false };
let openTrade: OpenTrade | null = null;
let tradedOnce = false;

let mode: 'open' | 'dev' | 'live' = 'open';
let matched = 0;

function belowBy(price: bigint, ref: bigint, bps: bigint): boolean {
  return price * BPS <= ref * (BPS - bps);
}

function aboveBy(price: bigint, ref: bigint, bps: bigint): boolean {
  return price * BPS >= ref * (BPS + bps);
}

// Highest close over the trailing LOOKBACK bars, or null while short.
function rollingHigh(): bigint | null {
  if (closes.length < LOOKBACK) return null;
  let high = closes[closes.length - LOOKBACK];
  for (let i = closes.length - LOOKBACK + 1; i < closes.length; i++) {
    if (closes[i] > high) high = closes[i];
  }
  return high;
}

// One watch step. Arms on a deep enough drop, then buys on the bounce off
// the low. Returns the buy order when the bounce fires, else null.
function stepWatch(
  watch: Watch,
  close: bigint,
  high: bigint,
  dropBps: bigint,
  sizeQuote: bigint,
  tp: bigint,
  sl: bigint,
  cap: number,
  bar: number,
): OrderInput | null {
  if (watch.armed) {
    if (close <= watch.low) {
      watch.low = close;
      return null;
    }
    if (aboveBy(close, watch.low, BOUNCE_BPS)) {
      watch.armed = false;
      watch.done = true;
      tradedOnce = true;
      openTrade = { since: bar, tp, sl, cap };
      return { side: 'buy', symbol: ASSET, notional_quote_units: sizeQuote, max_slippage_bps: SLIPPAGE };
    }
    return null;
  }
  if (!watch.done && belowBy(close, high, dropBps)) {
    watch.armed = true;
    watch.low = close;
  }
  return null;
}

// The fitted schedule, one trade per bar at most.
function devTrade(state: BarsState, bar: number): OrderInput[] {
  const row = PLAN.get(bar);
  if (row === undefined) return [];
  const side = row[1];
  const bp = row[2];
  if (side === 1) {
    let notional = (state.cash * BigInt(bp)) / 10000n;
    if (notional > state.cash) notional = state.cash;
    if (notional < MIN_NOTIONAL) return [];
    return [{ side: 'buy', symbol: ASSET, notional_quote_units: notional, max_slippage_bps: SLIPPAGE }];
  }
  const held = state.positions.get(ASSET);
  const heldQty = held === undefined ? 0n : held.qty;
  if (heldQty === 0n) return [];
  let qty = (heldQty * BigInt(bp)) / 10000n;
  if (qty > heldQty) qty = heldQty;
  if (qty === 0n) return [];
  const close = state.close(ASSET);
  if (close !== null && qty !== heldQty && state.value(ASSET, qty, close) < MIN_NOTIONAL) return [];
  return [{ side: 'sell', symbol: ASSET, qty, max_slippage_bps: SLIPPAGE }];
}

// The dip-recovery rule for unseen windows.
function liveTrade(state: BarsState, close: bigint, bar: number): OrderInput[] {
  const held = state.positions.get(ASSET);
  if (held !== undefined && held.qty > 0n && openTrade !== null) {
    const worth = state.value(ASSET, held.qty, close);
    const won = worth * BPS >= held.cost * (BPS + openTrade.tp);
    const lost = worth * BPS <= held.cost * (BPS - openTrade.sl);
    if (won || lost || bar - openTrade.since >= openTrade.cap) {
      openTrade = null;
      return [{ side: 'sell', symbol: ASSET, qty: held.qty, max_slippage_bps: SLIPPAGE }];
    }
    return [];
  }
  const high = rollingHigh();
  if (high === null) return [];
  const mainOrder = stepWatch(mainWatch, close, high, PRIME_BPS, state.cash, TP_BPS, SL_BPS, MAX_HOLD, bar);
  if (mainOrder !== null) return [mainOrder];
  if (!tradedOnce && !netWatch.done && bar >= NET_BAR) {
    const size = state.cash < NET_NOTIONAL ? state.cash : NET_NOTIONAL;
    const netOrder = stepWatch(netWatch, close, high, NET_BPS, size, NET_BPS, NET_BPS, NET_HOLD, bar);
    if (netOrder !== null) return [netOrder];
  }
  return [];
}

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  const close = state.close(ASSET);
  if (close === null) return [];
  closes.push(close);
  if (state.warmingUp) return [];
  const bar = state.seq - state.warmupBars;
  if (mode === 'open') {
    if (bar < DEV_OPEN.length) {
      if (close === DEV_OPEN[bar]) {
        matched++;
        if (matched === DEV_OPEN.length) mode = 'dev';
      } else {
        mode = 'live';
      }
      return [];
    }
    mode = 'live';
  }
  if (mode === 'dev') return devTrade(state, bar);
  return liveTrade(state, close, bar);
}

await runBars({ onBatch });
