// Pure technical-analysis primitives for the pullback/trend indicators —
// see ta.test.ts. Definitions are exactly the pre-registered ones
// (docs/signals/PREREG_PULLBACK_INDICATORS.md §2). Every series is aligned
// to its input: out[i] is the value as of bar i's close, null until defined.

export type Series = (number | null)[];

/** Simple mean of the n values ending at i (i included). */
export function sma(xs: readonly number[], n: number): Series {
  const out: Series = xs.map(() => null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA with α = 2/(n+1), seeded with SMA(n) at index n-1. */
export function ema(xs: readonly number[], n: number): Series {
  const out: Series = xs.map(() => null);
  if (xs.length < n) return out;
  const a = 2 / (n + 1);
  let prev = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < xs.length; i++) {
    prev = a * xs[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder's averages of close-to-close gains and losses (RMA, seeded with the
 * simple mean of the first n changes). Returned separately because the exact
 * RSI trigger needs them. Defined from index n (the n-th change). */
export function wilderAverages(closes: readonly number[], n: number): { up: Series; down: Series } {
  const up: Series = closes.map(() => null);
  const down: Series = closes.map(() => null);
  if (closes.length <= n) return { up, down };
  let u = 0;
  let d = 0;
  for (let i = 1; i <= n; i++) {
    const ch = closes[i] - closes[i - 1];
    u += Math.max(ch, 0);
    d += Math.max(-ch, 0);
  }
  u /= n;
  d /= n;
  up[n] = u;
  down[n] = d;
  for (let i = n + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    u = (u * (n - 1) + Math.max(ch, 0)) / n;
    d = (d * (n - 1) + Math.max(-ch, 0)) / n;
    up[i] = u;
    down[i] = d;
  }
  return { up, down };
}

/** Pine ta.rsi semantics: down == 0 → 100, up == 0 → 0, else 100 − 100/(1 + up/down). */
export function rsiFrom(up: number, down: number): number {
  if (down === 0) return 100;
  if (up === 0) return 0;
  return 100 - 100 / (1 + up / down);
}

export function wilderRsi(closes: readonly number[], n: number): Series {
  const { up, down } = wilderAverages(closes, n);
  return up.map((u, i) => (u === null || down[i] === null ? null : rsiFrom(u, down[i]!)));
}

/** Population standard deviation of the n values ending at i (Pine ta.stdev default). */
export function stdevPop(xs: readonly number[], n: number): Series {
  const out: Series = xs.map(() => null);
  for (let i = n - 1; i < xs.length; i++) {
    let m = 0;
    for (let k = i - n + 1; k <= i; k++) m += xs[k];
    m /= n;
    let v = 0;
    for (let k = i - n + 1; k <= i; k++) v += (xs[k] - m) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

/** Max of the n values BEFORE i (i excluded). Defined from index n. */
export function priorMax(xs: readonly number[], n: number): Series {
  return xs.map((_, i) => (i < n ? null : Math.max(...xs.slice(i - n, i))));
}

/** Min of the n values BEFORE i (i excluded). Defined from index n. */
export function priorMin(xs: readonly number[], n: number): Series {
  return xs.map((_, i) => (i < n ? null : Math.min(...xs.slice(i - n, i))));
}
