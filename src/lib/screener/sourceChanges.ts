/** Days where the set of DefiLlama slugs summed into an asset changed, from
 * one reading per day (ascending). Each day is compared with the LAST day
 * that had a slug list, so a day without one (older rows) neither reads as
 * "everything removed" nor hides a change across it. See sourceChanges.test.ts. */
export function sourceChanges(days: readonly (readonly [string, readonly string[] | null])[]): { date: string; added: string[]; removed: string[] }[] {
  const out: { date: string; added: string[]; removed: string[] }[] = [];
  let prev: readonly string[] | null = null;
  for (const [date, cur] of days) {
    if (!cur) continue;
    if (prev) {
      const added = cur.filter((x) => !prev!.includes(x));
      const removed = prev.filter((x) => !cur.includes(x));
      if (added.length || removed.length) out.push({ date, added, removed });
    }
    prev = cur;
  }
  return out;
}
