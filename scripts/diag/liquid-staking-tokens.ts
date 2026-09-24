// Read-only summary of cryptoport.liquid_staking_tokens (count, age, how
// many carry a category base, a sample by base). With --refresh, first runs
// the same refresh "Refresh token list" does (~10 CoinGecko calls — ask
// before spending them).
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/diag/liquid-staking-tokens.ts [--refresh]
process.loadEnvFile(`${__dirname}/../../.env.local`);

async function main() {
  const { serviceDb } = await import("../../src/lib/supabase");
  if (process.argv.includes("--refresh")) {
    const { refreshLiquidStakingTokens } = await import("../../src/lib/adapters/liquidStakingRegistry");
    console.log("refresh:", await refreshLiquidStakingTokens());
  }
  const { data, error } = await serviceDb().from("liquid_staking_tokens").select("coingecko_id, symbol, base_symbol, categories, updated_at");
  if (error) throw new Error(error.message);
  const rows = data as { coingecko_id: string; symbol: string; base_symbol: string | null; categories: string[]; updated_at: string }[];
  console.log(`${rows.length} tokens, updated ${rows.map((r) => r.updated_at).sort().at(-1) ?? "never"}`);
  const byBase = new Map<string, string[]>();
  for (const r of rows) byBase.set(r.base_symbol ?? "(inferred)", [...(byBase.get(r.base_symbol ?? "(inferred)") ?? []), r.symbol]);
  for (const [base, syms] of [...byBase].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${base}: ${syms.length} — ${syms.slice(0, 12).join(" ")}${syms.length > 12 ? " …" : ""}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
