// Read-only. Every value that differs between two recorded screener config
// versions (screener_scoring_config_versions), by JSON path. Ids can be
// given as a unique prefix.
//
//   node scripts/diag/screener-config-diff.mjs <older_version_id> <newer_version_id>
import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "cryptoport" } });

const prefixes = process.argv.slice(2);
if (prefixes.length !== 2) throw new Error("usage: screener-config-diff.mjs <older_version_id> <newer_version_id>");
const { data, error } = await db.from("screener_scoring_config_versions").select("id, created_at, config");
if (error) throw error;
const [a, b] = prefixes.map((p) => {
  const hits = data.filter((d) => d.id.startsWith(p));
  if (hits.length !== 1) throw new Error(`"${p}" matches ${hits.length} config versions`);
  return hits[0];
});
const walk = (x, y, path = "") => {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${path}.${k}`);
  } else console.log(path, JSON.stringify(x), "->", JSON.stringify(y));
};
console.log(`${a.id} (${a.created_at}) -> ${b.id} (${b.created_at})`);
walk(a.config, b.config);
