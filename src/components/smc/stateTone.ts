import type { IndicatorView } from "@/lib/signals/view";

/** Text color for an indicator state. Only directional states get red/green:
 * SMC's Bull/Bear is a call, but the bar-close indicators' Flat just means
 * "no position, waiting for a setup" — neutral grey, never a sell-red. */
export function stateToneClass(state: NonNullable<IndicatorView["state"]>): string {
  switch (state.label) {
    case "Bull":
    case "Long":
      return "text-positive";
    case "Bear":
      return "text-negative";
    case "Flat":
      return "text-fg-muted";
  }
}
