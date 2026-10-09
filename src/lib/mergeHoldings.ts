// "Merge same coin": one row per coin per chain instead of one per wallet or
// address — the same coin held in two places becomes one row with the
// quantities added. Pure. Only plain coin rows merge (an asset key, no
// position fields); positions valued as a whole, perps and predictions stay
// as they are. The merged row is valued exactly like its parts: quantity ×
// the coin's one price, so totals don't change.

import type { Holding } from "./types.ts";

export function mergeSameCoin<T extends Holding & { wallets?: { id: string; name: string }[] }>(holdings: readonly T[]): T[] {
  const out: T[] = [];
  const merged = new Map<string, T>();
  for (const h of holdings) {
    const qty = typeof h.qty === "string" ? Number(h.qty) : h.qty;
    const mergeable = !!h.price_key && h.category === "token" && !h.position_side && h.usd_override == null && qty != null && Number.isFinite(qty);
    if (!mergeable) {
      out.push(h);
      continue;
    }
    const key = `${h.chain ?? ""}|${h.price_key}`;
    const cur = merged.get(key);
    if (!cur) {
      const first = { ...h, qty, ...(h.wallets ? { wallets: [...h.wallets] } : {}) };
      merged.set(key, first);
      out.push(first);
    } else {
      cur.qty = (cur.qty as number) + (qty as number);
      if (cur.contract !== h.contract) cur.contract = null; // several contracts: none is "the" one
      // Every wallet it sums, each once.
      for (const w of h.wallets ?? []) if (cur.wallets && !cur.wallets.some((x) => x.id === w.id)) cur.wallets.push(w);
    }
  }
  return out;
}
