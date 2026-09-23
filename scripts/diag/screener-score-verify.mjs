// Read-only. Independent check of a run's stored Phase 3 scores (SPEC rule:
// verify with a different tool than the one that wrote it). Recomputes Score
// B, percentile, grade, tercile, tier and tag for EVERY stored row in plain
// JS from the stored metrics — no import of scores.ts or config.ts; the
// thresholds below are typed in from SPEC's decisions on purpose, so a
// config/code drift shows up as a mismatch. Percentiles here are computed a
// different way (average of 1-based tie ranks, rescaled) than scores.ts's
// counting mid-rank; the two are algebraically equal, so any difference is
// a bug in one of them.
//
//   node scripts/diag/screener-score-verify.mjs [run_id]
import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "cryptoport" } });

let runId = process.argv[2];
if (!runId) {
  const { data } = await db.from("screener_asset_scores").select("run_id, computed_at").order("computed_at", { ascending: false }).limit(1).single();
  runId = data.run_id;
}
const { data: stored, error: e1 } = await db.from("screener_asset_scores").select("*").eq("run_id", runId);
if (e1) throw e1;
const { data: metrics, error: e2 } = await db
  .from("screener_asset_metrics")
  .select("asset_id, mom_3w, mom_12w, rev_90d_change, dilution_rate, screener_assets(ticker)")
  .in("asset_id", stored.map((s) => s.asset_id))
  .eq("run_id", runId);
if (e2) throw e2;
const m = new Map(metrics.map((r) => [r.asset_id, r]));

/** Tie-averaged 1-based rank r among n present values -> (r - 0.5) / n. */
function pctOf(ids, valueOf) {
  const present = ids.filter((id) => valueOf(id) !== null).sort((a, b) => valueOf(a) - valueOf(b));
  const out = new Map();
  for (let i = 0; i < present.length; ) {
    let j = i;
    while (j + 1 < present.length && valueOf(present[j + 1]) === valueOf(present[i])) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) out.set(present[k], (avgRank - 0.5) / present.length);
    i = j + 1;
  }
  return out;
}
// Ranking population = full-history assets (both legs); a one-leg asset's
// values are placed against it: mid-rank among population + itself.
const ids = stored.map((s) => s.asset_id);
const hasBoth = (id) => m.get(id).mom_3w !== null && m.get(id).mom_12w !== null;
const fullIds = ids.filter(hasBoth);
const place = (v, pop) => (pop.filter((x) => x < v).length + 0.5 * (pop.filter((x) => x === v).length + 1)) / (pop.length + 1);
function legPct(field) {
  const own = pctOf(fullIds, (id) => m.get(id)[field]);
  const pop = fullIds.map((id) => m.get(id)[field]);
  return (id) => (m.get(id)[field] === null ? undefined : own.has(id) ? own.get(id) : place(m.get(id)[field], pop));
}
const p3 = legPct("mom_3w");
const p12 = legPct("mom_12w");
const score = new Map(ids.map((id) => {
  const legs = [p3(id), p12(id)].filter((v) => v !== undefined);
  return [id, legs.length ? legs.reduce((a, b) => a + b) / legs.length : null]; // regime modifiers are all 0 (SPEC 2026-09-23)
}));
const fullPctMap = pctOf(fullIds, (id) => score.get(id));
const fullScores = fullIds.map((id) => score.get(id));
const sp = new Map(ids.filter((id) => score.get(id) !== null).map((id) => [id, hasBoth(id) ? fullPctMap.get(id) : place(score.get(id), fullScores)]));
const grade = (p) => (p >= 0.8 ? "A" : p >= 0.6 ? "B" : p >= 0.4 ? "C" : p >= 0.2 ? "D" : "F");
const tier = (r) =>
  (r.dilution_rate !== null && r.dilution_rate > 0.25) || (r.rev_90d_change !== null && r.rev_90d_change < -0.4)
    ? "high_risk"
    : r.dilution_rate !== null && r.dilution_rate > 0.1 ? "caution" : "pass";
const grid = { pass: ["LEADER", "NEUTRAL", "WATCH"], caution: ["SPECULATIVE", "NEUTRAL", "NEUTRAL"], high_risk: ["SPECULATIVE", "NEUTRAL", "AVOID"] };

let mismatches = 0;
const close = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-12);
for (const s of stored) {
  const id = s.asset_id;
  const p = sp.get(id) ?? null;
  const t = tier(m.get(id));
  const graded = hasBoth(id); // insufficient history (one leg) or no legs: no grade/tercile/tag
  const raw = graded ? grade(p) : null;
  const shown = raw === null ? null : t === "high_risk" && "AB".includes(raw) ? "C" : raw;
  const terc = graded ? (p >= 2 / 3 ? 1 : p >= 1 / 3 ? 2 : 3) : null;
  const expect = { timing_score: score.get(id), timing_percentile: p, timing_grade_raw: raw, timing_grade: shown, momentum_tercile: terc, quality_risk_tier: t, setup_tag: terc === null ? null : grid[t][terc - 1] };
  const bad = Object.entries(expect).filter(([k, v]) => (typeof v === "number" || v === null ? !close(s[k], v) && s[k] !== v : s[k] !== v));
  if (bad.length) {
    mismatches++;
    console.log(`MISMATCH ${m.get(id).screener_assets.ticker}: ${bad.map(([k, v]) => `${k} stored ${s[k]} vs ${v}`).join("; ")}`);
  }
}
console.log(`run ${runId}: ${stored.length} stored rows checked independently (${fullIds.length} full history, ${ids.length - fullIds.length} not), ${mismatches} mismatch(es)`);
