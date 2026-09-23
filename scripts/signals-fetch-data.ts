// Signals backtest data (docs/signals/PREREG_PULLBACK_INDICATORS.md §4):
// Hyperliquid candles (1h / 4h / 1d, one candleSnapshot each — the API returns
// the latest ~5,000) and hourly funding since each perp's first REAL candle
// (n > 0), for the 38 pre-registered tokens. Hyperliquid only; no CoinGecko.
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/signals-fetch-data.ts
//
// Writes ~/cryptoport-archive/signals/data/<coin>_<interval>.json and
// <coin>_funding.json (skips files that already exist — resumable), plus
// manifest.json. Paced for Hyperliquid's per-minute request weight (a 5,000-
// candle snapshot is heavy); fetchWithRetry backs off on a 429.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.loadEnvFile(`${__dirname}/../.env.local`);

const INTERVALS = ["1h", "4h", "1d"] as const;
const CANDLE_PAUSE_MS = 6000;

async function main() {
  const { fetchCandles, fetchFundingHistory } = await import("../src/lib/smc/hyperliquid");
  const { SIGNALS_UNIVERSE: UNIVERSE } = await import("../src/lib/signals/universe");
  const dir = join(process.env.SIGNALS_ARCHIVE_DIR ?? join(homedir(), "cryptoport-archive", "signals"), "data");
  mkdirSync(dir, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const now = Date.now();
  let calls = 0;

  for (const coin of UNIVERSE) {
    for (const iv of INTERVALS) {
      const file = join(dir, `${coin}_${iv}.json`);
      if (existsSync(file)) continue;
      const candles = await fetchCandles(coin, iv, 0, now);
      calls++;
      writeFileSync(file, JSON.stringify({ coin, interval: iv, fetchedAt, candles }));
      console.log(`${coin} ${iv}: ${candles.length} candles (${candles.filter((c) => (c.n ?? 0) > 0).length} with trades)`);
      await new Promise((r) => setTimeout(r, CANDLE_PAUSE_MS));
    }
    const ffile = join(dir, `${coin}_funding.json`);
    if (!existsSync(ffile)) {
      // From the first candle with real trades on any interval (1d reaches furthest back).
      const firstReal = Math.min(
        ...INTERVALS.map((iv) => {
          const cs = JSON.parse(readFileSync(join(dir, `${coin}_${iv}.json`), "utf8")).candles as { t: number; n?: number }[];
          return cs.find((c) => (c.n ?? 0) > 0)?.t ?? Infinity;
        }),
      );
      const rows = Number.isFinite(firstReal) ? await fetchFundingHistory(coin, firstReal * 1000) : [];
      calls += Math.max(1, Math.ceil(rows.length / 500));
      writeFileSync(ffile, JSON.stringify({ coin, fetchedAt, rows }));
      console.log(`${coin} funding: ${rows.length} hourly rows`);
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ fetchedAt, universe: UNIVERSE, intervals: INTERVALS, callsThisSession: calls }, null, 2));
  console.log(`done: ${calls} Hyperliquid calls this session`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
