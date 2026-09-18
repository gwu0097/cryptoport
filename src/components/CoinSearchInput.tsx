"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CoinSearchResult } from "@/lib/adapters/coingecko";
import { inputClass } from "./ui/Field";
import { TokenIcon } from "./TokenIcon";

const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;

/** Debounced against CoinGecko's /search via whatever server action the
 * caller passes in (searchCoinsAction, differently gated per route — see
 * this component's own callers). A monotonic request id (not
 * AbortController — the search runs server-side inside a Server Action,
 * nothing here to abort) discards a stale response that resolves after a
 * newer keystroke already fired. Only fetches while `enabled` (the dropdown
 * is actually open) — an empty query never fires a call. */
function useCoinSearch(query: string, enabled: boolean, search: (query: string) => Promise<CoinSearchResult[]>) {
  const [results, setResults] = useState<CoinSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < MIN_QUERY_LENGTH) return;

    const id = ++requestId.current;
    const timer = setTimeout(() => {
      setLoading(true);
      search(trimmed)
        .then((found) => {
          if (id === requestId.current) setResults(found);
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, enabled, search]);

  return { results, loading };
}

/**
 * Shared coin-search-and-pick box: extracted from Watchlist's AddCoinPanel
 * (its original SearchTab/useCoinSearch) once addHolding's manual-holding
 * identity picker became a second consumer of the exact same debounced-
 * typeahead logic. `search` and `onSelect` are passed in rather than
 * imported directly, so this stays route-agnostic (no cross-route import
 * from one Server Action module into another's client component).
 *
 * Two distinct UX shapes share this one component, controlled by
 * `clearOnSelect`:
 * - Watchlist (`clearOnSelect: true`): every pick immediately commits (adds
 *   to the list) — the box clears itself so the next search starts fresh.
 * - A form field (`clearOnSelect: false`, the default — e.g. addHolding's
 *   ticker input): picking fills the box with the coin's symbol, the way
 *   any other combobox would, so the surrounding <form> submits it as the
 *   ticker text.
 *
 * Editing the text after a pick always calls `onSelect(null)` — the caller
 * is responsible for dropping whatever identity it stashed from the last
 * pick, so a stale coingecko_id can never be submitted alongside a ticker
 * the user has since changed.
 */
export function CoinSearchInput({
  search,
  onSelect,
  placeholder,
  name,
  defaultValue,
  clearOnSelect = false,
  disabled = false,
  required = false,
}: {
  search: (query: string) => Promise<CoinSearchResult[]>;
  onSelect: (coin: CoinSearchResult | null) => void;
  placeholder?: string;
  name?: string;
  defaultValue?: string;
  clearOnSelect?: boolean;
  disabled?: boolean;
  required?: boolean;
}) {
  const [query, setQuery] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const { results, loading } = useCoinSearch(query, open, search);

  function handlePick(coin: CoinSearchResult) {
    setQuery(clearOnSelect ? "" : coin.symbol);
    setOpen(false);
    onSelect(coin);
  }

  return (
    <div>
      <input
        type="text"
        name={name}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          onSelect(null);
        }}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        required={required}
        className={inputClass}
      />
      {open && query.trim().length >= MIN_QUERY_LENGTH && (
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
                disabled={disabled}
                onClick={() => handlePick(coin)}
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
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
