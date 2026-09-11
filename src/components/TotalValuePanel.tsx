import type { ReactNode } from "react";
import { formatUsd } from "@/lib/format";
import { Panel } from "./ui/Panel";

/**
 * The "Total value" summary block shared by every page that shows a
 * portfolio/wallet/protocol total — portfolio, assets, defi, dashboard,
 * wallets list, and a single wallet's detail page. Only the genuinely
 * identical part (the label + big number) is pulled out here; each page's
 * own caption lines below it (an unpriced-count warning, a blended 24h
 * change, a sync-error notice, wallet notes...) stay page-specific,
 * composed via children in whatever order/combination that page needs —
 * this used to be six independently hand-copied versions of the whole
 * block (three near-identical, two each extended with a different extra
 * line, and one that silently dropped the unpriced warning other pages
 * all show for the same underlying data).
 */
export function TotalValuePanel({ total, children }: { total: number; children?: ReactNode }) {
  return (
    <Panel className="mb-6">
      <p className="text-sm text-fg-muted">Total value</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums text-fg">{formatUsd(total)}</p>
      {children}
    </Panel>
  );
}
