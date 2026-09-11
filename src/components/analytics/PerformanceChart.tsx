"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { StitchedPoint } from "@/lib/analytics";
import { formatUsd, formatUsdSigned, formatPercent } from "@/lib/format";
import { scalePoints, linePath, areaPath } from "@/lib/chart";
import { usePersistedState } from "../usePersistedState";
import { Panel } from "../ui/Panel";
import { Button } from "../ui/Button";
import { inputClass } from "../ui/Field";

const WIDTH = 600;
const HEIGHT = 220;
const PADDING_Y = 16;

export interface WalletSeriesOption {
  /** "all" for the blended total across every wallet. */
  id: string;
  name: string;
  /** null for the "all" option, and for a wallet with no address on file. */
  address: string | null;
  points: StitchedPoint[];
  coveragePct: number;
  uncoveredCount: number;
}

type RangeKey = "7d" | "30d" | "90d" | "1y" | "all";

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", days: null },
];

const WALLET_STORAGE_KEY = "cryptoport:analyticsWallet";
const RANGE_STORAGE_KEY = "cryptoport:analyticsRange";

function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Duplicated from walletAuth.ts's truncateAddress rather than imported —
// that module carries a real `import "server-only"` guard (it pulls in
// viem/siwe), which throws if bundled into a client component like this
// one. A 1-line presentational helper is the documented exception to
// "don't duplicate real logic" for exactly this boundary (see CLAUDE.md).
function truncateAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

function sliceToRange(points: StitchedPoint[], days: number | null): StitchedPoint[] {
  if (days === null || points.length === 0) return points;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  return points.filter((p) => p.date >= cutoffDate);
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5">
      {options.map((opt) => (
        <Button
          key={opt.key}
          type="button"
          variant={value === opt.key ? "primary" : "secondary"}
          size="sm"
          className={value === opt.key ? "" : "border-none bg-transparent"}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
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
  emptyStateAction,
}: {
  options: WalletSeriesOption[];
  /** Rendered instead of the chart when no wallet has any price-history
   * data cached yet — the "Backfill history" CTA, owned by the page since
   * it's a server action form. */
  emptyStateAction: ReactNode;
}) {
  const [walletId, setWalletId] = usePersistedState(WALLET_STORAGE_KEY, "all");
  const [range, setRange] = usePersistedState<RangeKey>(RANGE_STORAGE_KEY, "90d");

  const selected = options.find((o) => o.id === walletId) ?? options[0];
  const rangeDays = RANGES.find((r) => r.key === range)?.days ?? 90;

  const sliced = useMemo(() => sliceToRange(selected.points, rangeDays), [selected, rangeDays]);

  const hasAnyHistory = options.some((o) => o.points.length > 0);

  if (!hasAnyHistory) {
    return (
      <Panel title="Performance">
        <p className="text-sm text-fg-muted">
          No historical prices cached yet — fetch up to a year of history for your current holdings to see
          how their value has moved over time.
        </p>
        <div className="mt-3">{emptyStateAction}</div>
      </Panel>
    );
  }

  return (
    <Panel title="Performance">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {options.length > 1 && <WalletCombobox options={options} value={selected.id} onChange={setWalletId} />}
        <ToggleGroup options={RANGES.map((r) => ({ key: r.key, label: r.label }))} value={range} onChange={setRange} />
      </div>

      {sliced.length < 2 ? (
        <p className="mt-4 text-sm text-fg-muted">Not enough data in this range yet — try a wider one.</p>
      ) : (
        <Chart points={sliced} />
      )}

      <div className="mt-3 space-y-1 text-xs text-fg-muted">
        {selected.coveragePct < 100 && (
          <p>
            Estimate based on {selected.coveragePct.toFixed(0)}% of current value
            {selected.uncoveredCount > 0 &&
              ` — ${selected.uncoveredCount} holding${selected.uncoveredCount === 1 ? "" : "s"} (manual entries, DeFi positions) couldn't be priced historically`}
            .
          </p>
        )}
        <p>
          Dashed portion is estimated from today&rsquo;s holdings at historical prices — it doesn&rsquo;t
          reflect past buys or sells. Solid portion is real, captured daily.
        </p>
      </div>
    </Panel>
  );
}

function Chart({ points }: { points: StitchedPoint[] }) {
  const coords = scalePoints(
    points.map((p) => p.total),
    WIDTH,
    HEIGHT,
    PADDING_Y,
  );

  const seamIndex = points.findIndex((p) => p.kind === "real");
  const estimatedCoords = seamIndex === -1 ? coords : coords.slice(0, seamIndex + 1);
  const realCoords = seamIndex === -1 ? [] : coords.slice(seamIndex);

  const first = points[0].total;
  const last = points[points.length - 1].total;
  const deltaUsd = last - first;
  const deltaPct = first !== 0 ? (deltaUsd / first) * 100 : 0;
  const trendClass = deltaUsd >= 0 ? "text-positive" : "text-negative";

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums text-fg">{formatUsd(last)}</span>
        <span className={`text-sm font-medium tabular-nums ${trendClass}`}>
          {formatUsdSigned(deltaUsd)} ({formatPercent(deltaPct)})
        </span>
      </div>
      <div className={trendClass}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="mt-2 h-52 w-full"
          role="img"
          aria-label="Portfolio value over time"
        >
          {estimatedCoords.length > 1 && (
            <path
              d={linePath(estimatedCoords)}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeDasharray="5,5"
              strokeOpacity={0.6}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {realCoords.length > 1 && (
            <>
              <path d={areaPath(coords, WIDTH, HEIGHT)} fill="currentColor" fillOpacity={0.08} stroke="none" />
              <path
                d={linePath(realCoords)}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          {realCoords.length === 0 && (
            <path d={areaPath(coords, WIDTH, HEIGHT)} fill="currentColor" fillOpacity={0.08} stroke="none" />
          )}
        </svg>
      </div>
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>{shortDate(points[0].date)}</span>
        {seamIndex > 0 && <span>snapshots start {shortDate(points[seamIndex].date)}</span>}
        <span>{shortDate(points[points.length - 1].date)}</span>
      </div>
    </div>
  );
}
