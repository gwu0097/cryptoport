"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { StitchedPoint } from "@/lib/analytics";
import { formatUsd } from "@/lib/format";
import { recordRecentWallet } from "@/lib/recentWallets";
import { usePersistedState } from "../usePersistedState";
import { Panel } from "../ui/Panel";
import { inputClass } from "../ui/Field";
import { ValueChart } from "../charts/ValueChart";

export interface WalletSeriesOption {
  /** "all" for the blended total across every wallet. */
  id: string;
  name: string;
  /** null for the "all" option, and for a wallet with no address on file. */
  address: string | null;
  points: StitchedPoint[];
  coveragePct: number;
  /** No resolvable CoinGecko key at all (manual entries, DeFi/LP
   * positions) — backfilling again can never help these. */
  unresolvedUsd: number;
  unresolvedCount: number;
  /** A key resolves but isn't cached yet — clicking "Backfill history"
   * again can make progress on these. */
  uncachedUsd: number;
  uncachedCount: number;
}

const WALLET_STORAGE_KEY = "cryptoport:analyticsWallet";
const RANGE_STORAGE_KEY = "cryptoport:analyticsRange";

// Duplicated from walletAuth.ts's truncateAddress rather than imported —
// that module carries a real `import "server-only"` guard (it pulls in
// viem/siwe), which throws if bundled into a client component like this
// one. A 1-line presentational helper is the documented exception to
// "don't duplicate real logic" for exactly this boundary (see CLAUDE.md).
function truncateAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

/**
 * A button per wallet stopped fitting once there were more than a handful,
 * and a plain <select>'s scroll list isn't real search — this filters as
 * you type, against both a wallet's name and its address, so pasting or
 * typing part of an address finds it too (a native <input list>/<datalist>
 * pair, the pattern this app already uses for free-text-with-suggestions
 * inputs like the tag field, can't do this: its suggestions bind directly
 * to the input's own text value, with no separate id to select by, so two
 * wallets sharing a name would be ambiguous). No new dependency — this is
 * the only combobox in the app right now, so it stays local here rather
 * than becoming a `ui/` primitive; extract if a second one shows up.
 */
