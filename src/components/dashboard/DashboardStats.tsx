"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { formatPercent, formatUsd, formatUsdSigned } from "@/lib/format";
import type { BlendedChange } from "@/lib/dashboard";
import type { PositionsSummary } from "@/lib/positionsSummary";
import { useHideBalance } from "../HideBalanceProvider";

const MASK = "••••••";
const tone = (v: number | null) => (v === null || v === 0 ? "text-fg" : v > 0 ? "text-positive" : "text-negative");

/** One stat: a label, the number, a caption — and an action at the right
 * of all three (the number never waits below it). */
function Tile({ label, value, caption, className = "", action }: { label: ReactNode; value: ReactNode; caption?: ReactNode; className?: string; action?: ReactNode }) {
  return (
    // The action wraps under the figure when both don't fit (a phone), so
    // the figure is never cut off to make room for it.
    <div className={`flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-xl border border-border bg-surface p-4 ${className}`}>
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-xs font-medium text-fg-muted">{label}</p>
        <div className="mt-1 truncate text-xl font-semibold tabular-nums">{value}</div>
        {caption && <div className="mt-0.5 truncate text-xs text-fg-muted">{caption}</div>}
      </div>
      {action}
    </div>
  );
}

/**
 * The Dashboard's stat strip (industry convention: the headline numbers in
 * a row on top). Every figure is computed elsewhere — the total and 24h
 * change (dashboard.ts), the open positions (positionsSummary.ts), today's
 * Wallet Watch coins — the Dashboard only shows them. Dollar figures
 * derived from the total are masked with it (a $ delta next to a hidden
 * total would give it away).
 */
export function DashboardStats({
  total,
  change,
  positions,
  watch,
  refresh,
}: {
  total: number;
  change: BlendedChange | null;
  positions: PositionsSummary | null;
  /** Coins the watched wallets traded since this morning's read, and how many wallets. */
  watch: { coins: number; traders: number } | null;
  refresh: ReactNode;
}) {
  const { hidden, setHidden } = useHideBalance();
  return (
    // A grid on phones and tablets; one row from xl, the total twice as wide.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:flex [&>*]:xl:flex-1">
      <Tile
        className="col-span-2 sm:col-span-1 xl:!flex-[2]"
        label={
          <span className="inline-flex items-center gap-1">
            Total value
            <button type="button" onClick={() => setHidden(!hidden)} aria-label={hidden ? "Show total value" : "Hide total value"} aria-pressed={hidden} className="rounded p-0.5 text-fg-muted transition hover:text-fg">
              {hidden ? <EyeOff className="size-3" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
            </button>
          </span>
        }
        value={<span className="text-fg">{hidden ? MASK : formatUsd(total)}</span>}
        action={refresh}
      />
      <Tile
        label="24h change"
        value={change ? <span className={tone(change.pct)}>{formatPercent(change.pct)}</span> : <span className="text-fg-muted">—</span>}
        caption={change ? `${hidden ? "" : `${formatUsdSigned(change.usd)} · `}${change.coveragePct.toFixed(0)}% priced` : "Not enough 24h data yet"}
      />
      {positions && positions.count > 0 && (
        <Tile
          label="Open PnL"
          value={positions.pnlUsd !== null ? <span className={tone(positions.pnlUsd)}>{formatUsdSigned(positions.pnlUsd)}</span> : <span className="text-fg-muted">—</span>}
          caption={`${positions.count} open position${positions.count === 1 ? "" : "s"}${positions.unknownPnl > 0 ? ` · ${positions.unknownPnl} without PnL` : ""}`}
        />
      )}
      {positions && positions.count > 0 && (
        <Tile
          label={positions.perps > 0 ? "Margin" : "In predictions"}
          value={<span className="text-fg">{formatUsd(positions.perps > 0 ? positions.marginUsd : positions.predictionUsd)}</span>}
          caption={positions.perps > 0 && positions.predictions > 0 ? `+ ${formatUsd(positions.predictionUsd)} in predictions` : positions.perps > 0 ? `${positions.perps} perp${positions.perps === 1 ? "" : "s"}` : `${positions.predictions} market${positions.predictions === 1 ? "" : "s"}`}
        />
      )}
      {watch && (
        <Tile
          label={
            <Link href="/wallet-watch" className="hover:text-accent">
              Wallet Watch today
            </Link>
          }
          value={<span className="text-fg">{watch.coins} coin{watch.coins === 1 ? "" : "s"}</span>}
          caption={`by ${watch.traders} wallet${watch.traders === 1 ? "" : "s"} today`}
        />
      )}
    </div>
  );
}
