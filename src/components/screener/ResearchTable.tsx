"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { ResearchRow, TierValue } from "@/lib/screener/queries";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "name" | "sector" | "revenue" | "fees" | "marketCap" | "ps" | "pf" | "capture" | "mom3w" | "mom12w" | "beta" | "tier";
type Sort = { key: SortKey; dir: "asc" | "desc" };
const DEFAULT_SORT: Sort = { key: "revenue", dir: "desc" };

const TIER_ORDER: Record<TierValue, number> = { pass: 3, caution: 2, high_risk: 1 };
const TIER_LABEL: Record<TierValue, string> = { pass: "Pass", caution: "Caution", high_risk: "High risk" };
const TIER_CLASS: Record<TierValue, string> = { pass: "text-fg", caution: "text-warning", high_risk: "text-negative" };
const RULE_LABEL: Record<string, string> = {
  dilution_high: "dilution > 25%/yr",
  unlocks_90d: "unlocks > 5% in 90d",
  revenue_90d_drop: "revenue down > 40% vs prior 90d",
  dilution_caution: "dilution > 10%/yr",
};
const GATE_LABEL: Record<string, string> = {
  core_data: "missing data",
  out_of_scope: "out of scope",
  mcap_floor: "mcap < $10M",
  liquidity: "volume < $2M",
  revenue_floor: "revenue < $1M/yr",
  unlock_overhang: "unlock overhang",
  collapsing_revenue: "revenue collapse",
};

/** null = missing: always sorted last, whichever direction. */
function sortValue(r: ResearchRow, key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return r.name;
    case "sector":
      return r.sectorBucket ?? "";
    case "revenue":
      return r.revAnn;
    case "fees":
      return r.feesAnn;
    case "marketCap":
      return r.marketCapUsd;
    case "ps":
      return r.psCirc;
    case "pf":
      return r.pfCirc;
    case "capture":
      return r.capture;
    case "mom3w":
      return r.mom3w;
    case "mom12w":
      return r.mom12w;
    case "beta":
      return r.betaBtc;
    case "tier":
      return r.tier ? TIER_ORDER[r.tier] : null;
  }
}

const muted = <span className="text-fg-muted">—</span>;
const usd = (v: number | null) => (v === null ? muted : <span className="tabular-nums">{formatCompactUsd(v)}</span>);
const multiple = (v: number | null) => (v === null ? muted : <span className="tabular-nums">{v.toFixed(1)}×</span>);
/** Ratios stored as fractions (0.12 = 12%). */
function Pct({ value, signed = true }: { value: number | null; signed?: boolean }) {
  if (value === null) return muted;
  const cls = signed ? (value > 0 ? "text-positive" : value < 0 ? "text-negative" : "") : "";
  return <span className={`tabular-nums ${cls}`}>{signed ? formatPercent(value * 100) : `${(value * 100).toFixed(0)}%`}</span>;
}

/**
 * The screener's DEFAULT view (decided 2026-09-23 after Phase 4): a research
 * table, not a ranking. Verified fundamentals, kill-filter status, the risk
 * tier, valuation and momentum as plain sortable columns — no grade, tag or
 * ranked order, because the Phase 4 backtest found no predictive value for
 * the momentum ranking (SPEC, "Product"). Default sort: annualized revenue.
 */
export function ResearchTable({ rows }: { rows: ResearchRow[] }) {
  const [sort, setSort] = usePersistedState<Sort>("cryptoport:screenerResearchSort", DEFAULT_SORT);
  const [showUnrated, setShowUnrated] = useState(false);
  const { key: sortKey, dir: sortDir } = sort;
  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }
  const visible = showUnrated ? rows : rows.filter((r) => r.rated);
  const unratedCount = rows.filter((r) => !r.rated).length;
  const sorted = [...visible].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });
  const header = (label: string, key: SortKey, className = "") => (
    <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />
  );

  return (
    <>
      <label className="mb-2 flex items-center gap-2 px-5 text-sm text-fg-muted">
        <input type="checkbox" checked={showUnrated} onChange={(e) => setShowUnrated(e.target.checked)} />
        Include the {unratedCount} assets that failed a kill filter (shown with the filters they failed)
      </label>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr className={theadRowClass}>
              {header("Asset", "name")}
              {header("Sector", "sector", hideOnMobileClass)}
              {header("Revenue (ann.)", "revenue")}
              {header("Fees (ann.)", "fees", hideOnMobileClass)}
              {header("Market cap", "marketCap")}
              {header("P/S", "ps")}
              {header("P/F", "pf", hideOnMobileClass)}
              {header("Value capture", "capture", hideOnMobileClass)}
              {header("Mom 3w vs BTC", "mom3w")}
              {header("Mom 12w vs BTC", "mom12w", hideOnMobileClass)}
              {header("Beta", "beta", hideOnMobileClass)}
              {header("Risk tier", "tier")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.assetId} className={`${trClass} ${r.rated ? "" : "opacity-60"}`}>
                <td className={tdClass}>
                  <div className="flex items-center gap-1.5">
                    {r.sourceConflict && (
                      <AlertTriangle
                        className="size-3.5 shrink-0 text-warning"
                        aria-label="DefiLlama and CoinGecko disagree on this asset's market cap by more than the configured threshold"
                      />
                    )}
                    <span className="font-medium text-fg">{r.ticker.toUpperCase()}</span>
                    <span className="truncate text-fg-muted">{r.name}</span>
                  </div>
                  {!r.rated && <div className="text-xs text-fg-muted">Failed: {r.failedGates.map((g) => GATE_LABEL[g] ?? g).join(", ")}</div>}
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{r.sectorBucket?.replaceAll("_", " ") ?? "—"}</td>
                <td className={tdClass}>{usd(r.revAnn)}</td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>{usd(r.feesAnn)}</td>
                <td className={tdClass}>{usd(r.marketCapUsd)}</td>
                <td className={tdClass}>{multiple(r.psCirc)}</td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>{multiple(r.pfCirc)}</td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>
                  <Pct value={r.capture} signed={false} />
                </td>
                <td className={tdClass}>
                  <Pct value={r.mom3w} />
                </td>
                <td className={`${tdClass} ${hideOnMobileClass}`}>
                  <Pct value={r.mom12w} />
                </td>
                <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>{r.betaBtc === null ? muted : r.betaBtc.toFixed(2)}</td>
                <td className={tdClass}>
                  {r.tier ? (
                    <>
                      <span className={TIER_CLASS[r.tier]} title={r.firedRules.map((x) => RULE_LABEL[x] ?? x).join("; ") || undefined}>
                        {TIER_LABEL[r.tier]}
                      </span>
                      <span className="ml-1 text-xs text-fg-muted" title="Tier rules that could be evaluated (a rule with missing data doesn't fire)">
                        {r.rulesEvaluable}/4
                      </span>
                    </>
                  ) : (
                    muted
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
