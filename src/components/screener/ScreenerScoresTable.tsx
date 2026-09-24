"use client";

import { AlertTriangle } from "lucide-react";
import { TIER_LABEL, TIER_CLASS, RULE_LABEL } from "@/lib/screener/labels";
import type { ScreenerRow, SetupTagValue, TierValue } from "@/lib/screener/queries";
import { formatCompactUsd, formatPercent } from "@/lib/format";
import { tableClass, theadRowClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";

type SortKey = "rank" | "percentile" | "name" | "tag" | "grade" | "mom3w" | "mom12w" | "tier" | "confidence" | "sector" | "marketCap";
type Sort = { key: SortKey; dir: "asc" | "desc" };
// Graded view: rank ascending (1, 2, 3…) so the numbering reads in order on
// load. The insufficient-history view has no rank; it defaults to its placed
// percentile, highest first.
const DEFAULT_SORT_GRADED: Sort = { key: "rank", dir: "asc" };
const DEFAULT_SORT_INSUFFICIENT: Sort = { key: "percentile", dir: "desc" };

const TAG_ORDER: Record<SetupTagValue, number> = { LEADER: 5, SPECULATIVE: 4, NEUTRAL: 3, WATCH: 2, AVOID: 1 };
const TIER_ORDER: Record<TierValue, number> = { pass: 3, caution: 2, high_risk: 1 };
const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 } as const;
const GRADE_ORDER: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };

function sortValue(row: ScreenerRow, key: SortKey): number | string {
  switch (key) {
    case "rank": // resolved against rankOf in the comparator (rank isn't a row field)
    case "percentile":
      return row.timingPercentile ?? -Infinity;
    case "name":
      return row.name;
    case "tag":
      return row.tag ? TAG_ORDER[row.tag] : -Infinity;
    case "grade":
      return row.grade ? GRADE_ORDER[row.grade] : -Infinity;
    case "mom3w":
      return row.mom3w ?? -Infinity;
    case "mom12w":
      return row.mom12w ?? -Infinity;
    case "tier":
      return TIER_ORDER[row.tier];
    case "confidence":
      return CONFIDENCE_ORDER[row.confidence];
    case "sector":
      return row.sectorBucket ?? "";
    case "marketCap":
      return row.marketCapUsd ?? -Infinity;
  }
}

const TAG_CLASS: Record<SetupTagValue, string> = {
  LEADER: "border-positive/40 bg-positive/10 text-positive",
  SPECULATIVE: "border-warning/40 bg-warning/10 text-warning",
  AVOID: "border-negative/40 bg-negative/10 text-negative",
  WATCH: "border-border text-fg",
  NEUTRAL: "border-border text-fg-muted",
};


/** Momentum is a ratio (0.12 = +12% vs BTC); formatPercent takes percent units. */
function MomCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-fg-muted">—</span>;
  return <span className={`tabular-nums ${value > 0 ? "text-positive" : value < 0 ? "text-negative" : ""}`}>{formatPercent(value * 100)}</span>;
}

/**
 * The Phase 3 screener table. Two uses, same columns minus grade/tag:
 * - "graded": rated assets with both momentum legs, ranked by Score B.
 * - "insufficient": rated assets with ONE momentum leg — scored and placed
 *   against the graded set's distribution but never graded or tagged (a
 *   one-leg score keeps the full 0-1 range and lands at the extremes by
 *   construction; SPEC, Phase 3). Kept visually separate so a placed
 *   percentile is never read as a rank.
 * Percentile is Score B's percentile among graded (full-history) assets.
 */
