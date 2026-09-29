// Wallet Watch Discord alerts (owner 2026-09-28): a live delivery posts only
// when it changes the picture, not per transaction — Risk's 51 BAGSPAY buys
// are "opened", then "added $1K", "added $5K". Buys of a coin less than an
// hour apart are one burst (spam-like DCA); a buy an hour or more after the
// coin's previous one starts a new burst, which posts — and pings — once it
// reaches $100 (Bacon adding to AURORA). Judged by comparing the
// coin's day (coinDays, the activity table's own numbers) before and after
// the delivery's new legs, so a repeat of the same delivery posts nothing.
// Pure.

import type { CoinDay } from "./watchActivity.ts";
import { formatPrice, formatUsd, formatUsdSigned } from "./format.ts";

/** Nothing under this much trading posts (a test buy, dust). */
export const ALERT_MIN_USD = 100;
/** Today's buys of one coin post again at each of these. */
export const ADD_STEPS_USD = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
/** A trim posts at each of these shares of the position sold. */
export const TRIM_STEPS = [0.25, 0.5, 0.75];
/** Buys of one coin closer than this are one burst. */
export const BURST_GAP_MS = 60 * 60_000;
/** Worth less than this is "nothing held" (a leftover isn't a position). */
const DUST_USD = 1;

export type WatchAlertKind = "opened" | "resumed" | "added" | "soldOut" | "trimmed";

export interface WatchAlert {
  kind: WatchAlertKind;
  ticker: string;
  contract: string | null;
  /** The message without the trader's name. */
  text: string;
  /** Opens, new bursts of buying and full exits ping the owner's Discord role. */
  ping: boolean;
}

/** The coin's latest trade price, else its average exit or entry. */
function priceOf(c: CoinDay): number | null {
  const t = c.trades.find((x) => x.usd !== null && x.qty > 0);
  return t ? t.usd! / t.qty : (c.avgExitUsd ?? c.avgEntryUsd);
}

/** The highest step in (prev, now], or null. */
function crossed(steps: readonly number[], prev: number, now: number): number | null {
  return [...steps].reverse().find((s) => prev < s && now >= s) ?? null;
}

const pay = (qty: number | null, ticker: string | null) => (qty !== null && ticker ? `${qty < 1 ? qty.toFixed(3) : qty.toFixed(2)} ${ticker} ` : "");
const pct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;

function result(c: CoinDay): string {
  if (c.realizedUsd !== null) return `${formatUsdSigned(c.realizedUsd)}${c.realizedPct !== null ? ` (${pct(c.realizedPct)})` : ""}`;
  return c.soldUsd !== null ? `received ${formatUsd(c.soldUsd)}` : "size unknown";
}

