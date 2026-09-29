import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A read paged 1,000 rows at a time is one serial round trip per page
// (2026-09-29: the Dashboard's price and coin tables, 5 of its 7 hops).
// Every existing paging loop is listed with its count; a new one fails
// here, and a fixed one must be taken off (the count only goes down).
// A background job may page (it isn't a page render) — list it with why.
const PAGING_ALLOWED: Record<string, { count: number; why: string }> = {
  "src/lib/queries.ts": { count: 2, why: "render: asset_prices + assets whole-table reads — phase 3 replaces them" },
  "src/lib/unrecognizedTokensQuery.ts": { count: 2, why: "render: wallet page's discovered tokens — phase 4" },
  "src/lib/priceHistory.ts": { count: 1, why: "render: Performance/Analytics daily closes — phase 4" },
  "src/lib/pricingCoverageQuery.ts": { count: 1, why: "render: Owner's console only" },
  "src/lib/screener/assetView.ts": { count: 1, why: "render: Encyclopedia fundamentals" },
  "src/lib/screener/queries.ts": { count: 1, why: "render: Fundamentals page" },
  "src/lib/screener/pagination.ts": { count: 1, why: "screener jobs' shared pager" },
  "src/lib/screener/derive.ts": { count: 1, why: "screener snapshot cron" },
  "src/lib/adapters/assetPrices.ts": { count: 2, why: "pricing pass (button and crons), not a render" },
  "src/lib/adapters/multicallEvm.ts": { count: 2, why: "wallet sync: the token registry fallback" },
  "src/lib/adapters/assetKeys.ts": { count: 1, why: "mapping tables, cached 5 min per server" },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

test("no new paging loops, and the list only shrinks", () => {
  const found = new Map<string, number>();
  for (const f of sourceFiles("src")) {
    const n = (readFileSync(f, "utf8").match(/\.range\(/g) ?? []).length;
    if (n > 0) found.set(relative(".", f), n);
  }
  for (const [file, n] of found) {
    const allowed = PAGING_ALLOWED[file]?.count ?? 0;
    assert.ok(n <= allowed, `${file} pages a table ${n}× (allowed ${allowed}): read it in one round trip (an RPC) instead, or list a background job here with why`);
  }
  for (const [file, { count }] of Object.entries(PAGING_ALLOWED)) {
    assert.ok((found.get(file) ?? 0) >= count, `${file} now pages ${found.get(file) ?? 0}× — lower its allowance to match`);
  }
});
