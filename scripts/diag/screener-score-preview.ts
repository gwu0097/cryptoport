// Read-only dry run of Phase 3 scoring on an existing run's stored metrics —
// no writes (usable before screener_asset_scores exists). Applies the
// CURRENT config's scopeOverrides to the stored rated set, since a run's
// metrics were rated under the config of their day.
//
//   node scripts/diag/screener-score-preview.ts [run_id]      (Node strips the types itself)
import { createClient } from "@supabase/supabase-js";
import { SCREENER_CONFIG } from "../../src/lib/screener/config.ts";
import { scoreRun, type ScoreInput } from "../../src/lib/screener/scores.ts";
import type { RegimeLabel } from "../../src/lib/screener/regime.ts";

process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { db: { schema: "cryptoport" } });

let runId = process.argv[2];
if (!runId) {
  const { data } = await db.from("screener_runs").select("id").eq("kind", "live").eq("status", "ok").order("started_at", { ascending: false }).limit(1).single();
  runId = data!.id;
}
const { data: metrics, error } = await db
  .from("screener_asset_metrics")
  .select("asset_id, mom_3w, mom_12w, beta_btc, rev_90d_change, dilution_rate, sector_bucket, screener_assets(gecko_id, ticker)")
  .eq("run_id", runId)
  .eq("rated", true);
if (error) throw error;
const overrides = Object.keys(SCREENER_CONFIG.scopeOverrides);
type M = { asset_id: string; mom_3w: number | null; mom_12w: number | null; beta_btc: number | null; rev_90d_change: number | null; dilution_rate: number | null; sector_bucket: string; screener_assets: { gecko_id: string; ticker: string } };
const rated = (metrics as unknown as M[]).filter((m) => !overrides.includes(m.screener_assets.gecko_id));
const ids = rated.map((m) => m.asset_id);
const { data: snaps } = await db.from("screener_asset_snapshots").select("asset_id, market_cap_usd").eq("run_id", runId).eq("is_backfilled", false).in("asset_id", ids);
const { data: conflicts } = await db.from("screener_field_conflicts").select("asset_id").eq("run_id", runId).in("field_name", ["price_usd", "market_cap_usd"]).in("asset_id", ids);
const { data: regime } = await db.from("screener_regime_snapshots").select("label").eq("run_id", runId).maybeSingle();
const mcap = new Map((snaps ?? []).map((s) => [s.asset_id, s.market_cap_usd]));
const conflicted = new Set((conflicts ?? []).map((c) => c.asset_id));

const inputs: ScoreInput[] = rated.map((m) => ({
  asset_id: m.asset_id, mom_3w: m.mom_3w, mom_12w: m.mom_12w, beta_btc: m.beta_btc, rev_90d_change: m.rev_90d_change,
  dilution_rate: m.dilution_rate, unlocks_90d_pct_circulating: null, market_cap_usd: mcap.get(m.asset_id) ?? null,
  has_source_conflict: conflicted.has(m.asset_id),
}));
const { scores, ...summary } = scoreRun(inputs, (regime?.label ?? null) as RegimeLabel | null);
const byId = new Map(rated.map((m) => [m.asset_id, m]));
console.log(`run ${runId} | regime ${regime?.label} | rated ${metrics!.length} -> ${rated.length} after scopeOverrides (${overrides.join(", ")})`);
console.log(JSON.stringify(summary, null, 2));
const pct = (v: number | null) => (v === null ? "   —  " : `${(v * 100).toFixed(1).padStart(5)}%`);
for (const s of [...scores].sort((a, b) => (b.timing_score ?? -1) - (a.timing_score ?? -1))) {
  const m = byId.get(s.asset_id)!;
  console.log(
    `${m.screener_assets.ticker.toUpperCase().padEnd(8)} ${String(s.setup_tag).padEnd(11)} grade ${s.timing_grade ?? "—"}${s.timing_grade !== s.timing_grade_raw ? `(raw ${s.timing_grade_raw})` : "       "} ` +
      `tier ${s.quality_risk_tier.padEnd(9)} rules ${s.rules_evaluable}/4 conf ${s.confidence.padEnd(6)} size ${String(s.size_bucket).padEnd(5)} ` +
      `score ${s.timing_score?.toFixed(3) ?? "  —  "} mom3w ${pct(m.mom_3w)} mom12w ${pct(m.mom_12w)} ${m.sector_bucket}`,
  );
}
