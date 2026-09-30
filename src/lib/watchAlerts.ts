// Wallet Watch Discord alerts (owner 2026-09-28): a live delivery posts only
// when it changes the picture, not per transaction — Risk's 51 BAGSPAY buys
// are "opened", then "added $1K", "added $5K". Buys of a coin less than an
// hour apart are one burst (spam-like DCA); a buy an hour or more after the
// coin's previous one starts a new burst, which posts once it reaches $100
// (Bacon adding to AURORA). The only ping (owner 2026-09-29: "only first
// ping over 200 is good, rest is noise"): a coin opened today, once what's
// been bought into it reaches $200 — in one buy or thirty. A sell-out within
// the hour of opening is a flip, said so on its card. Judged by comparing the
// coin's day (coinDays, the activity table's own numbers) before and after
// the delivery's new legs, so a repeat of the same delivery posts nothing.
// Every card shows the market cap at the trade's price (owner 2026-09-29:
// "a must for both buy and sell") when the coin's supply is known, and a
// sale says what it was sold into, for how much, at what price. Pure.

import type { CoinDay } from "./watchActivity.ts";
import { formatCompactUsd, formatPrice, formatUsd, formatUsdSigned } from "./format.ts";

/** Nothing under this much trading posts (a test buy, dust). */
export const ALERT_MIN_USD = 100;
/** Today's buys of one coin post again at each of these. */
export const ADD_STEPS_USD = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
/** A trim posts at each of these shares of the position sold. */
export const TRIM_STEPS = [0.25, 0.5, 0.75];
/** A position opened today pings once its buys reach this. */
export const PING_POSITION_USD = 200;
/** Buys of one coin closer than this are one burst; a position sold out
 * within this of its first buy is a flip. */
export const BURST_GAP_MS = 60 * 60_000;
/** Worth less than this is "nothing held" (a leftover isn't a position). */
const DUST_USD = 1;

export type WatchAlertKind = "opened" | "building" | "resumed" | "added" | "soldOut" | "trimmed";

export interface WatchAlert {
  kind: WatchAlertKind;
  ticker: string;
  contract: string | null;
  /** The contract's chain (holdings vocabulary: "solana", "eth", …). */
  chain: string | null;
  /** After the trader's name: "opened SBC", "sold out of H&G (flipped in 3m)". */
  headline: string;
  /** The numbers: "3.23 SOL ($384.02) at $0.00002616". */
  detail: string;
  /** Pings the owner's Discord role: only a position opened today reaching
   * $200 (at once, or "is building"). */
  ping: boolean;
  /** A close's return (%), when known: colours its card win or loss. */
  returnPct?: number | null;
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

/** How long a position was held: "13m", "3h 20m"; under an hour a flip. */
function heldText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  const d = m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return ms < BURST_GAP_MS ? `flipped in ${d}` : `held ${d}`;
}

const signedPay = (v: number, ticker: string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v) < 1 ? Math.abs(v).toFixed(3) : Math.abs(v).toFixed(2)} ${ticker}`;

/** A closed position's card (owner 2026-09-30: say plainly that it closed
 * and what it made or lost, as trading bots do): the result as a heading,
 * then what went in and came out, then the exit and how long it was held.
 * Part held before today: its cost isn't known here, so no result. */
function closeDetail(c: CoinDay, mc: string, heldMs: number | null): string {
  const r = exitReturnPct(c);
  const share = c.boughtQty > 0 ? Math.min(1, c.soldQty / c.boughtQty) : 1;
  const lines: string[] = [];
  // Discord's largest text is a "# " heading; text can't be coloured, so
  // the dot carries it (with the card's bar).
  const dot = r === null ? "" : r >= 0 ? "🟢 " : "🔴 ";
  if (r !== null && c.realizedUsd !== null) lines.push(`# ${dot}${formatUsdSigned(c.realizedUsd)} (${pct(r)})`);
  else if (r !== null && c.boughtPay !== null && c.soldPay !== null && c.payTicker) lines.push(`# ${dot}${signedPay(c.soldPay - c.boughtPay * share, c.payTicker)} (${pct(r)})`);
  else lines.push("## Closed · result unknown");
  const side = (qty: number | null, usd: number | null) => `${pay(qty, c.payTicker)}${usd !== null ? `(${formatUsd(usd)})` : ""}`.trim() || "—";
  if (!c.soldFromEarlier && c.buys > 0) lines.push(`In ${side(c.boughtPay, c.boughtUsd)} → Out ${side(c.soldPay, c.soldUsd)}`);
  else lines.push(`Out ${side(c.soldPay, c.soldUsd)}${c.soldFromEarlier ? " · some was held before today" : ""}`);
  const exit = c.avgExitUsd !== null ? `Exit ${formatPrice(c.avgExitUsd)}${mc}` : mc.replace(/^ · /, "");
  lines.push([exit, heldMs !== null ? heldText(heldMs) : ""].filter(Boolean).join(" · "));
  return lines.filter(Boolean).join("\n");
}

