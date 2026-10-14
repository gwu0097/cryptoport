import "server-only";
import { getActiveWalletsWithHoldings, getAssetsGroupedByTicker, getAssetStatsMap, getPriceMap, getValueHistory } from "./queries";
import { getPriceHistoryMap } from "./priceHistory";
import { requestNowSec } from "./requestClock";
import { attribute, attributeByWallet, changeSinceClose, daysBefore, mergeByTicker, WINDOW_DAYS, type Attribution, type AttributionWindow, type ByWallet, type WalletAttributionInput } from "./analytics/attribution.ts";
import { coinKey, matchDestinations, tickersToName, type DroppedCoin, type TxLeg } from "./analytics/transferMatch.ts";
import { chunkByLength } from "./urlBatch.ts";
import { userDb } from "./supabase";
import { parseNumeric, valueHolding } from "./valuation";
import { riskProfile, type RiskProfile } from "./analytics/risk.ts";
import { exactChange, walletComposition, type SnapshotAssets } from "./analytics/exactAttribution.ts";
import { holdingContext, type HoldingContext } from "./analytics/holdingContext.ts";
import type { Holding } from "./types";

// The Analytics page's one read: the same holdings, prices and snapshots
// Assets and Performance show, run through the pure analytics modules. No
// external call — everything here is already stored.

/** Holdings below this share of the portfolio are summarized, not listed. */
const MIN_LISTED_WEIGHT = 0.001;
/** The benchmark: BTC's daily price history (a CoinGecko coin, backfilled
 * like any held coin's). */
const BENCHMARK_KEY = "bitcoin";
/** Transaction rows read for "where it went" — one request (no paging in a
 * render); past it, the window's older part is unknown (coveredFrom). */
const TX_ROW_CAP = 1000;
/** Tickers safe inside PostgREST's ilike(any).{…} list (it isn't quoted). */
const NAMEABLE_TICKER = /^[\p{L}\p{N}.$+-]{1,24}$/u;
/** Two of the user's own coins with one ticker: their prices must agree
 * this closely to value that ticker, else it's ambiguous. */
const SAME_PRICE = 0.02;

type TxRow = { wallet_id: string; chain: string; tx_hash: string; occurred_at: string; direction: string; ticker: string | null; amount: number | string | null; counterparty: string | null };

export interface AnalyticsView {
  totalUsd: number;
  /** "Everything else" split by wallet, per window (attributeByWallet). */
  byWallet: Record<AttributionWindow, ByWallet>;
  /** Holdings whose value is unknown (no price) — left out of every figure. */
  unpricedCount: number;
  attribution: Record<AttributionWindow, Attribution>;
  risk: RiskProfile | null;
  holdings: HoldingContext[];
  smallHoldings: { count: number; usd: number };
}

