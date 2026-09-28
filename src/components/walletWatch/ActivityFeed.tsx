import Link from "next/link";
import type { WatchMovementView } from "@/lib/watchQuery";
import { formatPercent, formatPrice, formatQty, formatUsdSigned } from "@/lib/format";
import { AgeText } from "@/components/AgeText";
import { CASH_KEYS } from "@/lib/watchActivity";
import { CopyButton } from "@/components/CopyButton";

const VERB: Record<WatchMovementView["kind"], { token: string; perp: string; prediction: string }> = {
  new: { token: "bought", perp: "opened", prediction: "bet on" },
  added: { token: "added", perp: "increased", prediction: "added to" },
  trimmed: { token: "trimmed", perp: "reduced", prediction: "sold part of" },
  exited: { token: "sold all", perp: "closed", prediction: "exited" },
};

/** SOL, USDC and the like: the coins trades are paid in. Their balance
 * moving is cash from sales or spent on buys, not an investment decision. */
const isCash = (m: WatchMovementView) => m.positionType === "token" && !!m.priceKey && CASH_KEYS.has(m.priceKey);

function what(m: WatchMovementView): string {
  if (m.positionType === "perp") return `${m.side ?? ""} ${m.ticker}`.trim();
  if (m.positionType === "prediction") return m.label ?? m.ticker;
  const qty = Math.abs(m.qtyAfter - m.qtyBefore);
  return m.kind === "exited" ? `${formatQty(m.qtyBefore)} ${m.ticker}` : `${formatQty(qty)} ${m.ticker}`;
}

/** The coin's price now and how far it has moved since the trade's price —
 * whether a buy has already run. Its age is in the tooltip. */
export function NowPrice({ nowUsd, nowAt, movePrice, serverNowSec }: { nowUsd: number; nowAt: string; movePrice: number; serverNowSec: number }) {
  const change = ((nowUsd - movePrice) / movePrice) * 100;
  return (
    <span className="text-xs text-fg-muted">
      {" · now "}
      {formatPrice(nowUsd)}{" "}
      <span className={change > 0 ? "text-positive" : change < 0 ? "text-negative" : ""}>({formatPercent(change)})</span>{" "}
      <span className="text-fg-muted/70">
        · priced <AgeText at={nowAt} serverNowSec={serverNowSec} />
      </span>
    </span>
  );
}

/**
 * What watched wallets bought and sold (watched_movements): newest first.
 * Changes between two reads (daily, or a Refresh) — a buy and sell between
 * reads doesn't show, and each move is sized at that read's price.
 */
export function ActivityFeed({ movements, serverNowSec, showNames = true }: { movements: WatchMovementView[]; serverNowSec: number; showNames?: boolean }) {
  if (movements.length === 0) {
    return <p className="text-sm text-fg-muted">No movements yet. They appear after a wallet is read a second time — daily, or when you press Refresh.</p>;
  }
  return (
    <ul className="divide-y divide-border/60">
      {movements.map((m) => {
        const buying = m.kind === "new" || m.kind === "added";
        return (
          <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
            <span className="min-w-0">
              {showNames && (
                <Link href={`/wallet-watch/${m.influencerId}`} className="font-medium text-fg hover:underline">
                  {m.influencerName}
                </Link>
              )}{" "}
              <span className={buying ? "text-positive" : "text-negative"}>{isCash(m) ? (buying ? "cash up" : "cash down") : VERB[m.kind][m.positionType]}</span>{" "}
              <span className="text-fg">{what(m)}</span>
              {m.contract && (
                <span className="ml-1 inline-flex align-middle">
                  <CopyButton value={m.contract} label={`Copy ${m.ticker} contract`} title={`Copy ${m.ticker}'s contract: ${m.contract}`} />
                </span>
              )}
              {m.priceUsd !== null && m.positionType === "token" && <span className="text-xs text-fg-muted"> at {formatPrice(m.priceUsd)}</span>}
              {m.nowUsd !== null && m.nowAt !== null && m.priceUsd !== null && m.priceUsd > 0 && (
                <NowPrice nowUsd={m.nowUsd} nowAt={m.nowAt} movePrice={m.priceUsd} serverNowSec={serverNowSec} />
              )}
            </span>
            <span className="flex items-baseline gap-3 tabular-nums">
              {m.usdDelta !== null && <span className={buying ? "text-positive" : "text-negative"}>{formatUsdSigned(m.usdDelta)}</span>}
              {m.walletShare !== null && (
                <span className="text-xs text-fg-muted" title="The size of this move as a share of the wallet's value after it">
                  {(m.walletShare * 100).toFixed(1)}% of wallet
                </span>
              )}
              <span className="text-xs text-fg-muted">
                <AgeText at={m.snapshotAt} serverNowSec={serverNowSec} />
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
