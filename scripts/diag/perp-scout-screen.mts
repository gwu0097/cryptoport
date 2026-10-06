// Read-only: Perp Scout's trader screen (docs/perp-scout/PLAN.md), run from
// chat to pick traders for src/lib/perpScout/followed.ts. Reads the
// Hyperliquid leaderboard (one file, no rate-limit weight) and each reviewed
// account's perps record (info `portfolio`, weight 20, ~1.2 s apart so it
// stays under the IP's 1,200 a minute), then prints the passers ranked by
// yearly return ÷ drawdown and how many failed each rule. Free, keyless; no
// database.
//
//   (in the cloud sandbox: NODE_USE_ENV_PROXY=1, so fetch uses the egress proxy)
//   node scripts/diag/perp-scout-screen.mts [--review 70] [--top 25] [--json out.json]
//        [--address 0xabc… ...]   (check given addresses instead of the leaderboard)
//        [--swing]   (also read each passer's latest fills — userFills, weight
//                    up to 120, ~7 s apart — for how often it adjusts and how
//                    long it holds, swing.ts; passers that aren't swing
//                    traders are dropped; ranked by 12-month %)
import { writeFileSync } from "node:fs";
import { parseLeaderboard, passesStage1, looksPromising, pickForReview, stage3Failures, traderScore, STAGE3_REASON_LABEL, type LeaderboardRow, type Stage3Reason } from "../../src/lib/perpScout/screen.ts";
import { parsePortfolio, traderStats, type TraderStats } from "../../src/lib/perpScout/portfolio.ts";
import { parseFills } from "../../src/lib/perpScout/entries.ts";
import { swingStats, swingFailures, type SwingStats } from "../../src/lib/perpScout/swing.ts";

const INFO_URL = "https://api.hyperliquid.xyz/info";
const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const SPACING_MS = 1_200;

const arg = (name: string, fallback: string | null = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const addresses = process.argv.flatMap((a, i) => (process.argv[i - 1] === "--address" ? [a.toLowerCase()] : []));
const reviewN = Number(arg("review", "70"));
const topN = Number(arg("top", "25"));
const jsonOut = arg("json");
const swing = process.argv.includes("--swing");
/** userFills weighs up to 20 + 100 for 2,000 fills: ~7 s apart stays under 1,200 a minute. */
const FILLS_SPACING_MS = 7_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt < 3) {
      await sleep(5_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

const usd = (x: number | null) => (x === null ? "—" : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(0)}K`);
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);

async function main() {
  let review: (LeaderboardRow | { address: string; displayName: null; accountValue: null; allTime: null; month: null })[];
  if (addresses.length) {
    review = addresses.map((address) => ({ address, displayName: null, accountValue: null, allTime: null, month: null }));
  } else {
    const res = await fetch(LEADERBOARD_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);
    const board = parseLeaderboard(await res.json());
    const stage1 = board.filter(passesStage1);
    const promising = stage1.filter(looksPromising);
    review = pickForReview(promising, reviewN);
    console.error(`leaderboard ${board.length} · stage 1 ${stage1.length} · stage 1b ${promising.length} · reviewing ${review.length}`);
  }

  const now = Date.now();
  const rejected: Partial<Record<Stage3Reason, number>> = {};
  const rows: { address: string; name: string | null; equity: number | null; allTimePnl: number | null; monthPnl: number | null; stats: TraderStats; score: number | null; failures: Stage3Reason[]; swing?: SwingStats; swingFails?: string[] }[] = [];
  let failed = 0;
  for (const [i, r] of review.entries()) {
    if (i > 0) await sleep(SPACING_MS);
    try {
      const stats = traderStats(parsePortfolio(await post({ type: "portfolio", user: r.address })), now);
      const failures = stage3Failures(stats);
      for (const f of failures) rejected[f] = (rejected[f] ?? 0) + 1;
      rows.push({ address: r.address, name: r.displayName, equity: r.accountValue, allTimePnl: r.allTime?.pnl ?? stats.totalPnl, monthPnl: r.month?.pnl ?? stats.monthPnl, stats, score: traderScore(stats), failures });
    } catch (e) {
      failed++;
      console.error(`${r.address}: ${(e as Error).message}`);
    }
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${review.length}`);
  }

  let passed = rows.filter((r) => r.failures.length === 0 && r.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const yearPct = (r: (typeof rows)[number]) => (r.stats.typicalEquity ? r.stats.yearPnl / r.stats.typicalEquity : null);
  const monthPct = (r: (typeof rows)[number]) => (r.stats.equityNow && r.stats.monthPnl !== null ? r.stats.monthPnl / r.stats.equityNow : null);
  if (swing) {
    const checkList = addresses.length ? rows : passed;
    console.error(`reading fills for ${checkList.length}`);
    for (const [i, r] of checkList.entries()) {
      if (i > 0) await sleep(FILLS_SPACING_MS);
      try {
        r.swing = swingStats(parseFills(await post({ type: "userFills", user: r.address })), now);
        r.swingFails = swingFailures(r.swing);
      } catch (e) {
        r.swingFails = [`fills unreadable: ${(e as Error).message}`];
      }
    }
    if (!addresses.length) {
      const notSwing = passed.filter((r) => r.swingFails?.length);
      console.log(`swing check: ${passed.length - notSwing.length} of ${passed.length} are swing traders`);
      for (const r of notSwing) console.log(`  not swing ${r.address.slice(0, 10)}: ${r.swingFails!.join(", ")}`);
      passed = passed.filter((r) => !r.swingFails?.length).sort((a, b) => (yearPct(b) ?? -Infinity) - (yearPct(a) ?? -Infinity));
    }
  }
  const shown = addresses.length ? rows : passed.slice(0, topN);
  console.log(`\nreviewed ${rows.length + failed} · unreadable ${failed} · passed ${passed.length}`);
  for (const [reason, n] of Object.entries(rejected)) console.log(`  ${n} × ${STAGE3_REASON_LABEL[reason as Stage3Reason]}`);
  console.log("\naddress                                     equity   allTime   30d      hist  winWk  maxDD  best4  turnov  score   12mo%   30d%  ord/wk  holdH  fails");
  for (const r of shown) {
    const s = r.stats;
    console.log(
      [
        r.address,
        usd(r.equity ?? s.typicalEquity).padStart(8),
        usd(r.allTimePnl).padStart(8),
        usd(r.monthPnl).padStart(8),
        `${Math.round(s.historyWeeks / 4.35)}mo`.padStart(5),
        pct(s.winningWeeksShare).padStart(6),
        pct(s.drawdownShare).padStart(6),
        pct(s.bestFourShare).padStart(6),
        (s.turnover === null ? "—" : `${s.turnover.toFixed(0)}×`).padStart(7),
        (r.score === null ? "—" : r.score.toFixed(2)).padStart(6),
        pct(yearPct(r)).padStart(7),
        pct(monthPct(r)).padStart(6),
        (r.swing ? r.swing.ordersPerWeek.toFixed(1) : "").padStart(7),
        (r.swing?.medianHoldHours != null ? r.swing.medianHoldHours.toFixed(0) : "").padStart(6),
        [...r.failures, ...(r.swingFails ?? [])].join(","),
      ].join(" "),
    );
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date(now).toISOString(), rejected, failed, rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
