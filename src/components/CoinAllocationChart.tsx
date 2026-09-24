"use client";

import type { AssetGroup } from "@/lib/queries";
import { formatShare, formatUsd } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";
import { Panel } from "./ui/Panel";
import { useHideBalance } from "./HideBalanceProvider";

const MASK = "••••••";

// A fixed categorical palette rather than deriving a color per-ticker
// (e.g. hashing the symbol) — this app has no per-asset brand-color data,
// and a hashed color can't guarantee two adjacent slices look distinct.
// Assigned by rank (biggest holding first), so the same coin can get a
// different color across users/over time — acceptable here since the
// legend is always shown right next to the ring, unlike a standalone
// color-coded key meant to be memorized.
const PALETTE = [
  "#f59e0b",
  "#8b5cf6",
  "#22c55e",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
  "#eab308",
];
const OTHER_COLOR = "#64748b";

// Top N individually, everything else folded into one "Other" slice —
// unbounded slices (this app's own users hold 30+ distinct tickers, see
// the SuperVerse/Polymarket investigations earlier this session) would
// render as a ring of slivers too thin to read or color distinctly.
const MAX_SLICES = 7;

interface Slice {
  key: string;
  label: string;
  iconUrl: string | null;
  usd: number;
  share: number;
  color: string;
  count: number;
}

function buildSlices(groups: AssetGroup[], total: number): Slice[] {
  const priced = groups.filter((g) => g.total > 0).sort((a, b) => b.total - a.total);
  const top = priced.slice(0, MAX_SLICES);
  const rest = priced.slice(MAX_SLICES);
  const restTotal = rest.reduce((sum, g) => sum + g.total, 0);

  const slices: Slice[] = top.map((g, i) => ({
    key: g.tickerKey,
    label: g.ticker,
    iconUrl: g.iconUrl,
    usd: g.total,
    share: total > 0 ? g.total / total : 0,
    color: PALETTE[i % PALETTE.length],
    count: 1,
  }));

  if (restTotal > 0) {
    slices.push({
      key: "__other__",
      label: `Other (${rest.length})`,
      iconUrl: null,
      usd: restTotal,
      share: total > 0 ? restTotal / total : 0,
      color: OTHER_COLOR,
      count: rest.length,
    });
  }

  return slices;
}

/**
 * Donut chart of portfolio value by coin — reported directly (a
 * screenshot from another app), placed above the Assets table. Pure SVG,
 * no charting dependency (this app has none installed, and a ring made of
 * N stroked-circle arcs is simple enough not to earn one) — a plain
 * `<circle>` per slice with `strokeDasharray`/`strokeDashoffset`, the
 * standard technique for an SVG donut, rotated -90deg so the first slice
 * starts at 12 o'clock like the reference screenshot.
 *
 * Only priced holdings contribute (an unpriced group has no `total` to
 * show a slice for — same "missing ≠ 0" rule as everywhere else in this
 * app, not a 0%-width sliver). Renders nothing at all if there's no
 * priced value yet, rather than an empty ring.
 *
 * Stacks vertically on narrow screens (ring above the legend list, both
 * full-width) and side-by-side from `sm:` up — verified against a ~400px
 * viewport, this app's own established mobile-width bar.
 *
 * The legend's per-coin $ figures mask under the shared privacy toggle
 * (useHideBalance, see HideBalanceProvider's own doc comment) — reported
 * directly: hiding the total elsewhere on the page should hide these too,
 * since they're raw dollar figures derived from the same portfolio, not
 * an individual holding's own market price. The ring itself and every %
 * figure stay visible either way — a relative proportion doesn't reveal
 * portfolio size the way an absolute dollar amount does, same reasoning
 * TotalValuePanel's own doc comment already applies elsewhere. This makes
 * the component a client component (the hook is client-only), unlike the
 * rest of this page's server-rendered tree — data still arrives as plain
 * props from the Server Component parent, nothing else changes.
 */
export function CoinAllocationChart({ groups, total, className = "mb-4" }: { groups: AssetGroup[]; total: number; className?: string }) {
  const { hidden } = useHideBalance();
  const slices = buildSlices(groups, total);
  if (slices.length === 0) return null;

  const size = 200;
  const strokeWidth = 26;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const biggest = slices[0];
  // Cumulative offsets via a pure reduce, not a mutated running-total
  // variable — the React Compiler's immutability lint (real error, caught
  // by the gate before shipping) flags any reassignment of a variable
  // captured across a component's own render body, even outside JSX
  // itself, since it can't prove that's safe to memoize.
  const arcs = slices.reduce<{ list: (Slice & { dash: number; offset: number })[]; running: number }>(
    (acc, s) => {
      const dash = s.share * circumference;
      const offset = -acc.running * circumference;
      return { list: [...acc.list, { ...s, dash, offset }], running: acc.running + s.share };
    },
    { list: [], running: 0 },
  ).list;

  return (
    <Panel title="Coin allocation" className={`@container ${className}`}>
      {/* Side by side only when the panel itself is wide enough (a container
          query, not a viewport one): in the half-width slot beside Chain
          allocation, a viewport breakpoint put the ring and legend in a row
          wider than the panel, pushing the ring against its edge. The ring
          is smaller there, and the legend shrinks (names truncate) rather
          than pushing the ring. */}
      <div className="flex flex-col items-center gap-6 @md:flex-row @md:justify-center @2xl:gap-10">
        <div className="relative shrink-0">
          <svg viewBox={`0 0 ${size} ${size}`} className="size-40 -rotate-90 @2xl:size-[200px]">
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-border)" strokeWidth={strokeWidth} />
            {arcs.map((s) => {
              // 0-length dasharray segments (a slice with no share, shouldn't
              // happen given the `total > 0` filter above, but defensive)
              // would otherwise draw a stray full-circumference stroke.
              if (s.dash <= 0) return null;
              return (
                <circle
                  key={s.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${s.dash} ${circumference - s.dash}`}
                  strokeDashoffset={s.offset}
                />
              );
            })}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
            <TokenIcon ticker={biggest.label} url={biggest.iconUrl} />
            <span className="text-lg font-semibold text-fg">{formatShare(biggest.usd, total)}</span>
            <span className="text-xs text-fg-muted">{biggest.label}</span>
          </div>
        </div>

        {/* A grid sized to its content, not a fixed-width list with
            justify-between, so the name sits right next to its figures. */}
        <ul className="grid w-full max-w-xs min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] @md:flex-1">
          {slices.map((s) => (
            <li key={s.key} className="contents">
              <span className="flex min-w-0 items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} aria-hidden="true" />
                {s.key === "__other__" ? (
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-raised text-[10px] font-medium text-fg-muted">
                    ···
                  </span>
                ) : (
                  <TokenIcon ticker={s.label} url={s.iconUrl} size="sm" />
                )}
                <span className="truncate text-fg">{s.label}</span>
              </span>
              <span className="hidden text-right text-xs tabular-nums text-fg-muted sm:block">{hidden ? MASK : formatUsd(s.usd)}</span>
              <span className="text-right tabular-nums text-fg-muted">{formatShare(s.usd, total)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
