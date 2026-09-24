"use client";

import { formatTimeInZone, formatSpan, signalRecency, barsAgo, type Recency } from "@/lib/smc/time";
import { useTimeZone } from "@/components/timezone/TimeZoneProvider";
import { useNowSec } from "@/components/useServerNow";

// Recency styling (reported directly: "if it was like 30 min ago, might be a
// way for me to manually go in"). Within one chart bar: flashing — with a
// static highlight instead for anyone who prefers reduced motion.
const RECENCY_CLASS: Record<Recency, string> = {
  within_bar: "font-semibold motion-safe:animate-pulse motion-reduce:rounded motion-reduce:bg-current/15 motion-reduce:px-1",
  within_block: "font-semibold",
  within_day: "",
  older: "opacity-60",
  stale: "opacity-50",
};

/** A signal time in the user's timezone (with the year if it isn't this
 * year) plus "(x ago)", colored by side and styled by how recent it is in
 * the chart's own bars — dimmed and flagged once it's STALE_BARS+ bars old,
 * so an old signal can never pass for a fresh one at a glance. */
export function SignalTime({
  sec,
  side,
  barSeconds,
  serverNowSec,
  price,
}: {
  sec: number;
  side: "BUY" | "SELL";
  barSeconds: number;
  serverNowSec: number;
  price?: string;
}) {
  const now = useNowSec(serverNowSec);
  const tz = useTimeZone();
  const recency = signalRecency(sec, now, barSeconds);
  return (
    <span className="whitespace-nowrap">
      <span
        className={`${side === "BUY" ? "text-positive" : "text-negative"} ${RECENCY_CLASS[recency]}`}
        title={recency === "within_bar" ? "Fired within the last bar" : undefined}
      >
        {side === "BUY" ? "Buy" : "Sell"} · {formatTimeInZone(sec, tz, now)}
        {price ? ` @ ${price}` : ""}
        <span className="ml-1 opacity-80">({formatSpan(now - sec)} ago)</span>
      </span>
      {recency === "stale" && (
        <span
          className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning"
          title="This is the most recent signal, but it fired long ago in this timeframe's bars — the state has held since then."
        >
          stale · {barsAgo(sec, now, barSeconds).toLocaleString("en-US")} bars
        </span>
      )}
    </span>
  );
}

/** A future time in the user's timezone plus "(in x)". */
export function UntilTime({ sec, serverNowSec }: { sec: number; serverNowSec: number }) {
  const now = useNowSec(serverNowSec);
  const tz = useTimeZone();
  return (
    <>
      {formatTimeInZone(sec, tz, now)}
      {sec > now && <span className="ml-1 opacity-80">(in {formatSpan(sec - now)})</span>}
    </>
  );
}
