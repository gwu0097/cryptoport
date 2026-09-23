// Pure SMC signal engine — a port of the user's TradingView indicator
// "SMC Bot Replica v4.2" (external/smc_bot_replica_v4_2.pine) per
// external/smc_signal_overlay_spec.md §4, with the scoping decisions in
// BACKLOG.md ("SMC signal engine + chart"). See engine.test.ts.
//
//   chart candles (1h / 4h / 1d)
//     -> epoch-aligned blocks at 3x the chart timeframe (3h / 12h / 3d),
//        COMPLETED blocks only (full candle count AND wall-clock past the end)
//     -> Wilder's RMA(8) of block closes ("Close Series") and opens ("Open Series")
//     -> bull = Close Series > Open Series; a Buy/Sell label where it flips.
//
// Delay = 1 (the indicator's non-repainting mode — its default of 0 repaints
// and can't be traded): in Pine, request.security(htf, rma[1], lookahead_on)
// means that while block k is forming, the ribbon shows the RMA as of the
// last COMPLETED block before it. So the ribbon is a step line, and a label
// prints on the first chart candle whose visible ribbon state differs from
// the previous candle's — exactly Pine's ta.crossover on the chart series.
// The v4.2 "ATR trail" is a placeholder in the Pine source and isn't ported.

export type ChartTimeframe = "1H" | "4H" | "1D";

export const TIMEFRAMES: Record<ChartTimeframe, { interval: "1h" | "4h" | "1d"; candleSeconds: number; blockLabel: string; historyDays: number }> = {
  // historyDays: how much to fetch — RMA(8) needs ~50 blocks to forget its
  // seed ((7/8)^50 ≈ 0.1%); these give 400+ blocks, and fit one API call.
  "1H": { interval: "1h", candleSeconds: 3_600, blockLabel: "3H", historyDays: 60 },
  "4H": { interval: "4h", candleSeconds: 14_400, blockLabel: "12H", historyDays: 400 },
  "1D": { interval: "1d", candleSeconds: 86_400, blockLabel: "3D", historyDays: 1_500 },
};

export const BLOCK_MULTIPLIER = 3; // fixed property of the indicator, not configurable
export const RMA_LENGTH = 8; // hardcoded in the original; solved from its plot values

export interface Candle {
  t: number; // open time, unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Block {
  id: number; // floor(t / blockSeconds) — epoch-aligned, anchor 0
  start: number; // unix seconds
  end: number; // exclusive
  open: number;
  close: number;
  count: number;
}

/** Group candles into epoch-aligned blocks. `completed` has only blocks with
 * the full candle count whose end has passed `nowSec` (no repainting from a
 * still-forming block); `forming` is the block containing the latest candle
 * if it isn't complete. */
export function buildBlocks(
  candles: readonly Candle[],
  candleSeconds: number,
  nowSec: number,
): { completed: Block[]; forming: Block | null } {
  const blockSeconds = candleSeconds * BLOCK_MULTIPLIER;
  const byId = new Map<number, Candle[]>();
  for (const c of [...candles].sort((a, b) => a.t - b.t)) {
    const id = Math.floor(c.t / blockSeconds);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(c);
  }
  const blocks: Block[] = [...byId.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, cs]) => ({ id, start: id * blockSeconds, end: (id + 1) * blockSeconds, open: cs[0].o, close: cs[cs.length - 1].c, count: cs.length }));
  const isComplete = (b: Block) => b.count === BLOCK_MULTIPLIER && nowSec >= b.end;
  const last = blocks.at(-1) ?? null;
  return { completed: blocks.filter(isComplete), forming: last && !isComplete(last) ? last : null };
}

/** Wilder's RMA exactly as Pine's ta.rma: undefined until index n-1, seeded
 * with the simple mean of the first n values, then (prev*(n-1) + x)/n. */
