import { getUser } from "@/lib/auth";
import { serviceDb } from "@/lib/supabase";
import { copyableContracts, ownContract } from "@/lib/coinContracts";

export const dynamic = "force-dynamic";

/**
 * A coin's contract to copy, asked only when its copy button is clicked
 * (the Dashboard movers): `jup:<mint>` is its own mint; a CoinGecko id is
 * looked up in token_registry (one request) and only an address that can be
 * copied as written is offered (coinContracts.ts: a Solana/Sui address from
 * `contract_exact` — the lowercase `contract` is a wrong mint). Native coins
 * have none.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getUser())) return Response.json({ error: "Not signed in" }, { status: 401 });
  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  if (!key) return Response.json({ contract: null });
  const own = ownContract(key);
  if (own) return Response.json({ contract: own.contract, chain: own.chainName });
  if (key.includes(":")) return Response.json({ contract: null }); // venue keys (hl:, coinbase:) aren't tokens on a chain
  const { data, error } = await serviceDb().from("token_registry").select("chain_id, contract, contract_exact").eq("coingecko_id", key).limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const [first] = copyableContracts((data ?? []) as { chain_id: string; contract: string; contract_exact: string | null }[]);
  return Response.json(first ? { contract: first.contract, chain: first.chainName } : { contract: null });
}
