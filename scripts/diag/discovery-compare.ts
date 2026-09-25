// Read-only, phase 1 of docs/sync/PLAN.md: for each wallet, on each chain
// Alchemy can index, compares today's discovery (every CoinGecko-listed token
// on the chain, multicall balanceOf — fetchChainHoldings) with Alchemy
// discovery (alchemy_getTokenBalances, paged) + our own balanceOf over what it
// found ∪ the wallet's last-sync tokens. Prints per chain: tokens found by each,
// the set difference both ways with value, and wall time; then totals for both
// paths run the way the real sync runs them (all chains in parallel).
// No CoinGecko calls (no pricing pass; values from stored asset_prices).
//
//   NODE_OPTIONS="--conditions=react-server" <cached tsx> scripts/diag/discovery-compare.ts <wallet id | 0xaddress> ...
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

// Our chain id -> Alchemy network, for the 20 chains whose token API works
// with this app's key (checked live 2026-09-25, docs/sync/PLAN.md).
const ALCHEMY: Record<string, string> = {
  eth: "eth-mainnet", base: "base-mainnet", arb: "arb-mainnet", op: "opt-mainnet", matic: "polygon-mainnet",
  avax: "avax-mainnet", bsc: "bnb-mainnet", linea: "linea-mainnet", scrl: "scroll-mainnet", blast: "blast-mainnet",
  zksync: "zksync-mainnet", xdai: "gnosis-mainnet", celo: "celo-mainnet", zora: "zora-mainnet", berachain: "berachain-mainnet",
  zetachain: "zetachain-mainnet", soneium: "soneium-mainnet", ron: "ronin-mainnet", unichain: "unichain-mainnet", rbh: "robinhood-mainnet",
};

type Found = Map<string, bigint>; // lowercase contract -> raw balance