export function rma(values: readonly number[], n: number = RMA_LENGTH): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (values.length < n) return out;
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = (prev * (n - 1) + values[i]) / n;
    out[i] = prev;
  }
  return out;
}

export interface RibbonPoint {
  time: number; // chart candle open time
  close: number; // Close Series visible on this candle
  open: number; // Open Series visible on this candle
  bull: boolean;
}

export interface Flip {
  time: number; // the candle the label prints on
  side: "BUY" | "SELL";
  price: number; // that candle's close (where it would be seen on the chart)
}

export interface Trigger {
  /** The forming block's close decides the next state: above -> bull, below -> bear. */
  price: number;
  formingBlockStart: number;
  formingBlockEnd: number; // the label (if any) prints on the first candle at/after this
  /** What crossing the trigger would do, given the current state. */
  flipIfClose: "above" | "below";
  flipTo: "BUY" | "SELL";
}

export interface SmcResult {
  ribbon: RibbonPoint[];
  flips: Flip[];
  state: { bull: boolean; lastFlip: Flip | null } | null;
  trigger: Trigger | null;
  completedBlocks: number;
}

/**
 * The next state is decided by the forming block's close alone. With C, O =
 * the last completed block's Close/Open Series and o = the forming block's
 * open (known from its first candle):
 *   C' = (7C + close)/8,  O' = (7O + o)/8,  bull' ⇔ C' > O'
 *   ⇔ close > o + 7(O − C)
 * so a single price decides it — "BUY if this block closes above X".
 */
export function triggerPrice(lastClose: number, lastOpen: number, formingOpen: number, n: number = RMA_LENGTH): number {
  return formingOpen + (n - 1) * (lastOpen - lastClose);
}

export function computeSmc(candles: readonly Candle[], tf: ChartTimeframe, nowSec: number): SmcResult {
  const { candleSeconds } = TIMEFRAMES[tf];
  const { completed, forming } = buildBlocks(candles, candleSeconds, nowSec);
  const closeSeries = rma(completed.map((b) => b.close));
  const openSeries = rma(completed.map((b) => b.open));

  // Delay = 1: a candle sees the latest completed block that ended at or
  // before the candle's own block started.
  const blockSeconds = candleSeconds * BLOCK_MULTIPLIER;
  const ribbon: RibbonPoint[] = [];
  const flips: Flip[] = [];
  let j = -1; // index into completed of the latest block with end <= this candle's block start
  let prevBull: boolean | null = null;
  for (const c of [...candles].sort((a, b) => a.t - b.t)) {
    const blockStart = Math.floor(c.t / blockSeconds) * blockSeconds;
    while (j + 1 < completed.length && completed[j + 1].end <= blockStart) j++;
    const C = j >= 0 ? closeSeries[j] : null;
    const O = j >= 0 ? openSeries[j] : null;
    if (C === null || O === null) continue;
    const bull = C > O;
    ribbon.push({ time: c.t, close: C, open: O, bull });
    if (prevBull !== null && bull !== prevBull) flips.push({ time: c.t, side: bull ? "BUY" : "SELL", price: c.c });
    prevBull = bull;
  }

  const lastC = closeSeries.at(-1) ?? null;
  const lastO = openSeries.at(-1) ?? null;
  let trigger: Trigger | null = null;
  if (forming && lastC !== null && lastO !== null) {
    const bullAfterLast = lastC > lastO;
    trigger = {
      price: triggerPrice(lastC, lastO, forming.open),
      formingBlockStart: forming.start,
      formingBlockEnd: forming.end,
      flipIfClose: bullAfterLast ? "below" : "above",
      flipTo: bullAfterLast ? "SELL" : "BUY",
    };
  }

  const lastPoint = ribbon.at(-1);
  return {
    ribbon,
    flips,
    state: lastPoint ? { bull: lastPoint.bull, lastFlip: flips.at(-1) ?? null } : null,
    trigger,
    completedBlocks: completed.length,
  };
}
