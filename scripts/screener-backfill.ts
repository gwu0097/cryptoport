// Historical backfill runner for the screener's asset universe (last 365
// days, ending yesterday — see backfill.ts). Not deployed as a Vercel route
// — it can run longer than any function maxDuration; run it locally:
//
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=unused NODE_OPTIONS="--conditions=react-server" \
//     npx tsx --env-file=.env.local scripts/screener-backfill.ts [--assets a,b,c] [--confirm]
//
// (The anon key only needs a placeholder: supabase.ts insists on it at
// import time, and this path never uses the anon client.)
//
// Always prints a plan first — assets to fetch and the CoinGecko calls
// that costs — and refuses to spend more than COINGECKO_BUDGET calls
// without --confirm. A full run on 2026-09-22 exhausted the CoinGecko Demo
// key's 10,000 calls/month cap and took down every CoinGecko-backed
// feature in the app: check month-to-date usage on the CoinGecko developer
// dashboard before confirming a large run.
//
// --assets restricts to those gecko_ids; omit for the whole universe.
// Safe to re-run / resume: assets that already have backfilled rows in the
// window are skipped before any external call.
import { planScreenerBackfill, runScreenerBackfill } from "../src/lib/screener/backfill";

const COINGECKO_BUDGET = 50;

function parseAssets(argv: string[]): string[] | undefined {
  const i = argv.indexOf("--assets");
  if (i === -1) return undefined;
  const ids = (argv[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--assets needs a comma-separated list of gecko_ids");
  return ids;
}

async function main() {
  const argv = process.argv.slice(2);
  const geckoIds = parseAssets(argv);
  const plan = await planScreenerBackfill({ geckoIds });
  console.log(`Plan: ${plan.toFetch.length} assets to fetch (≈${plan.toFetch.length} CoinGecko calls + retries), ${plan.alreadyDone} already done (skipped, no calls).`);
  if (plan.noMembership.length > 0) console.log(`Not in the latest live run, can't backfill: ${plan.noMembership.join(", ")}`);
  if (plan.toFetch.length === 0) return console.log("Nothing to do.");
  if (plan.toFetch.length > COINGECKO_BUDGET && !argv.includes("--confirm")) {
    console.log(`\nThat's over the ${COINGECKO_BUDGET}-call budget. Check month-to-date usage on the CoinGecko developer dashboard (Demo cap: 10,000/month), then re-run with --confirm.`);
    process.exit(2);
  }

  console.log("Starting screener backfill...");
  const result = await runScreenerBackfill({ geckoIds: plan.toFetch });
  console.log(`\nBackfill run: ${result.runId}`);
  console.log(`Assets processed: ${result.assetsProcessed} (skipped as already done: ${result.assetsSkippedDone})`);
  console.log(`Total rows inserted: ${result.totalRowsInserted}`);
  const errors = result.perAsset.filter((r) => r.error !== null);
  if (errors.length > 0) {
    console.log(`\n${errors.length} asset(s) failed:`);
    for (const r of errors) console.log(`  ${r.geckoId}: ${r.error}`);
  }
}

main().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
