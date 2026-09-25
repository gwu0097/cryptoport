"use client";

import { useState } from "react";
import type { UnrecognizedTokenRow } from "@/lib/unrecognizedTokensQuery";
import { REASON_LABEL, SPAM_LABEL } from "@/lib/unrecognizedTokens";
import { formatQty } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { usePersistedState } from "@/components/usePersistedState";
import { TruncatedAddress } from "@/components/TruncatedAddress";

type SortKey = "symbol" | "chain" | "amount" | "reason" | "firstSeen";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const STORAGE_KEY = "cryptoport:unrecognizedTokensSort";
const DEFAULT_SORT: Sort = { key: "chain", dir: "asc" };

function sortValue(r: UnrecognizedTokenRow, key: SortKey): number | string {
  switch (key) {
    case "symbol":
      return r.symbol.toLowerCase();
    case "chain":
      return r.chainName;
    case "amount":
      return r.amount ?? -1;
    case "reason":
      return r.reason;
    case "firstSeen":
      return r.firstSeenAt;
  }
}

/**
 * Tokens this wallet holds that aren't in its total (docs/sync/PLAN.md D3):
 * not on CoinGecko's list, or listed with no price. Collapsed by default;
 * tokens that look like airdrop spam (unrecognizedTokens.ts spamSign) sit
 * behind a toggle. Symbols are plain text — spam symbols carry URLs, and
 * nothing here links to them.
 */
export function UnrecognizedTokensPanel({ tokens }: { tokens: UnrecognizedTokenRow[] }) {
  const [sort, setSort] = usePersistedState<Sort>(STORAGE_KEY, DEFAULT_SORT);
  const [showSpam, setShowSpam] = useState(false);
  const { key: sortKey, dir: sortDir } = sort;

  function toggleSort(key: SortKey) {
    setSort(key === sortKey ? { key, dir: sortDir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  }

  const spamCount = tokens.filter((t) => t.spam).length;
  const shown = tokens.filter((t) => showSpam || !t.spam).sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <details id="unrecognized" className="group mb-6 rounded-xl border border-border bg-surface">
      <summary className="cursor-pointer list-none p-5 text-base font-semibold text-fg">
        <span className="mr-2 inline-block transition group-open:rotate-90">›</span>
        Unrecognized tokens <span className="font-normal text-fg-muted">({tokens.length})</span>
        <span className="mt-1 block text-sm font-normal text-fg-muted">
          Held by this wallet but not included in its total: no CoinGecko listing, or no price.
          {spamCount > 0 && ` ${spamCount} look like airdrop spam.`}
        </span>
      </summary>

      <div className="px-5 pb-5">
        {spamCount > 0 && (
          <label className="mb-3 flex items-center gap-2 text-sm text-fg-muted">
            <input type="checkbox" checked={showSpam} onChange={(e) => setShowSpam(e.target.checked)} />
            Show the {spamCount} that look like spam
          </label>
        )}
        {shown.length === 0 ? (
          <p className="text-sm text-fg-muted">Every unrecognized token here looks like spam.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <SortableHeader label="Token" sortKeyValue="symbol" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableHeader label="Chain" sortKeyValue="chain" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableHeader label="Balance" sortKeyValue="amount" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <SortableHeader label="Why" sortKeyValue="reason" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
                  <SortableHeader label="First seen" sortKeyValue="firstSeen" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className={hideOnMobileClass} />
                  <th className={`${thClass} ${hideOnMobileClass}`}>Contract</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={`${t.chain}|${t.contract}`} className={trClass}>
                    <td className={tdClass}>
                      <span className="break-all">{t.symbol}</span>
                      {t.spam && <span className="ml-2 text-xs text-warning" title={SPAM_LABEL[t.spam]}>likely spam</span>}
                    </td>
                    <td className={`${tdClass} text-fg-muted`}>{t.chainName}</td>
                    <td className={`${tdClass} tabular-nums`}>{t.amount === null ? "—" : formatQty(t.amount)}</td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{REASON_LABEL[t.reason]}</td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>{t.firstSeenAt.slice(0, 10)}</td>
                    <td className={`${tdClass} ${hideOnMobileClass}`}>
                      <TruncatedAddress address={t.contract} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
