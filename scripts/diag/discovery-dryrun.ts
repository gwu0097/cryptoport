// Read-only phase-3 gate for docs/sync/PLAN.md: for each EVM wallet, runs the
// new chain scan (fetchChainHoldings: Alchemy discovery ∪ last-sync tokens,
// registry fallback) and classifies what it finds with STORED prices only
// (no ensureAssetPrices → no CoinGecko calls, no writes). Compares the token
// rows it would save against the wallet's stored plain-token rows: every
// token added or removed, with value. The gate: only additions (newly found
// tokens), each named; removals must be explained (dust, native guard).
// Receipt dedupe runs as the real sync runs it (receiptDedupe.ts), against the
// wallet's stored Zerion positions and stored trading volumes.
//
//   NODE_OPTIONS="--conditions=react-server" <cached tsx> scripts/diag/discovery-dryrun.ts [wallet id ...]   (default: every active EVM wallet)
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

async function main() {
  const { serviceDb } = await import("../../src/lib/supabase");
  const { EVM_CHAINS } = await import("../../src/lib/adapters/evmChains");
  const { fetchChainHoldings } = await import("../../src/lib/adapters/multicallEvm");
  const { readReceiptClaims } = await import("../../src/lib/adapters/receiptTokens");
  const { classifyHeld } = await import("../../src/lib/tokenDiscovery");
  const { dedupeReceipts, linkReceiptPositions } = await import("../../src/lib/receiptDedupe");
  const db = serviceDb();

  let ids = process.argv.slice(2);
  if (ids.length === 0) {
    const { data } = await db.from("wallets").select("id").eq("active", true).eq("mode", "auto").eq("chain", "ETH");
    ids = (data as { id: string }[]).map((w) => w.id);
  }
  const prices = new Map<string, number>();
  const volumes = new Map<string, number | null>();
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("asset_prices").select("price_key, usd, volume_24h").not("usd", "is", null).order("price_key").range(f, f + 999);
    for (const r of data as { price_key: string; usd: number | string; volume_24h: number | string | null }[]) {
      prices.set(r.price_key, Number(r.usd));
      volumes.set(r.price_key, r.volume_24h === null ? null : Number(r.volume_24h));
    }
    if (data!.length < 1000) break;
  }
  const evm = new Set(EVM_CHAINS.map((c) => c.id));
  let grandAdded = 0;
  let grandRemoved = 0;

  for (const id of ids) {
    const { data: w } = await db.from("wallets").select("name, address").eq("id", id).single();
    const { data: rows } = await db.from("holdings").select("chain, contract, ticker, qty, price_key").eq("wallet_id", id).eq("source", "auto").eq("category", "token");
    const stored = (rows as { chain: string; contract: string | null; ticker: string; qty: number; price_key: string | null }[]).filter((r) => evm.has(r.chain));
    const previous = new Map<string, string[]>();
    for (const r of stored) if (r.contract) previous.set(r.chain, [...(previous.get(r.chain) ?? []), r.contract.toLowerCase()]);

    const t0 = Date.now();
    const scans = await Promise.all(EVM_CHAINS.map((c) => fetchChainHoldings(c, w!.address as `0x${string}`, previous.get(c.id) ?? []).catch((e: Error) => ({ error: e.message, chain: c }))));
    const ms = Date.now() - t0;
    const ok = scans.filter((s): s is Exclude<typeof s, { error: string }> => !("error" in s));
    const noPrice = ok.flatMap((s) => s.held.filter((h) => !(h.token.coingecko_id && prices.has(h.token.coingecko_id))).map((h) => ({ chain: s.chain.id, contract: h.token.contract })));
    const claims = await readReceiptClaims(w!.address, noPrice).catch(() => []);

    type Tok = { chain: string; contract: string; price_key: string; coingecko_id: string | null; usd: number; label: string };
    const toks: Tok[] = [];
    let unrecognized = 0;
    let receipts = 0;
    for (const s of ok) {
      for (const h of s.held) {
        const claim = claims.find((c) => c.chain === s.chain.id && c.receipt === h.token.contract);
        let as;
        if (claim) {
          const { data: u } = await db.from("token_registry").select("coingecko_id, symbol").eq("chain_id", s.chain.id).eq("contract", claim.asset).not("coingecko_id", "is", null).maybeSingle();
          if (u) as = { underlyingId: u.coingecko_id as string, underlyingSymbol: u.symbol as string, underlyingQty: claim.assets };
        }
        const c = classifyHeld(h, prices, as, 0.01);
        if (c.kind === "unrecognized") unrecognized++;
        if (c.kind === "counted") toks.push({ chain: s.chain.id, contract: h.token.contract, price_key: h.token.coingecko_id!, coingecko_id: null, usd: h.qty! * prices.get(h.token.coingecko_id!)!, label: h.token.symbol });
        if (c.kind === "receipt") {
          receipts++;
          toks.push({ chain: s.chain.id, contract: h.token.contract, price_key: c.as.underlyingId, coingecko_id: c.as.underlyingId, usd: c.as.underlyingQty * prices.get(c.as.underlyingId)!, label: `${h.token.symbol} (as ${c.as.underlyingSymbol})` });
        }
      }
    }
    const { data: defi } = await db.from("holdings").select("chain, contract, qty, pool_contract, protocol").eq("wallet_id", id).eq("source", "auto_defi");
    const allClaims = await readReceiptClaims(w!.address, toks).catch(() => []);
    const linked = linkReceiptPositions((defi ?? []) as { chain: string | null; contract: string | null; qty: number | null; pool_contract: string | null; protocol: string }[], allClaims);
    const deduped = dedupeReceipts(toks, linked, volumes);
    const keptToks = new Set(deduped.tokens);
    const droppedByDedupe = toks.filter((t) => !keptToks.has(t));
    const positionsDropped = linked.filter((p) => !deduped.positions.includes(p));
    const next = new Map(deduped.tokens.map((t) => [`${t.chain}|${t.contract}`, t.usd]));
    const nextLabel = new Map(toks.map((t) => [`${t.chain}|${t.contract}`, t.label]));
    const before = new Map<string, { usd: number; ticker: string }>();
    for (const r of stored) if (r.contract) before.set(`${r.chain}|${r.contract.toLowerCase()}`, { usd: r.price_key && prices.has(r.price_key) ? Number(r.qty) * prices.get(r.price_key)! : 0, ticker: r.ticker });

    const added = [...next].filter(([k]) => !before.has(k));
    const removed = [...before].filter(([k]) => !next.has(k));
    const addedUsd = added.reduce((s, [, v]) => s + v, 0);
    const removedUsd = removed.reduce((s, [, v]) => s + v.usd, 0);
    grandAdded += addedUsd;
    grandRemoved += removedUsd;
    const fallbacks = ok.filter((s) => s.discovery.fallback).map((s) => `${s.chain.id}: ${s.discovery.fallback}`);
    const errors = scans.filter((s): s is { error: string; chain: (typeof EVM_CHAINS)[number] } => "error" in s).map((s) => `${s.chain.id}: ${s.error.slice(0, 60)}`);
    console.log(`\n## ${w!.name}: scan ${ms}ms | +${added.length} tokens $${addedUsd.toFixed(2)} (${receipts} receipts) | -${removed.length} tokens $${removedUsd.toFixed(2)} | ${unrecognized} unrecognized`);
    for (const [k, v] of added.sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   + $${v.toFixed(2).padStart(8)}  ${nextLabel.get(k)}  ${k}`);
    for (const [k, v] of removed.sort((a, b) => b[1].usd - a[1].usd)) console.log(`   - $${v.usd.toFixed(2).padStart(8)}  ${v.ticker}  ${k}`);
    for (const t of droppedByDedupe) console.log(`   (deduped: ${t.label} $${t.usd.toFixed(2)} — its position counts it)`);
    for (const p of positionsDropped) console.log(`   (deduped: ${p.protocol} position ${p.chain} — the held token counts it)`);
    if (fallbacks.length) console.log(`   fallbacks: ${fallbacks.join("; ")}`);
    if (errors.length) console.log(`   chain errors: ${errors.join("; ")}`);
  }
  console.log(`\nALL WALLETS: +$${grandAdded.toFixed(2)} added, -$${grandRemoved.toFixed(2)} removed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
