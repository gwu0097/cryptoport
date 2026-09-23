// Pure Phase 4b statistics — see backtestStats.test.ts. Implements the
// definitions in docs/screener/PHASE_4_PLAN.md ("Definitions") and nothing
// else: rank IC (Spearman, average ranks for ties), IC/spread summaries with
// a Student-t CI, tercile spreads, rank-residual ("controlled") IC, and the
// held-back-third rule. No I/O.

/** 1-based ranks, ties given the average of their ranks. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = x.length;
  if (n < 2 || y.length !== n) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Spearman = Pearson of the two average-rank vectors. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  return pearson(averageRanks(x), averageRanks(y));
}

// Student-t quantile via the regularized incomplete beta function
// (Numerical Recipes' continued fraction) and bisection on the CDF.
function logGamma(z: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  const x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betaCf(a: number, b: number, x: number): number {
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function incBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaCf(a, b, x)) / a : 1 - (bt * betaCf(b, a, 1 - x)) / b;
}
function tCdf(t: number, df: number): number {
  const ib = incBeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - ib / 2 : ib / 2;
}
/** Two-sided 95% critical value t_{0.975, df}. */
export function tQuantile975(df: number): number {
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < 0.975) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  t: number;
  ci: [number, number];
}

/** mean, sample sd, t = mean/(sd/√n), 95% CI mean ± t_{0.975,n−1}·sd/√n. Null below 2 values. */
export function summarize(xs: readonly number[]): Summary | null {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const half = tQuantile975(n - 1) * se;
  return { n, mean, sd, t: se > 0 ? mean / se : NaN, ci: [mean - half, mean + half] };
}

/** Definitions: sort the population by factor descending, ties broken by
 * gecko_id ascending; top = the first ⌈n/3⌉ positions, bottom = the last
 * ⌈n/3⌉; spread = mean return of top − mean return of bottom. */
export function tercileSpread(rows: readonly { id: string; factor: number; ret: number }[]): number | null {
  if (rows.length < 3) return null;
  const sorted = [...rows].sort((a, b) => b.factor - a.factor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = Math.ceil(sorted.length / 3);
  const mean = (xs: readonly { ret: number }[]) => xs.reduce((a, b) => a + b.ret, 0) / xs.length;
  return mean(sorted.slice(0, k)) - mean(sorted.slice(sorted.length - k));
}

/** OLS residuals of y on the columns of xs, with an intercept (normal
 * equations; ≤ 3 regressors here, solved by Gaussian elimination). */
export function olsResiduals(y: readonly number[], xs: readonly (readonly number[])[]): number[] {
  const n = y.length;
  const cols = [new Array<number>(n).fill(1), ...xs];
  const k = cols.length;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => cols[i].reduce((s, v, r) => s + v * cols[j][r], 0)));
  const b = Array.from({ length: k }, (_, i) => cols[i].reduce((s, v, r) => s + v * y[r], 0));
  for (let p = 0; p < k; p++) {
    let piv = p;
    for (let r = p + 1; r < k; r++) if (Math.abs(A[r][p]) > Math.abs(A[piv][p])) piv = r;
    [A[p], A[piv]] = [A[piv], A[p]];
    [b[p], b[piv]] = [b[piv], b[p]];
    for (let r = p + 1; r < k; r++) {
      const f = A[r][p] / A[p][p];
      for (let c = p; c < k; c++) A[r][c] -= f * A[p][c];
      b[r] -= f * b[p];
    }
  }
  const beta = new Array<number>(k).fill(0);
  for (let p = k - 1; p >= 0; p--) beta[p] = (b[p] - A[p].slice(p + 1).reduce((s, v, j) => s + v * beta[p + 1 + j], 0)) / A[p][p];
  return y.map((v, r) => v - cols.reduce((s, col, j) => s + beta[j] * col[r], 0));
}

export interface HoldoutResult {
  train_dates: string[];
  holdout_dates: string[];
  train_mean_ic: number | null;
  holdout_mean_ic: number | null;
  holdout_ci: [number, number] | null;
  /** (i) same sign of training and holdout mean IC AND (ii) holdout CI excludes 0. */
  passes: boolean;
}

/** The held-back third: the last ⌈n/3⌉ periods (time order) are the holdout. */
export function heldBackThird(periods: readonly { date: string; ic: number }[]): HoldoutResult {
  const sorted = [...periods].sort((a, b) => (a.date < b.date ? -1 : 1));
  const h = Math.ceil(sorted.length / 3);
  const train = sorted.slice(0, sorted.length - h);
  const hold = sorted.slice(sorted.length - h);
  const mean = (xs: readonly { ic: number }[]) => (xs.length ? xs.reduce((a, b) => a + b.ic, 0) / xs.length : null);
  const trainMean = mean(train);
  const holdMean = mean(hold);
  const s = summarize(hold.map((p) => p.ic));
  const sameSign = trainMean !== null && holdMean !== null && Math.sign(trainMean) === Math.sign(holdMean) && trainMean !== 0;
  const excludesZero = s !== null && (s.ci[0] > 0 || s.ci[1] < 0);
  return {
    train_dates: train.map((p) => p.date),
    holdout_dates: hold.map((p) => p.date),
    train_mean_ic: trainMean,
    holdout_mean_ic: holdMean,
    holdout_ci: s?.ci ?? null,
    passes: sameSign && excludesZero,
  };
}
