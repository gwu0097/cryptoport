"use client";

import type { Attribution, AttributionWindow } from "@/lib/analytics/attribution";
import { formatPercent, formatUsdSigned } from "@/lib/format";
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

function Figure({ label, value, caption }: { label: string; value: number | null; caption: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised/40 p-3">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone(value)}`}>{signed(value)}</p>
      <p className="mt-1 text-xs text-fg-muted">{caption}</p>
    </div>
  );
}

/** Biggest price contributors one way, bars scaled to the largest of all. */
function Movers({ title, rows, scale }: { title: string; rows: Attribution["contributions"]; scale: number }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">None</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c) => (
            <li key={c.key} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 text-sm">
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
                <span className={tone(c.usd)}>{formatUsdSigned(c.usd)}</span>{" "}
                <span className="text-xs text-fg-muted">({formatPercent(c.changePct)})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What moved the portfolio (analytics/attribution.ts): the total change since
 * a daily snapshot, split into price moves on today's holdings and
 * everything else.
 */
export function AttributionPanel({ byWindow }: { byWindow: Record<AttributionWindow, Attribution> }) {
  const [window, setWindow] = usePersistedState<AttributionWindow>("cryptoport:analyticsAttributionWindow", "7d");
  const a = byWindow[window] ?? byWindow["7d"];
  const gains = a.contributions.filter((c) => c.usd > 0).slice(0, TOP);
  const drags = a.contributions.filter((c) => c.usd < 0).slice(0, TOP);
  const scale = Math.max(1, ...[...gains, ...drags].map((c) => Math.abs(c.usd)));

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
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure
          label="Total change"
          value={a.actualUsd}
          caption={a.base ? `Since the ${a.base.date} daily snapshot` : "No daily snapshot from the start of this window yet"}
        />
        <Figure label="From price moves" value={a.priceUsd} caption="What today's holdings gained or lost from price alone" />
        <Figure
          label="From everything else"
          value={a.otherUsd}
          caption="Deposits, withdrawals, wallets added, trades, positions opened or closed, rewards"
        />
      </div>
      <div className="mt-5 grid gap-6 md:grid-cols-2">
        <Movers title="Biggest gains from price" rows={gains} scale={scale} />
        <Movers title="Biggest losses from price" rows={drags} scale={scale} />
      </div>
      {a.unattributed.tickers.length > 0 && (
        <p className="mt-4 text-xs text-fg-muted">
          {a.unattributed.tickers.length} holdings have no {window} price change to split out (protocol positions, perp margin, tokens
          whose price source gives no {window} change); their moves land in &ldquo;everything else&rdquo;.
        </p>
      )}
    </Panel>
  );
}
