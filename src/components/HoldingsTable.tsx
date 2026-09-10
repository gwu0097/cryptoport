"use client";

import { useState } from "react";
import { ArrowUp, ArrowDown, ChevronsUpDown, Trash } from "lucide-react";
import type { HoldingWithValuation } from "@/lib/queries";
import { formatUsd, formatQty, formatTicker } from "@/lib/format";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "./ui/table";
import { inputClass } from "./ui/Field";
import { SubmitButton } from "./ui/SubmitButton";
import { ConfirmDeleteButton } from "./ui/ConfirmDeleteButton";
import { TokenIcon } from "./TokenIcon";
import { updateHolding, deleteHolding } from "@/app/wallets/actions";

type SortKey = "ticker" | "qty" | "price" | "value" | "category";

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : -Infinity;
}

function sortValue(holding: HoldingWithValuation, key: SortKey): number | string {
  switch (key) {
    case "ticker":
      return holding.ticker;
    case "category":
      return holding.category;
    case "qty":
      return numeric(holding.qty);
    case "price":
      return numeric(holding.price);
    case "value":
      return holding.valuation.kind === "priced" ? holding.valuation.usd : -Infinity;
  }
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronsUpDown className="size-3 text-fg-muted/50" aria-hidden="true" />;
  return dir === "desc" ? (
    <ArrowDown className="size-3" aria-hidden="true" />
  ) : (
    <ArrowUp className="size-3" aria-hidden="true" />
  );
}

function Header({
  label,
  sortKeyValue,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  sortKeyValue: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  return (
    <th className={thClass}>
      <button type="button" onClick={() => onSort(sortKeyValue)} className="flex items-center gap-1 hover:text-fg">
        {label}
        <SortIcon active={sortKey === sortKeyValue} dir={sortDir} />
      </button>
    </th>
  );
}

// A holding manually added into an otherwise-auto wallet (see
// wallets/[id]/page.tsx — the adapter doesn't always catch everything, e.g.
// a DeFi position) — editable/deletable in place, same as the plain
// manual-wallet table's own edit form. Auto-sourced holdings stay
// read-only: their values come from the last sync, not something to
// hand-edit.
function ManualHoldingActions({ holding, walletId }: { holding: HoldingWithValuation; walletId: string }) {
  const update = updateHolding.bind(null, holding.id, walletId);
  return (
    <div className="flex items-center gap-2">
      <form action={update} className="flex items-center gap-2">
        {holding.source === "manual_usd" ? (
          <input
            name="usd_override"
            type="text"
            inputMode="decimal"
            defaultValue={holding.usd_override ?? ""}
            className={`${inputClass} w-24`}
          />
        ) : (
          <input
            name="qty"
            type="text"
            inputMode="decimal"
            defaultValue={holding.qty ?? ""}
            className={`${inputClass} w-24`}
          />
        )}
        <SubmitButton variant="secondary" size="sm">
          Save
        </SubmitButton>
      </form>
      <form action={deleteHolding.bind(null, holding.id, walletId)}>
        <ConfirmDeleteButton
          confirmMessage={`Delete the ${holding.ticker} holding?`}
          aria-label="Delete holding"
        >
          <Trash className="size-3.5" aria-hidden="true" />
        </ConfirmDeleteButton>
      </form>
    </div>
  );
}

/** Only the table body is interactive (re-sorting already-fetched rows in
 * the browser, no server round-trip) — everything around it (the chain
 * sections, the filter pills) stays server-rendered. Defaults to Value
 * descending, matching the server-side default sort in queries.ts.
 *
 * `walletId` is optional and, when given, adds an edit/delete column for
 * this wallet's manually-added holdings (auto-sourced ones stay read-only)
 * — omitted by the Assets and lookup pages, where holdings either span
 * many wallets or belong to no saved wallet at all, so there's no single
 * wallet_id an edit/delete action could target. */
export function HoldingsTable({
  holdings,
  walletId,
}: {
  holdings: HoldingWithValuation[];
  walletId?: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sorted = [...holdings].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : (av as number) - (bv as number);
    return sortDir === "desc" ? -cmp : cmp;
  });

  return (
    <table className={tableClass}>
      <thead>
        <tr className={theadRowClass}>
          <Header label="Ticker" sortKeyValue="ticker" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Qty" sortKeyValue="qty" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Price" sortKeyValue="price" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Value" sortKeyValue="value" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          <Header label="Category" sortKeyValue="category" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          {walletId && <th className={thClass}></th>}
        </tr>
      </thead>
      <tbody>
        {sorted.map((holding) => (
          <tr key={holding.id} className={trClass}>
            <td className={tdClass}>
              <div className="flex items-center gap-2">
                <TokenIcon ticker={holding.ticker} url={holding.icon_url} />
                {formatTicker(holding.ticker)}
              </div>
            </td>
            <td className={`${tdClass} tabular-nums`}>{formatQty(holding.qty)}</td>
            <td className={`${tdClass} tabular-nums`}>{holding.price ?? "unpriced"}</td>
            <td className={`${tdClass} tabular-nums`}>
              {holding.valuation.kind === "priced" ? (
                formatUsd(holding.valuation.usd)
              ) : (
                <span className="text-warning">unpriced</span>
              )}
            </td>
            <td className={tdClass}>
              <span className="rounded-md bg-surface-raised px-2 py-0.5 text-xs text-fg-muted">
                {holding.category}
              </span>
            </td>
            {walletId && (
              <td className={tdClass}>
                {holding.source !== "auto" && (
                  <ManualHoldingActions holding={holding} walletId={walletId} />
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
