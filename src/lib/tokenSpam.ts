// Whether an unrecognized token's symbol marks it as airdrop spam
// (unrecognizedTokens.ts SpamSign). Server-side only in practice: it loads
// the full IANA top-level-domain list (`tlds`), which the browser never
// needs. Pure.
import tlds from "tlds" with { type: "json" };
import type { SpamSign } from "./unrecognizedTokens.ts";

const TLDS = new Set<string>(tlds);

// A web address in the symbol: a name, a dot, and a real top-level domain
// (IANA's list — any ending spam moves to: .ink, .icu, .gifts, ...). A dot
// followed by something that isn't a domain ending is a bridge suffix, not
// an address (USDC.e, BTC.b, USDC.axl).
// Every ".label" preceded by a name character is checked (lookbehind, so
// "better-gmx.eth.link" checks both "eth" and "link").
const DOTTED = /(?<=[\p{L}\p{N}-])\.([a-z]{2,24})(?![a-z])/giu;
const ADVERTISES = [
  /https?:\/\//i,
  /\bwww\./i,
  /t\.me\//i,
  /@\w{3,}/, // a Telegram / X handle
  /\b(claim|reward|rewards|airdrop|voucher|visit|redeem|bonus|presale)\b/i,
];

function hasDomain(symbol: string): boolean {
  for (const m of symbol.matchAll(DOTTED)) if (TLDS.has(m[1].toLowerCase())) return true;
  return false;
}

// Latin mixed with Cyrillic or Greek letters: "UЅDТ" (Cyrillic Ѕ and Т).
const LATIN = /[a-z]/i;
const CYRILLIC_OR_GREEK = /[\u0370-\u03ff\u0400-\u04ff]/;

/**
 * Why an unrecognized token looks like spam, or null. `listedSymbols` is the
 * upper-cased symbols of CoinGecko-listed tokens on the token's chain
 * (token_registry): an unlisted token wearing one of those names is an
 * impostor — the real coin would have been counted, not listed here.
 */
export function spamSign(symbol: string | null, listedSymbols: ReadonlySet<string>): SpamSign | null {
  const s = symbol ?? "";
  if (hasDomain(s) || ADVERTISES.some((re) => re.test(s))) return "advertises";
  if (LATIN.test(s) && CYRILLIC_OR_GREEK.test(s)) return "lookalike";
  if (s.trim() && listedSymbols.has(s.trim().toUpperCase())) return "impersonates";
  return null;
}
