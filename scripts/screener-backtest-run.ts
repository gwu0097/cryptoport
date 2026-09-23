// Phase 4b: the backtest tests, on the 4a panels. Definitions: the
// "Definitions" section of docs/screener/PHASE_4_PLAN.md — implemented in
// src/lib/screener/backtestStats.ts (pure, tested).
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/screener-backtest-run.ts
//
// Order is the point (requirement A): a screener_backtest_runs row is
// inserted with the prediction (read verbatim from PHASE_4.md) and status
// 'running' BEFORE anything is computed, then updated with the results. It
// refuses to run from uncommitted code, so code_commit names exactly what ran.
// Windows are computed and stored SEPARATELY — nothing is pooled across them.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.loadEnvFile(`${__dirname}/../.env.local`);

const WINDOWS = ["1y", "2y", "3y"] as const;
const FACTORS: Record<string, { col: string; sign: 1 | -1; label: string }> = {
  score_b: { col: "timing_score", sign: 1, label: "Score B (timing_score)" },
  mom_3w: { col: "mom_3w", sign: 1, label: "mom_3w" },
  mom_12w: { col: "mom_12w", sign: 1, label: "mom_12w" },
  beta_btc: { col: "beta_btc", sign: 1, label: "beta_btc (no expected sign)" },
  cheap_ps: { col: "ps_circ", sign: -1, label: "−ps_circ (cheapness)" },
  cheap_pf: { col: "pf_circ", sign: -1, label: "−pf_circ (cheapness)" },
  low_dilution_implied: { col: "dilution_rate_implied", sign: -1, label: "−dilution_rate_implied (proxy)" },
};
const FACTORS_BY_WINDOW: Record<string, string[]> = {
  "1y": Object.keys(FACTORS),
  "2y": ["score_b", "mom_3w", "mom_12w", "beta_btc"],
  "3y": ["score_b", "mom_3w", "mom_12w", "beta_btc"],
};
const MIN_N = 10;

type Row = Record<string, unknown> & { date: string; gecko_id: string; rated: boolean; in_90d_set: boolean };

