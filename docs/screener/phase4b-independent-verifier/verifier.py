#!/usr/bin/env python3
"""Independent verifier: rank IC, tercile spread, held-back third.
Implemented from definitions.md only. Standard library only."""
import csv, json, math, os, sys
from datetime import date, timedelta
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
INP = os.path.join(os.path.dirname(HERE), "input")

# ---------------- Student-t quantile ----------------
def betacf(a, b, x):
    MAXIT, EPS, FPMIN = 1000, 3e-16, 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    if abs(d) < FPMIN: d = FPMIN
    d = 1.0 / d; h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN: d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN: c = FPMIN
        d = 1.0 / d; h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN: d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN: c = FPMIN
        d = 1.0 / d; de = d * c; h *= de
        if abs(de - 1.0) < EPS: break
    return h

def betai(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    lbt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)
    bt = math.exp(lbt)
    if x < (a + 1) / (a + b + 2):
        return bt * betacf(a, b, x) / a
    return 1.0 - bt * betacf(b, a, 1 - x) / b

def t_cdf(t, df):
    x = df / (df + t * t)
    tail = 0.5 * betai(df / 2.0, 0.5, x)
    return 1 - tail if t >= 0 else tail

def t_quantile(p, df):
    lo, hi = -1e3, 1e3
    for _ in range(300):
        mid = (lo + hi) / 2
        if t_cdf(mid, df) < p: lo = mid
        else: hi = mid
    return (lo + hi) / 2

# ---------------- stats ----------------
def avg_ranks(v):
    idx = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v); i = 0
    while i < len(idx):
        j = i
        while j + 1 < len(idx) and v[idx[j + 1]] == v[idx[i]]: j += 1
        ar = (i + j) / 2.0 + 1
        for k in range(i, j + 1): r[idx[k]] = ar
        i = j + 1
    return r

def pearson(x, y):
    n = len(x); mx = sum(x) / n; my = sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x); syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0: return None
    return sxy / math.sqrt(sxx * syy)

def spearman(x, y): return pearson(avg_ranks(x), avg_ranks(y))

def summary(vals):
    vals = [v for v in vals if v is not None]
    n = len(vals)
    if n == 0: return {"n": 0, "mean": None, "sd": None, "t": None, "ci": [None, None]}
    m = sum(vals) / n
    if n < 2: return {"n": n, "mean": m, "sd": None, "t": None, "ci": [None, None]}
    s = math.sqrt(sum((v - m) ** 2 for v in vals) / (n - 1))
    se = s / math.sqrt(n)
    if se == 0: return {"n": n, "mean": m, "sd": s, "t": None, "ci": [m, m]}
    q = t_quantile(0.975, n - 1)
    return {"n": n, "mean": m, "sd": s, "t": m / se, "ci": [m - q * se, m + q * se]}

