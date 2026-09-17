"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, AlertTriangle, X } from "lucide-react";
import type { CoinSearchResult } from "@/lib/adapters/coingecko";
import { parseTickerInput } from "@/lib/watchlistInput";
import {
  addWatchlistItem,
  addWatchlistItems,
  resolveTickersAction,
  searchCoinsAction,
  type TickerMatch,
} from "@/app/(app)/watchlist/actions";
import { Panel } from "../ui/Panel";
import { ToggleGroup } from "../ui/ToggleGroup";
import { Button } from "../ui/Button";
import { inputClass } from "../ui/Field";
import { TokenIcon } from "../TokenIcon";

const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;

/** Debounced against CoinGecko's /search — this is the app's first type-
 * against-a-live-API input (see this file's own review note on
 * WalletCombobox, which is local-array-filtered and doesn't need this). A
 * monotonic request id (not AbortController — fetchWithRetry runs
 * server-side inside the Server Action, nothing here to abort) discards a
 * stale response that resolves after a newer keystroke already fired. */
function useCoinSearch(query: string) {
  const [results, setResults] = useState<CoinSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    // Below the minimum length, there's nothing to fetch — the caller
    // (SearchTab) already gates rendering the results dropdown on this
    // same length check, so leaving stale `results`/`loading` state
    // untouched here is harmless (never rendered) and avoids a
    // synchronous setState directly in the effect body.
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    const id = ++requestId.current;
    const timer = setTimeout(() => {
      setLoading(true);
      searchCoinsAction(trimmed)
        .then((found) => {
          if (id === requestId.current) setResults(found);
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  return { results, loading };
}

function SearchTab({ watchlistId }: { watchlistId: string }) {
  const [query, setQuery] = useState("");
  const { results, loading } = useCoinSearch(query);
  const [pending, startTransition] = useTransition();
  const [addedId, setAddedId] = useState<string | null>(null);

  function handleAdd(coin: CoinSearchResult) {
    startTransition(async () => {
      await addWatchlistItem(watchlistId, {
        coingeckoId: coin.id,
        ticker: coin.symbol,
        name: coin.name,
        imageUrl: coin.imageUrl,
      });
      setAddedId(coin.id);
      setQuery("");
    });
  }

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setAddedId(null);
        }}
        placeholder="Search a ticker or coin name (e.g. PEPE, Bitcoin)…"
        className={inputClass}
      />
      {query.trim().length >= MIN_QUERY_LENGTH && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-fg-muted">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Searching…
            </div>
          ) : results.length === 0 ? (
            <p className="p-3 text-sm text-fg-muted">No coins found.</p>
          ) : (
            results.map((coin) => (
              <button
                key={coin.id}
                type="button"
                disabled={pending}
                onClick={() => handleAdd(coin)}
                className="flex w-full items-center gap-3 border-b border-border/60 p-3 text-left text-sm last:border-b-0 hover:bg-surface-raised disabled:opacity-50"
              >
                <TokenIcon ticker={coin.symbol} url={coin.imageUrl} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">{coin.name}</div>
                  <div className="text-xs text-fg-muted">
                    {coin.symbol}
                    {coin.marketCapRank !== null && ` · #${coin.marketCapRank}`}
                  </div>
                </div>
                {addedId === coin.id && <span className="shrink-0 text-xs text-positive">Added</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function BulkTab({ watchlistId }: { watchlistId: string }) {
  const [text, setText] = useState("");
  const [review, setReview] = useState<TickerMatch[] | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [resolving, startResolve] = useTransition();
  const [adding, startAdd] = useTransition();

  const tickers = parseTickerInput(text);

  function handleResolve() {
    startResolve(async () => {
      const matches = await resolveTickersAction(tickers);
      setReview(matches);
      // No-match rows never count toward the commit — nothing to exclude
      // them from, they simply can't be added.
      setExcluded(new Set());
    });
  }

  function toggleExcluded(ticker: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  const addable = (review ?? []).filter((r) => r.match !== null && !excluded.has(r.ticker));

  function handleCommit() {
    startAdd(async () => {
      await addWatchlistItems(
        watchlistId,
        addable.map((r) => ({
          coingeckoId: r.match!.id,
          ticker: r.match!.symbol,
          name: r.match!.name,
          imageUrl: r.match!.imageUrl,
        })),
      );
      setText("");
      setReview(null);
      setExcluded(new Set());
    });
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setReview(null);
        }}
        placeholder="Paste tickers — comma, space, or newline separated (e.g. BTC, ETH, SUI, PEPE)"
        rows={3}
        className={`${inputClass} resize-y`}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          {tickers.length} ticker{tickers.length === 1 ? "" : "s"} detected
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={tickers.length === 0 || resolving}
          onClick={handleResolve}
        >
          {resolving ? "Matching tickers…" : "Match tickers"}
        </Button>
      </div>

      {review && (
        <div className="mt-3 divide-y divide-border/60 rounded-lg border border-border">
          {review.map((r) => (
            <div key={r.ticker} className="flex items-center gap-3 p-2.5 text-sm">
              {r.match ? (
                <>
                  <TokenIcon ticker={r.match.symbol} url={r.match.imageUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-fg">
                      <span className="font-medium">{r.ticker}</span> → {r.match.name} ({r.match.symbol})
                      {r.match.marketCapRank !== null && ` · #${r.match.marketCapRank}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleExcluded(r.ticker)}
                    aria-label={excluded.has(r.ticker) ? `Include ${r.ticker}` : `Exclude ${r.ticker}`}
                    className={`shrink-0 rounded p-1 ${
                      excluded.has(r.ticker)
                        ? "text-fg-muted hover:text-fg"
                        : "text-positive hover:bg-negative/10 hover:text-negative"
                    }`}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </>
              ) : (
                <>
                  <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
                  <span className="flex-1 text-warning">{r.ticker} — no match found</span>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {review && (
        <div className="mt-3 flex justify-end">
          <Button type="button" size="sm" disabled={addable.length === 0 || adding} onClick={handleCommit}>
            {adding ? "Adding…" : `Add ${addable.length} ticker${addable.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Single add (live search, pick the exact coin) + bulk add (paste, auto-
 * match, review before committing) — both decisions made explicitly: see
 * this feature's own plan for why a bare typed ticker is never trusted
 * blind (CoinGecko returns 20+ distinct coins for a symbol like "PEPE").
 */
export function AddCoinPanel({ watchlistId }: { watchlistId: string }) {
  const [tab, setTab] = useState<"search" | "bulk">("search");

  return (
    <Panel title="Add coins">
      <ToggleGroup
        options={[
          { key: "search", label: "Search" },
          { key: "bulk", label: "Bulk paste" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-3">
        {tab === "search" ? <SearchTab watchlistId={watchlistId} /> : <BulkTab watchlistId={watchlistId} />}
      </div>
    </Panel>
  );
}
