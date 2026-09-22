// One-time historical backfill runner for the screener's asset universe.
// Not deployed as a Vercel route — this can run long enough (per-protocol
// history fetches across the whole universe) that a fixed function
// maxDuration isn't the right shape for it; run it locally instead:
//
//   NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/screener-backfill.ts
//
// Safe to re-run: runScreenerBackfill() skips any (asset, date) pair that
// already has a backfilled row (see backfill.ts's own doc comment).
// Requires at least one successful /api/cron/screener-snapshot run first —
// this reads the universe from screener_assets, it doesn't build it.
import { runScreenerBackfill } from "../src/lib/screener/backfill";

async function main() {
  console.log("Starting screener backfill...");
  const result = await runScreenerBackfill();
  console.log(`\nAssets processed: ${result.assetsProcessed}`);
  console.log(`Total rows inserted: ${result.totalRowsInserted}`);
  const errors = result.perAsset.filter((r) => r.error !== null);
  if (errors.length > 0) {
    console.log(`\n${errors.length} asset(s) failed:`);
    for (const r of errors) console.log(`  ${r.geckoId}: ${r.error}`);
  }
  const skipped = result.perAsset.reduce((sum, r) => sum + r.rowsSkippedExisting, 0);
  console.log(`Rows already present (skipped): ${skipped}`);
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