/** A sale's card: what it brought in (and the market cap then), then the
 * result when what was sold was bought today. */
function sellDetail(c: CoinDay, mc: string, resultSuffix: string): string {
  const lines = [`${received(c)}${mc}`];
  if (c.realizedUsd !== null) lines.push(`${result(c)}${resultSuffix}`);
  return lines.join("\n");
}

function result(c: CoinDay): string {
  if (c.realizedUsd !== null) return `${formatUsdSigned(c.realizedUsd)}${c.realizedPct !== null ? ` (${pct(c.realizedPct)})` : ""}`;
  return c.soldUsd !== null ? `received ${formatUsd(c.soldUsd)}` : "size unknown";
}

/** A whole position's return on selling out (owner 2026-09-30): in dollars
 * when every trade was sized, else in the coin it was paid with (SOL in, SOL
 * out — exact even when a trade has no dollar price). Null when some of what
 * was sold was held before today: that part's cost isn't known here. */
export function exitReturnPct(c: CoinDay): number | null {
  if (c.soldFromEarlier || c.boughtQty <= 0 || c.soldQty <= 0) return null;
  if (c.realizedPct !== null) return c.realizedPct;
  if (c.boughtPay === null || c.soldPay === null || c.boughtPay <= 0) return null;
  return ((c.soldPay / c.soldQty) / (c.boughtPay / c.boughtQty) - 1) * 100;
}

/** What a sale brought in: "received 4.12 SOL ($490.10) at $0.00001420". */
function received(c: CoinDay): string {
  const sold = c.soldUsd !== null ? `(${formatUsd(c.soldUsd)})` : "";
  const at = c.avgExitUsd !== null ? ` at ${formatPrice(c.avgExitUsd)}` : "";
  return `received ${pay(c.soldPay, c.payTicker)}${sold}${at}`.replace(/\s+/g, " ").trim();
}

/** What a delivery changed, per coin it touched. `supplyOf`: the coin's
 * circulating supply, when known — each card's market cap at its price. */
