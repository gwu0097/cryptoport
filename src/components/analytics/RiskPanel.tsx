import Link from "next/link";
import type { RiskProfile } from "@/lib/analytics/risk";
import { RISK_WINDOW_DAYS } from "@/lib/analytics/risk";
import { formatShare, formatUsd, formatUsdSigned } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const TOP = 8;

function Tile({ label, value, caption, className = "" }: { label: string; value: string; caption?: string; className?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised/40 p-3">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${className || "text-fg"}`}>{value}</p>
      {caption && <p className="mt-1 text-xs text-fg-muted">{caption}</p>}
    </div>
  );
}

/**
 * How risky the portfolio is as held now (analytics/risk.ts): its swings,
 * worst fall and sensitivity to BTC over the last 90 days with prices, and
 * which holdings the swings come from.
 */
export function RiskPanel({ risk, totalUsd }: { risk: RiskProfile | null; totalUsd: number }) {
  if (!risk) {
    return (
      <Panel title="Risk profile" className="mb-4">
        <p className="text-sm text-fg-muted">
          Not enough daily price history for your holdings yet (at least 30 days in common is needed).{" "}
          <Link href="/performance" className="text-accent hover:underline">
            Backfill history on Performance
          </Link>{" "}
          fills it in.
        </p>
      </Panel>
    );
  }
  const b = risk.benchmark;
  const top = risk.assets.filter((a) => a.riskShare > 0.001).slice(0, TOP);
  const scale = Math.max(...top.map((a) => Math.max(a.weight, a.riskShare)), 0.01);

  return (
    <Panel title="Risk profile" className="mb-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Tile
          label="Volatility (annualized)"
          value={pct(risk.volatility, 0)}
          caption={b ? `BTC over the same days: ${pct(b.volatility, 0)}` : "Typical yearly swing, from daily moves"}
        />
        <Tile
          label="Worst drawdown"
          value={pct(risk.maxDrawdown)}
          className="text-negative"
          caption={b ? `Deepest fall from a peak · BTC: ${pct(b.maxDrawdown)}` : "Deepest fall from a peak"}
        />
        <Tile
          label="Worst day"
          value={pct(risk.worstDay.change, 2)}
          className="text-negative"
          caption={`${risk.worstDay.date} · best: ${pct(risk.bestDay.change, 2)} on ${risk.bestDay.date}`}
        />
        <Tile
          label="Beta to BTC"
          value={risk.beta === null ? "—" : risk.beta.toFixed(2)}
          caption={
            risk.beta === null
              ? "No BTC price history to compare with"
              : `Moves ${risk.beta.toFixed(2)}× BTC's daily move · correlation ${risk.correlation?.toFixed(2) ?? "—"}`
          }
        />
        <Tile
          label="If BTC falls 20%"
          value={risk.btcDrop20Usd === null ? "—" : formatUsdSigned(risk.btcDrop20Usd)}
          className="text-negative"
          caption={
            risk.btcDrop20Usd === null
              ? "Needs BTC price history"
              : `${formatShare(-risk.btcDrop20Usd, risk.modeledUsd)} of the modeled value, from each holding's beta`
          }
        />
        <Tile
          label="Cash-like"
          value={formatShare(risk.cashLikeUsd, risk.modeledUsd)}
          caption={`${formatUsd(risk.cashLikeUsd)} held within 2% of $1 every day`}
        />
      </div>

      <div className="mt-6">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Where your risk comes from</p>
        <p className="mt-1 text-xs text-fg-muted">
          Each holding&apos;s share of your value next to its share of your portfolio&apos;s swings. A holding whose risk bar is longer than
          its value bar moves the portfolio more than its size suggests.
        </p>
        <ul className="mt-3 space-y-2">
          {top.map((a) => (
            <li key={a.key} className="grid grid-cols-[4.5rem_1fr_7.5rem] items-center gap-2 text-sm">
              <span className="truncate font-medium text-fg" title={a.ticker}>
                {a.ticker}
              </span>
              <span className="flex flex-col gap-1">
                <span className="h-1.5 rounded-full bg-surface-raised">
                  <span className="block h-1.5 rounded-full bg-fg-muted/60" style={{ width: `${(a.weight / scale) * 100}%` }} />
                </span>
                <span className="h-1.5 rounded-full bg-surface-raised">
                  <span className="block h-1.5 rounded-full bg-warning/80" style={{ width: `${(Math.max(0, a.riskShare) / scale) * 100}%` }} />
                </span>
              </span>
              <span className="text-right text-xs tabular-nums">
                <span className="text-fg-muted">{pct(a.weight)}</span> · <span className="text-warning">{pct(a.riskShare)} risk</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-5 text-xs text-fg-muted">
        Today&apos;s holdings over the last {risk.days} days with daily prices ({risk.from} → {risk.to}, up to {RISK_WINDOW_DAYS}), covering{" "}
        {formatUsd(risk.modeledUsd)} ({formatShare(risk.modeledUsd, totalUsd)} of your value).
        {risk.unmodeled.tickers.length > 0 && (
          <>
            {" "}
            Not modeled: {formatUsd(risk.unmodeled.usd)} in {risk.unmodeled.tickers.length} holdings without enough price history (
            {risk.unmodeled.tickers.slice(0, 6).join(", ")}
            {risk.unmodeled.tickers.length > 6 ? ", …" : ""}) —{" "}
            <Link href="/performance" className="text-accent hover:underline">
              Backfill history
            </Link>{" "}
            adds the CoinGecko-listed ones.
          </>
        )}
      </p>
    </Panel>
  );
}