export function ScreenerScoresTable({ rows, variant }: { rows: ScreenerRow[]; variant: "graded" | "insufficient" }) {
  const graded = variant === "graded";
  // ".v2": the graded key's default changed from percentile to rank; a new
  // key so a previously saved sort (e.g. by grade) doesn't override it once.
  const [rawSort, setSort] = usePersistedState<Sort>(
    graded ? "cryptoport:screenerScoresSort.v2" : "cryptoport:screenerInsufficientSort",
    graded ? DEFAULT_SORT_GRADED : DEFAULT_SORT_INSUFFICIENT,
  );
  const sort = !graded && rawSort.key === "rank" ? DEFAULT_SORT_INSUFFICIENT : rawSort;
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: SortKey) {
    // Rank reads naturally 1 → n; every other column starts highest-first.
    const firstDir = key === "rank" ? "asc" : "desc";
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: firstDir });
  }

  // Rank = position by Score B percentile (ties share a rank), fixed however
  // the table is sorted. Insufficient-history rows are never ranked.
  const rankOf = new Map<string, number>();
  if (graded) {
    const byPct = [...rows].sort((a, b) => (b.timingPercentile ?? -1) - (a.timingPercentile ?? -1));
    byPct.forEach((r, i) => rankOf.set(r.assetId, i > 0 && r.timingPercentile === byPct[i - 1].timingPercentile ? rankOf.get(byPct[i - 1].assetId)! : i + 1));
  }
  const valueOf = (r: ScreenerRow, key: SortKey) => (key === "rank" ? (rankOf.get(r.assetId) ?? Infinity) : sortValue(r, key));

  const sorted = [...rows].sort((a, b) => {
    const av = valueOf(a, sortKey);
    const bv = valueOf(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    const primary = sortDir === "desc" ? -cmp : cmp;
    if (primary !== 0) return primary;
    // Tie-break (always the same direction): rank ascending, so e.g. sorting
    // by Grade lists the A's as 1, 2, 3… instead of in arbitrary order.
    const tie = graded ? (rankOf.get(a.assetId) ?? Infinity) - (rankOf.get(b.assetId) ?? Infinity) : (b.timingPercentile ?? -1) - (a.timingPercentile ?? -1);
    return tie !== 0 ? tie : a.name.localeCompare(b.name);
  });
  const header = (label: string, key: SortKey, className = "") => (
    <SortableHeader label={label} sortKeyValue={key} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={className} />
  );

  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr className={theadRowClass}>
            {graded && header("Rank", "rank")}
            {header("Asset", "name")}
            {graded && header("Setup", "tag")}
            {graded && header("Grade", "grade")}
            {header(graded ? "Percentile" : "Placed at", "percentile")}
            {header("Mom 3w", "mom3w")}
            {header("Mom 12w", "mom12w")}
            {header("Risk tier", "tier")}
            {header("Confidence", "confidence", hideOnMobileClass)}
            {header("Sector", "sector", hideOnMobileClass)}
            {header("Market cap", "marketCap", hideOnMobileClass)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.assetId} className={trClass}>
              {graded && <td className={`${tdClass} tabular-nums text-fg-muted`}>{rankOf.get(row.assetId)}</td>}
              <td className={tdClass}>
                <div className="flex items-center gap-1.5">
                  {row.sourceConflict && (
                    <AlertTriangle
                      className="size-3.5 shrink-0 text-warning"
                      aria-label="DefiLlama and CoinGecko disagree on this asset's market cap by more than the configured threshold"
                    />
                  )}
                  <span className="font-medium text-fg">{row.ticker.toUpperCase()}</span>
                  <span className="truncate text-fg-muted">{row.name}</span>
                </div>
              </td>
              {graded && (
                <td className={tdClass}>
                  {row.tag ? (
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TAG_CLASS[row.tag]}`}>{row.tag}</span>
                  ) : (
                    <span className="text-fg-muted">—</span>
                  )}
                </td>
              )}
              {graded && (
                <td className={tdClass}>
                  <span className="font-medium">{row.grade ?? "—"}</span>
                  {row.grade !== row.gradeRaw && row.gradeRaw && (
                    <span className="ml-1 text-xs text-fg-muted" title="High risk caps the displayed grade at C">
                      (raw {row.gradeRaw})
                    </span>
                  )}
                </td>
              )}
              <td className={`${tdClass} tabular-nums`}>
                {row.timingPercentile === null ? "—" : `${(row.timingPercentile * 100).toFixed(0)}`}
              </td>
              <td className={tdClass}>
                <MomCell value={row.mom3w} />
              </td>
              <td className={tdClass}>
                <MomCell value={row.mom12w} />
              </td>
              <td className={tdClass}>
                <span className={TIER_CLASS[row.tier]} title={row.firedRules.map((r) => RULE_LABEL[r] ?? r).join("; ") || undefined}>
                  {TIER_LABEL[row.tier]}
                </span>
                <span className="ml-1 text-xs text-fg-muted" title="Tier rules that could be evaluated (a rule with missing data doesn't fire)">
                  {row.rulesEvaluable}/4
                </span>
              </td>
              <td className={`${tdClass} ${hideOnMobileClass} capitalize text-fg-muted`}>{row.confidence}</td>
              <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{row.sectorBucket?.replaceAll("_", " ") ?? "—"}</td>
              <td className={`${tdClass} ${hideOnMobileClass} tabular-nums`}>
                {row.marketCapUsd === null ? <span className="text-fg-muted">—</span> : formatCompactUsd(row.marketCapUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
