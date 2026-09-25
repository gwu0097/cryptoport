// Read-only: compares one EVM wallet's stored holdings against Zerion's view of
// the same address, to find missing or double-counted value. Prints:
//  1. value per chain, ours vs Zerion (Zerion doesn't cover Hyperliquid);
//  2. wallet tokens Zerion lists (>= $0.50) that we don't store, with why
//     (chain not scanned / not in the token list / listed but not kept);
//  3. DeFi positions per protocol, ours vs Zerion;
//  4. stored rows counted twice: a held receipt token (vault share, aToken,
//     cToken, Comet — read on-chain) and a DeFi position for the same money.
// Costs ~3-5 Zerion calls (paged), a few RPC reads, no CoinGecko calls.
//
//   NODE_OPTIONS="--conditions=react-server" <cached tsx> scripts/diag/wallet-vs-zerion.ts <wallet id>
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

type Row = Record<string, unknown> & { chain: string | null; contract: string | null; ticker: string; source: string; protocol: string | null };

type ZerionItem = { id: string; attributes: Record<string, unknown>; relationships: Record<string, { data?: { id?: string } }> };

async function zerionAll(path: string, auth: string): Promise<ZerionItem[]> {
  const out: ZerionItem[] = [];
  let url: string | null = `https://api.zerion.io/v1${path}`;
  while (url) {
    await new Promise((r) => setTimeout(r, 1100)); // free tier: 1 call/second
    const res = await fetch(url, { headers: { authorization: auth, accept: "application/json" } });
    if (!res.ok) throw new Error(`Zerion ${res.status} for ${url}`);
    const j = (await res.json()) as { data: ZerionItem[]; links?: { next?: string } };
    out.push(...j.data);
    url = j.links?.next ?? null;
  }
  return out;
}

