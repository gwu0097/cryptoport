// WRITES (derived rows only). Scores an existing live run with the local
// code — computeRunScores, the exact function the cron calls — replacing
// that run's screener_asset_scores rows. Use to verify a scoring change on
// real data without triggering a new snapshot. It scores the run's STORED
// rated set: a scope change in config takes effect from the next run's
// metrics, not retroactively.
//
//   NODE_OPTIONS="--conditions=react-server" ~/.npm/_npx/<hash>/node_modules/.bin/tsx scripts/diag/screener-score-run.ts [run_id]
// (tsx isn't a project dependency; any cached copy works — plain `node`
// can't resolve the "@/..." import alias derive.ts uses.) Note it scores
// the run's STORED rated set, so it won't match a preview that applied a
// newer scopeOverrides — for an end-to-end check, run a fresh live snapshot.
process.loadEnvFile(`${__dirname}/../../.env.local`);
// Env is loaded before the imports below run (dynamic import): the
// Supabase module reads process.env at load time.
// tsx compiles this package's .ts as CommonJS (no top-level await).
async function main() {
  const { ensureConfigVersion, computeRunScores } = await import("../../src/lib/screener/derive");
  const { serviceDb } = await import("../../src/lib/supabase");

  const db = serviceDb();
  let runId = process.argv[2];
  if (!runId) {
    const { data } = await db.from("screener_runs").select("id").eq("kind", "live").eq("status", "ok").order("started_at", { ascending: false }).limit(1).single();
    runId = data!.id as string;
  }
  const { data: regime } = await db.from("screener_regime_snapshots").select("label").eq("run_id", runId).maybeSingle();
  const configVersionId = await ensureConfigVersion();
  const t0 = Date.now();
  const out = await computeRunScores(runId, configVersionId, (regime?.label ?? null) as never);
  console.log(JSON.stringify({ runId, configVersionId, regime: regime?.label ?? null, ...out, ms: Date.now() - t0 }, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {}; // a module, not a global script (both diag scripts declare main)
