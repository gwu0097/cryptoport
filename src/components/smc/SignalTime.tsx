"use client";

import { useEffect, useState } from "react";
import { formatPt, formatSpan, signalRecency, type Recency } from "@/lib/smc/time";

/** Current time in seconds, ticking every 30s — null during server render
 * and the first client render, so the absolute time (identical on both)
 * renders first and the relative part never causes a hydration mismatch. */
function useNowSec(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// Recency styling (reported directly: "if it was like 30 min ago, might be a
// way for me to manually go in"). Within one chart bar: flashing — with a
// static highlight instead for anyone who prefers reduced motion.
const RECENCY_CLASS: Record<Recency, string> = {
  within_bar: "font-semibold motion-safe:animate-pulse motion-reduce:rounded motion-reduce:bg-current/15 motion-reduce:px-1",
  within_block: "font-semibold",
  within_day: "",
  older: "opacity-60",
};

/** A signal time in Pacific time plus "(x ago)", colored by side and styled
 * by how recent it is in the chart's own bars. */
export function SignalTime({
  sec,
  side,
  barSeconds,
  price,
}: {
  sec: number;
  side: "BUY" | "SELL";
  barSeconds: number;
  price?: string;
}) {
  const now = useNowSec();
  const recency = now === null ? null : signalRecency(sec, now, barSeconds);
  return (
    <span
      className={`${side === "BUY" ? "text-positive" : "text-negative"} ${recency ? RECENCY_CLASS[recency] : ""}`}
      title={recency === "within_bar" ? "Fired within the last bar" : undefined}
    >
      {side === "BUY" ? "Buy" : "Sell"} · {formatPt(sec)}
      {price ? ` @ ${price}` : ""}
      {now !== null && <span className="ml-1 opacity-80">({formatSpan(now - sec)} ago)</span>}
    </span>
  );
}

/** A future time in Pacific time plus "(in x)". */
export function UntilTime({ sec }: { sec: number }) {
  const now = useNowSec();
  return (
    <>
      {formatPt(sec)}
      {now !== null && sec > now && <span className="ml-1 opacity-80">(in {formatSpan(sec - now)})</span>}
    </>
  );
}
