// Perp Scout's trader list as a file (owner 2026-10-06: "a way to import
// traders as well as export"). Pure: the CSV an export writes, and what an
// import accepts — that CSV, Perp Scout's JSON (an array of traders, or
// `{ traders }`), or plain text with one address per line and an optional
// name after a comma or tab.

import { isTraderAddress, type FollowedTrader } from "./followed.ts";

export interface ImportedTrader {
  address: string;
  name: string | null;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The list as CSV: address, name, when it was added and why. */
export function tradersToCsv(traders: readonly FollowedTrader[]): string {
  const rows = [["address", "name", "added_on", "why"], ...traders.map((t) => [t.address, t.name, t.addedOn, t.why])];
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

/** One CSV line's cells (quotes and doubled quotes handled). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const clean = (name: unknown) => (typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : null);

/**
 * The traders in an import file, each address once (first name wins), with
 * the lines that weren't a Hyperliquid address counted as skipped. A
 * header row and blank lines are ignored.
 */
export function parseTraderImport(text: string): { traders: ImportedTrader[]; skipped: number } {
  const found: ImportedTrader[] = [];
  let skipped = 0;
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return { traders: [], skipped: 1 };
    }
    const list = Array.isArray(data) ? data : ((data as { traders?: unknown }).traders ?? []);
    for (const item of Array.isArray(list) ? list : []) {
      const address = typeof item === "string" ? item : (item as { address?: unknown })?.address;
      const a = typeof address === "string" ? address.trim().toLowerCase() : "";
      if (isTraderAddress(a)) found.push({ address: a, name: typeof item === "string" ? null : clean((item as { name?: unknown }).name) });
      else skipped++;
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [first, second] = csvCells(line);
      const a = (first ?? "").toLowerCase();
      if (isTraderAddress(a)) found.push({ address: a, name: clean(second) });
      else if (a !== "address") skipped++;
    }
  }
  const seen = new Set<string>();
  return { traders: found.filter((t) => !seen.has(t.address) && seen.add(t.address)), skipped };
}
