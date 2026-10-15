"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import type { TokenOverview } from "@/lib/tokenOverview";
import { holdingChangedSince, type SavedCostBasis } from "@/lib/costBasisStore";
import { formatCompactUsd, formatPercent, formatPrice, formatQty, formatStaleness, formatUsd } from "@/lib/format";
import { TokenIcon } from "../TokenIcon";
import { CopyButton } from "../CopyButton";
import { TradingViewCompareChart } from "../TradingViewCompareChart";
import { ValueChart } from "../charts/ValueChart";
import { useHideBalance } from "../HideBalanceProvider";

// Answers kept a minute: reopening a token (or Back/Forward) costs nothing.
const cache = new Map<string, { at: number; data: TokenOverview }>();
const FRESH_MS = 60_000;

const tone = (x: number | null | undefined) => (x == null ? "text-fg-muted" : x > 0 ? "text-positive" : x < 0 ? "text-negative" : "text-fg");

/** The token drawer's Overview (TokenDrawerProvider opens it). */
export function TokenDrawer({ tokenKey, onClose }: { tokenKey: string; onClose: () => void }) {
  const [state, setState] = useState<{ key: string; data?: TokenOverview; error?: string } | null>(null);
  const { hidden } = useHideBalance();
  const shown = state?.key === tokenKey ? state : null;
  // The chart expanded over the whole screen (owner 2026-10-15, like the
  // Dashboard heatmap): its height in px, measured on the click; null = in
  // the drawer. Esc closes it first, then the drawer.
  const [bigChart, setBigChart] = useState<{ key: string; height: number } | null>(null);
  const bigHeight = bigChart?.key === tokenKey ? bigChart.height : null;

  useEffect(() => {
    let cancelled = false;
    const hit = cache.get(tokenKey);
    if (hit && Date.now() - hit.at < FRESH_MS) {
      Promise.resolve().then(() => !cancelled && setState({ key: tokenKey, data: hit.data }));
      return () => {
        cancelled = true;
      };
    }
    fetch(`/api/token?key=${encodeURIComponent(tokenKey)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as TokenOverview;
      })
      .then((data) => {
        cache.set(tokenKey, { at: Date.now(), data });
        if (!cancelled) setState({ key: tokenKey, data });
      })
      .catch((e: Error) => !cancelled && setState({ key: tokenKey, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [tokenKey]);

  // Esc closes; the page behind doesn't scroll while it's open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (bigHeight !== null) setBigChart(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, bigHeight]);

  const d = shown?.data;
  const money = (n: number | null) => (n === null ? "—" : hidden ? "••••" : formatUsd(n));

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Token details">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <aside className="relative flex h-dvh w-full flex-col overflow-y-auto overscroll-contain border-l border-border bg-surface shadow-2xl sm:w-[480px]">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-surface px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <TokenIcon ticker={d?.ticker ?? "?"} url={d?.iconUrl ?? null} />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold text-fg">
                {d?.ticker ?? "…"} {d?.name && <span className="text-sm font-normal text-fg-muted">{d.name}</span>}
              </p>
              {d?.stats?.usd != null && (
                <p className="text-sm tabular-nums text-fg">
                  {formatPrice(d.stats.usd)}{" "}
                  {(["change24h", "change7d", "change30d"] as const).map((k, i) => (
                    <span key={k} className={`ml-2 text-xs ${tone(d.stats?.[k])}`}>
                      {["24h", "7d", "30d"][i]} {formatPercent(d.stats?.[k] ?? null)}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-fg-muted hover:text-fg">
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        {!shown && <p className="p-5 text-sm text-fg-muted">Loading…</p>}
        {shown?.error && <p className="p-5 text-sm text-negative">Couldn&apos;t load this token: {shown.error}</p>}

        {d && (
          <div className="flex flex-col gap-5 p-5">
            {d.stats && (
              <p className="-mt-2 text-xs text-fg-muted">
                MC {formatCompactUsd(d.stats.marketCap)} · Vol 24h {formatCompactUsd(d.stats.volume24h)}
                {d.stats.updatedAt && ` · priced ${new Date(d.stats.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
              </p>
            )}

            <section>
              {d.chart.tradingView ? (
                <>
                  <div className="mb-1 flex justify-end">
                    <button type="button" onClick={() => setBigChart({ key: tokenKey, height: Math.max(window.innerHeight - 96, 360) })} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-raised hover:text-fg">
                      <Maximize2 className="size-3.5" aria-hidden="true" />
                      Expand chart
                    </button>
                  </div>
                  <TradingViewCompareChart baseTicker={d.chart.tradingView} height={320} interval="240" compact />
                  {bigHeight !== null && (
                    <div className="fixed inset-0 z-[60] flex flex-col bg-black/70 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={`${d.ticker} chart`}>
                      <button type="button" aria-label="Collapse chart" onClick={() => setBigChart(null)} className="absolute inset-0 cursor-default" />
                      <div className="relative flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-fg">
                            {d.ticker} {d.name && <span className="font-normal text-fg-muted">{d.name}</span>}
                          </p>
                          <button type="button" onClick={() => setBigChart(null)} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-fg-muted transition hover:bg-surface-raised hover:text-fg">
                            <Minimize2 className="size-3.5" aria-hidden="true" />
                            Collapse
                          </button>
                        </div>
                        <TradingViewCompareChart baseTicker={d.chart.tradingView} height={bigHeight} interval="240" compact />
                      </div>
                    </div>
                  )}
                </>
              ) : d.chart.closes.length >= 2 ? (
                <>
                  <ValueChart points={d.chart.closes.map(([date, total]) => ({ date, total, kind: "real" as const }))} rangeStorageKey="cryptoport:tokenChartRange" heightClass="h-40" priceChart />
                  <p className="mt-1 text-[11px] text-fg-muted">Daily closes CryptoPort recorded — TradingView has no chart for this coin.</p>
                </>
              ) : (
                <p className="text-sm text-fg-muted">No chart: TradingView doesn&apos;t list this coin and CryptoPort has no price history for it yet.</p>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Your position</h3>
                <span className="text-sm font-semibold tabular-nums text-fg">{money(d.position.totalUsd)}</span>
              </div>
              {d.position.rows.length === 0 ? (
                <p className="text-sm text-fg-muted">Not in any of your wallets.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {d.position.rows.map((r, i) => (
                    <li key={`${r.walletId}-${i}`}>
                      <Link href={`/wallets/${r.walletId}`} onClick={onClose} className="flex items-center justify-between gap-3 px-3 pt-2 text-sm hover:bg-surface-raised">
                        <span className="min-w-0">
                          <span className="block truncate text-fg">{r.walletName}</span>
                          <span className="block text-xs text-fg-muted">
                            {r.chainName}
                            {r.protocol && ` · ${r.protocol}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-right tabular-nums">
                          <span className="block text-fg">{money(r.usd)}</span>
                          <span className="block text-xs text-fg-muted">{hidden ? "••••" : r.qty === null ? "—" : formatQty(r.qty)}</span>
                        </span>
                      </Link>
                      {/* Once per wallet: one lookup covers its every chain. */}
                      {d.position.rows.findIndex((x) => x.walletId === r.walletId) === i && <CostBasisLine tokenKey={d.key} walletId={r.walletId} ticker={d.ticker} price={d.stats?.usd ?? null} saved={d.costBasis?.[r.walletId] ?? null} walletQty={walletQty(d, r.walletId)} />}
                    </li>
                  ))}
                </ul>
              )}
              {d.position.unpriced > 0 && <p className="mt-1 text-xs text-warning">{d.position.unpriced} holding{d.position.unpriced === 1 ? "" : "s"} unpriced — not in the total.</p>}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Contracts</h3>
              {d.contracts.length === 0 ? (
                <p className="text-sm text-fg-muted">None to copy — a chain&apos;s own coin, or no address on record.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {d.contracts.map((c) => (
                    <li key={`${c.chainId}:${c.contract}`} className="flex items-center gap-2 text-sm">
                      <span className="w-24 shrink-0 truncate text-fg-muted">{c.chainName}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={c.contract}>
                        {c.contract}
                      </span>
                      <CopyButton value={c.contract} label={`Copy ${d.ticker} on ${c.chainName}`} title={`Copy ${c.contract}`} />
                      <a href={`https://dexscreener.com/search?q=${encodeURIComponent(c.contract)}`} target="_blank" rel="noopener noreferrer" title="Open on DexScreener" className="text-fg-muted hover:text-fg">
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Also</h3>
              {d.watchlists.length > 0 && <p className="mb-2 text-sm text-fg">★ On {d.watchlists.map((w) => w.name).join(", ")}</p>}
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <Link href={`/encyclopedia?id=${encodeURIComponent(d.key)}`} onClick={onClose} className="text-accent hover:underline">
                  Encyclopedia
                </Link>
                <Link href={`/trend-finder?id=${encodeURIComponent(d.key)}`} onClick={onClose} className="text-accent hover:underline">
                  Trend Finder
                </Link>
                {!d.key.includes(":") && (
                  <a href={`https://www.coingecko.com/en/coins/${encodeURIComponent(d.key)}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    CoinGecko
                  </a>
                )}
              </p>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

/** The wallet's quantity of the coin across its chains; null when any is unknown. */
function walletQty(d: TokenOverview, walletId: string): number | null {
  const qs = d.position.rows.filter((r) => r.walletId === walletId).map((r) => r.qty);
  return qs.some((q) => q === null) ? null : (qs as number[]).reduce((a, b) => a + b, 0);
}

/** "Cost basis" under a wallet's line: worked out on demand (a few history
 * reads) and saved, so it shows at once next time with when it was worked
 * out and a Refresh — its average entry, cost and P/L, and what came in
 * without a payment. */
function CostBasisLine({ tokenKey, walletId, ticker, price, saved, walletQty }: { tokenKey: string; walletId: string; ticker: string; price: number | null; saved: SavedCostBasis | null; walletQty: number | null }) {
  const [state, setState] = useState<{ busy?: boolean; data?: SavedCostBasis; error?: string } | null>(saved ? { data: saved } : null);
  const { hidden } = useHideBalance();

  async function load() {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    try {
      const res = await fetch("/api/token/cost-basis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: tokenKey, walletId }) });
      const body = (await res.json()) as SavedCostBasis & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      // The drawer's cached overview carries it too, so reopening within its minute shows it.
      const hit = cache.get(tokenKey);
      if (hit) hit.data = { ...hit.data, costBasis: { ...hit.data.costBasis, [walletId]: body } };
      setState({ data: body });
    } catch (e) {
      setState((s) => ({ data: s?.data, error: (e as Error).message }));
    }
  }

  if (!state?.data) {
    if (state?.busy) return <p className="px-3 pb-2 text-xs text-fg-muted">Reading this wallet&apos;s history…</p>;
    return (
      <div className="px-3 pb-2 text-xs">
        <button type="button" onClick={load} className="text-accent hover:underline">
          Cost basis
        </button>
        {state?.error && <p className="text-negative">Cost basis: {state.error}</p>}
      </div>
    );
  }
  const data = state.data;
  const changed = holdingChangedSince(data, walletQty);
  const footer = (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-fg-muted">
      <span>Worked out {formatStaleness(data.computedAt)}</span>
      {changed && <span className="text-warning">· your holding changed since</span>}
      <button type="button" onClick={load} disabled={state.busy} className="text-accent hover:underline disabled:opacity-50">
        {state.busy ? "Refreshing…" : "Refresh"}
      </button>
      {state.error && <span className="text-negative">{state.error}</span>}
    </p>
  );
  if (!data.results.length) {
    return (
      <div className="px-3 pb-2 text-xs">
        <p className="text-fg-muted">{data.note ?? "No history found for it in this wallet."}</p>
        {footer}
      </div>
    );
  }
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
  return (
    <div className="flex flex-col gap-1 px-3 pb-2 text-xs">
      {data.results.map((c) => {
        const pl = c.avgCost && price ? (price - c.avgCost) / c.avgCost : null;
        return (
          <div key={c.chain} className="rounded-md bg-surface-raised px-2 py-1.5">
            {c.avgCost !== null ? (
              <p className="tabular-nums text-fg">
                Avg entry {formatPrice(c.avgCost)} · cost {hidden ? "••••" : formatUsd(c.costUsd ?? 0)}
                {pl !== null && <span className={`ml-1 ${tone(pl)}`}>{formatPercent(pl * 100)}</span>}
                <span className="text-fg-muted"> · {c.buys} buy{c.buys === 1 ? "" : "s"} since {day(c.firstBuyAt)}</span>
              </p>
            ) : (
              <p className="text-fg">No buy found in this wallet&apos;s history.</p>
            )}
            {c.unknownQty > 0 && (
              <p className="mt-0.5 text-fg-muted">
                {formatQty(c.unknownQty)} {ticker} came in without a payment from this wallet (a transfer, an airdrop…) — cost unknown
                {c.avgCost === null && c.firstSeenAt ? `, first on ${day(c.firstSeenAt)}` : ""}.
              </p>
            )}
            {c.partial && <p className="mt-0.5 text-warning">Long history: the oldest moves weren&apos;t read.</p>}
            <p className="mt-0.5 text-[10px] text-fg-muted">Estimate: each buy valued at the paid coin&apos;s price when it was paid.</p>
          </div>
        );
      })}
      {footer}
    </div>
  );
}
