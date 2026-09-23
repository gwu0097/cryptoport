// The Signals page's indicator list — the dropdown at the top of the page.
// SMC v4.2 is the first; a new indicator is a new entry here plus its own
// engine module (see engine.ts for the shape one needs: completed-block
// ribbon, flips, trigger). Reported directly: "This is the first signal
// we're putting in, but we might add more signals later."

export interface IndicatorDef {
  id: string; // ?ind= value
  label: string;
  description: string;
}

export const INDICATORS: IndicatorDef[] = [
  {
    id: "smc",
    label: "SMC v4.2",
    description: "Your SMC Bot Replica v4.2: RMA(8) of 3× block closes vs opens, non-repainting (Delay = 1).",
  },
];

export const DEFAULT_INDICATOR = INDICATORS[0];

export function indicatorById(id: string | undefined): IndicatorDef {
  return INDICATORS.find((i) => i.id === id) ?? DEFAULT_INDICATOR;
}
