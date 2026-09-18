"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, X } from "lucide-react";
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
import { CoinSearchInput } from "../CoinSearchInput";

function SearchTab({ watchlistId }: { watchlistId: string }) {
  const [pending, startTransition] = useTransition();

  function handleSelect(coin: CoinSearchResult | null) {
    if (!coin) return;
    startTransition(async () => {
      await addWatchlistItem(watchlistId, {
        coingeckoId: coin.id,
        ticker: coin.symbol,
        name: coin.name,
        imageUrl: coin.imageUrl,
      });
    });
  }

  return (
    <CoinSearchInput
      search={searchCoinsAction}
      onSelect={handleSelect}
      placeholder="Search a ticker or coin name (e.g. PEPE, Bitcoin)…"
      clearOnSelect
      disabled={pending}
    />
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
