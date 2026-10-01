import { getUser } from "@/lib/auth";
import { serviceDb } from "@/lib/supabase";
import { pickContract } from "@/lib/coinContract";

export const dynamic = "force-dynamic";

/**
 * A coin's contract to copy, asked only when its copy button is clicked
 * (the Dashboard movers): `jup:<mint>` is its own mint; a CoinGecko id is
 * looked up in token_registry (one request). Native coins have none.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getUser())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  if (!key) return Response.json({ contract: null });
  if (key.startsWith("jup:")) return Response.json({ contract: key.slice(4), chain: "solana" });
  if (key.includes(":")) return Response.json({ contract: null }); // venue keys (hl:, coinbase:) aren't tokens on a chain
  const { data, error } = await serviceDb().from("token_registry").select("chain_id, contract").eq("coingecko_id", key).limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const picked = pickContract((data ?? []) as { chain_id: string; contract: string }[]);
  return Response.json(picked ?? { contract: null });
}