def ceil3(n): return -(-n // 3)

def tercile_spread(recs, mode="positional"):
    """recs: list of (factor, fwd, gecko_id). factor already sign-adjusted."""
    n = len(recs); k = ceil3(n)
    if mode == "positional":
        s = sorted(recs, key=lambda r: (-r[0], r[2]))
        top, bot = s[:k], s[-k:]
    elif mode == "flip_after":  # caller passes raw factor; top = lowest raw (tie gecko asc on raw desc order, reversed)
        s = sorted(recs, key=lambda r: (-r[0], r[2]))  # desc on raw, gecko asc
        s = s[::-1]  # then reversed for "cheapness": ties now gecko desc
        top, bot = s[:k], s[-k:]
    elif mode == "rank_threshold":
        # descending avg rank: rank 1 = highest; include all whose avg desc-rank <= k / >= n-k+1
        r = avg_ranks([-x[0] for x in recs])
        top = [x for x, rr in zip(recs, r) if rr <= k]
        bot = [x for x, rr in zip(recs, r) if rr >= n - k + 1]
    if not top or not bot: return None
    return sum(x[1] for x in top) / len(top) - sum(x[1] for x in bot) / len(bot)

# ---------------- data ----------------
def f(x):
    return None if x is None or x == "" else float(x)

def fwd(p0, p1, b0, b1):
    if None in (p0, p1, b0, b1) or p0 == 0 or b0 == 0 or b1 == 0: return None
    return (p1 / p0) / (b1 / b0) - 1

def load(w):
    rows = list(csv.DictReader(open(os.path.join(INP, f"panel_{w}.csv"))))
    mism = {"abs_diff_gt_1e-9": 0, "given_nonnull_recompute_null": 0, "recompute_nonnull_given_null": 0,
            "rated_only_abs_diff_gt_1e-9": 0, "max_abs_diff": 0.0}
    for r in rows:
        p0, b0 = f(r["price_d"]), f(r["btc_d"])
        for h in (30, 90):
            mine = fwd(p0, f(r[f"price_d{h}"]), b0, f(r[f"btc_d{h}"]))
            given = f(r[f"fwd{h}_btc"])
            r[f"my_fwd{h}"] = mine
            if mine is None and given is not None: mism["given_nonnull_recompute_null"] += 1
            elif mine is not None and given is None: mism["recompute_nonnull_given_null"] += 1
            elif mine is not None:
                d = abs(mine - given)
                mism["max_abs_diff"] = max(mism["max_abs_diff"], d)
                if d > 1e-9:
                    mism["abs_diff_gt_1e-9"] += 1
                    if r["rated"] == "true": mism["rated_only_abs_diff_gt_1e-9"] += 1
    return rows, mism

FACTORS = {
    "1y": [("timing_score", 1), ("mom_3w", 1), ("mom_12w", 1), ("beta_btc", 1),
           ("-ps_circ", -1), ("-pf_circ", -1), ("-dilution_rate_implied", -1)],
    "2y": [("timing_score", 1), ("mom_3w", 1), ("mom_12w", 1), ("beta_btc", 1)],
}
FACTORS["3y"] = FACTORS["2y"]

def col(name): return name.lstrip("-")

def run_window(w, rows, alt):
    byd = defaultdict(list)
    for r in rows: byd[r["date"]].append(r)
    dates = sorted(byd)
    d90 = [d for d in dates if byd[d][0]["in_90d_set"] == "true"]
    # grid checks
    dd = [date.fromisoformat(d) for d in dates]
    grid = {"dates_30": len(dates), "step30_ok": all((b - a).days == 30 for a, b in zip(dd, dd[1:])),
            "dates_90": d90,
            "step90_ok": all((date.fromisoformat(b) - date.fromisoformat(a)).days == 90 for a, b in zip(d90, d90[1:])),
            "last90_eq_last30_minus_60": (dd[-1] - date.fromisoformat(d90[-1])).days == 60,
            "in90_flag_consistent_per_date": all(len({r["in_90d_set"] for r in byd[d]}) == 1 for d in dates),
            "min_rated_both_mom_legs": min(sum(1 for r in byd[d] if r["rated"] == "true" and r["mom_3w"] and r["mom_12w"]) for d in dates)}
    out = {}
    for h, hd in ((30, dates), (90, d90)):
        hk = f"h{h}"; out[hk] = {}
        for fname, sgn in FACTORS[w]:
            per, skipped = [], 0
            for d in hd:
                recs = []
                n_rated_fwd = 0
                for r in byd[d]:
                    if r["rated"] != "true": continue
                    y = r[f"my_fwd{h}"]
                    if y is None: continue
                    n_rated_fwd += 1
                    x = f(r[col(fname)])
                    if x is None: continue
                    recs.append((sgn * x, y, r["gecko_id"], x))
                if len(recs) < 10:
                    skipped += 1; continue
                ic = spearman([x[0] for x in recs], [x[1] for x in recs])
                sp = tercile_spread([(x[0], x[1], x[2]) for x in recs])
                e = {"date": d, "n": len(recs), "ic": ic, "spread": sp}
                # alternatives
                a = {"spread_rank_threshold": tercile_spread([(x[0], x[1], x[2]) for x in recs], "rank_threshold")}
                if sgn == -1:
                    a["spread_flip_after_tiebreak"] = tercile_spread([(x[3], x[1], x[2]) for x in recs], "flip_after")
                a["n_before_factor_null_filter"] = n_rated_fwd
                alt.setdefault(w, {}).setdefault(hk, {}).setdefault(fname, []).append({"date": d, **a, "spread": sp})
                if ic is None: skipped += 1; e["ic"] = None
                per.append(e)
            res = {"per_period": per, "skipped_periods": skipped,
                   "ic_summary": summary([p["ic"] for p in per]),
                   "spread_summary": summary([p["spread"] for p in per])}
            if h == 30:
                n = len(hd); k = ceil3(n)
                tr, ho = hd[:n - k], hd[n - k:]
                tri = [p["ic"] for p in per if p["date"] in tr and p["ic"] is not None]
                hoi = [p["ic"] for p in per if p["date"] in ho and p["ic"] is not None]
                trm = sum(tri) / len(tri) if tri else None
                hs = summary(hoi)
                same = trm is not None and hs["mean"] is not None and (trm > 0) == (hs["mean"] > 0) and trm != 0 and hs["mean"] != 0
                excl = hs["ci"][0] is not None and (hs["ci"][0] > 0 or hs["ci"][1] < 0)
                res["holdout"] = {"train_dates": tr, "holdout_dates": ho, "train_mean_ic": trm,
                                  "holdout_mean_ic": hs["mean"], "holdout_ci": hs["ci"],
                                  "holdout_t": hs["t"], "same_sign": same, "ci_excludes_0": excl,
                                  "passes": bool(same and excl)}
            out[hk][fname] = res
    return out, grid

def main():
    tq = {str(df): t_quantile(0.975, df) for df in (2, 7, 8, 11, 23, 35)}
    expect = {"2": 4.303, "8": 2.306, "35": 2.030}
    for k, v in expect.items():
        assert abs(tq[k] - v) < 5e-4, (k, tq[k])
    res = {"windows": {}, "fwd_recompute_mismatches": {}, "fwd_recompute_mismatch_detail": {},
           "t_quantile_checks": {"computed": tq, "expected": expect}, "grid_checks": {}}
    alt = {}
    for w in ("1y", "2y", "3y"):
        rows, mism = load(w)
        res["fwd_recompute_mismatches"][w] = mism["abs_diff_gt_1e-9"]
        res["fwd_recompute_mismatch_detail"][w] = mism
        res["windows"][w], res["grid_checks"][w] = run_window(w, rows, alt)
    json.dump(res, open(os.path.join(HERE, "results.json"), "w"), indent=1, allow_nan=False)
    # alternatives summary
    altsum = {}
    for w, hs in alt.items():
        for hk, fs in hs.items():
            for fn, lst in fs.items():
                s = {"primary_spread_mean": summary([x["spread"] for x in lst])["mean"],
                     "rank_threshold_spread_mean": summary([x["spread_rank_threshold"] for x in lst])["mean"],
                     "periods_where_rank_threshold_differs": sum(1 for x in lst if x["spread_rank_threshold"] is None or abs(x["spread_rank_threshold"] - x["spread"]) > 1e-12),
                     "min_n_before_factor_filter": min(x["n_before_factor_null_filter"] for x in lst)}
                if "spread_flip_after_tiebreak" in lst[0]:
                    s["flip_after_spread_mean"] = summary([x["spread_flip_after_tiebreak"] for x in lst])["mean"]
                    s["periods_where_flip_after_differs"] = sum(1 for x in lst if abs(x["spread_flip_after_tiebreak"] - x["spread"]) > 1e-12)
                altsum[f"{w}/{hk}/{fn}"] = s
    json.dump(altsum, open(os.path.join(HERE, "alternatives.json"), "w"), indent=1, allow_nan=False)

if __name__ == "__main__":
    main()
