// Activity backfill (owner 2026-09-29): the lines a morning read would have
// written for the days before an address was first read — new / added /
// trimmed / exited, per coin, per day — rebuilt from its stored trade
// history. Each day ends at the read's time (08:00 UTC, the cron); a coin's
// quantity then is today's snapshot minus every move since, so a day's line
// is its net change, judged by the daily diff's own rule (watchDiff.ts
// moveKind): a buy and a sale of the same coin on one day cancel, exactly as
// two snapshots would show them. Pure.

import { moveKind, type MoveKind } from "./watchDiff.ts";
import type { ActivityLeg } from "./watchActivity.ts";

const DAY_MS = 86_400_000;
/** The daily read's start (pg_cron → api/wallet-watch/tick, 08:00 UTC). */
export const READ_HOUR_UTC = 8;

export interface BackfillMovement {
  snapshotAt: string;
  assetKey: string;
  kind: MoveKind;
  ticker: string;
  priceKey: string | null;
  qtyBefore: number;
  qtyAfter: number;
  priceUsd: number;
  usdDelta: number;
  contract: string | null;
  contractChain: string | null;
}

/** Each 08:00 UTC read time after `fromMs`, up to and including `untilMs`. */
export function readTimes(fromMs: number, untilMs: number): number[] {
  const first = new Date(fromMs);
  let t = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate(), READ_HOUR_UTC);
  if (t <= fromMs) t += DAY_MS;
  const out: number[] = [];
  for (; t <= untilMs; t += DAY_MS) out.push(t);
  return out;
}

/**
 * The movement lines for each day ending at a read time in `times`.
 * `qtyNow`: each coin's quantity in the snapshot taken at `snapshotAtMs`.
 * `priceOn`: a coin's close on a day (YYYY-MM-DD), when stored; otherwise
 * the day's own trade prices are used, and a coin with neither isn't sized
 * — like the daily diff, it has no line.
 */
export function backfillMovements(
  legs: readonly ActivityLeg[],
  qtyNow: ReadonlyMap<string, number>,
  snapshotAtMs: number,
  times: readonly number[],
  priceOn: (priceKey: string, day: string) => number | null,
): BackfillMovement[] {
  const byCoin = new Map<string, ActivityLeg[]>();
  for (const l of legs) {
    if (Date.parse(l.at) > snapshotAtMs) continue; // not in the snapshot yet
    byCoin.set(l.assetKey, [...(byCoin.get(l.assetKey) ?? []), l]);
  }
  const out: BackfillMovement[] = [];
  for (const [key, coinLegs] of byCoin) {
    // Quantity at a time: now, minus every move after it.
    const qtyAt = (t: number) => (qtyNow.get(key) ?? 0) - coinLegs.filter((l) => Date.parse(l.at) > t).reduce((s, l) => s + l.qtyDelta, 0);
    const first = coinLegs[0];
    for (let i = 0; i < times.length; i++) {
      // Each day starts where the one before ended (the last one ends at the
      // address's first read, whatever the hour).
      const end = times[i];
      const start = i === 0 ? end - DAY_MS : times[i - 1];
      const day = coinLegs.filter((l) => Date.parse(l.at) > start && Date.parse(l.at) <= end);
      if (day.length === 0) continue;
      const qtyAfter = Math.max(0, qtyAt(end));
      const qtyBefore = Math.max(0, qtyAt(start));
      const date = new Date(end).toISOString().slice(0, 10);
      const traded = day.filter((l) => l.priceUsd !== null);
      const tradePrice = traded.length > 0 ? traded.reduce((s, l) => s + Math.abs(l.qtyDelta) * l.priceUsd!, 0) / traded.reduce((s, l) => s + Math.abs(l.qtyDelta), 0) : null;
      const price = (first.priceKey ? priceOn(first.priceKey, date) : null) ?? tradePrice;
      if (price === null) continue;
      const kind = moveKind(qtyBefore, qtyAfter, price);
      if (!kind) continue;
      const withContract = day.find((l) => l.contract) ?? first;
      out.push({
        snapshotAt: new Date(end).toISOString(),
        assetKey: key,
        kind,
        ticker: first.ticker,
        priceKey: first.priceKey,
        qtyBefore,
        qtyAfter,
        priceUsd: price,
        usdDelta: (qtyAfter - qtyBefore) * price,
        contract: withContract.contract ?? null,
        contractChain: withContract.contract ? withContract.sourceChain : null,
      });
    }
  }
  return out.sort((a, b) => a.snapshotAt.localeCompare(b.snapshotAt));
}
