import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { AgeText } from "@/components/AgeText";
import { requestNowSec } from "@/lib/requestClock";
import { getAssetFundamentals, type AssetFundamentals } from "@/lib/screener/assetView";
import { TIER_LABEL, TIER_CLASS, RULE_LABEL, GATE_LABEL } from "@/lib/screener/labels";
import { formatCompactUsd, formatPercent, formatPrice } from "@/lib/format";
import { FundamentalsHistoryChart } from "./FundamentalsHistoryChart";

// Every field is always shown; a value the dataset doesn't have reads "N/A"
// (asked for directly: "Don't hide it just because it's not there").
const NA = <span className="text-fg-muted">N/A</span>;
const usd = (v: number | null | undefined) => (v == null ? NA : <span className="tabular-nums">{formatCompactUsd(v)}</span>);
const price = (v: number | null | undefined) => (v == null ? NA : <span className="tabular-nums">{formatPrice(v)}</span>);
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
/** Supply counts: "15.43M", not token-precision decimals. */
const qty = (v: number | null | undefined) => (v == null ? NA : <span className="tabular-nums" title={v.toLocaleString("en-US")}>{COMPACT.format(v)}</span>);
const multiple = (v: number | null | undefined) =>
  v == null ? NA : <span className="tabular-nums">{v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×</span>;
/** Stored as fractions (0.12 = 12%). */
const pct = (v: number | null | undefined, signed = false) => {
  if (v == null) return NA;
  // Float noise that rounds to 0.00% (BTC's momentum vs BTC) is zero, not a red "-0.00%".
  if (Math.abs(v * 100) < 0.005) v = 0;
  const cls = signed ? (v > 0 ? "text-positive" : v < 0 ? "text-negative" : "") : "";
  return <span className={`tabular-nums ${cls}`}>{signed ? formatPercent(v * 100) : `${(v * 100).toFixed(1)}%`}</span>;
};
const num = (v: number | null | undefined) => (v == null ? NA : <span className="tabular-nums">{v.toFixed(2)}</span>);

function Field({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 text-sm last:border-b-0">
      <span className="text-fg-muted" title={hint}>
        {label}
        {hint && <span className="ml-1 cursor-help text-xs opacity-60">ⓘ</span>}
      </span>
      <span className="text-right text-fg">{value}</span>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Panel title={title} description={description}>
      <div>{children}</div>
    </Panel>
  );
}

/**
 * The Encyclopedia's Fundamentals tab: this coin's row of the Fundamentals
 * dataset (internally "screener"), read from what the daily job already
 * stored. A research dataset, not a signal — no grade, score or rank here
 * (SPEC "Product"); the full cross-asset table is /screener.
 */
export async function FundamentalsTab({ geckoId, name }: { geckoId: string; name: string }) {
  const f = await getAssetFundamentals(geckoId);
  const nowSec = requestNowSec();
  const s = f?.snapshot ?? null;
  const m = f?.metrics ?? null;
  const failed = m ? Object.entries(m.gateStatus).filter(([, r]) => r === "fail").map(([g]) => GATE_LABEL[g] ?? g) : [];
  const notEvaluable = m ? Object.entries(m.gateStatus).filter(([, r]) => r === "not_evaluable").map(([g]) => GATE_LABEL[g] ?? g) : [];

  return (
    <div className="space-y-6">
      <Panel>
        {f === null ? (
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-fg">{name} isn&rsquo;t in the Fundamentals dataset.</span> It tracks tokens of
            revenue-generating protocols and chains that DefiLlama reports fees for, so every figure below is N/A. Nothing is
            estimated for coins outside it.
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <span>
                Status:{" "}
                {m === null ? (
                  NA
                ) : m.rated ? (
                  <span className="font-medium text-fg">Rated</span>
                ) : (
                  <span className="font-medium text-warning">Unrated</span>
                )}
                {m && !m.rated && failed.length > 0 && <span className="text-fg-muted"> — failed: {failed.join(", ")}</span>}
              </span>
              <span className="text-fg-muted">
                Sector (DefiLlama category): <span className="text-fg">{f.asset.sector ?? "N/A"}</span>
              </span>
              <span className="text-fg-muted">
                Data: {f.run ? <>daily run of {f.run.startedAt.slice(0, 10)} (UTC), <AgeText at={f.run.startedAt} serverNowSec={nowSec} /></> : "N/A"}
              </span>
            </div>
            {notEvaluable.length > 0 && (
              <p className="text-xs text-fg-muted">Filters that couldn&rsquo;t be evaluated (no data, so neither pass nor fail): {notEvaluable.join(", ")}.</p>
            )}
            {f.run?.degraded && (
              <p className="flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="size-3.5" aria-hidden="true" /> This day&rsquo;s run was degraded (CoinGecko unavailable): market cap and supply are N/A for it.
              </p>
            )}
            {f.conflicts.map((c) => (
              <p key={c.field} className="flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="size-3.5" aria-hidden="true" /> Sources disagree on {c.field.replaceAll("_", " ")}: {c.sourceA}{" "}
                {c.valueA === null ? "N/A" : formatCompactUsd(c.valueA)} vs {c.sourceB} {c.valueB === null ? "N/A" : formatCompactUsd(c.valueB)}
                {c.pctDiff !== null ? ` (${(c.pctDiff * 100).toFixed(0)}% apart)` : ""}.
              </p>
            ))}
            {f.snapshot === null && f.run && <p className="text-xs text-fg-muted">No snapshot for this asset in the latest run — current figures are N/A.</p>}
          </div>
        )}
        <p className="mt-3 text-xs text-fg-muted">
          A verified research dataset, not a signal: no grade, score or rank is shown, because the backtest found no predictive value.{" "}
          <Link href="/screener" className="text-accent hover:underline">
            Compare across every asset in Fundamentals →
          </Link>
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Quality & Risk" description="A risk tier, not a grade: worst rule wins. A rule without its input data doesn't fire.">
          <Field label="Tier" value={f?.tier ? <span className={`font-medium ${TIER_CLASS[f.tier.value]}`}>{TIER_LABEL[f.tier.value]}</span> : NA} />
          {(f?.tier?.rules.length ? f.tier.rules : Object.keys(RULE_LABEL).map((rule) => ({ rule, fired: null }))).map((r) => (
            <Field
              key={r.rule}
              label={RULE_LABEL[r.rule] ?? r.rule}
              value={r.fired === null || !f?.tier ? NA : r.fired ? <span className="text-negative">fired</span> : <span className="text-fg-muted">not fired</span>}
            />
          ))}
          <Field label="Rules with data" value={f?.tier ? `${f.tier.rulesEvaluable} of ${f.tier.rules.length}` : NA} />
        </Section>

        <Section title="Revenue & fees" description="From DefiLlama. Annualized = the latest 30 days × 365/30.">
          <Field label="Revenue (annualized)" value={usd(m?.revAnn)} />
          <Field label="Fees (annualized)" value={usd(m?.feesAnn)} />
          <Field label="Holders revenue (annualized)" value={usd(m?.holdersRevAnn)} hint="DefiLlama's holders revenue. Its 0 can mean either no holder mechanism or not tracked, so value capture and buyback yield below only use it for tokens with a documented mechanism." />
          <Field label="Revenue (30d)" value={usd(s?.revenue30d)} />
          <Field label="Fees (30d)" value={usd(s?.fees30d)} />
          <Field label="Holders revenue (30d)" value={usd(s?.holdersRevenue30d)} />
          <Field label="Value capture" value={pct(m?.capture)} hint="Holders revenue ÷ revenue, last 30 days. N/A unless the token has a documented holder value mechanism (buyback, burn, staking share)." />
          <Field label="Buyback yield" value={pct(m?.buybackYield)} hint="Annualized holders revenue ÷ market cap. N/A unless the token has a documented holder value mechanism." />
          <Field label="Revenue pace (30d vs 90d)" value={pct(m?.revGrowth, true)} />
          <Field label="Revenue, 90d vs prior 90d" value={pct(m?.rev90dChange, true)} />
        </Section>

        <Section title="Valuation & supply" description="Market data from CoinGecko at the daily run.">
          <Field label="Price" value={price(s?.priceUsd)} />
          <Field label="Market cap" value={usd(s?.marketCapUsd)} />
          <Field label="Fully diluted valuation" value={usd(s?.fdvUsd)} />
          <Field label="P/S (circulating)" value={multiple(m?.psCirc)} />
          <Field label="P/S (fully diluted)" value={multiple(m?.psFd)} />
          <Field label="P/F (circulating)" value={multiple(m?.pfCirc)} />
          <Field label="P/F (fully diluted)" value={multiple(m?.pfFd)} />
          <Field label="TVL" value={usd(s?.tvlUsd)} />
          <Field label="Market cap ÷ TVL" value={multiple(m?.mcTvl)} hint="Only computed for sectors where TVL is the business (e.g. lending, liquid staking)." />
          <Field label="Volume (24h)" value={usd(s?.volume24hUsd)} />
          <Field label="Circulating supply" value={qty(s?.circulatingSupply)} />
          <Field label="Total supply" value={qty(s?.totalSupply)} />
          <Field label="Max supply" value={qty(s?.maxSupply)} />
          <Field label="Float" value={pct(m?.floatRatio)} hint="Circulating supply ÷ max supply (total supply when there is no max)." />
          <Field label="Dilution (measured)" value={pct(m?.dilutionRate, true)} hint="Annualized growth of circulating supply from live daily snapshots — the only dilution that can move the risk tier." />
          <Field label="Dilution (implied)" value={pct(m?.dilutionRateImplied, true)} hint="From backfilled market cap ÷ price. Display only; never drives the tier." />
        </Section>

        <Section title="Descriptive market behavior" description="Plain description of past moves, not a prediction.">
          <Field label="Momentum vs BTC (3 weeks)" value={pct(m?.mom3w, true)} />
          <Field label="Momentum vs BTC (12 weeks)" value={pct(m?.mom12w, true)} />
          <Field label="Beta vs BTC" value={num(m?.betaBtc)} />
          <div className="mt-4">
            <p className="mb-1 text-sm text-fg-muted">Revenue sources (DefiLlama)</p>
            {s && s.contributingSlugs.length > 0 ? (
              <ul className="space-y-0.5 text-sm">
                {s.contributingSlugs.map((slug) => (
                  <li key={slug}>
                    <a href={`https://defillama.com/protocol/${slug}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      {slug}
                    </a>
                    {slug === f?.asset.defillamaSlug && <span className="ml-1.5 text-xs text-fg-muted">(primary)</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">{NA}</p>
            )}
          </div>
        </Section>
      </div>

      <FundamentalsHistory f={f} />
    </div>
  );
}

function FundamentalsHistory({ f }: { f: AssetFundamentals | null }) {
  const points = f?.history ?? [];
  const hasData = points.some((p) => p.fees30d !== null || p.revenue30d !== null || p.holdersRevenue30d !== null);
  const firstLive = points.find((p) => !p.isBackfilled)?.date;
  return (
    <Panel
      title="History"
      description="Rolling 30-day fees, revenue and holders revenue, one point per UTC day. Faded points are backfilled from DefiLlama history; full-color points were captured by the daily job on the day."
    >
      {hasData ? (
        <>
          <FundamentalsHistoryChart points={points} />
          <p className="mt-2 text-xs text-fg-muted">
            {points.length} days, {points[0].date} to {points[points.length - 1].date}
            {firstLive ? ` · daily capture since ${firstLive}` : " · all backfilled"}. A missing day is a gap, never a zero.
          </p>
        </>
      ) : (
        <p className="text-sm text-fg-muted">N/A — no stored fee or revenue history for this coin.</p>
      )}
    </Panel>
  );
}
