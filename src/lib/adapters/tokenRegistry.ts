import "server-only";
import { serviceDb } from "../supabase";
import { dedupeTokenRegistryRows } from "./tokenRegistryDedupe";

interface TokenRegistryRow {
  chain_id: string;
  contract: string;
  symbol: string;
  [key: string]: unknown;
}

/**
 * The single upsert implementation for cryptoport.token_registry —
 * decimals, image URLs, 24h change, and the CoinGecko coins/list import
 * all write through this. Extracted after tokenRegistryDedupe.ts's dedupe
 * step (see that file's own doc comment for the crash it prevents) was
 * applied by hand to three of what were then four separate copies of this
 * same upsert pattern, leaving the fourth (the coins/list import) still
 * exposed to the crash it fixes. One implementation now, so a future fix
 * here can't fail to propagate the same way.
 *
 * `symbol` has to be present on every row even when a caller only means to
 * update e.g. decimals: Postgres validates NOT NULL on the row an upsert
 * would insert even when a conflict is found and the actual write ends up
 * being the DO UPDATE branch instead — confirmed the hard way, this always
 * threw without it.
 */
export async function upsertTokenRegistry(rows: TokenRegistryRow[]): Promise<void> {
  const deduped = dedupeTokenRegistryRows(rows);
  // Chunked — Supabase/PostgREST has a practical payload-size ceiling, and
  // some chains (Ethereum, BSC) have tens of thousands of registered
  // contracts.
  for (let i = 0; i < deduped.length; i += 1000) {
    const chunk = deduped.slice(i, i + 1000);
    const { error } = await serviceDb()
      .from("token_registry")
      .upsert(chunk, { onConflict: "chain_id,contract" });
    if (error) throw new Error(`Failed to upsert token_registry: ${error.message}`);
  }
}