export function watchAlerts(
  before: readonly CoinDay[],
  after: readonly CoinDay[],
  newTxIds: ReadonlySet<string>,
  supplyOf: (c: CoinDay) => number | null = () => null,
): WatchAlert[] {
  const prev = new Map(before.map((c) => [c.assetKey, c]));
  const out: WatchAlert[] = [];
  for (const c of after) {
    if (!c.trades.some((t) => newTxIds.has(t.txId))) continue;
    const b = prev.get(c.assetKey);
    const price = priceOf(c);
    const supply = supplyOf(c);
    const mcAt = (p: number | null) => (supply !== null && supply > 0 && p !== null ? ` · MC ${formatCompactUsd(p * supply)}` : "");
    const worth = (qty: number) => (price === null ? null : qty * price);
    const alert = (kind: WatchAlertKind, headline: string, detail: string, ping: boolean, returnPct?: number | null) =>
      out.push({ kind, ticker: c.ticker, contract: c.contract, chain: c.contractChain, headline, detail, ping, ...(returnPct !== undefined ? { returnPct } : {}) });
    const bought = c.boughtUsd ?? 0;
    const boughtBefore = b?.boughtUsd ?? 0;
    const sold = c.soldUsd ?? 0;

    // Opened: not held at the morning read, and today's buys reach the
    // minimum; it pings if they already reach PING_POSITION_USD.
    const heldAtRead = worth(c.heldBefore);
    const openedToday = heldAtRead !== null && heldAtRead < DUST_USD;
    const entryText = (prefix: string) => (c.avgEntryUsd !== null ? `${prefix}${formatPrice(c.avgEntryUsd)}` : "");
    const buysText = c.buys === 1 ? "" : `${c.buys} buys · `;
    let posted = false; // a buy alert this delivery: the size steps don't repeat it
    if (openedToday && bought >= ALERT_MIN_USD && boughtBefore < ALERT_MIN_USD) {
      alert("opened", `opened ${c.ticker}`, `${buysText}${pay(c.boughtPay, c.payTicker)}(${formatUsd(bought)})${entryText(c.buys === 1 ? " at " : " · avg entry ")}${mcAt(c.avgEntryUsd)}`, bought >= PING_POSITION_USD);
      posted = true;
    } else if (openedToday && bought >= PING_POSITION_USD && boughtBefore < PING_POSITION_USD) {
      // A small open built up: one ping when it reaches $200.
      alert("building", `is building ${c.ticker}`, `${buysText}${pay(c.boughtPay, c.payTicker)}(${formatUsd(bought)})${entryText(" · avg entry ")}${mcAt(c.avgEntryUsd)}`, true);
      posted = true;
    } else if (!openedToday || boughtBefore >= ALERT_MIN_USD) {
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
      if (isNewBurst && burst.some((t) => newTxIds.has(t.txId)) && burstBefore < ALERT_MIN_USD && burstNow >= ALERT_MIN_USD) {
        const pauseMs = start > 0 ? Date.parse(buys[start].at) - Date.parse(buys[start - 1].at) : null;
        const pause = pauseMs !== null ? ` after ${pauseMs >= 86_400_000 ? `${Math.floor(pauseMs / 86_400_000)}d` : `${Math.floor(pauseMs / 3_600_000)}h`} without buying` : "";
        const paid = burst.every((t) => t.payTicker === burst[0].payTicker && t.payQty !== null) ? pay(burst.reduce((s, t) => s + t.payQty!, 0), burst[0].payTicker) : "";
        const n = burst.length === 1 ? "" : `${burst.length} buys · `;
        const held = worth(c.holdingQty);
        const burstQty = burst.reduce((s, t) => s + t.qty, 0);
        const burstPrice = burstQty > 0 && burst.every((t) => t.usd !== null) ? burstNow / burstQty : null;
        const at = burstPrice !== null ? ` at ${formatPrice(burstPrice)}` : "";
        alert("resumed", `added to ${c.ticker}${pause}`, `${n}${paid}(${formatUsd(burstNow)})${at}${mcAt(burstPrice)}${held !== null ? ` · now holds ${formatUsd(held)}` : ""}`, false);
        posted = true;
      }
    }
    // The day's size steps, unpinged — unless this delivery already posted.
    const step = crossed(ADD_STEPS_USD, boughtBefore, bought);
    if (step !== null && !posted) {
      alert("added", `has added ${formatUsd(step)} of ${c.ticker} today`, `${c.buys} buy${c.buys === 1 ? "" : "s"} · ${pay(c.boughtPay, c.payTicker)}(${formatUsd(bought)})${entryText(" · avg entry ")}${mcAt(c.avgEntryUsd)}`, false);
    }

    // Sold out: something was held before this delivery, nothing is now.
    const holdingBefore = b ? b.holdingQty : c.heldBefore;
    const nowWorth = worth(c.holdingQty);
    const beforeWorth = worth(holdingBefore);
    if (nowWorth !== null && beforeWorth !== null && nowWorth < DUST_USD && beforeWorth >= DUST_USD && sold >= ALERT_MIN_USD) {
      // A flip — opened today and gone within the hour — posts without a ping.
      const firstBuy = c.trades.filter((t) => t.side === "buy").map((t) => t.at).sort()[0];
      const lastSell = c.trades.filter((t) => t.side === "sell").map((t) => t.at).sort().at(-1);
      const heldMs = openedToday && firstBuy && lastSell ? Date.parse(lastSell) - Date.parse(firstBuy) : null;
      const r = exitReturnPct(c);
      alert("soldOut", `closed ${c.ticker}${r !== null ? ` · ${pct(r)}` : ""}`, closeDetail(c, mcAt(c.avgExitUsd), heldMs), false, r);
      continue;
    }
    // Trimmed: a quarter, a half, three quarters of the position sold.
    const position = (x: CoinDay) => x.heldBefore + x.boughtQty;
    const share = position(c) > 0 ? c.soldQty / position(c) : 0;
    const shareBefore = b && position(b) > 0 ? b.soldQty / position(b) : 0;
    const trim = crossed(TRIM_STEPS, shareBefore, share);
    if (trim !== null && sold >= ALERT_MIN_USD) {
      alert("trimmed", `trimmed ${c.ticker} by ${Math.round(share * 100)}%`, sellDetail(c, mcAt(c.avgExitUsd), " on what was sold"), false);
    }
  }
  return out;
}

