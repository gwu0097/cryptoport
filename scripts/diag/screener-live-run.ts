// WRITES a real live run: one snapshot + every derivation step, with the
// LOCAL code — the same two functions the cron route calls. Recorded with
// trigger "unknown" (no Vercel cron header), so it's distinguishable from a
// scheduled run. Use to verify a change end to end before pushing; it adds
// a same-day live run (see BACKLOG: consumers pick one run per UTC day).
//
//   NODE_OPTIONS="--conditions=react-server" ~/.npm/_npx/<hash>/node_modules/.bin/tsx scripts/diag/screener-live-run.ts [--force-degraded]
//
// --force-degraded: take the CoinGecko-unavailable path without calling
// CoinGecko (the run is flagged degraded, market cap/supply/volume null).
process.loadEnvFile(`${__dirname}/../../.env.local`);
// Env is loaded before the imports below run (dynamic import): the
// Supabase module reads process.env at load time.
// tsx compiles this package's .ts as CommonJS (no top-level await).
async function main() {
  const { runScreenerSnapshot } = await import("../../src/lib/screener/snapshot");
  const { runScreenerDerivations } = await import("../../src/lib/screener/derive");

  const t0 = Date.now();
  const forced = process.argv.includes("--force-degraded");
  const snap = await runScreenerSnapshot(undefined, forced ? { forceDegraded: "forced by scripts/diag/screener-live-run.ts --force-degraded (test of the degraded path)" } : {});
  const t1 = Date.now();
  console.log("snapshot:", JSON.stringify({ ...snap, gapDates: snap.gapDates.length }), `${((t1 - t0) / 1000).toFixed(1)}s`);
  const derivations = await runScreenerDerivations(snap.runId);
  console.log("derivations:", JSON.stringify(derivations, null, 2), `${((Date.now() - t1) / 1000).toFixed(1)}s`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {}; // a module, not a global script (both diag scripts declare main)
