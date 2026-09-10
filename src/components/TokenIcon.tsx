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
export function TokenIcon({ ticker, url }: { ticker: string; url: string | null }) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-raised text-[10px] font-medium text-fg-muted">
        {ticker.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className="size-5 shrink-0 rounded-full bg-surface-raised object-cover"
      onError={() => setFailed(true)}
    />
  );
}