export async function getAnalytics(): Promise<AnalyticsView> {
  const today = new Date(requestNowSec() * 1000).toISOString().slice(0, 10);
  const windows = Object.keys(WINDOW_DAYS) as AttributionWindow[];
  const requestedDates = windows.map((w) => daysBefore(today, WINDOW_DAYS[w]));
  // Two round trips: these together (with the earliest coin-by-coin
  // snapshot and the longest window's stored transactions), then the price
  // history of what's held with the wallet snapshots each window starts
  // from and the price keys of the transactions' tickers.
  const txFrom = `${[...requestedDates].sort()[0]}T00:00:00Z`;
  const [{ groups, grand }, stats, snapshots, wallets, firstExactRes, txRes] = await Promise.all([
    getAssetsGroupedByTicker(),
    getAssetStatsMap(),
    getValueHistory(),
    getActiveWalletsWithHoldings(),
    userDb().then((db) => db.from("wallet_snapshots").select("snapshot_date").not("assets", "is", null).order("snapshot_date").limit(1)),
    userDb().then((db) =>
      db
        .from("transactions")
        .select("wallet_id, chain, tx_hash, occurred_at, direction, ticker, amount, counterparty")
        .gte("occurred_at", txFrom)
        .in("direction", ["in", "out"])
        .order("occurred_at", { ascending: false })
        .limit(TX_ROW_CAP),
    ),
  ]);
  // "Where it went" reads only stored transactions; a failed read shows no
  // destinations rather than calling every coin unexplained.
  if (txRes.error) console.error(`[analytics] transactions read failed: ${txRes.error.message}`);
  const txRows = txRes.error ? null : ((txRes.data ?? []) as TxRow[]);
  const txLegs: TxLeg[] = (txRows ?? []).map((r) => ({
    walletId: r.wallet_id,
    chain: r.chain,
    txHash: r.tx_hash,
    occurredAt: r.occurred_at,
    direction: r.direction,
    ticker: r.ticker,
    amount: parseNumeric(r.amount),
    counterparty: r.counterparty,
  }));
  const txPartial = !!txRows && txRows.length >= TX_ROW_CAP;
  const coveredFrom = txPartial ? txRows[txRows.length - 1].occurred_at : null;
  const nameable = tickersToName(txLegs).filter((t) => NAMEABLE_TICKER.test(t));
  // A window starts on its own day, or — while the coin-by-coin snapshots
  // are newer than that — on the first of them (owner 2026-10-02: show what
  // can be measured, labeled, not an estimate).
  const firstExact = ((firstExactRes.data ?? []) as { snapshot_date: string }[])[0]?.snapshot_date ?? null;
  const baseDates = requestedDates.map((d) => (firstExact && d < firstExact ? firstExact : d));
  const benchmark = { ticker: "BTC", source: "auto", contract: null, chain: null, coingecko_id: BENCHMARK_KEY, price_key: BENCHMARK_KEY } as Pick<
    Holding,
    "ticker" | "source" | "contract" | "chain" | "coingecko_id" | "price_key"
  >;
  const [{ history }, snaps, assetRes] = await Promise.all([
    getPriceHistoryMap([...wallets.flatMap((w) => w.holdings), benchmark]),
    userDb().then((db) => db.from("wallet_snapshots").select("wallet_id, snapshot_date, total_usd, assets, positions_usd, created_at").in("snapshot_date", [...new Set(baseDates)])),
    // Which coins the transactions' tickers are (rows carry a symbol, no
    // price_key) — a sold-out coin isn't in the user's price scope.
    Promise.all(
      chunkByLength(nameable).map((batch) =>
        userDb().then((db) => db.from("assets").select("price_key, symbol").ilikeAnyOf("symbol", batch).limit(1000)),
      ),
    ),
  ]);

  // An asset (a price_key with a price) has a price series; everything else
  // with a value — protocol positions, perp margin, rows priced by their
  // stored value — moves without a price change to attribute.
  const assets = groups.filter((g) => !g.tickerKey.startsWith("ticker:") && g.price !== null && g.total > 0);
  const others = groups.filter((g) => !assets.includes(g) && g.total > 0);
  const positions = { usd: others.reduce((s, g) => s + g.total, 0), tickers: others.map((g) => g.ticker) };

  // Each window's change from the coin's own close on the snapshot day where
  // we have one (same moment as the snapshot), else the source's rolling
  // change (changeSinceClose).
  const aligned = (key: string, priceNow: number | null, fallback: Record<AttributionWindow, number | null>): Record<AttributionWindow, number | null> =>
    Object.fromEntries(windows.map((w, i) => [w, changeSinceClose(history.get(key), baseDates[i], priceNow) ?? fallback[w]])) as Record<AttributionWindow, number | null>;
  const attributionInput = assets.map((g) => ({
    key: g.tickerKey,
    ticker: g.ticker,
    valueUsd: g.total,
    change: aligned(g.tickerKey, g.price, { "24h": g.change24h, "7d": g.change7d, "30d": g.change30d }),
  }));
  // Per wallet, for "where did everything else come from": each wallet's
  // coins (with the asset's change) and its value held outside a priced coin.
  const prices = await getPriceMap();
  const walletInputs: WalletAttributionInput[] = wallets.map((w) => {
    const assets = new Map<string, { key: string; ticker: string; valueUsd: number; change: Record<AttributionWindow, number | null> }>();
    const positions = { usd: 0, tickers: [] as string[] };
    let live = 0;
    for (const h of w.holdings) {
      const v = valueHolding(h, prices);
      if (v.kind !== "priced") continue;
      live += v.usd;
      const st = h.price_key ? stats.get(h.price_key) : undefined;
      if (h.price_key && st && st.usd !== null && h.usd_override == null) {
        const a = assets.get(h.price_key) ?? { key: h.price_key, ticker: h.ticker, valueUsd: 0, change: aligned(h.price_key, parseNumeric(st.usd), { "24h": st.change24h, "7d": st.change7d, "30d": st.change30d }) };
        a.valueUsd += v.usd;
        assets.set(h.price_key, a);
      } else {
        positions.usd += v.usd;
        positions.tickers.push(h.ticker);
      }
    }
    return { id: w.id, name: w.name, createdAt: (w as { created_at?: string }).created_at ?? null, liveUsd: live, assets: [...assets.values()], positions };
  });
  const { data: walletSnaps, error: snapError } = snaps;
  if (snapError) throw new Error(`Failed to load wallet snapshots: ${snapError.message}`);
  const byWallet = Object.fromEntries(
    windows.map((win, i) => {
      const base = new Map<string, number>();
      for (const r of walletSnaps as { wallet_id: string; snapshot_date: string; total_usd: number | string }[]) {
        if (r.snapshot_date === baseDates[i]) base.set(r.wallet_id, parseNumeric(r.total_usd) ?? 0);
      }
      return [win, attributeByWallet(win, walletInputs, base, today, baseDates[i])];
    }),
  ) as AnalyticsView["byWallet"];

  const attribution = Object.fromEntries(
    windows.map((w, i) => [w, attribute(w, attributionInput, positions, grand.total, snapshots, today, baseDates[i])]),
  ) as Record<AttributionWindow, Attribution>;

  // Exact where the starting snapshot recorded each wallet's composition:
  // the price effect from each wallet's own snapshot prices, and the rest
  // named per coin. Needs every wallet that existed then to have one.
  const tickerOf = new Map<string, string>();
  for (const w of wallets) for (const h of w.holdings) if (h.price_key && !tickerOf.has(h.price_key)) tickerOf.set(h.price_key, h.ticker);
  const nowComposition = new Map(wallets.map((w) => [w.id, walletComposition(w.holdings, prices)]));
  // "Where it went": each coin's ticker as transaction rows name it — from
  // the assets read (sold-out coins too), else the held row's ticker.
  const assetsFailed = assetRes.find((r) => r.error);
  if (assetsFailed?.error) console.error(`[analytics] assets read failed: ${assetsFailed.error.message}`);
  const symbolByKey = new Map<string, string>();
  for (const r of assetRes.flatMap((x) => (x.data ?? []) as { price_key: string; symbol: string | null }[])) if (r.symbol) symbolByKey.set(r.price_key, r.symbol);
  const symbolOf = (key: string) => symbolByKey.get(key) ?? tickerOf.get(key) ?? null;
  const matchWallets = wallets.map((w) => ({ id: w.id, name: w.name, address: w.address, txSyncedAt: (w as { tx_synced_at?: string | null }).tx_synced_at ?? null }));
  windows.forEach((win, i) => {
    type SnapRow = { wallet_id: string; snapshot_date: string; total_usd: number | string; assets: SnapshotAssets | null; positions_usd: number | string | null; created_at: string };
    const base = new Map((walletSnaps as SnapRow[]).filter((r) => r.snapshot_date === baseDates[i]).map((r) => [r.wallet_id, r]));
    const rows = byWallet[win].wallets;
    const measurable = rows.every((r) => r.added || base.get(r.id)?.assets);
    const actual = attribution[win].actualUsd;
    if (!measurable || actual === null || base.size === 0) return;
    const byCoin = new Map<string, { usd: number; valueUsd: number; pBefore: number; pNow: number }>();
    let price = 0;
    const dropped: DroppedCoin[] = [];
    for (const r of rows) {
      if (r.added) continue;
      const b = base.get(r.id)!;
      const c = exactChange({ assets: b.assets ?? {}, positionsUsd: parseNumeric(b.positions_usd) ?? 0 }, nowComposition.get(r.id)!);
      price += c.priceUsd;
      r.priceUsd = c.priceUsd;
      r.otherUsd = r.actualUsd === null ? null : r.actualUsd - c.priceUsd;
      r.exact = {
        quantityUsd: c.quantityUsd,
        positionsUsd: c.positionsUsd,
        revaluedUsd: c.revaluedUsd,
        coins: c.coins
          .filter((x) => Math.abs(x.quantityUsd + x.revaluedUsd) >= 1)
          .slice(0, 4)
          .map((x) => ({ key: x.key, ticker: tickerOf.get(x.key) ?? x.key, qtyBefore: x.qtyBefore, qtyAfter: x.qtyAfter, usd: x.quantityUsd + x.revaluedUsd, revalued: x.revaluedUsd !== 0 })),
      };
      for (const x of c.coins) {
        if (x.qtyAfter < x.qtyBefore && Math.abs(x.quantityUsd + x.revaluedUsd) >= 1) {
          dropped.push({ walletId: r.id, key: x.key, symbol: symbolOf(x.key), drop: x.qtyBefore - x.qtyAfter, unitPrice: x.priceBefore ?? x.priceNow });
        }
        if (x.priceBefore === null || x.priceNow === null || x.qtyBefore <= 0) continue;
        const cur = byCoin.get(x.key) ?? { usd: 0, valueUsd: 0, pBefore: x.priceBefore, pNow: x.priceNow };
        cur.usd += x.priceUsd;
        cur.valueUsd += x.qtyAfter * x.priceNow;
        byCoin.set(x.key, cur);
      }
    }
    rows.sort((x, y) => Math.abs(y.otherUsd ?? 0) - Math.abs(x.otherUsd ?? 0));
    const a = attribution[win];
    a.exact = true;
    a.priceUsd = price;
    a.otherUsd = actual - price;
    a.contributions = mergeByTicker(
      [...byCoin].map(([key, c]) => ({ key, ticker: tickerOf.get(key) ?? key, valueUsd: c.valueUsd, changePct: (c.pNow / c.pBefore - 1) * 100, usd: c.usd })),
    ).filter((c) => Math.abs(c.usd) >= 0.01);

    // Where each coin that went down went, from stored transactions
    // (transferMatch.ts). Skipped when a read failed — no line beats a
    // wrong "not found".
    if (txRows === null || assetsFailed) return;
    const since = new Map([...base].map(([id, b]) => [id, b.created_at]));
    const m = matchDestinations({ legs: txLegs, wallets: matchWallets, since, coins: dropped, priceOf: priceLookup(base, nowComposition, symbolOf), coveredFrom });
    for (const r of rows) {
      if (!r.exact) continue;
      for (const c of r.exact.coins) if (c.qtyAfter < c.qtyBefore) c.destinations = m.byCoin.get(coinKey(r.id, c.key));
      const mine = m.moves.filter((x) => x.fromWalletId === r.id || x.toWalletId === r.id);
      if (mine.length === 0) continue;
      const net = mine.some((x) => x.usd === null) ? null : mine.reduce((s, x) => s + (x.toWalletId === r.id ? 1 : -1) * (x.usd as number), 0);
      // Moves out and in that cancel aren't a caption ("of which $0").
      if (net === null || Math.abs(net) >= 1) r.exact.movedUsd = net;
    }
    byWallet[win].moves = m.moves;
    byWallet[win].historyPartial = txPartial;
  });

  // What each window can honestly show: measured (exact) — from a later
  // start when its own day predates the coin-by-coin snapshots — or nothing
  // yet (owner 2026-10-02: "if we don't have their data, don't show it").
  windows.forEach((win, i) => {
    const a = attribution[win];
    if (!a.exact) a.building = true;
    else if (baseDates[i] !== requestedDates[i]) {
      const days = Math.round((Date.parse(today) - Date.parse(baseDates[i])) / 86_400_000);
      a.shortened = { days, fullFrom: daysBefore(baseDates[i], -WINDOW_DAYS[win]) };
    }
  });

  const risk = riskProfile(
    [
      ...assets.map((g) => ({ key: g.tickerKey, ticker: g.ticker, valueUsd: g.total, prices: history.get(g.tickerKey) })),
      ...others.map((g) => ({ key: g.tickerKey, ticker: g.ticker, valueUsd: g.total, prices: undefined })),
    ],
    history.get(BENCHMARK_KEY),
  );
  const riskOf = new Map((risk?.assets ?? []).map((a) => [a.key, a]));

  const listed = assets.filter((g) => g.total >= MIN_LISTED_WEIGHT * grand.total);
  const small = assets.filter((g) => !listed.includes(g));
  const holdings = listed
    .map((g) =>
      holdingContext(
        {
          key: g.tickerKey,
          ticker: g.ticker,
          iconUrl: g.iconUrl,
          valueUsd: g.total,
          price: g.price,
          change7d: g.change7d,
          change30d: g.change30d,
          marketCap: g.marketCap,
          volume24h: stats.get(g.tickerKey)?.volume24h ?? null,
          prices: history.get(g.tickerKey),
          risk: riskOf.get(g.tickerKey) ?? null,
        },
        grand.total,
        today,
      ),
    )
    .sort((a, b) => b.valueUsd - a.valueUsd);

  return {
    totalUsd: grand.total,
    byWallet,
    unpricedCount: grand.unpricedCount,
    attribution,
    risk,
    holdings,
    smallHoldings: { count: small.length, usd: small.reduce((s, g) => s + g.total, 0) },
  };
}