async function alchemyDiscover(network: string, owner: string): Promise<{ contracts: string[]; pages: number }> {
  const url = `https://${network}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  const contracts: string[] = [];
  let pageKey: string | undefined;
  let pages = 0;
  do {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params: [owner, "erc20", ...(pageKey ? [{ pageKey }] : [])] }),
    });
    const j = (await res.json()) as { result?: { tokenBalances: { contractAddress: string; tokenBalance: string | null }[]; pageKey?: string }; error?: { message: string } };
    if (!j.result) throw new Error(`alchemy ${network}: ${j.error?.message ?? res.status}`);
    pages++;
    for (const t of j.result.tokenBalances) if (t.tokenBalance && BigInt(t.tokenBalance) > BigInt(0)) contracts.push(t.contractAddress.toLowerCase());
    pageKey = j.result.pageKey;
  } while (pageKey && pages < 50); // all-or-nothing in the real design; here just a guard
  return { contracts, pages };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error("usage: discovery-compare.ts <wallet id | 0xaddress> ...");
  const { serviceDb } = await import("../../src/lib/supabase");
  const { EVM_CHAINS, MULTICALL3_ADDRESS } = await import("../../src/lib/adapters/evmChains");
  const { fetchChainHoldings } = await import("../../src/lib/adapters/multicallEvm");
  const { evmTransport } = await import("../../src/lib/adapters/evmTransport");
  const { createPublicClient } = await import("viem");
  const db = serviceDb();
  const chains = EVM_CHAINS.filter((c) => ALCHEMY[c.id]);

  for (const arg of args) {
    let address = arg;
    let walletId: string | null = null;
    if (!arg.startsWith("0x")) {
      const { data } = await db.from("wallets").select("id, name, address").eq("id", arg).single();
      address = data!.address;
      walletId = data!.id;
      console.log(`\n######## ${data!.name} ${address}`);
    } else console.log(`\n######## ${address}`);
    const previous = new Map<string, Set<string>>();
    if (walletId) {
      const { data } = await db.from("holdings").select("chain, contract").eq("wallet_id", walletId).eq("source", "auto").eq("category", "token").not("contract", "is", null);
      for (const r of data as { chain: string; contract: string }[]) previous.set(r.chain, (previous.get(r.chain) ?? new Set()).add(r.contract.toLowerCase()));
    }

    // Today's path, all chains in parallel (as fetchEvmChainsHoldings runs them).
    const t0 = Date.now();
    const oldPer = new Map<string, { found: Found; ms: number; error?: string }>();
    await Promise.all(
      chains.map(async (c) => {
        const s = Date.now();
        try {
          const scan = await fetchChainHoldings(c, address as `0x${string}`);
          oldPer.set(c.id, { found: new Map(scan.held.map((h) => [h.token.contract.toLowerCase(), BigInt(Math.round((h.qty ?? 0) * 1e6))])), ms: Date.now() - s });
        } catch (e) {
          oldPer.set(c.id, { found: new Map(), ms: Date.now() - s, error: (e as Error).message.slice(0, 80) });
        }
      }),
    );
    const oldWall = Date.now() - t0;

    // New path: Alchemy discovery ∪ last-sync tokens, then our own balanceOf.
    const t1 = Date.now();
    const newPer = new Map<string, { found: Found; ms: number; pages: number; discovered: number; error?: string }>();
    const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
    await Promise.all(
      chains.map(async (c) => {
        const s = Date.now();
        try {
          const { contracts, pages } = await alchemyDiscover(ALCHEMY[c.id], address);
          const union = [...new Set([...contracts, ...(previous.get(c.id) ?? [])])];
          const client = createPublicClient({ transport: evmTransport(c) });
          const found: Found = new Map();
          for (let i = 0; i < union.length; i += 300) {
            const batch = union.slice(i, i + 300);
            const res = await client.multicall({ multicallAddress: MULTICALL3_ADDRESS, contracts: batch.map((a) => ({ address: a as `0x${string}`, abi: ERC20, functionName: "balanceOf", args: [address as `0x${string}`] })) });
            res.forEach((r, j) => {
              if (r.status === "success" && (r.result as bigint) > BigInt(0)) found.set(batch[j], r.result as bigint);
            });
          }
          newPer.set(c.id, { found, ms: Date.now() - s, pages, discovered: contracts.length });
        } catch (e) {
          newPer.set(c.id, { found: new Map(), ms: Date.now() - s, pages: 0, discovered: 0, error: (e as Error).message.slice(0, 80) });
        }
      }),
    );
    const newWall = Date.now() - t1;

    // Values for the differences: token_registry id -> asset_prices usd.
    let missedUsd = 0;
    let gainedListed = 0;
    let gainedUnlisted = 0;
    for (const c of chains) {
      const o = oldPer.get(c.id)!;
      const n = newPer.get(c.id)!;
      const missed = [...o.found.keys()].filter((k) => !n.found.has(k));
      const gained = [...n.found.keys()].filter((k) => !o.found.has(k));
      const lines: string[] = [];
      for (const k of [...missed, ...gained]) {
        const { data: reg } = await db.from("token_registry").select("symbol, decimals, coingecko_id").eq("chain_id", c.id).eq("contract", k).maybeSingle();
        let usd: number | null = null;
        if (reg?.coingecko_id) {
          const { data: p } = await db.from("asset_prices").select("usd").eq("price_key", reg.coingecko_id).maybeSingle();
          const raw = missed.includes(k) ? Number(o.found.get(k)) / 1e6 : reg.decimals != null ? Number(n.found.get(k)) / 10 ** reg.decimals : null;
          if (p?.usd != null && raw != null) usd = Number(p.usd) * raw;
        }
        if (missed.includes(k)) {
          missedUsd += usd ?? 0;
          lines.push(`   MISSED by Alchemy  ${String(reg?.symbol).padEnd(10)} ${usd === null ? "   ?" : "$" + usd.toFixed(2)}  ${k}`);
        } else {
          if (reg?.coingecko_id) gainedListed++;
          else gainedUnlisted++;
          lines.push(`   new   ${reg ? (reg.coingecko_id ? `listed ${String(reg.symbol).padEnd(10)} ${usd === null ? "?" : "$" + usd.toFixed(2)}` : "on list, no id") : "UNLISTED"}  ${k}`);
        }
      }
      console.log(
        `${c.id.padEnd(10)} today ${String(o.found.size).padStart(3)} tokens ${String(o.ms).padStart(6)}ms${o.error ? " ERR " + o.error : ""} | alchemy ${String(n.found.size).padStart(3)} (discovered ${n.discovered}, ${n.pages} page${n.pages === 1 ? "" : "s"}) ${String(n.ms).padStart(6)}ms${n.error ? " ERR " + n.error : ""}`,
      );
      for (const l of lines.slice(0, 12)) console.log(l);
      if (lines.length > 12) console.log(`   … ${lines.length - 12} more`);
    }
    console.log(`\nWALL TIME, ${chains.length} chains in parallel: today ${oldWall}ms | alchemy ${newWall}ms`);
    console.log(`Missed by Alchemy (found today): $${missedUsd.toFixed(2)} | newly found: ${gainedListed} listed, ${gainedUnlisted} unlisted`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
