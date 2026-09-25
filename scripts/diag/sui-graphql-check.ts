// Read-only: runs the Sui adapter's GraphQL fetchers (balances, coin
// metadata, native stakes) for every Sui wallet and compares balance counts
// with BlockVision's JSON-RPC. No pricing, so no CoinGecko calls.
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/diag/sui-graphql-check.ts
process.loadEnvFile(`${__dirname}/../../.env.local`);
async function main() {
  const { serviceDb } = await import("../../src/lib/supabase");
  const { fetchBalances, fetchCoinMetadata, fetchSuiStakeHoldings } = await import("../../src/lib/adapters/sui");
  const { data } = await serviceDb().from("wallets").select("name, address").eq("chain", "SUI");
  for (const w of data!) {
    const t = Date.now();
    const balances = (await fetchBalances(w.address)).filter((b) => BigInt(b.totalBalance) > BigInt(0));
    const meta = await fetchCoinMetadata(balances.map((b) => b.coinType));
    const stakes = await fetchSuiStakeHoldings(w.address);
    const rpc = await fetch("https://sui-mainnet-endpoint.blockvision.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getAllBalances", params: [w.address] }) }).then((r) => r.json()).catch(() => null);
    const rpcHeld = Array.isArray(rpc?.result) ? rpc.result.filter((b: { totalBalance: string }) => BigInt(b.totalBalance) > BigInt(0)).length : "n/a";
    console.log(`${w.name}: ${balances.length} coins (BlockVision ${rpcHeld}), ${[...meta.values()].filter(Boolean).length} with metadata, ${Date.now() - t}ms`);
    console.log("  native:", balances.find((b) => b.coinType === "0x2::sui::SUI")?.totalBalance ?? "none");
    for (const s of stakes) console.log(`  ${s.protocol_section}: ${(s.qty ?? 0).toFixed(4)} SUI — ${s.display_label}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
export {};