/** A ticker's unit price from the user's own coins (held now, or in the
 * window's base snapshots): null when none has it, or two of them disagree
 * (a namesake). */
function priceLookup(
  base: ReadonlyMap<string, { assets: SnapshotAssets | null }>,
  now: ReadonlyMap<string, { assets: SnapshotAssets }>,
  symbolOf: (key: string) => string | null,
): (ticker: string) => number | null {
  const byTicker = new Map<string, Map<string, number>>();
  // The snapshot's price first (the out-leg is valued at it too), else now.
  const add = (assets: SnapshotAssets | null) => {
    for (const [key, [, price]] of Object.entries(assets ?? {})) {
      const sym = symbolOf(key)?.toUpperCase();
      if (!sym || price === null || price <= 0) continue;
      const prices = byTicker.get(sym) ?? new Map<string, number>();
      if (!prices.has(key)) prices.set(key, price);
      byTicker.set(sym, prices);
    }
  };
  for (const b of base.values()) add(b.assets);
  for (const c of now.values()) add(c.assets);
  return (ticker) => {
    const prices = [...(byTicker.get(ticker.toUpperCase())?.values() ?? [])];
    if (prices.length === 0) return null;
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    return hi / lo - 1 > SAME_PRICE ? null : prices[0];
  };
}
