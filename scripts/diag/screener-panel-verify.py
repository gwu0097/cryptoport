# Read-only. Usage: python3 scripts/diag/screener-panel-verify.py  (needs the panels in ~/cryptoport-archive/screener/backtest/)
# Required step: spot-check the built panels against a DIFFERENT source.
# mom_3w and fwd30_btc recomputed from DefiLlama /prices/historical at the readings' REAL timestamps
# (1y: each backfilled row's stored observed_at; 2y/3y: the deep store's 00:00 grid) — no use of our history/pairing code.
import csv, json, os, random, time, datetime, urllib.request
env={}
for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env.local")):
    if "=" in l and not l.startswith("#"): k,v=l.rstrip("\n").split("=",1); env[k]=v.strip().strip('"')
def rest(path):
    req=urllib.request.Request(env["NEXT_PUBLIC_SUPABASE_URL"]+"/rest/v1/"+path, headers={"apikey":env["SUPABASE_SERVICE_ROLE_KEY"],"Authorization":"Bearer "+env["SUPABASE_SERVICE_ROLE_KEY"],"Accept-Profile":"cryptoport"})
    return json.load(urllib.request.urlopen(req))
def hist(gid, ts):
    time.sleep(1.5)
    c=json.load(urllib.request.urlopen(f"https://coins.llama.fi/prices/historical/{int(ts)}/coingecko:{gid}"))["coins"].get(f"coingecko:{gid}")
    return (c["price"], c["timestamp"]) if c else (None, None)
def iso(ts): return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%m-%d %H:%M")
def shift(d,n): return (datetime.date.fromisoformat(d)+datetime.timedelta(n)).isoformat()
D=os.path.expanduser("~/cryptoport-archive/screener/backtest")
random.seed(42); results=[]
for w in ["1y","3y"]:
    rows=[r for r in csv.DictReader(open(f"{D}/panel_{w}.csv")) if r["rated"]=="true" and r["mom_3w"] and r["fwd30_btc"] and r["price_from_coingecko"]=="false"]
    for r in random.sample(rows, 4):
        g=r["gecko_id"]; d=r["date"]
        def moment(date):
            if w!="1y": return datetime.datetime.fromisoformat(date+"T00:00:00+00:00").timestamp()
            # A backfilled row's observed_at is a nominal 12:00 label; its price's REAL moment is the
            # backfill run's /chart grid: the run's start time of day, on that date.
            got=rest(f"screener_asset_snapshots?select=observed_at,run_id&asset_id=eq.{r['asset_id']}&is_backfilled=eq.true&observed_at=gte.{date}T00:00:00Z&observed_at=lt.{shift(date,1)}T00:00:00Z")
            run=rest(f"screener_runs?select=started_at&id=eq.{got[0]['run_id']}")[0]
            tod=datetime.datetime.fromisoformat(run["started_at"]).strftime("%H:%M:%S")
            return datetime.datetime.fromisoformat(f"{date}T{tod}+00:00").timestamp()
        t0,t21,t30=moment(d),moment(shift(d,-21)),moment(shift(d,30))
        (p0,a0),(p21,_),(p30,_)=hist(g,t0),hist(g,t21),hist(g,t30)
        (b0,_),(b21,_),(b30,_)=hist("bitcoin",t0),hist("bitcoin",t21),hist("bitcoin",t30)
        mom=(p0/p21)/(b0/b21)-1; fwd=(p30/p0)/(b30/b0)-1
        dm=mom-float(r["mom_3w"]); df=fwd-float(r["fwd30_btc"])
        results.append((w,g,d,abs(dm)<0.01 and abs(df)<0.01))
        print(f"{w} {g:24} D={d} (moment {iso(t0)}, historical point {iso(a0)}): mom_3w ours {float(r['mom_3w']):+.4f} vs {mom:+.4f} | fwd30 ours {float(r['fwd30_btc']):+.4f} vs {fwd:+.4f}")
print(f"{sum(ok for *_,ok in results)}/{len(results)} rows within 1 point on both")
