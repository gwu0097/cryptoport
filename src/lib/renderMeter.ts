import "server-only";
import { cache } from "react";
import { after } from "next/server";
import { headers } from "next/headers";
import { dbSpanMs, serialDepth, type Timed } from "./roundTrips";

// Every Supabase request a page render makes is timed here (supabase.ts
// passes meteredFetch to both clients), and the render logs one line when
// its response is finished:
//   [render] /dashboard load req=13 hops=2 db=198ms slow=rpc/asset_market_rows:120ms
// hops = the serial round trips the render waited through (roundTrips.ts);
// slow = its longest request, body included; cold = the first render on a
// new server instance (its connections to Supabase are new too).
// No request of its own, nothing stored: a log line on Vercel. 2026-09-29:
// latency kept coming back one page at a time; this measures every page.

/** Serial Supabase round trips a page render should need at most. */
export const TARGET_HOPS = 2;

type Meter = { reqs: (Timed & { path: string })[]; logging: boolean; prices?: string; misses: Set<string> };

let rendersOnThisInstance = 0;

// One meter per request: React's cache() is per request during a render.
// Outside one (a script, a request with no React scope) it doesn't dedupe,
// so two calls return different objects and nothing is metered.
const meterFor = cache((): Meter => ({ reqs: [], logging: false, misses: new Set() }));

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
    const cold = rendersOnThisInstance++ === 0 ? " cold" : "";
    after(() => {
      const hops = serialDepth(m.reqs);
      const over = hops > TARGET_HOPS ? ` (target ≤ ${TARGET_HOPS} hops)` : "";
      const slowest = m.reqs.reduce<(typeof m.reqs)[number] | null>((a, r) => (!a || r.end - r.start > a.end - a.start ? r : a), null);
      const slow = slowest ? ` slow=${slowest.path}:${Math.round(slowest.end - slowest.start)}ms` : "";
      const prices = m.prices ? ` prices=${m.prices}` : "";
      const miss = m.misses.size > 0 ? ` scope-miss=${m.misses.size}(${[...m.misses].slice(0, 5).join(",")})` : "";
      console.log(`[render] ${path}${cold} req=${m.reqs.length} hops=${hops} db=${Math.round(dbSpanMs(m.reqs))}ms${slow}${prices}${miss}${over}`);
      // Every request, when diagnosing a page locally (RENDER_METER_VERBOSE=1):
      // start offset + duration, to see which ones wait on which.
      if (process.env.RENDER_METER_VERBOSE === "1") {
        const t0 = Math.min(...m.reqs.map((r) => r.start));
        for (const r of [...m.reqs].sort((a, b) => a.start - b.start)) console.log(`  ${Math.round(r.start - t0)}+${Math.round(r.end - r.start)} ${r.path}`);
      }
    });
  } catch {
    // no request scope: nothing to log against
  }
}

/** The render's price scope ("mine:304"), for its log line. */
export function notePriceScope(label: string): void {
  const m = currentMeter();
  if (m) m.prices = label;
}

/** A scoped price map was asked for a coin outside its scope (queries.ts
 * guardPrices): a page that needs a wider scope. Logged, never thrown — the
 * coin shows "—" (unknown), not a wrong number. */
export function noteScopeMiss(key: string): void {
  const m = currentMeter();
  if (m) m.misses.add(key);
  else console.error(`[render] scope-miss outside a render: ${key}`);
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
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname.replace(/^\/rest\/v1\//, "");
  try {
    // The body is read here, so a request's time includes its transfer (a
    // large answer's cost shows up where it's paid); supabase-js reads it
    // all anyway.
    const res = await fetch(input, init);
    const body = await res.arrayBuffer();
    // A 204/205/304 can't carry a body, even an empty one.
    const empty = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(empty ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally {
    m.reqs.push({ start, end: performance.now(), path });
  }
};