function WalletCombobox({
  options,
  value,
  onChange,
}: {
  options: WalletSeriesOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.id === value) ?? options[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return options;
    return options.filter((o) => o.name.toLowerCase().includes(q) || (o.address ?? "").toLowerCase().includes(q));
  }, [options, query]);

  function select(id: string) {
    onChange(id);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && filtered[highlight]) select(filtered[highlight].id);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    }
  }

  return (
    <div className="relative w-full sm:w-64">
      <input
        ref={inputRef}
        type="text"
        value={open ? query : selected.name}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setHighlight(0);
          setOpen(true);
        }}
        // A plain onBlur would fire before a row's onClick, closing the
        // list first and swallowing the click — each row's onMouseDown
        // below prevents that default instead, so blur only needs to
        // handle every other way focus leaves (tab away, click elsewhere).
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="Search wallets…"
        className={inputClass}
        aria-label="Wallet"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listId}
      />
      {open && (
        <ul
          id={listId}
          className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-fg-muted">No wallets match</li>
          ) : (
            filtered.map((o, i) => (
              <li key={o.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(o.id)}
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm ${
                    i === highlight ? "bg-surface-raised" : ""
                  } ${o.id === value ? "text-accent" : "text-fg"} hover:bg-surface-raised`}
                >
                  <span>{o.name}</span>
                  {o.address && <span className="text-xs text-fg-muted">{truncateAddress(o.address)}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function PerformanceChart({
  options,
  initialWalletId,
  emptyStateAction,
  backfillNudge,
}: {
  options: WalletSeriesOption[];
  /** From the page's own `?wallet=` search param — set by the sidebar's
   * "Recent" analytics-wallet links, which have no client state to hand
   * off directly (see navItems.tsx). Wins over whatever was persisted
   * from a previous visit, and itself becomes the new persisted choice. */
  initialWalletId?: string;
  /** Rendered instead of the chart when no wallet has any price-history
   * data cached yet — the "Backfill history" CTA, owned by the page since
   * it's a server action form. */
  emptyStateAction: ReactNode;
  /** Same "Backfill history" action, sized for an inline nudge next to the
   * coverage caption — shown only when the *selected* wallet has holdings
   * a re-click could actually help (a resolved key with no cached data
   * yet), not for ones nothing can ever price (manual/DeFi). */
  backfillNudge: ReactNode;
}) {
  const [walletId, setWalletId] = usePersistedState(WALLET_STORAGE_KEY, "all");

  useEffect(() => {
    if (initialWalletId) setWalletId(initialWalletId);
    // setWalletId is re-declared every render (usePersistedState's setter
    // isn't memoized), but it only closes over setValue (stable, from
    // useState) and the constant WALLET_STORAGE_KEY — so the stale
    // reference this closure captures behaves identically to a fresh one,
    // and omitting it from the deps is safe. Only initialWalletId should
    // actually re-trigger this, e.g. clicking a different "Recent" wallet
    // link while already on /analytics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWalletId]);

  const selected = options.find((o) => o.id === walletId) ?? options[0];

  useEffect(() => {
    // Records this as a recently-selected Analytics wallet — see
    // recentWallets.ts, and CollapsibleNavItem's "analyticsWallets"
    // namespace in the sidebar. "All wallets" isn't a specific wallet, so
    // it's excluded (mirrors wallets/[id]/page.tsx's RecordRecentWallet,
    // which only exists per-wallet in the first place).
    if (selected.id === "all") return;
    recordRecentWallet("analyticsWallets", { id: selected.id, name: selected.name });
  }, [selected.id, selected.name]);

  const hasAnyHistory = options.some((o) => o.points.length > 0);

  if (!hasAnyHistory) {
    return (
      <Panel title="Performance">
        <p className="text-sm text-fg-muted">
          No historical prices cached yet — fetch up to a year of history for your current holdings to see
          how their value has moved over time. Runs in the background (a few minutes for a large portfolio) —
          check back and refresh once it&rsquo;s done.
        </p>
        <div className="mt-3">{emptyStateAction}</div>
      </Panel>
    );
  }

  return (
    <Panel title="Performance">
      {options.length > 1 && (
        <div className="mb-3">
          <WalletCombobox options={options} value={selected.id} onChange={setWalletId} />
        </div>
      )}

      <ValueChart points={selected.points} rangeStorageKey={RANGE_STORAGE_KEY} />

      <div className="mt-3 space-y-1 text-xs text-fg-muted">
        {selected.coveragePct < 100 && (
          <p>
            Estimate based on {selected.coveragePct.toFixed(0)}% of current value.
            {selected.unresolvedCount > 0 &&
              ` ${formatUsd(selected.unresolvedUsd)} across ${selected.unresolvedCount} holding${
                selected.unresolvedCount === 1 ? "" : "s"
              } (manual entries, DeFi positions) can't be priced historically.`}
            {selected.uncachedCount > 0 &&
              ` ${formatUsd(selected.uncachedUsd)} across ${selected.uncachedCount} more holding${
                selected.uncachedCount === 1 ? "" : "s"
              } just ${
                selected.uncachedCount === 1 ? "hasn't had its" : "haven't had their"
              } price history fetched yet.`}
          </p>
        )}
        {selected.uncachedCount > 0 && (
          <div className="flex items-center gap-2">
            {backfillNudge}
            <span>runs in the background — refresh in a bit</span>
          </div>
        )}
        <p>
          Dashed portion is estimated from today&rsquo;s holdings at historical prices — it doesn&rsquo;t
          reflect past buys or sells. Solid portion is real, captured daily.
        </p>
        {selected.points.some((p) => p.kind === "estimated") && selected.points.some((p) => p.kind === "real") && (
          <p>
            * A range that crosses from the estimate into real snapshots links the two by their own % moves.
            The step where real snapshots begin isn&rsquo;t a gain or loss (the estimate leaves out holdings
            without price history), so it isn&rsquo;t counted.
          </p>
        )}
      </div>
    </Panel>
  );
}
