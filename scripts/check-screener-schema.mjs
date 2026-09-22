// Pre-push schema preflight: every screener_* table/column db/schema.sql
// declares must exist in the live database. Read-only.
//
//   node scripts/check-screener-schema.mjs     (exit 1 on any gap)
//
// Why: twice on 2026-09-22 code was pushed (i.e. deployed) that wrote to a
// table/column whose additive DDL hadn't been run yet (screener_unmatched
// before step A2; stablecoin_supply_30d_change_pct_prevmonth before part A).
// Neither cost data, but a cron run in the gap would have lost that step's
// output. db/schema.sql is kept in sync with every schema change, so it's the
// source of truth this checks the live DB (PostgREST's OpenAPI description)
// against. Run it after handing over DDL and before `git push`.
import { readFileSync } from "node:fs";

process.loadEnvFile(new URL("../.env.local", import.meta.url).pathname);

const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

/** table -> declared columns, from `create table cryptoport.screener_x (...)` blocks. */
const declared = new Map();
for (const m of sql.matchAll(/create table cryptoport\.(screener_\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = m[2]
    .split("\n")
    .map((l) => l.trim().match(/^([a-z_][a-z0-9_]*)\s+(uuid|text|int|integer|boolean|jsonb|double precision|timestamptz|text\[\]|numeric)/i))
    .filter(Boolean)
    .map((x) => x[1]);
  declared.set(m[1], cols);
}
for (const m of sql.matchAll(/alter table cryptoport\.(screener_\w+)\s+add column\s+([a-z_][a-z0-9_]*)/gi)) {
  declared.get(m[1])?.push(m[2]);
}

const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
  headers: {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Accept-Profile": "cryptoport",
  },
});
if (!res.ok) throw new Error(`OpenAPI fetch failed: HTTP ${res.status}`);
const live = (await res.json()).definitions ?? {};

const gaps = [];
for (const [table, cols] of declared) {
  if (!live[table]) {
    gaps.push(`missing table ${table}`);
    continue;
  }
  for (const c of cols) if (!(c in live[table].properties)) gaps.push(`missing column ${table}.${c}`);
}

console.log(`Checked ${declared.size} screener tables, ${[...declared.values()].reduce((n, c) => n + c.length, 0)} columns declared in db/schema.sql.`);
if (gaps.length > 0) {
  console.log(`\nSCHEMA GAPS — run the pending DDL before pushing:\n  ${gaps.join("\n  ")}`);
  process.exit(1);
}
console.log("OK: live database has every declared screener table and column.");
