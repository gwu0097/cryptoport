// How a wallet's unrecognized tokens (wallet_discovered_tokens: held, but no
// CoinGecko listing or no price — docs/sync/PLAN.md D3) are shown. Never in
// totals; listed so nothing is silently dropped. Pure.

export type UnrecognizedReason = "unlisted" | "unpriced";

export const REASON_LABEL: Record<UnrecognizedReason, string> = {
  unlisted: "Not on CoinGecko",
  unpriced: "Listed, no price",
};

/** A raw on-chain balance in whole tokens; null when decimals are unknown
 * (the balance can't be sized — shown as "—", never guessed). */
export function tokenAmount(raw: string | null, decimals: number | null): number | null {
  if (raw === null || decimals === null || !Number.isInteger(decimals) || decimals < 0 || !/^\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  const scale = BigInt(10) ** BigInt(decimals);
  // Whole part exactly, then the fraction to 12 digits, so huge spam supplies
  // don't lose everything to floating point.
  const whole = n / scale;
  const frac = Number(((n % scale) * BigInt(10) ** BigInt(12)) / scale) / 1e12;
  return Number(whole) + frac;
}

const MAX_SYMBOL = 24;

/** A symbol as safe plain text: control and zero-width characters removed,
 * whitespace collapsed, long ones cut. Spam symbols carry URLs and odd
 * Unicode; they're only ever rendered as text. */
export function displaySymbol(symbol: string | null): string {
  const clean = (symbol ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "?";
  return clean.length > MAX_SYMBOL ? `${clean.slice(0, MAX_SYMBOL - 1)}…` : clean;
}

// Why a token looks like airdrop spam (tokenSpam.ts decides). Hidden behind a
// toggle, still listed.
export type SpamSign = "advertises" | "impersonates" | "lookalike";

export const SPAM_LABEL: Record<SpamSign, string> = {
  advertises: "Its name advertises a website or a claim",
  impersonates: "Copies the name of a listed coin on this chain",
  lookalike: "Uses look-alike letters from another alphabet",
};