async function main() {
  const { averageRanks, spearman, summarize, tercileSpread, olsResiduals, heldBackThird } = await import("../src/lib/screener/backtestStats");
  const { ensureConfigVersion } = await import("../src/lib/screener/derive");
  const { serviceDb } = await import("../src/lib/supabase");
  const { parquetReadObjects, asyncBufferFromFile } = await import("hyparquet/src/node.js");

  const repo = join(__dirname, "..");
  const dirty = execSync("git status --porcelain -- src scripts", { cwd: repo }).toString().trim();
  if (dirty && !process.argv.includes("--allow-dirty")) throw new Error(`uncommitted changes under src/ or scripts/ — commit first so code_commit is exact:\n${dirty}`);
  const codeCommit = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  const phase4 = readFileSync(join(repo, "docs/screener/PHASE_4.md"), "utf8");
  const prediction = phase4.slice(phase4.indexOf("## Prediction"), phase4.indexOf("\n---\n")).trim();
  if (!prediction.startsWith("## Prediction")) throw new Error("prediction section not found in PHASE_4.md");

  const dir = join(process.env.SCREENER_ARCHIVE_DIR ?? join(homedir(), "cryptoport-archive", "screener"), "backtest");
  const coverage = Object.fromEntries(WINDOWS.map((w) => [w, JSON.parse(readFileSync(join(dir, `coverage_${w}.json`), "utf8"))]));
  const survivorship = JSON.parse(readFileSync(join(dir, "survivorship_by_window.json"), "utf8"));

  // 1. The row goes in FIRST, with the prediction, before any number exists.
  const db = serviceDb();
  const configVersionId = await ensureConfigVersion();
  const { data: inserted, error: insertError } = await db
    .from("screener_backtest_runs")
    .insert({
      config_version_id: configVersionId,
      code_commit: codeCommit,
      prediction,
      params: {
        definitions: "docs/screener/PHASE_4_PLAN.md#definitions",
        windows: WINDOWS,
        horizons: { primary: 30, descriptive: 90 },
        factors: Object.fromEntries(WINDOWS.map((w) => [w, FACTORS_BY_WINDOW[w].map((f) => FACTORS[f].label)])),
        min_population: MIN_N,
        panels: Object.fromEntries(WINDOWS.map((w) => [w, { content_sha256: coverage[w].panel_content_sha256, rows: coverage[w].rows }])),
        pooling: "none — each window is separate evidence",
      },
      status: "running",
    })
    .select("id, created_at")
    .single();
  if (insertError) throw new Error(`insert failed: ${insertError.message}`);
  const runId = inserted.id as string;
  console.log(`backtest run ${runId} inserted at ${inserted.created_at} with its prediction; computing now`);

  try {
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const results: Record<string, unknown> = {};
    for (const w of WINDOWS) {
      const rows = (await parquetReadObjects({ file: await asyncBufferFromFile(join(dir, `panel_${w}.parquet`)) })) as Row[];
      const byDate = new Map<string, Row[]>();
      for (const r of rows) {
        if (!byDate.has(r.date)) byDate.set(r.date, []);
        byDate.get(r.date)!.push(r);
      }
      const windowOut: Record<string, unknown> = { population_rule: coverage[w].population_rule };
      for (const h of [30, 90] as const) {
        const fwdCol = h === 30 ? "fwd30_btc" : "fwd90_btc";
        const ewCol = h === 30 ? "fwd30_ew" : "fwd90_ew";
        const dates = [...byDate.keys()].filter((d) => h === 30 || byDate.get(d)!.some((r) => r.in_90d_set)).sort();
        const hOut: Record<string, unknown> = {};
        for (const f of FACTORS_BY_WINDOW[w]) {
          const { col, sign } = FACTORS[f];
          const perPeriod: { date: string; n: number; ic: number | null; spread: number | null; ic_ew: number | null }[] = [];
          let skipped = 0;
          for (const d of dates) {
            const pop = byDate.get(d)!.filter((r) => r.rated && num(r[col]) !== null && num(r[fwdCol]) !== null);
            if (pop.length < MIN_N) {
              skipped++;
              continue;
            }
            const fv = pop.map((r) => sign * num(r[col])!);
            const ret = pop.map((r) => num(r[fwdCol])!);
            const ewPop = pop.filter((r) => num(r[ewCol]) !== null);
            perPeriod.push({
              date: d,
              n: pop.length,
              ic: spearman(fv, ret),
              spread: tercileSpread(pop.map((r, i) => ({ id: r.gecko_id, factor: fv[i], ret: ret[i] }))),
              ic_ew: ewPop.length >= MIN_N ? spearman(ewPop.map((r) => sign * num(r[col])!), ewPop.map((r) => num(r[ewCol])!)) : null,
            });
          }
          const ics = perPeriod.map((p) => p.ic).filter((v): v is number => v !== null);
          const factorOut: Record<string, unknown> = {
            per_period: perPeriod,
            skipped_periods: skipped,
            ic_summary: summarize(ics),
            spread_summary: summarize(perPeriod.map((p) => p.spread).filter((v): v is number => v !== null)),
            ic_vs_ew_basket_summary: summarize(perPeriod.map((p) => p.ic_ew).filter((v): v is number => v !== null)),
          };
          if (h === 30) factorOut.holdout = heldBackThird(perPeriod.filter((p) => p.ic !== null).map((p) => ({ date: p.date, ic: p.ic! })));
          // Controls (1y only — size needs market cap): the factor's rank
          // regressed on the ranks of size and Score B (Score B: size only).
          if (w === "1y" && h === 30) {
            const resid: number[] = [];
            for (const d of dates) {
              const pop = byDate
                .get(d)!
                .filter((r) => r.rated && [col, "size_log_mcap", "timing_score", fwdCol].every((c) => num(r[c]) !== null));
              if (pop.length < MIN_N) continue;
              const fr = averageRanks(pop.map((r) => sign * num(r[col])!));
              const controls = [averageRanks(pop.map((r) => num(r.size_log_mcap)!))];
              if (f !== "score_b") controls.push(averageRanks(pop.map((r) => num(r.timing_score)!)));
              const ic = spearman(olsResiduals(fr, controls), pop.map((r) => num(r[fwdCol])!));
              if (ic !== null) resid.push(ic);
            }
            factorOut.residual_ic_summary = summarize(resid);
            factorOut.controls = f === "score_b" ? ["size"] : ["size", "Score B"];
          }
          hOut[f] = factorOut;
        }
        // Setup-tag test (1y, where tags come from the production rated universe).
        if (w === "1y") {
          const perPeriod = dates.map((d) => {
            const pop = byDate.get(d)!.filter((r) => r.rated && r.setup_tag && num(r[fwdCol]) !== null);
            const mean = (xs: Row[]) => (xs.length ? xs.reduce((a, r) => a + num(r[fwdCol])!, 0) / xs.length : null);
            const passTop = pop.filter((r) => r.setup_tag === "LEADER" || r.setup_tag === "WATCH");
            const spec = pop.filter((r) => r.setup_tag === "SPECULATIVE");
            const byTag = Object.fromEntries(
              ["LEADER", "NEUTRAL", "WATCH", "SPECULATIVE", "AVOID"].map((t) => {
                const g = pop.filter((r) => r.setup_tag === t);
                return [t, { n: g.length, mean_fwd: mean(g) }];
              }),
            );
            const a = mean(passTop);
            const b = mean(spec);
            return { date: d, by_tag: byTag, leader_watch_minus_speculative: a !== null && b !== null ? a - b : null, n_speculative: spec.length };
          });
          hOut.setup_tags = {
            per_period: perPeriod,
            leader_watch_minus_speculative_summary: summarize(perPeriod.map((p) => p.leader_watch_minus_speculative).filter((v): v is number => v !== null)),
          };
        }
        windowOut[`h${h}`] = hOut;
      }
      results[w] = windowOut;
    }

    const out = {
      run_id: runId,
      code_commit: codeCommit,
      config_version_id: configVersionId,
      computed_at: new Date().toISOString(),
      windows: results,
    };
    const coverageOut = Object.fromEntries(
      WINDOWS.map((w) => [
        w,
        {
          population_rule: coverage[w].population_rule,
          formation_dates_30d: coverage[w].formation_dates_30d,
          formation_dates_90d: coverage[w].formation_dates_90d,
          per_date: (coverage[w].per_date as { date: string; rated: number; rated_both_legs: number }[]).map((p) => ({ date: p.date, tested: p.rated, both_legs: p.rated_both_legs })),
        },
      ]),
    );
    writeFileSync(join(dir, `results_${runId}.json`), JSON.stringify(out, null, 2));
    const { error: updateError } = await db
      .from("screener_backtest_runs")
      .update({ status: "ok", finished_at: new Date().toISOString(), results: out, coverage: { ...coverageOut, survivorship: survivorship.counts ?? survivorship.summary } })
      .eq("id", runId);
    if (updateError) throw new Error(`update failed: ${updateError.message}`);
    console.log(`results written: ${join(dir, `results_${runId}.json`)}`);
  } catch (e) {
    await db.from("screener_backtest_runs").update({ status: "error", finished_at: new Date().toISOString(), notes: (e as Error).message }).eq("id", runId);
    throw e;
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {}; // a module, not a global script
