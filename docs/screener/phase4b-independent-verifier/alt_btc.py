# Alternative reading: one BTC price per date (median of the rows' btc_d / btc_d30), vs per-row pairing.
import csv, collections, statistics, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verifier import spearman, summary, f, FACTORS, col
for w in ("1y","2y","3y"):
    rows=list(csv.DictReader(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","input",f"panel_{w}.csv"))))
    byd=collections.defaultdict(list)
    for r in rows: byd[r["date"]].append(r)
    dev=[]
    for d,rs in byd.items():
        m0=statistics.median(float(r["btc_d"]) for r in rs if r["btc_d"])
        for r in rs:
            if r["btc_d"] and abs(float(r["btc_d"])/m0-1)>0.005: dev.append((d,r["gecko_id"],r["rated"],float(r["btc_d"])/m0-1))
    print(w,"rows with btc_d >0.5% off date median:",len(dev),"rated:",sum(1 for x in dev if x[2]=="true"), dev[:5])
    for fn,s in FACTORS[w]:
        ics_row, ics_med = [], []
        for d in sorted(byd):
            rs=[r for r in byd[d] if r["rated"]=="true"]
            m0=statistics.median(float(r["btc_d"]) for r in byd[d] if r["btc_d"])
            m1=statistics.median(float(r["btc_d30"]) for r in byd[d] if r["btc_d30"])
            X,Y1,Y2=[],[],[]
            for r in rs:
                x=f(r[col(fn)]); p0=f(r["price_d"]); p1=f(r["price_d30"])
                if None in (x,p0,p1) or not r["btc_d"] or not r["btc_d30"]: continue
                X.append(s*x); Y1.append((p1/p0)/(float(r["btc_d30"])/float(r["btc_d"]))-1); Y2.append((p1/p0)/(m1/m0)-1)
            ics_row.append(spearman(X,Y1)); ics_med.append(spearman(X,Y2))
        a,b=summary(ics_row),summary(ics_med)
        print(f"  {fn:24s} per-row IC={a['mean']:.4f} t={a['t']:.2f} | per-date-median BTC IC={b['mean']:.4f} t={b['t']:.2f}")