/** What a delivery changed, per coin it touched. */
export function watchAlerts(before: readonly CoinDay[], after: readonly CoinDay[], newTxIds: ReadonlySet<string>): WatchAlert[] {
  const prev = new Map(before.map((c) => [c.assetKey, c]));
  const out: WatchAlert[] = [];
  for (const c of after) {
    if (!c.trades.some((t) => newTxIds.has(t.txId))) continue;
    const b = prev.get(c.assetKey);
    const price = priceOf(c);
    const worth = (qty: number) => (price === null ? null : qty * price);
    const alert = (kind: WatchAlertKind, text: string) => out.push({ kind, ticker: c.ticker, contract: c.contract, text, ping: kind !== "added" && kind !== "trimmed" });
    const bought = c.boughtUsd ?? 0;
    const boughtBefore = b?.boughtUsd ?? 0;
    const sold = c.soldUsd ?? 0;

    // Opened: not held at the morning read, and today's buys reach the minimum.
    const heldAtRead = worth(c.heldBefore);
    if (heldAtRead !== null && heldAtRead < DUST_USD && bought >= ALERT_MIN_USD && boughtBefore < ALERT_MIN_USD) {
      const buys = c.buys === 1 ? "" : `${c.buys} buys, `;
      const entry = c.avgEntryUsd !== null ? ` at ${formatPrice(c.avgEntryUsd)}` : "";
      alert("opened", `🟢 opened **${c.ticker}**: ${buys}${pay(c.boughtPay, c.payTicker)}(${formatUsd(bought)})${c.buys === 1 ? entry : entry.replace(" at", " avg entry")}`);
    } else {
      // A new burst: the latest buys, back to a gap of an hour or more (or to
      // the first buy today of a coin held at the read — never the opening
      // burst, which "opened" covered). Posts once it reaches the minimum.
      const buys = c.trades.filter((t) => t.side === "buy").sort((x, y) => x.at.localeCompare(y.at));
      let start = buys.length - 1;
      while (start > 0 && Date.parse(buys[start].at) - Date.parse(buys[start - 1].at) < BURST_GAP_MS) start--;
      const burst = buys.slice(start);
      const isNewBurst = start > 0 || (heldAtRead !== null && heldAtRead >= DUST_USD);
      const burstUsd = (ts: typeof burst) => ts.reduce((s, t) => s + (t.usd ?? 0), 0);
      const burstNow = burstUsd(burst);
      const burstBefore = burstUsd(burst.filter((t) => !newTxIds.has(t.txId)));
      const resumed = isNewBurst && burst.some((t) => newTxIds.has(t.txId)) && burstBefore < ALERT_MIN_USD && burstNow >= ALERT_MIN_USD;
      if (resumed) {
        const pauseMs = start > 0 ? Date.parse(buys[start].at) - Date.parse(buys[start - 1].at) : null;
        const pause = pauseMs !== null ? ` after ${pauseMs >= 86_400_000 ? `${Math.floor(pauseMs / 86_400_000)}d` : `${Math.floor(pauseMs / 3_600_000)}h`} without buying` : "";
        const paid = burst.every((t) => t.payTicker === burst[0].payTicker && t.payQty !== null) ? pay(burst.reduce((s, t) => s + t.payQty!, 0), burst[0].payTicker) : "";
        const n = burst.length === 1 ? "" : `${burst.length} buys, `;
        const held = worth(c.holdingQty);
        alert("resumed", `🔵 added to **${c.ticker}**${pause}: ${n}${paid}(${formatUsd(burstNow)})${held !== null ? ` · now holds ${formatUsd(held)}` : ""}`);
      }
      // The day's size steps — unless this delivery already posted the burst.
      const step = crossed(ADD_STEPS_USD, boughtBefore, bought);
      if (step !== null && !resumed) {
        const entry = c.avgEntryUsd !== null ? `, avg entry ${formatPrice(c.avgEntryUsd)}` : "";
        alert("added", `➕ has added **${formatUsd(step)}** of **${c.ticker}** today (${c.buys} buy${c.buys === 1 ? "" : "s"}${entry})`);
      }
    }

    // Sold out: something was held before this delivery, nothing is now.
    const holdingBefore = b ? b.holdingQty : c.heldBefore;
    const nowWorth = worth(c.holdingQty);
    const beforeWorth = worth(holdingBefore);
    if (nowWorth !== null && beforeWorth !== null && nowWorth < DUST_USD && beforeWorth >= DUST_USD && sold >= ALERT_MIN_USD) {
      alert("soldOut", `🔴 sold out of **${c.ticker}**: ${result(c)}`);
      continue;
    }
    // Trimmed: a quarter, a half, three quarters of the position sold.
    const position = (x: CoinDay) => x.heldBefore + x.boughtQty;
    const share = position(c) > 0 ? c.soldQty / position(c) : 0;
    const shareBefore = b && position(b) > 0 ? b.soldQty / position(b) : 0;
    const trim = crossed(TRIM_STEPS, shareBefore, share);
    if (trim !== null && sold >= ALERT_MIN_USD) {
      alert("trimmed", `🟠 trimmed **${c.ticker}** by ${Math.round(share * 100)}%: ${result(c)}${c.realizedUsd !== null ? " on what was sold" : ""}`);
    }
  }
  return out;
}

/** One Discord message: the role ping (opens and full exits, when a role is
 * set), who, what, and the contract to copy. */
export function alertMessage(trader: string, a: WatchAlert, link: string | null, roleId: string | null): string {
  const lines = [`${a.ping && roleId ? `<@&${roleId}> ` : ""}**${trader}** ${a.text}`];
  if (a.contract) lines.push(`\`${a.contract}\``);
  if (link) lines.push(`<${link}>`);
  return lines.join("\n");
}
