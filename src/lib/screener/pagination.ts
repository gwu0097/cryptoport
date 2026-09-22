import "server-only";

/**
 * PostgREST (Supabase's REST layer) caps any unbounded `.select()` at
 * 1,000 rows by default — a real bug hit live during Phase 1 testing: an
 * existence-check query returned only the first 1,000 of 383,557 existing
 * rows, so everything past that page looked "not yet backfilled" and got
 * duplicated. This exact gotcha was independently hit three separate
 * times in one session across different ad-hoc scripts before it got a
 * shared fix — this codebase's own stated trigger for extracting one
 * (CLAUDE.md: "the moment the same logic needs the same fix applied more
 * than once, that's the signal to extract a shared implementation").
 *
 * Keyset (cursor) pagination, not `.range()`/OFFSET — a second real bug
 * hit fixing the first one: OFFSET-based pagination degrades badly at
 * scale (Postgres re-scans and discards `offset` rows on every page), and
 * live-verified this session it actually hit a statement timeout
 * (`57014`) partway through a ~500K-row table, not just "slow." `id`
 * (every screener table's uuid primary key) has a real total order and an
 * index by construction, so `id > cursor ORDER BY id LIMIT pageSize` stays
 * fast regardless of how deep into the table a page is.
 */
export async function fetchAllRows<T extends { id: string }>(
  query: (
    cursor: string,
    limit: number,
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const pageSize = 1000;
  const rows: T[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000"; // lexically before any real uuid
  while (true) {
    const { data, error } = await query(cursor, pageSize);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}
