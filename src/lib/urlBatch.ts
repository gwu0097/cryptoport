// Lists packed into one URL (CoinGecko's ids= / contract_addresses= /
// symbols=), split by length as well as count. 2026-09-29: CoinGecko's
// CloudFront began refusing any query over ~2,000 characters ("Request
// blocked", HTTP 403) — 250 coin ids is ~3,400, so every price refresh and
// contract lookup failed from everywhere, while a 131-id request (1,896
// characters) returned 200. Pure.

/** CoinGecko's limit in practice is ~2,048 characters for the whole query;
 * the list gets this much, leaving room for the other parameters. */
export const MAX_LIST_CHARS = 1_500;

/** `items` in batches whose comma-joined length stays within `maxChars`
 * (and at most `maxCount` each). An item longer than the limit goes alone. */
export function chunkByLength(items: readonly string[], maxChars = MAX_LIST_CHARS, maxCount = Infinity): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const item of items) {
    const added = (batch.length > 0 ? 1 : 0) + encodeURIComponent(item).length;
    if (batch.length > 0 && (length + added > maxChars || batch.length >= maxCount)) {
      out.push(batch);
      batch = [];
      length = 0;
    }
    length += batch.length > 0 ? added : encodeURIComponent(item).length;
    batch.push(item);
  }
  if (batch.length > 0) out.push(batch);
  return out;
}
