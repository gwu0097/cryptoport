// Read-only. One live screener run's full report: notes (trigger, derivations,
// plausibility warnings), its regime row, and metric/score/snapshot counts.
//
//   node scripts/diag/screener-run-report.mjs            # latest live run
//   node scripts/diag/screener-run-report.mjs <run_id>
//   node scripts/diag/screener-run-report.mjs --since 2026-09-23T00:00:00Z   # every live run since
import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "cryptoport" } });

const SELECT = "id, kind, started_at, finished_at, status, universe_size, matched_count, unmatched_count, notes";
const argv = process.argv.slice(2);
let runs;
if (argv[0] === "--since") {
  ({ data: runs } = await db.from("screener_runs").select(SELECT).eq("kind", "live").gte("started_at", argv[1]).order("started_at"));
} else if (argv[0]) {
  ({ data: runs } = await db.from("screener_runs").select(SELECT).eq("id", argv[0]));
} else {
  ({ data: runs } = await db.from("screener_runs").select(SELECT).eq("kind", "live").order("started_at", { ascending: false }).limit(1));
}

const count = async (table, runId, rated) => {
  let q = db.from(table).select("*", { count: "exact", head: true }).eq("run_id", runId);
  if (rated !== undefined) q = q.eq("rated", rated);
  const { count: n, error } = await q;
  return error ? `n/a (${error.message})` : n;
};

for (const r of runs ?? []) {
  console.log(`=== RUN ${r.id} ${r.kind} ${r.status} started ${r.started_at} finished ${r.finished_at}`);
  console.log(`universe ${r.universe_size} matched ${r.matched_count} unmatched ${r.unmatched_count}`);
  console.log("notes:", JSON.stringify(r.notes, null, 2));
  const { data: regime } = await db.from("screener_regime_snapshots").select("*").eq("run_id", r.id).maybeSingle();
  console.log("regime:", JSON.stringify(regime, null, 2));
  console.log(
    `snapshots ${await count("screener_asset_snapshots", r.id)} | metrics ${await count("screener_asset_metrics", r.id)}` +
      ` (rated ${await count("screener_asset_metrics", r.id, true)}) | scores ${await count("screener_asset_scores", r.id)}`,
  );
}
