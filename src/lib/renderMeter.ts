import "server-only";
import { cache } from "react";
import { after } from "next/server";
import { headers } from "next/headers";
import { dbSpanMs, serialDepth, type Timed } from "./roundTrips";

// Every Supabase request a page render makes is timed here (supabase.ts
// passes meteredFetch to both clients), and the render logs one line when
// its response is finished:
//   [render] /dashboard load req=18 hops=7 db=1582ms (target ≤ 2 hops)
// hops = the serial round trips the render waited through (roundTrips.ts).
// No request of its own, nothing stored: a log line on Vercel. 2026-09-29:
// latency kept coming back one page at a time; this measures every page.

/** Serial Supabase round trips a page render should need at most. */
export const TARGET_HOPS = 2;

type Meter = { reqs: Timed[]; logging: boolean };

// One meter per request: React's cache() is per request during a render.
// Outside one (a script, a request with no React scope) it doesn't dedupe,
// so two calls return different objects and nothing is metered.
const meterFor = cache((): Meter => ({ reqs: [], logging: false }));

function currentMeter(): Meter | null {
  try {
    const m = meterFor();
    return m === meterFor() ? m : null;
  } catch {
    return null;
  }
}

async function scheduleLog(m: Meter): Promise<void> {
  // Request data is read now: a Server Component's after() can't read it.
  let path = "?"; // "<path> <load|nav|action>", set by proxy.ts
  try {
    path = (await headers()).get("x-cp-path") ?? "?";
  } catch {
    // no request scope
  }
  try {
    after(() => {
      const hops = serialDepth(m.reqs);
      const over = hops > TARGET_HOPS ? ` (target ≤ ${TARGET_HOPS} hops)` : "";
      console.log(`[render] ${path} req=${m.reqs.length} hops=${hops} db=${Math.round(dbSpanMs(m.reqs))}ms${over}`);
    });
  } catch {
    // no request scope: nothing to log against
  }
}

/** fetch for the Supabase clients: times each request into the render's
 * meter, when there is one; otherwise a plain fetch. */
export const meteredFetch: typeof fetch = async (input, init) => {
  const m = currentMeter();
  if (!m) return fetch(input, init);
  if (!m.logging) {
    m.logging = true;
    void scheduleLog(m);
  }
  const start = performance.now();
  try {
    return await fetch(input, init);
  } finally {
    m.reqs.push({ start, end: performance.now() });
  }
};
