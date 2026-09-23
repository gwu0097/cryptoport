import { formatPrice } from "@/lib/format";
import type { NextTrigger } from "@/lib/signals/triggers";

const sideWord = (side: "BUY" | "SELL") => (side === "BUY" ? "Buy" : "Sell");

/** One NextTrigger, worded honestly per kind: an exact close for "price"; for
 * "blocked", why no close can fire this bar; for "value" (no exact trigger
 * exists), the current indicator values — never presented as a price. */
export function TriggerText({ trigger, closeUnit }: { trigger: NextTrigger; closeUnit?: string }) {
  const color = trigger.side === "BUY" ? "text-positive" : "text-negative";
  switch (trigger.kind) {
    case "price":
      return (
        <span className={color}>
          {sideWord(trigger.side)} if {closeUnit ? `this ${closeUnit} ` : ""}closes {trigger.condition} {formatPrice(trigger.price)}
          {trigger.floor !== null && <span className="text-fg-muted"> and above SMA(200) {formatPrice(trigger.floor)}</span>}
        </span>
      );
    case "blocked":
      return (
        <span className="text-fg-muted" title="The entry needs a close below the first price, but the SMA(200) trend filter needs one above the second.">
          No {sideWord(trigger.side)} possible this bar: needs a close below {formatPrice(trigger.price)}, but SMA(200) needs above{" "}
          {formatPrice(trigger.floor)}
        </span>
      );
    case "value":
      return (
        <span className="text-fg-muted">
          <span className={color}>{sideWord(trigger.side)}</span> (no exact price): {trigger.text}
        </span>
      );
  }
}
