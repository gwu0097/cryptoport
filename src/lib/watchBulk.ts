// Wallet Watch bulk add (owner 2026-10-07): a pasted list, one wallet a line,
// to name/address pairs. Pure — the form previews with it and the server
// action parses again (which chain an address is, is the server's call).
//
// A line is a name and an address in either order, separated by spaces,
// tabs, commas or a pipe: "Swing 4a7N   4a7NWcur…", "0xabc…, Ansem". The
// address is the one long unbroken token; everything else is the name. A
// line with only an address gets no name (the server uses its short form).

/** How many lines one bulk add takes (the per-user influencer cap is 40). */
export const BULK_MAX = 40;

export interface BulkLine {
  /** 1-based line number in the pasted text. */
  line: number;
  name: string | null;
  address: string;
}

export interface BulkProblem {
  line: number;
  text: string;
  error: string;
}

const SEPARATORS = /[\s,;|]+/;
/** Shortest real address the app reads is a Solana one (32 characters). */
const looksLikeAddress = (t: string) => t.length >= 26 && /^[A-Za-z0-9:._-]+$/.test(t);

export function parseBulk(text: string): { lines: BulkLine[]; problems: BulkProblem[] } {
  const lines: BulkLine[] = [];
  const problems: BulkProblem[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const tokens = trimmed.split(SEPARATORS).filter(Boolean);
    const candidates = tokens.filter(looksLikeAddress);
    if (candidates.length === 0) return problems.push({ line, text: trimmed, error: "No address on this line" });
    if (candidates.length > 1) return problems.push({ line, text: trimmed, error: "More than one address on this line" });
    const address = candidates[0];
    const key = /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
    const earlier = seen.get(key);
    if (earlier) return problems.push({ line, text: trimmed, error: `Same address as line ${earlier}` });
    seen.set(key, line);
    const name = tokens.filter((t) => t !== address).join(" ").slice(0, 80) || null;
    lines.push({ line, name, address });
  });
  if (lines.length > BULK_MAX) {
    for (const extra of lines.splice(BULK_MAX)) problems.push({ line: extra.line, text: extra.address, error: `Over ${BULK_MAX} lines — add the rest in another batch` });
  }
  return { lines, problems };
}