const STYLE: Record<WatchAlertKind, { emoji: string; color: number }> = {
  opened: { emoji: "🟢", color: 0x22c55e },
  building: { emoji: "🟢", color: 0x22c55e },
  resumed: { emoji: "🔵", color: 0x3b82f6 },
  added: { emoji: "➕", color: 0x64748b },
  trimmed: { emoji: "🟠", color: 0xf59e0b },
  soldOut: { emoji: "⚪", color: 0x64748b },
};

/** A close is a win or a loss by its result; unknown stays grey. */
function styleOf(a: WatchAlert): { emoji: string; color: number } {
  if (a.kind !== "soldOut" || a.returnPct == null) return STYLE[a.kind];
  return a.returnPct >= 0 ? { emoji: "✅", color: 0x22c55e } : { emoji: "❌", color: 0xef4444 };
}

/** Where the coin trades: Fomo for Solana (its token page, checked
 * 2026-09-28); DexScreener for EVM chains whose slug it's known by. */
const DEXSCREENER: Record<string, string> = { eth: "ethereum", arb: "arbitrum", base: "base", bsc: "bsc", matic: "polygon", op: "optimism", avax: "avalanche" };
export function tokenLink(chain: string | null, contract: string | null): string | null {
  if (!contract) return null;
  if (chain === "solana") return `https://fomo.family/tokens/solana/${contract}`;
  const slug = chain ? DEXSCREENER[chain] : undefined;
  return slug ? `https://dexscreener.com/${slug}/${contract}` : null;
}

export interface DiscordEmbed {
  title: string;
  url?: string;
  description: string;
  color: number;
}

/** One alert as a Discord card: the coloured bar says what happened, the
 * title (linked to the coin's trading page) who and what, then the numbers
 * and the contract to copy. The trader's CryptoPort page is linked on an
 * open only. */
export function alertEmbed(trader: string, a: WatchAlert, traderLink: string | null): DiscordEmbed {
  const url = tokenLink(a.chain, a.contract);
  const lines = [a.detail];
  if (a.contract) lines.push(`\`${a.contract}\``);
  if (traderLink && a.kind === "opened") lines.push(`[${trader} on CryptoPort](${traderLink})`);
  const style = styleOf(a);
  return { title: `${style.emoji} ${trader} ${a.headline}`.slice(0, 256), ...(url ? { url } : {}), description: lines.join("\n"), color: style.color };
}
