// Historical backfill runner for the screener's asset universe (last 365
// days only — see BACKFILL_DAYS in backfill.ts). Not deployed as a Vercel
// route — it can run longer than any function maxDuration; run it locally:
//
//   NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/screener-backfill.ts [--assets uniswap,hyperliquid,...]
//
// --assets restricts to those gecko_ids (the validation run); omit for the
// whole universe. Safe to re-run: an (asset, date) pair that already has a
// backfilled row is skipped. Requires at least one successful live
// /api/cron/screener-snapshot run written by the lean-provenance code
// (it reads each asset's contributing_slugs from that run).
import { runScreenerBackfill } from "../src/lib/screener/backfill";

function parseAssets(argv: string[]): string[] | undefined {
  const i = argv.indexOf("--assets");
  if (i === -1) return undefined;
  const ids = (argv[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--assets needs a comma-separated list of gecko_ids");
  return ids;
}

async function main() {
  const geckoIds = parseAssets(process.argv.slice(2));
  console.log(`Starting screener backfill (${geckoIds ? `${geckoIds.length} assets` : "whole universe"})...`);
  const result = await runScreenerBackfill({ geckoIds });
  console.log(`\nBackfill run: ${result.runId}`);
  console.log(`Assets processed: ${result.assetsProcessed}`);
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
