// Read-only. Verifies a DEGRADED live run end to end, through the real code
// paths (not re-implementations): the run's flag/notes/provenance, its rows,
// the unmatched log left untouched, nothing rated, and — the subtle half of
// the same-day preference — that a complete run of the same UTC day still
// wins both run selection (runSelection.ts, what /screener uses) AND the
// history reader (derive.ts loadHistoryReadings + history.ts dailyReadings,
// what momentum/revenue/dilution windows use), and that the gap detector's
// query counts the day as covered.
//
//   NODE_OPTIONS="--conditions=react-server" ~/.npm/_npx/<hash>/node_modules/.bin/tsx scripts/diag/screener-degraded-verify.ts <degraded_run_id>
process.loadEnvFile(`${__dirname}/../../.env.local`);

async function main() {
  const { serviceDb } = await import("../../src/lib/supabase");
  const { loadHistoryReadings } = await import("../../src/lib/screener/derive");
  const { dailyReadings } = await import("../../src/lib/screener/history");
  const { pickRunPerUtcDay, latestDailyRun, findGapDates } = await import("../../src/lib/screener/runSelection");
  const db = serviceDb();
  const runId = process.argv[2];
  const check = (ok: boolean, what: string) => console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);

  const { data: run } = await db.from("screener_runs").select("*").eq("id", runId).single();
  const day = (run.started_at as string).slice(0, 10);
  check(run.degraded === true && run.status === "ok", `run flagged degraded, status ok (degraded=${run.degraded}, status=${run.status})`);
  console.log("      notes.degradation:", JSON.stringify(run.notes.degradation));
  check(run.provenance.fields.price_usd.source === "defillama" && /not fetched/.test(run.provenance.fields.market_cap_usd.source), "provenance: price from DefiLlama, market cap 'not fetched'");
  check(/defillama/.test(run.notes.reference_prices?.bitcoin?.source ?? ""), `BTC reference from the same DefiLlama response (${run.notes.reference_prices?.bitcoin?.price_usd})`);

  const count = async (q: (b: ReturnType<typeof db.from>) => unknown) => (await (q(db.from("screener_asset_snapshots")) as Promise<{ count: number }>)).count;
  const rows = await count((t) => t.select("*", { count: "exact", head: true }).eq("run_id", runId));
  const mcap = await count((t) => t.select("*", { count: "exact", head: true }).eq("run_id", runId).not("market_cap_usd", "is", null));
  const supply = await count((t) => t.select("*", { count: "exact", head: true }).eq("run_id", runId).not("circulating_supply", "is", null));
  const priced = await count((t) => t.select("*", { count: "exact", head: true }).eq("run_id", runId).not("price_usd", "is", null));
  const fees = await count((t) => t.select("*", { count: "exact", head: true }).eq("run_id", runId).not("fees_30d", "is", null));
  check(rows > 0 && mcap === 0 && supply === 0, `rows written ${rows}; market cap non-null ${mcap}, supply non-null ${supply} (must be 0)`);
  console.log(`      price non-null ${priced}/${rows}, fees_30d non-null ${fees}/${rows}`);

  const { count: rated } = await db.from("screener_asset_metrics").select("*", { count: "exact", head: true }).eq("run_id", runId).eq("rated", true);
  const { count: scored } = await db.from("screener_asset_scores").select("*", { count: "exact", head: true }).eq("run_id", runId);
  check(rated === 0 && scored === 0, `nothing rated (${rated}) or scored (${scored})`);
  const uc = run.notes.unmatched_changes;
  const { count: cgOpenedByRun } = await db.from("screener_unmatched").select("*", { count: "exact", head: true }).eq("first_seen_run_id", runId).eq("kind", "no_coingecko_market_data");
  const { count: cgResolvedByRun } = await db.from("screener_unmatched").select("*", { count: "exact", head: true }).eq("resolved_run_id", runId).eq("kind", "no_coingecko_market_data");
  check(cgOpenedByRun === 0 && cgResolvedByRun === 0, `no CoinGecko-kind unmatched intervals opened (${cgOpenedByRun}) or resolved (${cgResolvedByRun}) by this run; run's own diff: ${JSON.stringify(uc)}`);

  // Run selection — what /screener uses.
  const { data: runs } = await db.from("screener_runs").select("id, started_at, status, kind, degraded").eq("kind", "live").order("started_at", { ascending: false }).limit(30);
  const todays = (runs ?? []).filter((r) => (r.started_at as string).startsWith(day));
  const latestByTime = todays.filter((r) => r.status === "ok").sort((a, b) => (b.started_at as string).localeCompare(a.started_at as string))[0];
  const picked = pickRunPerUtcDay(runs ?? []).get(day)!;
  check(latestByTime.id === runId && picked.id !== runId && !picked.degraded, `run selection: the degraded run is the day's LATEST (${latestByTime.id === runId}), yet the complete ${picked.id} wins; latestDailyRun = ${latestDailyRun(runs ?? [])!.id}`);

  // History reader — what the momentum/revenue/dilution windows use. Read as
  // a later run would (asOf = now, after the degraded run).
  const { rows: history } = await loadHistoryReadings(new Date().toISOString());
  const byAsset = new Map<string, typeof history>();
  for (const h of history) byAsset.set(h.asset_id, [...(byAsset.get(h.asset_id) ?? []), h]);
  let assetsWithBoth = 0, pickedComplete = 0, pickedDegraded = 0, degradedOnly = 0, wouldHaveBeenDegraded = 0;
  const flagged = history.filter((h) => h.run_id === runId);
  for (const readings of byAsset.values()) {
    const today = readings.filter((r) => r.observed_at.startsWith(day) && !r.is_backfilled);
    const hasDeg = today.some((r) => r.run_id === runId);
    const hasComplete = today.some((r) => r.run_id !== runId);
    if (!hasDeg) continue;
    if (!hasComplete) { degradedOnly++; continue; }
    assetsWithBoth++;
    const chosen = dailyReadings(readings, new Date().toISOString()).get(day)!;
    if (chosen.run_id === runId) pickedDegraded++; else pickedComplete++;
    // Counterfactual: the old rule (latest reading wins) — proves the test bites.
    const latest = today.sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
    if (latest.run_id === runId) wouldHaveBeenDegraded++;
  }
  check(flagged.length > 0 && flagged.every((h) => h.degraded === true), `history loader marks all ${flagged.length} of this run's readings degraded`);
  check(assetsWithBoth > 0 && pickedDegraded === 0, `history: of ${assetsWithBoth} assets with both a complete and a degraded reading on ${day}, the complete one is chosen for ${pickedComplete}, the degraded for ${pickedDegraded}`);
  console.log(`      (counterfactual: under plain latest-wins the degraded reading would have been chosen for ${wouldHaveBeenDegraded}; ${degradedOnly} assets have only the degraded reading that day)`);

  // Gap detection — the snapshot job's own query + findGapDates.
  const since = new Date(); since.setUTCDate(since.getUTCDate() - 14);
  const { data: okRuns } = await db.from("screener_runs").select("id, started_at, status, kind, degraded").gte("started_at", since.toISOString()).eq("kind", "live").eq("status", "ok");
  check((okRuns ?? []).some((r) => r.id === runId), "the gap detector's query (live, status ok) returns the degraded run");
  const onlyDegraded = (okRuns ?? []).filter((r) => r.id === runId);
  const tomorrow = new Date(`${day}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  check(!findGapDates(onlyDegraded, tomorrow, 3).includes(day), `with ONLY the degraded run in the log, ${day} is not a gap the next day`);
}
main().catch((e) => { console.error(e); process.exit(1); });
export {}; // a module, not a global script (diag scripts declare main)
