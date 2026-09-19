"use client";

import { useState } from "react";

/**
 * Icon URLs are arbitrary, adapter-supplied hosts (CoinGecko, Jupiter's own
 * token-list assets, whatever a Solana project self-hosts) — Next's
 * <Image> requires an allowlisted domain per host, impractical for a set
 * this open-ended, so this is a plain <img>. Falls back to a ticker-initial
 * badge when there's no URL or the image 404s (a surprising number of
 * Jupiter-listed icon URLs are dead links).
 */
const SIZE_CLASSES = {
  md: "size-5",
  sm: "size-3.5",
} as const;

/** `size="sm"`, when a caller wants a visibly smaller/secondary icon — e.g.
 * ChainGroupedHoldings' protocol nav row deliberately reads as lower-
 * priority than its chain row right above it (same idea, smaller icon, no
 * new component). Defaults to the original "md" so every existing call
 * site is unaffected. */
export function TokenIcon({
  ticker,
  url,
  size = "md",
}: {
  ticker: string;
  url: string | null;
  size?: "md" | "sm";
}) {
  const [failed, setFailed] = useState(false);
  const sizeClass = SIZE_CLASSES[size];

  if (!url || failed) {
    return (
      <span
        className={`grid ${sizeClass} shrink-0 place-items-center rounded-full bg-surface-raised text-[10px] font-medium text-fg-muted`}
      >
        {ticker.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className={`${sizeClass} shrink-0 rounded-full bg-surface-raised object-cover`}
      onError={() => setFailed(true)}
    />
  );
}
