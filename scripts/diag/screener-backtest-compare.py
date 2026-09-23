# Read-only. Compare a backtest run's results with the independent verifier's (Phase 4b).
#   python3 scripts/diag/screener-backtest-compare.py <our results_<run>.json> <verifier results.json>
# Per window, horizon, factor and period: IC and tercile spread; plus summaries and holdout outcomes.
import json, sys
ours = json.load(open(sys.argv[1]))["windows"]; theirs = json.load(open(sys.argv[2]))["windows"]
FMAP = {"score_b": "timing_score", "mom_3w": "mom_3w", "mom_12w": "mom_12w", "beta_btc": "beta_btc",
        "cheap_ps": "-ps_circ", "cheap_pf": "-pf_circ", "low_dilution_implied": "-dilution_rate_implied"}
def find(d, name):
    for k in (name, name.lstrip("-"), "neg_" + name.lstrip("-"), name.replace("-", "minus_")):
        if k in d: return d[k]
    return None
tot = mism = 0; notes = []
for w in ours:
    for h in ("h30", "h90"):
        for f, v in ours[w][h].items():
            if f == "setup_tags": continue
            t = find(theirs.get(w, {}).get(h, {}), FMAP[f])
            if t is None: notes.append(f"{w} {h} {f}: missing in verifier"); continue
            tp = {p["date"]: p for p in t.get("per_period", [])}
            for p in v["per_period"]:
                q = tp.get(p["date"]); tot += 1
                if q is None: mism += 1; notes.append(f"{w} {h} {f} {p['date']}: period missing in verifier"); continue
                for key in ("ic", "spread"):
                    a, b = p[key], q.get(key)
                    if (a is None) != (b is None) or (a is not None and abs(a - b) > 1e-9):
                        mism += 1; notes.append(f"{w} {h} {f} {p['date']} {key}: ours {a} vs verifier {b} (n {p['n']} vs {q.get('n')})"); break
            for key in ("ic_summary", "spread_summary"):
                a, b = v[key], t.get(key)
                if a and b and abs(a["mean"] - b["mean"]) > 1e-9: notes.append(f"{w} {h} {f} {key} mean: ours {a['mean']} vs {b['mean']}")
                if a and b and abs(a["ci"][0] - b["ci"][0]) > 1e-6: notes.append(f"{w} {h} {f} {key} CI low: ours {a['ci'][0]} vs {b['ci'][0]}")
            if h == "h30" and "holdout" in v and "holdout" in t and v["holdout"]["passes"] != t["holdout"]["passes"]:
                notes.append(f"{w} {f} holdout pass: ours {v['holdout']['passes']} vs verifier {t['holdout']['passes']}")
print(f"{tot - mism}/{tot} (window, horizon, factor, period) cells match on IC and spread within 1e-9")
for n in notes[:60]: print(" ", n)
if len(notes) > 60: print(f"  ... {len(notes) - 60} more")
