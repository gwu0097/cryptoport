import "server-only";
import { fetchWithRetry } from "./http";

const STAKEWIZ_BASE = "https://api.stakewiz.com";

/**
 * Validator display name + APY, from Stakewiz (api.stakewiz.com, free,
 * keyless, tested live — /validator/{vote_identity} returns `name`/
 * `total_apy`, verified against a real wallet: "Solana Mobile Validator",
 * 5.26% APY, matching jup.ag exactly). Shared by every adapter that needs
 * to label a Solana validator by its vote-account pubkey — originally
 * built for solanaStaking.ts, extracted once jitoMevRewards.ts became a
 * second caller needing the identical lookup, past this codebase's own
 * "two is the threshold to extract" rule.
 *
 * Best-effort only: a Stakewiz failure (down, rate-limited, or an obscure
 * validator with no wiz data — its API returns bare `false` rather than
 * 404 for an unknown vote pubkey, not an error status) degrades to a
 * plain truncated-pubkey label rather than throwing — this labels real
 * on-chain positions, so a labeling-service hiccup must never make the
 * underlying holding disappear from its caller.
 */
export async function fetchValidatorName(voter: string): Promise<string> {
  try {
    const res = await fetchWithRetry(`${STAKEWIZ_BASE}/validator/${voter}`);
    if (res.ok) {
      const body: { name?: string; total_apy?: number } | false = await res.json();
      if (body && body.name) {
        const apy = typeof body.total_apy === "number" ? ` (${body.total_apy.toFixed(2)}% APY)` : "";
        return `${body.name}${apy}`;
      }
    }
  } catch {
    // best-effort — fall through to the truncated-pubkey label below
  }
  return `${voter.slice(0, 4)}…${voter.slice(-4)}`;
}
