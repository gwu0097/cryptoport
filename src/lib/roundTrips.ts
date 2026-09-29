// A render's database round trips, from when each request started and
// ended (renderMeter.ts). Pure.

export interface Timed {
  start: number;
  end: number;
}

/** Serial round trips a render waited through: the longest chain of
 * requests where each started only after the one before it had answered.
 * Requests started together count once, however many there are. */
export function serialDepth(reqs: readonly Timed[]): number {
  const sorted = [...reqs].sort((a, b) => a.start - b.start);
  const depth: number[] = [];
  let best = 0;
  for (let i = 0; i < sorted.length; i++) {
    let d = 1;
    for (let j = 0; j < i; j++) if (sorted[j].end <= sorted[i].start && depth[j] + 1 > d) d = depth[j] + 1;
    depth.push(d);
    if (d > best) best = d;
  }
  return best;
}

/** Wall time from the first request's start to the last one's answer. */
export function dbSpanMs(reqs: readonly Timed[]): number {
  if (reqs.length === 0) return 0;
  return Math.max(...reqs.map((r) => r.end)) - Math.min(...reqs.map((r) => r.start));
}
