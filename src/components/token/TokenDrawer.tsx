"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import type { TokenOverview } from "@/lib/tokenOverview";
import { formatCompactUsd, formatPercent, formatPrice, formatQty, formatUsd } from "@/lib/format";
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

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
                <TradingViewCompareChart baseTicker={d.chart.tradingView} height={320} interval="240" compact />
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
                      <Link href={`/wallets/${r.walletId}`} onClick={onClose} className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-raised">
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
