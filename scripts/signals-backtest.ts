// Checkpoint B: run all five indicators through the ONE harness
// (src/lib/signals/harness.ts) per docs/signals/PREREG_PULLBACK_INDICATORS.md
// (§4 + Amendment 1). Reads the cached Hyperliquid data from
// scripts/signals-fetch-data.ts; makes no network calls.
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/signals-backtest.ts
//
// Writes ~/cryptoport-archive/signals/results_<stamp>.json (every per-token
// test + the 15 pooled verdicts) and prints the pooled table. Refuses to run
// from uncommitted code under src/ or scripts/ (the results name the commit).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TRIALS = 1000;
const MIN_POOLED_TRADES = 30;
const TFS = [
  { tf: "1H", interval: "1h", barSeconds: 3600 },
  { tf: "4H", interval: "4h", barSeconds: 14400 },
  { tf: "1D", interval: "1d", barSeconds: 86400 },
] as const;
const INDICATORS = ["smc", "rsi2", "bb", "ma", "donchian"] as const;
const SEGMENTS = ["train", "holdout"] as const;

async function main() {
  const { rulesFor } = await import("../src/lib/signals/rules");
  const H = await import("../src/lib/signals/harness");
  const { SIGNALS_UNIVERSE: UNIVERSE } = await import("../src/lib/signals/universe");
  type Candle = import("../src/lib/smc/engine").Candle;
  type CostId = import("../src/lib/signals/harness").CostModelId;
  const costs = H.COST_MODELS.map((m) => m.id) as CostId[];

  const repo = join(__dirname, "..");
  const dirty = execSync("git status --porcelain -- src scripts", { cwd: repo }).toString().trim();
  if (dirty && !process.argv.includes("--allow-dirty")) throw new Error(`commit first — uncommitted changes:\n${dirty}`);
  const commit = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  const base = process.env.SIGNALS_ARCHIVE_DIR ?? join(homedir(), "cryptoport-archive", "signals");
  const dataDir = join(base, "data");
  const manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
  const fetchedSec = Math.floor(Date.parse(manifest.fetchedAt) / 1000);

  type Pool = { returns: Record<CostId, number[]>; trialSums: Record<CostId, { pos: number; neg: number }[]> };
  const newPool = (): Pool => ({
    returns: Object.fromEntries(costs.map((c) => [c, []])) as unknown as Record<CostId, number[]>,
    trialSums: Object.fromEntries(costs.map((c) => [c, Array.from({ length: TRIALS }, () => ({ pos: 0, neg: 0 }))])) as unknown as Pool["trialSums"],
  });
  const pools = new Map<string, Pool>(); // `${ind}|${tf}|${seg}`
  const perToken: Record<string, unknown>[] = [];
  const fullHistory: Record<string, unknown>[] = [];
  let testsRun = 0;
  const pct = (indPf: number, trials: { pos: number; neg: number }[]) =>
    trials.filter((s) => H.profitFactor(s) >= indPf).length / trials.length;
  const ser = (x: number | null) => (x === Infinity ? "Infinity" : x);

  for (const { tf, interval, barSeconds } of TFS) {
    for (const coin of UNIVERSE) {
      const raw = JSON.parse(readFileSync(join(dataDir, `${coin}_${interval}.json`), "utf8")).candles as Candle[];
      // Completed candles only (the last one returned is still forming), and
      // only real venue candles: the leading pre-launch run with n = 0 is imported history (prereg §4).
      const firstReal = raw.findIndex((c) => (c.n ?? 0) > 0);
      const candles = (firstReal === -1 ? [] : raw.slice(firstReal)).filter((c) => c.t + barSeconds <= fetchedSec);
      if (candles.length < 60) continue;
      const funding = H.fundingSummer(JSON.parse(readFileSync(join(dataDir, `${coin}_funding.json`), "utf8")).rows);

      for (const ind of INDICATORS) {
        const rules = rulesFor(ind, candles, tf, fetchedSec);
        const seg = H.segments(rules.warmup, candles.length - 1);
        if (!seg) continue;
        const all = H.simulate(rules, candles, rules.warmup, candles.length - 1, barSeconds);
        fullHistory.push({ ind, tf, coin, trades: all.length, metrics: Object.fromEntries(costs.map((c) => [c, H.metricsOf(H.tradeReturns(all, funding)[c])])) });

        for (const s of SEGMENTS) {
          const [from, to] = seg[s === "train" ? "train" : "holdout"];
          const trades = H.simulate(rules, candles, from, to, barSeconds);
          const returns = H.tradeReturns(trades, funding);
          const key = `${ind}|${tf}|${s}`;
          if (!pools.has(key)) pools.set(key, newPool());
          const pool = pools.get(key)!;
          for (const c of costs) pool.returns[c].push(...returns[c]);
          const holds = trades.map((t) => t.exitPos - t.entryPos);
          const rand = H.rngFor(`${key}|${coin}`);
          const trialSums = Object.fromEntries(costs.map((c) => [c, [] as { pos: number; neg: number }[]])) as unknown as Pool["trialSums"];
          for (let k = 0; k < TRIALS; k++) {
            const rr = holds.length ? H.tradeReturns(H.randomTrades(holds, candles, from, to, barSeconds, rand), funding) : null;
            for (const c of costs) {
              const sums = rr ? H.sumsOf(rr[c]) : { pos: 0, neg: 0 };
              trialSums[c].push(sums);
              pool.trialSums[c][k].pos += sums.pos;
              pool.trialSums[c][k].neg += sums.neg;
            }
          }
          const row: Record<string, unknown> = { ind, tf, coin, segment: s, bars: to - from + 1, from: candles[from].t, to: candles[to].t };
          for (const c of costs) {
            const m = H.metricsOf(returns[c]);
            const indPf = H.profitFactor(m.sums);
            row[c] = {
              trades: m.trades,
              winRate: m.winRate,
              profitFactor: ser(m.profitFactor),
              meanReturn: m.meanReturn,
              pctRandomBeat: m.trades && !Number.isNaN(indPf) ? pct(indPf, trialSums[c]) : null,
            };
          }
          if (trades.length) testsRun++;
          perToken.push(row);
        }
      }
    }
    console.log(`${tf} done`);
  }

  // The 15 pooled verdicts (Amendment 1: the only thing a banner may state).
  const verdicts: Record<string, unknown>[] = [];
  for (const { tf } of TFS) {
    for (const ind of INDICATORS) {
      const seg = (s: string) => pools.get(`${ind}|${tf}|${s}`);
      const summarize = (c: CostId) => {
        const out: Record<string, unknown> = {};
        for (const s of SEGMENTS) {
          const p = seg(s);
          if (!p) continue;
          const m = H.metricsOf(p.returns[c]);
          const pf = H.profitFactor(m.sums);
          out[s] = {
            trades: m.trades,
            winRate: m.winRate,
            profitFactor: ser(m.profitFactor),
            meanReturn: m.meanReturn,
            pctRandomBeat: m.trades && !Number.isNaN(pf) ? pct(pf, p.trialSums[c]) : null,
          };
        }
        return out as Record<"train" | "holdout", { trades: number; profitFactor: number | string | null; pctRandomBeat: number | null }>;
      };
      const verdictFor = (r: ReturnType<typeof summarize>) => {
        if (!r.train || !r.holdout || r.train.trades < MIN_POOLED_TRADES || r.holdout.trades < MIN_POOLED_TRADES) return "insufficient trades";
        return (r.train.pctRandomBeat ?? 1) < 0.05 && (r.holdout.pctRandomBeat ?? 1) < 0.05 ? "beats random" : "does not beat random";
      };
      const byCost = Object.fromEntries(costs.map((c) => [c, summarize(c)])) as Record<CostId, ReturnType<typeof summarize>>;
      const pfNum = (x: unknown) => (x === "Infinity" ? Infinity : (x as number | null));
      const primaryV = verdictFor(byCost.primary);
      const stressV = verdictFor(byCost.stress);
      const hp = pfNum(byCost.primary.holdout?.profitFactor);
      const hs = pfNum(byCost.stress.holdout?.profitFactor);
      verdicts.push({
        ind,
        tf,
        verdict: primaryV,
        stressVerdict: stressV,
        costSensitive: primaryV !== stressV || (hp !== null && hs !== null && hp > 1 !== hs > 1),
        lowPower: tf === "1H",
        holdoutProfitFactor: ser(hp),
        results: byCost,
      });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = {
    prereg: "docs/signals/PREREG_PULLBACK_INDICATORS.md (+ Amendment 1)",
    commit,
    computedAt: new Date().toISOString(),
    dataFetchedAt: manifest.fetchedAt,
    trials: TRIALS,
    costModels: H.COST_MODELS,
    testCounts: { perTokenTestsWithTrades: testsRun, perTokenCells: perToken.length, pooledVerdicts: verdicts.length },
    verdicts,
    perToken,
    fullHistory,
  };
  const file = join(base, `results_${stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`\nresults: ${file}\n`);
  const f = (x: unknown, d = 2) => (x === null || x === undefined ? "—" : x === "Infinity" ? "∞" : typeof x === "number" ? x.toFixed(d) : String(x));
  console.log("ind      tf  | verdict (13bps)       | stress (30bps)        | cost-sens | train n / PF / %rand  | holdout n / PF / %rand");
  for (const v of verdicts as { ind: string; tf: string; verdict: string; stressVerdict: string; costSensitive: boolean; results: Record<string, Record<string, { trades: number; profitFactor: unknown; pctRandomBeat: number | null }>> }[]) {
    const p = v.results.primary;
    console.log(
      `${v.ind.padEnd(8)} ${v.tf.padEnd(3)} | ${v.verdict.padEnd(21)} | ${v.stressVerdict.padEnd(21)} | ${String(v.costSensitive).padEnd(9)} | ` +
        `${p.train?.trades ?? 0} / ${f(p.train?.profitFactor)} / ${f(p.train?.pctRandomBeat === null || p.train?.pctRandomBeat === undefined ? null : p.train.pctRandomBeat * 100, 1)}%  | ` +
        `${p.holdout?.trades ?? 0} / ${f(p.holdout?.profitFactor)} / ${f(p.holdout?.pctRandomBeat === null || p.holdout?.pctRandomBeat === undefined ? null : p.holdout.pctRandomBeat * 100, 1)}%`,
    );
  }
  console.log(`\ntests: ${testsRun} per-token (indicator × timeframe × token × segment) with trades, of ${perToken.length} cells; ${verdicts.length} pooled verdicts`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
