// Whether the providers still deliver to us (pure). Helius and Alchemy each
// switch a webhook off on their own after a day of failed deliveries — on
// 2026-10-02 both did while Vercel had paused the site, and the alerts went
// quiet with nothing saying so. The morning sweep reads both and alarms.

export interface WebhookState {
  provider: "Helius" | "Alchemy";
  /** The network, for Alchemy's per-network webhooks. */
  network?: string;
  /** Unknown (the provider didn't say) is not reported as off. */
  active: boolean | undefined;
  reason?: string | null;
}

/** One line per webhook that is switched off, empty when all deliver. */
export function webhookProblems(states: readonly WebhookState[]): string[] {
  return states
    .filter((s) => s.active === false)
    .map((s) => `${s.provider}${s.network ? ` ${s.network}` : ""} webhook is OFF${s.reason ? ` (${s.reason})` : ""} — no live trades or alerts until it's re-enabled in the ${s.provider} dashboard`);
}