async function main() {
  const walletId = process.argv[2];
  if (!walletId) throw new Error("usage: wallet-vs-zerion.ts <wallet id>");
  const { serviceDb } = await import("../../src/lib/supabase");
  const { valueHolding } = await import("../../src/lib/valuation");
  const { EVM_CHAINS } = await import("../../src/lib/adapters/evmChains");
  const db = serviceDb();

  const { data: wallet, error } = await db.from("wallets").select("name, address").eq("id", walletId).single();
  if (error || !wallet?.address) throw new Error(`wallet ${walletId}: ${error?.message ?? "no address"}`);
  const { data: rows } = await db.from("holdings").select("*").eq("wallet_id", walletId);
  const holdings = rows as Row[];
  const prices: Record<string, number | string | null> = {};
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from("asset_prices").select("price_key, usd").order("price_key").range(f, f + 999);
    for (const r of data as { price_key: string; usd: number | string | null }[]) prices[r.price_key] = r.usd;
    if (data!.length < 1000) break;
  }
  const usd = (h: Row) => {
    const v = valueHolding(h as never, prices);
    return v.kind === "priced" ? v.usd : 0;
  };

  const auth = "Basic " + Buffer.from(`${process.env.ZERION_API_KEY}:`).toString("base64");
  const chains = await zerionAll("/chains/", auth);
  const byNumeric = new Map(EVM_CHAINS.map((c) => [c.chainId, c.id]));
  const ours = new Map<string, string>(); // zerion chain id -> our chain id
  for (const c of chains) {
    const n = Number.parseInt(String(c.attributes.external_id ?? ""), 16);
    const id = c.id;
    if (byNumeric.has(n)) ours.set(id, byNumeric.get(n)!);
  }
  const simple = await zerionAll(`/wallets/${wallet.address}/positions/?filter%5Bpositions%5D=only_simple&currency=usd&page%5Bsize%5D=100`, auth);
  const complex = await zerionAll(`/wallets/${wallet.address}/positions/?filter%5Bpositions%5D=only_complex&currency=usd&page%5Bsize%5D=100`, auth);
  const chainOf = (p: (typeof simple)[number]) => String(p.relationships.chain?.data?.id ?? "");

  console.log(`${wallet.name} ${wallet.address}`);
  console.log(`ours: $${holdings.reduce((s, h) => s + usd(h), 0).toFixed(2)} in ${holdings.length} rows`);

  // 1. Per chain.
  // Zerion's values are unsigned; a loan is a debt. Polymarket's deposit sits
  // on Polygon in Zerion but under its own "polymarket" chain in ours.
  const signed = (p: ZerionItem) => (p.attributes.position_type === "loan" ? -1 : 1) * Number(p.attributes.value ?? 0);
  const zChain = new Map<string, number>();
  for (const p of [...simple, ...complex]) {
    const c = p.attributes.protocol === "Polymarket" ? "polymarket" : (ours.get(chainOf(p)) ?? `(${chainOf(p)})`);
    zChain.set(c, (zChain.get(c) ?? 0) + signed(p));
  }
  const oChain = new Map<string, number>();
  for (const h of holdings) oChain.set(h.chain ?? "-", (oChain.get(h.chain ?? "-") ?? 0) + usd(h));
  console.log("\n== value per chain (ours vs Zerion)");
  for (const c of [...new Set([...zChain.keys(), ...oChain.keys()])].sort((a, b) => (zChain.get(b) ?? oChain.get(b) ?? 0) - (zChain.get(a) ?? oChain.get(a) ?? 0))) {
    const o = oChain.get(c) ?? 0;
    const z = zChain.get(c);
    if (Math.max(o, z ?? 0) < 1) continue;
    console.log(`${c.padEnd(22)} ours $${o.toFixed(2).padStart(10)}  zerion ${z === undefined ? "        —" : "$" + z.toFixed(2).padStart(9)}  diff ${z === undefined ? "" : (o - z).toFixed(2)}`);
  }

  // 2. Wallet tokens Zerion has that we don't store.
  const have = new Set(holdings.map((h) => `${h.chain}|${(h.contract ?? "native").toLowerCase()}`));
  console.log("\n== wallet tokens Zerion lists (>= $0.50) that we don't store");
  let missing = 0;
  for (const p of simple.sort((a, b) => Number(b.attributes.value ?? 0) - Number(a.attributes.value ?? 0))) {
    const a = p.attributes as { value?: number; fungible_info?: { symbol?: string; implementations?: { chain_id?: string; address?: string | null }[] }; flags?: { is_trash?: boolean } };
    if ((a.value ?? 0) < 0.5) continue;
    const zc = chainOf(p);
    const our = ours.get(zc);
    const contract = (a.fungible_info?.implementations?.find((i) => i.chain_id === zc)?.address ?? "native").toLowerCase();
    if (our && have.has(`${our}|${contract}`)) continue;
    let why = "chain not scanned";
    if (our && contract === "native") why = "native not stored";
    else if (our) {
      const { data } = await db.from("token_registry").select("coingecko_id").eq("chain_id", our).eq("contract", contract).maybeSingle();
      why = data ? (data.coingecko_id ? `in token list (${data.coingecko_id}), not kept` : "in token list, no CoinGecko id") : "not in token list";
    }
    missing += a.value ?? 0;
    console.log(`$${(a.value ?? 0).toFixed(2).padStart(9)}  ${String(a.fungible_info?.symbol).padEnd(12)} ${zc.padEnd(18)} ${why}${a.flags?.is_trash ? " [Zerion: trash]" : ""}  ${contract}`);
  }
  console.log(`total $${missing.toFixed(2)} (a token stored as the chain's native coin, or dropped as a receipt, shows here too)`);

  // 3. DeFi per protocol.
  const zProto = new Map<string, number>();
  for (const p of complex) {
    const a = p.attributes as { protocol?: string; application_metadata?: { name?: string } };
    const name = a.application_metadata?.name ?? a.protocol ?? "?";
    zProto.set(name, (zProto.get(name) ?? 0) + signed(p));
  }
  const oProto = new Map<string, number>();
  for (const h of holdings) if (h.protocol) oProto.set(h.protocol, (oProto.get(h.protocol) ?? 0) + usd(h));
  console.log("\n== DeFi per protocol (ours vs Zerion; a liquid staking position counted as its token shows ours $0)");
  for (const name of [...new Set([...zProto.keys(), ...oProto.keys()])]) {
    const o = oProto.get(name) ?? 0;
    const z = zProto.get(name) ?? 0;
    if (Math.max(Math.abs(o), Math.abs(z)) < 1) continue;
    console.log(`${name.padEnd(28)} ours $${o.toFixed(2).padStart(10)}  zerion $${z.toFixed(2).padStart(10)}`);
  }

  // 4. Stored rows counted twice.
  const { readReceiptClaims } = await import("../../src/lib/adapters/receiptTokens");
  const { linkReceiptPositions, receiptKey } = await import("../../src/lib/receiptDedupe");
  const tokens = holdings.filter((h) => h.source === "auto" && h.contract);
  const positions = holdings.filter((h) => h.source === "auto_defi") as unknown as { chain: string | null; contract: string | null; qty: number | null; pool_contract?: string | null; protocol: string; ticker: string }[];
  const linked = linkReceiptPositions(
    positions.map((p) => ({ ...p, qty: p.qty === null ? null : Number(p.qty) })),
    await readReceiptClaims(wallet.address, tokens),
  );
  const held = new Set(tokens.map((t) => receiptKey(t.chain!, t.contract!)));
  console.log("\n== stored rows counted twice (held receipt token + its DeFi position)");
  let dup = 0;
  for (const p of linked) {
    if (!p.chain || !p.pool_contract || !held.has(receiptKey(p.chain, p.pool_contract))) continue;
    const t = tokens.find((x) => x.chain === p.chain && x.contract!.toLowerCase() === p.pool_contract);
    dup++;
    console.log(`${p.chain.padEnd(10)} ${String(t?.ticker).padEnd(12)} <-> ${p.protocol} ${p.ticker} ${p.qty}`);
  }
  if (dup === 0) console.log("(none)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
