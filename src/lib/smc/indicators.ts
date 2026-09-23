// The Signals page's indicator list — the dropdown at the top of the page.
// A new indicator is a new entry here plus its rules in src/lib/signals/
// (rules.ts + triggers.ts + view.ts). Reported directly: "This is the first
// signal we're putting in, but we might add more signals later."
//
// No indicator here has a measured edge: SMC's figures come from an external
// backtest this app never reproduced, and the four bar-close indicators'
// pre-registered backtest is deferred (docs/signals/
// PREREG_PULLBACK_INDICATORS.md §10). Each is shown on its own — never
// combined into a consensus/"N of 5 agree" figure.

import type { IndicatorId } from "@/lib/signals/rules";

export interface IndicatorDef {
  id: IndicatorId; // ?ind= value
  label: string;
  description: string;
  /** The warning banner, verbatim. */
  banner: string;
  /** How the state/trigger is computed — the page footer. */
  method: string;
}

const NOT_BACKTESTED = "Not backtested — visual reference only.";
const BAR_CLOSE_METHOD =
  "Decided on each completed bar's close (the forming bar never counts, so a printed signal never moves); long-only — Long after a Buy, Flat after a Sell, counted from the first bar every input is defined in the fetched history. Overlays are as of the last completed bar.";

export const INDICATORS: IndicatorDef[] = [
  {
    id: "smc",
    label: "SMC v4.2",
    description: "Your SMC Bot Replica v4.2: RMA(8) of 3× block closes vs opens, non-repainting (Delay = 1).",
    banner:
      "Visual reference only — not a trading strategy or a recommendation. Figures from an external backtest (methodology unrecorded); not reproduced in this app: profit factor 0.88 on BTC at 6bps round trip, and a random-entry control beat it in 41% of trials. Never validated on any other token.",
    method:
      "Blocks are epoch-aligned (3× the chart timeframe); only completed blocks count, and the ribbon shows the last completed block (Delay = 1), so a printed signal never moves. The trigger price is exact: the forming block's close alone decides the next state.",
  },
  {
    id: "rsi2",
    label: "RSI(2) pullback",
    description: "Buy when close > SMA(200) and Wilder RSI(2) < 10; sell when close > SMA(5).",
    banner: NOT_BACKTESTED,
    method: `${BAR_CLOSE_METHOD} Both triggers are exact closes (the RSI and both SMAs include the forming bar's own close).`,
  },
  {
    id: "bb",
    label: "Bollinger pullback",
    description: "Buy when close > SMA(200) and %B ≤ 0 on BB(20, 2); sell when close ≥ the middle band.",
    banner: NOT_BACKTESTED,
    method: `${BAR_CLOSE_METHOD} Both triggers are exact closes (the bands include the forming bar's own close).`,
  },
  {
    id: "ma",
    label: "MA pullback",
    description: "Buy when close > SMA(200), EMA(20) > EMA(50), the low touches EMA(20) and close > EMA(50); sell when close < EMA(50).",
    banner: NOT_BACKTESTED,
    method: `${BAR_CLOSE_METHOD} The sell trigger is an exact close; the buy depends on the bar's low and close together, so no single price exists — the current EMA values are shown instead.`,
  },
  {
    id: "donchian",
    label: "Donchian breakout",
    description: "Buy when close > the prior 55-bar high; sell when close < the prior 20-bar low.",
    banner: NOT_BACKTESTED,
    method: `${BAR_CLOSE_METHOD} Both triggers are exact (the channel excludes the forming bar).`,
  },
];

export const DEFAULT_INDICATOR = INDICATORS[0];

export function indicatorById(id: string | undefined): IndicatorDef {
  return INDICATORS.find((i) => i.id === id) ?? DEFAULT_INDICATOR;
}
