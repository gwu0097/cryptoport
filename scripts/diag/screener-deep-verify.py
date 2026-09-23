# Read-only. Usage: python3 scripts/diag/screener-deep-verify.py  (needs ~/cryptoport-archive/screener/deep/*.checkpoint.jsonl)
# Spot-check the deep store against DIFFERENT sources (SPEC required step).
import json, urllib.request, time, datetime, random, os
D=os.path.expanduser("~/cryptoport-archive/screener/deep")
prices={}; revenue={}
for l in open(f"{D}/prices.checkpoint.jsonl"):
    r=json.loads(l); prices[r["gecko_id"]]=dict(r["points"])
for l in open(f"{D}/revenue.checkpoint.jsonl"):
    r=json.loads(l); revenue[r["gecko_id"]]=dict(r["points"])
get=lambda u: json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"cryptoport-verify"})))
random.seed(2026)
# 1. prices vs /prices/historical at 00:00, random coins x random dates
ids=[g for g,p in prices.items() if len(p)>100]
ok=n=0; worst=[]
for g in random.sample(ids, 12):
    for d in random.sample(sorted(prices[g]), 2):
        ts=int(datetime.datetime.fromisoformat(d+"T00:00:00+00:00").timestamp())
        c=get(f"https://coins.llama.fi/prices/historical/{ts}/coingecko:{g}")["coins"].get(f"coingecko:{g}")
        time.sleep(1.5)
        if not c: print("  no historical point", g, d); continue
        diff=abs(prices[g][d]/c["price"]-1); n+=1; ok+=diff<0.005
        if diff>=0.005: worst.append((g,d,prices[g][d],c["price"]))
print(f"PRICES: {ok}/{n} within 0.5% of /prices/historical@00:00", worst[:5])
# completeness: every coin's dates contiguous?
gaps=sum(1 for g,p in prices.items() if p and (datetime.date.fromisoformat(max(p))-datetime.date.fromisoformat(min(p))).days+1!=len(p))
print(f"PRICES: {len(prices)} coins, {sum(1 for p in prices.values() if p)} with data, {gaps} with non-contiguous dates")
# 2. revenue vs DefiLlama's own PARENT page (its own cross-child sum)
for g,parent in [("uniswap","uniswap"),("hyperliquid","hyperliquid"),("gmx","gmx"),("aave","aave")]:
    body=get(f"https://api.llama.fi/summary/fees/{parent}?dataType=dailyRevenue"); time.sleep(1)
    pp={datetime.datetime.fromtimestamp(t,datetime.timezone.utc).strftime("%Y-%m-%d"):v for t,v in body["totalDataChart"]}
    ds=random.sample(sorted(set(pp)&set(revenue.get(g,{}))), 3)
    print(f"REVENUE {g}: " + ", ".join(f"{d} ours {revenue[g][d]:,.0f} vs parent {pp[d]:,.0f} ({100*(revenue[g][d]/pp[d]-1):+.2f}%)" if pp[d] else f"{d} ours {revenue[g][d]} parent 0" for d in ds))

