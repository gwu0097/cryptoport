// Hyperliquid weight per /signals load, measured at the fetch level
// (independently of the app's own meter) through the REAL data path:
// getIndicatorChart + computeWatchlistRows, concurrently, like the page.
// Read-only (Hyperliquid public data; no DB). Scenarios, in one process so
// the in-memory candle cache carries across them like a warm server:
//   A cold      — empty cache
//   B retry     — 65s later (A's rate-limited rows, if any, fill in)
//   C warm      — immediately after (same bar: cache hits)
//   D postClose — 20s after the next bar close (incremental fetches)
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/diag/signals-weight.ts [tf=1H] [ind=rsi2] [coin=BTC]
//
// Watchlist = SIGNALS_UNIVERSE (the perps on the user's watchlists at
// 2026-09-23, + BTC). Weight per Hyperliquid's /info rules (hlWeight.ts).

type Call = { type: string; items: number; status: number };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  if (String(input).includes("hyperliquid")) {
    const type = JSON.parse(String(init?.body ?? "{}")).type as string;
    const items = res.ok && type === "candleSnapshot" ? ((await res.clone().json()) as unknown[]).length : 0;
    calls.push({ type, items, status: res.status });
  }
  return res;
}) as typeof fetch;

async function main() {
  const [tf = "1H", ind = "rsi2", coin = "BTC"] = process.argv.slice(2);
  const { getIndicatorChart, computeWatchlistRows } = await import("../../src/lib/smc/signalData");
  const { requestWeight } = await import("../../src/lib/smc/hlWeight");
  const { TIMEFRAMES } = await import("../../src/lib/smc/engine");
  const { SIGNALS_UNIVERSE } = await import("../../src/lib/signals/universe");
  // Watchlists hold the TOKEN ticker (PEPE); the app maps it to the 1,000x perp (kPEPE).
  const items = SIGNALS_UNIVERSE.map((t) => ({ ticker: t.replace(/^k/, ""), name: t, image_url: null }));
  type Tf = keyof typeof TIMEFRAMES;
  const bar = TIMEFRAMES[tf as Tf].candleSeconds;
  const sleepUntil = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms - Date.now())));

  async function load(label: string) {
    calls = [];
    const t0 = Date.now();
    const [chart, list] = await Promise.all([
      getIndicatorChart(ind as never, coin, tf as Tf).catch((e: Error) => ({ error: e.message })),
      computeWatchlistRows(ind as never, tf as Tf, items),
    ]);
    const weight = calls.reduce((s, c) => s + requestWeight(c.type, c.items), 0);
    const byType = Object.fromEntries(
      [...new Set(calls.map((c) => c.type))].map((t) => [t, calls.filter((c) => c.type === t).reduce((s, c) => s + requestWeight(c.type, c.items), 0)]),
    );
    console.log(
      JSON.stringify({
        scenario: label,
        at: new Date(t0).toISOString(),
        weight,
        byType,
        requests: calls.length,
        http429: calls.filter((c) => c.status === 429).length,
        rows: list.rows.length,
        rowsRateLimitedNoCache: list.rows.filter((r) => r.error === "rate-limited").length,
        rowsStale: list.rows.filter((r) => r.staleAsOfSec !== null).length,
        rowsOk: list.rows.filter((r) => r.state !== null && r.staleAsOfSec === null).length,
        rowsNoState: list.rows.filter((r) => r.state === null).map((r) => `${r.ticker}${r.coin ? "" : " (unlisted)"}${r.error ? ` (${r.error})` : ""}`),
        chart: "error" in chart ? chart.error : chart.stale ? "stale" : "ok",
        seconds: (Date.now() - t0) / 1000,
      }),
    );
  }

  await load("A cold");
  await sleepUntil(Date.now() + 65_000);
  await load("B retry +65s");
  await load("C warm");
  const nextClose = (Math.floor(Date.now() / 1000 / bar) + 1) * bar;
  console.log(`waiting for the ${tf} close at ${new Date(nextClose * 1000).toISOString()} (+20s)…`);
  await sleepUntil((nextClose + 20) * 1000);
  await load("D postClose");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
