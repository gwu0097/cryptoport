"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { Attribution, AttributionWindow, WalletAttribution } from "@/lib/analytics/attribution";
import { Dialog } from "@/components/ui/Dialog";
import { useLazyDialog } from "@/components/ui/useLazyDialog";
import { formatPercent, formatQty, formatUsd, formatUsdSigned } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { usePersistedState } from "@/components/usePersistedState";

const WINDOWS: { key: AttributionWindow; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
];
const TOP = 6;

const tone = (n: number | null) => (n === null ? "text-fg-muted" : n > 0 ? "text-positive" : n < 0 ? "text-negative" : "text-fg");
const signed = (n: number | null) => (n === null ? "—" : formatUsdSigned(n));

const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Figure({ label, value, caption, onClick }: { label: string; value: number | null; caption: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="text-xs text-fg-muted">
        {label}
        {onClick && <span className="ml-1 text-accent">· by wallet →</span>}
      </p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone(value)}`}>{signed(value)}</p>
      <p className="mt-1 text-xs text-fg-muted">{caption}</p>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="rounded-lg border border-border bg-surface-raised/40 p-3 text-left transition hover:border-accent/60">
      {body}
    </button>
  ) : (
    <div className="rounded-lg border border-border bg-surface-raised/40 p-3">{body}</div>
  );
}

/** Where "everything else" came from, wallet by wallet (attributeByWallet). */
function ByWalletList({ rows, removedUsd, totalOtherUsd, exact }: { rows: WalletAttribution[]; removedUsd: number; totalOtherUsd: number | null; exact: boolean }) {
  const shown = rows.filter((w) => w.otherUsd === null || Math.abs(w.otherUsd) >= 1);
  const quiet = rows.length - shown.length;
  // What the wallet rows don't account for, so the list always adds up to the
  // headline: wallets without a snapshot that day, and snapshot-time drift.
  const accounted = rows.reduce((s, w) => s + (w.otherUsd ?? 0), 0) + removedUsd;
  const remainder = totalOtherUsd === null ? null : totalOtherUsd - accounted;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-fg-muted">
        Each wallet&apos;s change since its own daily snapshot, minus what price moves explain. What&apos;s left is deposits, withdrawals, trades,
        perp profit and funding, rewards — or a wallet added since.{" "}
        {exact
          ? "Measured from what each wallet held at the snapshot, coin by coin."
          : "Estimated: this window's snapshot predates coin-by-coin records, so price moves come from each coin's own close on the snapshot day (or, without one, its 24h/7d/30d change) on what's held now."}
      </p>
      <ul className="divide-y divide-border/60">
        {shown.map((w) => (
          <li key={w.id} className="py-2">
            <div className="flex items-baseline justify-between gap-3">
              <Link href={`/wallets/${w.id}`} className="font-medium text-fg hover:text-accent hover:underline" title="Open this wallet">
                {w.name} →
              </Link>
              <span className={`tabular-nums font-semibold ${tone(w.otherUsd)}`}>{signed(w.otherUsd)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-muted">
              {w.added ? (
                <span className="text-accent">added since the snapshot — its whole value ({formatUsd(w.liveUsd)}) is new</span>
              ) : w.actualUsd === null ? (
                <span>no snapshot for this wallet on that day</span>
              ) : (
                <>
                  <span>
                    change {signed(w.actualUsd)} · price {signed(w.priceUsd)}
                  </span>
                  <span>
                    {w.baseUsd !== null && formatUsd(w.baseUsd)} → {formatUsd(w.liveUsd)}
                  </span>
                </>
              )}
              {!w.exact && w.positionsUsd > 0 && <span title="Perp margin, LP and other protocol positions change value with profit, funding and rewards, not a coin price">{formatUsd(w.positionsUsd)} in positions/perps</span>}
              {!w.exact && w.unattributedCount > 0 && <span>{w.unattributedCount} holdings without a price change for this window</span>}
            </div>
            {w.exact && (
              <ul className="mt-1 space-y-0.5 text-xs">
                {w.exact.coins.map((c) => (
                  <li key={c.ticker} className="flex justify-between gap-3">
                    <span className="text-fg-muted">
                      {c.ticker} {formatQty(c.qtyBefore)} → {formatQty(c.qtyAfter)}
                      {c.revalued && <span className="text-warning"> · now unpriced or illiquid (still held)</span>}
                    </span>
                    <span className={`tabular-nums ${tone(c.usd)}`}>{signed(c.usd)}</span>
                  </li>
                ))}
                {Math.abs(w.exact.positionsUsd) >= 1 && (
                  <li className="flex justify-between gap-3" title="Perp margin and protocol positions move with profit, funding and rewards">
                    <span className="text-fg-muted">Positions / perps</span>
                    <span className={`tabular-nums ${tone(w.exact.positionsUsd)}`}>{signed(w.exact.positionsUsd)}</span>
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
        {remainder !== null && Math.abs(remainder) >= 1 && (
          <li className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-fg-muted" title="Wallets with no snapshot on that day, and the difference between the portfolio's snapshot and its wallets' snapshots">
              Not split by wallet
            </span>
            <span className={`tabular-nums font-semibold ${tone(remainder)}`}>{signed(remainder)}</span>
          </li>
        )}
        {removedUsd !== 0 && (
          <li className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-fg-muted">Wallets removed or deactivated since</span>
            <span className={`tabular-nums font-semibold ${tone(removedUsd)}`}>{signed(removedUsd)}</span>
          </li>
        )}
      </ul>
      {quiet > 0 && <p className="text-xs text-fg-muted">{quiet} more wallets changed by less than $1 beyond price.</p>}
    </div>
  );
}

function MoverRow({ c, scale }: { c: Attribution["contributions"][number]; scale: number }) {
  return (
    <li className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 text-sm">
      <span className="truncate font-medium text-fg" title={c.ticker}>
        {c.ticker}
      </span>
      <span className="h-2 rounded-full bg-surface-raised">
        <span
          className={`block h-2 rounded-full ${c.usd >= 0 ? "bg-positive/70" : "bg-negative/70"}`}
          style={{ width: `${Math.max(2, (Math.abs(c.usd) / scale) * 100)}%` }}
        />
      </span>
      <span className="text-right tabular-nums">
        <span className={tone(c.usd)}>{formatUsdSigned(c.usd)}</span> <span className="text-xs text-fg-muted">({formatPercent(c.changePct)})</span>
      </span>
    </li>
  );
}

/** Price contributors one way: the biggest TOP, then the rest behind a
 * toggle in a scrolling list — so the two sides add up to "From price
 * moves" (on a broad red day most of it is the long tail). Bars are scaled
 * to the largest of all. */
function Movers({ title, rows, scale }: { title: string; rows: Attribution["contributions"]; scale: number }) {
  const [open, setOpen] = useState(false);
  const top = rows.slice(0, TOP);
  const rest = rows.slice(TOP);
  const restUsd = rest.reduce((s, c) => s + c.usd, 0);
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">None</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {top.map((c) => (
              <MoverRow key={c.key} c={c} scale={scale} />
            ))}
          </ul>
          {rest.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="mt-1.5 grid w-full grid-cols-[4.5rem_1fr_auto] items-center gap-2 rounded text-left text-sm text-fg-muted hover:text-fg"
              >
                <span className="col-span-2 inline-flex items-center gap-1">
                  <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
                  {open ? "Hide" : "+"} {rest.length} more coin{rest.length === 1 ? "" : "s"}
                </span>
                <span className={`text-right tabular-nums ${tone(restUsd)}`}>{formatUsdSigned(restUsd)}</span>
              </button>
              {open && (
                <ul className="mt-1.5 max-h-72 space-y-1.5 overflow-y-auto overscroll-contain border-t border-border/60 pr-1 pt-1.5">
                  {rest.map((c) => (
                    <MoverRow key={c.key} c={c} scale={scale} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What moved the portfolio (analytics/attribution.ts): the total change since
 * a daily snapshot, split into price moves on today's holdings and
 * everything else.
 */
export function AttributionPanel({
  byWindow,
  byWallet,
}: {
  byWindow: Record<AttributionWindow, Attribution>;
  byWallet: Record<AttributionWindow, { wallets: WalletAttribution[]; removedUsd: number }>;
}) {
  const { dialogRef, open, openDialog } = useLazyDialog();
  const [window, setWindow] = usePersistedState<AttributionWindow>("cryptoport:analyticsAttributionWindow", "7d");
  const a = byWindow[window] ?? byWindow["7d"];
  const allGains = a.contributions.filter((c) => c.usd > 0);
  const allDrags = a.contributions.filter((c) => c.usd < 0);
  // Whatever of the price figure isn't in a listed coin (should be ~0).
  const unlisted = a.priceUsd - a.contributions.reduce((s, c) => s + c.usd, 0);
  const scale = Math.max(1, ...[...allGains.slice(0, TOP), ...allDrags.slice(0, TOP)].map((c) => Math.abs(c.usd)));

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center justify-between gap-2">
          What moved your portfolio
          <ToggleGroup options={WINDOWS} value={window} onChange={setWindow} />
        </span>
      }
      className="mb-4"
    >
      {a.building ? (
        // No coin-by-coin snapshot covers this window yet: nothing shown
        // rather than an estimate (owner 2026-10-02).
        <p className="text-sm text-fg-muted">
          Still building — this needs a daily snapshot that records each coin, and none covers this window yet. The first is taken at the
          next daily snapshot (06:00 UTC); check back tomorrow.
        </p>
      ) : (
      <>
      {a.shortened && (
        <p className="mb-3 rounded-lg border border-border bg-surface-raised/40 px-3 py-2 text-xs text-fg-muted">
          Showing the last <span className="font-medium text-fg">{a.shortened.days} day{a.shortened.days === 1 ? "" : "s"}</span> (since{" "}
          {SHORT_DATE.format(new Date(`${a.base?.date}T00:00:00Z`))}) — the coin-by-coin snapshots this needs start then. The full{" "}
          {WINDOWS.find((x) => x.key === window)?.label} view starts {SHORT_DATE.format(new Date(`${a.shortened.fullFrom}T00:00:00Z`))}.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure
          label="Total change"
          value={a.actualUsd}
          caption={a.base ? `Since the ${a.base.date} daily snapshot` : "No daily snapshot from the start of this window yet"}
        />
        <Figure
          label="From price moves"
          value={a.priceUsd}
          caption="What was held at the snapshot gained or lost from price alone"
        />
        <Figure
          label="From everything else"
          value={a.otherUsd}
          caption="Coins bought, sold, sent or received, wallets added, positions opened or closed, rewards — never a price move"
          onClick={openDialog}
        />
      </div>
      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <Movers key={`gains-${window}`} title="Biggest gains from price" rows={allGains} scale={scale} />
        <Movers key={`drags-${window}`} title="Biggest losses from price" rows={allDrags} scale={scale} />
      </div>
      <p className="mt-3 text-xs text-fg-muted">
        {allGains.length + allDrags.length} coins moved on price: {allGains.length} up ({formatUsdSigned(allGains.reduce((s, c) => s + c.usd, 0))}), {allDrags.length} down (
        {formatUsdSigned(allDrags.reduce((s, c) => s + c.usd, 0))}).
        {Math.abs(unlisted) >= 1 && <> {formatUsdSigned(unlisted)} of the price figure isn&apos;t in a single coin.</>}
      </p>
      {a.unattributed.tickers.length > 0 && (
        <p className="mt-4 text-xs text-fg-muted">
          {a.unattributed.tickers.length} holdings have no {window} price change to split out (protocol positions, perp margin, tokens
          whose price source gives no {window} change); their moves land in &ldquo;everything else&rdquo;.
        </p>
      )}
      </>
      )}
      <Dialog ref={dialogRef} title={`Everything else, by wallet · ${WINDOWS.find((x) => x.key === window)?.label}`}>
        {open && <ByWalletList rows={(byWallet[window] ?? byWallet["7d"]).wallets} removedUsd={(byWallet[window] ?? byWallet["7d"]).removedUsd} totalOtherUsd={a.otherUsd} exact={!!a.exact} />}
      </Dialog>
    </Panel>
  );
}
