"use client";

import { formatStaleness } from "@/lib/format";
import { useNowSec } from "./useServerNow";

/** formatStaleness ("3m ago") for a server-side timestamp, computed in the
 * browser from the server's render time + browser-elapsed time (see
 * useServerNow.ts) — so it keeps aging correctly when the Router Cache
 * re-shows an old render. `serverNowSec` must come from the same render
 * (requestNowSec()). */
export function AgeText({ at, serverNowSec, prefix = "" }: { at: string | number | null; serverNowSec: number; prefix?: string }) {
  const now = useNowSec(serverNowSec);
  const iso = at === null ? null : typeof at === "number" ? new Date(at).toISOString() : at;
  return (
    <>
      {prefix}
      {formatStaleness(iso, now * 1000)}
    </>
  );
}
