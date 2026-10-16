import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { serviceDb, userDb } from "@/lib/supabase";
import { ALCHEMY_HOSTS } from "@/lib/adapters/alchemy";
import { evmCostEvents } from "@/lib/adapters/costBasisEvm";
import { solanaCostEvents } from "@/lib/adapters/costBasisSolana";
import { EVM_CHAINS } from "@/lib/adapters/evmChains";
import { chainDisplayName } from "@/lib/chainNames";
import { averageCost, valuePaid, valueQtyPaid, type CostBasisRow } from "@/lib/costBasis";
import { DOLLAR_KEYS } from "@/lib/watchActivity";
import { fetchLlamaHistorical } from "@/lib/adapters/llamaPrices";
import { costBasisSettingKey, type SavedCostBasis } from "@/lib/costBasisStore";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/token/cost-basis {key, walletId} — a holding's cost basis, on
 * demand from the token drawer (owner 2026-10-14). The token's movements in
 * that wallet and what each buy paid — EVM from its transfers
 * (costBasisEvm.ts, ~2–4 Alchemy requests), Solana from its token account's
 * transactions (costBasisSolana.ts, owner 2026-10-16: ~1 Helius credit per
 * transaction, at most SOLANA_TX_CAP) — each payment valued when it was paid
 * (DefiLlama's price history, one batched call), averaged (costBasis.ts). The
 * answer is saved per user, wallet and
 * coin (costBasisStore.ts) and shown by `api/token` until a Refresh.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const guard = await guardUser("costBasis", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  const { key, walletId } = (await request.json().catch(() => ({}))) as { key?: string; walletId?: string };
  if (!key || !walletId) return Response.json({ error: "key and walletId required" }, { status: 400 });

  const db = await userDb();
  const [{ data: wallet }, { data: rows, error }] = await Promise.all([
    db.from("wallets").select("id, address").eq("id", walletId).eq("active", true).maybeSingle(),
    db.from("holdings").select("qty, chain, contract").eq("wallet_id", walletId).eq("price_key", key).not("contract", "is", null),
  ]);
  if (!wallet?.address) return Response.json({ error: "Wallet not found" }, { status: 404 });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  type Row = { qty: number | string | null; chain: string | null; contract: string };
  const all = (rows ?? []) as Row[];
  const evmRows = all.filter((r) => r.chain && ALCHEMY_HOSTS[r.chain] && /^0x[0-9a-fA-F]{40}$/.test(r.contract));
  const solRows = all.filter((r) => r.chain === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.contract));
  if (evmRows.length === 0 && solRows.length === 0) return saved(user.id, walletId, key, { results: [], note: "Cost basis reads EVM and Solana tokens (not a chain's own coin, or other chains yet).", computedAt: new Date().toISOString() });

  const results: CostBasisRow[] = [];
  const tsOf = (at: string) => Math.floor(Date.parse(at) / 1000);
  for (const row of solRows) {
    let raw: Awaited<ReturnType<typeof solanaCostEvents>>;
    try {
      raw = await solanaCostEvents(wallet.address, row.contract);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
    // SOL by its CoinGecko id, every token by its mint — DefiLlama prices both.
    const events = raw.events.map((e) => ({ at: e.at, qty: e.qty, paid: e.paid.map((p) => ({ coin: p.mint ? `solana:${p.mint}` : "coingecko:solana", qty: p.qty })) }));
    const points = events.flatMap((e) => (e.qty > 0 ? e.paid.map((p) => ({ coin: p.coin, ts: tsOf(e.at) })) : []));
    let priced = new Map<string, number>();
    try {
      if (points.length) priced = await fetchLlamaHistorical(points);
    } catch (e) {
      return Response.json({ error: `Price history: ${(e as Error).message}` }, { status: 502 });
    }
    const basis = averageCost(valueQtyPaid(events, (coin, at) => priced.get(`${coin}|${tsOf(at)}`) ?? null));
    const firstSeenAt = raw.events.filter((e) => e.qty > 0).map((e) => e.at).sort()[0] ?? null;
    results.push({ ...basis, chain: "solana", chainName: chainDisplayName("solana"), holdingQty: row.qty === null ? null : Number(row.qty), firstSeenAt, partial: raw.partial });
  }
  for (const row of evmRows) {
    const chain = row.chain!;
    let raw: Awaited<ReturnType<typeof evmCostEvents>>;
    try {
      raw = await evmCostEvents(wallet.address, chain, row.contract);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
    // What each buy paid with: the native coin, or tokens named by the registry.
    const paidContracts = [...new Set(raw.events.flatMap((e) => e.paid.map((p) => p.contract)).filter((c): c is string => !!c))];
    const { data: reg } = paidContracts.length
      ? await serviceDb().from("token_registry").select("contract, coingecko_id, decimals").eq("chain_id", chain).in("contract", paidContracts)
      : { data: [] };
    const registry = new Map(((reg ?? []) as { contract: string; coingecko_id: string | null; decimals: number | null }[]).map((r) => [r.contract.toLowerCase(), r]));
    const nativeKey = EVM_CHAINS.find((c) => c.id === chain)?.nativeCoingeckoId ?? "ethereum";
    // Each payment priced when it was paid (DefiLlama's history, one batched
    // call) — the app's own closes only reach back months.
    const coinOf = (contract: string | null) => (contract ? registry.get(contract)?.coingecko_id : nativeKey);
    const points = raw.events.flatMap((e) => (e.qty > 0 ? e.paid.map((p) => coinOf(p.contract)).filter((k): k is string => !!k && !DOLLAR_KEYS.has(k)).map((k) => ({ coin: `coingecko:${k}`, ts: tsOf(e.at) })) : []));
    let priced = new Map<string, number>();
    try {
      if (points.length) priced = await fetchLlamaHistorical(points);
    } catch (e) {
      return Response.json({ error: `Price history: ${(e as Error).message}` }, { status: 502 });
    }
    const priceOf = (contract: string | null, at: string) => {
      const k = coinOf(contract);
      const decimals = contract ? registry.get(contract)?.decimals : 18;
      if (!k || decimals == null) return null;
      const usd = DOLLAR_KEYS.has(k) ? 1 : priced.get(`coingecko:${k}|${tsOf(at)}`);
      return usd === undefined ? null : { usd, decimals };
    };
    const basis = averageCost(valuePaid(raw.events, priceOf));
    const firstSeenAt = raw.events.filter((e) => e.qty > 0).map((e) => e.at).sort()[0] ?? null;
    results.push({ ...basis, chain, chainName: chainDisplayName(chain), holdingQty: row.qty === null ? null : Number(row.qty), firstSeenAt, partial: raw.partial });
  }
  return saved(user.id, walletId, key, { results, computedAt: new Date().toISOString() });
}

/** Keeps the answer (costBasisStore.ts) so the drawer shows it next time
 * without reading the history again; a failed save still returns it. */
async function saved(userId: string, walletId: string, key: string, value: SavedCostBasis): Promise<Response> {
  const { error } = await serviceDb().from("app_settings").upsert({ key: costBasisSettingKey(userId, walletId, key), value, updated_at: value.computedAt });
  if (error) console.warn(`[cost-basis] save failed wallet=${walletId} key=${key}: ${error.message}`);
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}
