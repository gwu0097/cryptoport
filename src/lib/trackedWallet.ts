import "server-only";
import { serviceDb } from "./supabase";
import { truncateAddress, type WalletChain } from "./walletAuth";

type Db = ReturnType<typeof serviceDb>;

/**
 * Finds an existing ACTIVE tracked wallet for (chain, address) — shared by
 * the "link this wallet" flow ((app)/settings/walletActions.ts, via
 * userDb(), RLS-scoped — pass no userId, RLS already restricts rows to the
 * caller) and the wallet sign-in flow ((auth)/walletActions.ts, via
 * serviceDb(), no session yet to scope by — pass userId explicitly). These
 * used to be two independently hand-copied implementations of this exact
 * lookup.
 *
 * The .eq("active", true) + deterministic .order() are load-bearing, not
 * cosmetic: without them, a soft-deleted duplicate (deleteWallet sets
 * active=false, never removes the row — see its own comment in
 * (app)/wallets/actions.ts) could be the one returned, silently relinking/
 * re-syncing a stale leftover instead of the real tracked wallet the user
 * actually has open. Bit us live once already: verifying a wallet with an
 * old inactive duplicate lying around (same chain+address, from some
 * earlier duplicate-add) navigated to that empty duplicate instead of the
 * populated active one, which then looked like the synced holdings had
 * vanished until a fresh sync repopulated it.
 *
 * EVM dedupe deliberately does NOT filter on chain: a wallet tracked under
 * any of the 31 EVM chain labels (RON, SEI, ARB, ...) holds the exact same
 * address as one labeled plain ETH — the label is just which chain the
 * wallet is "focused" on for display, not which chains its 0x address
 * actually gets scanned across (see isAutoCapableChain's comment in
 * (app)/wallets/actions.ts). Filtering by chain='ETH' here would miss those
 * and create a duplicate, double-counted wallet with identical holdings —
 * a 0x-format address is unambiguous, no other chain's address format
 * overlaps with it, so matching on address alone is safe. Solana's 'SOL' is
 * the one literal chain value this app ever uses for that chain (per
 * types.ts), so an exact chain filter there is correct, not a guess.
 * wallets.address is stored exactly as typed elsewhere (see
 * (app)/wallets/actions.ts's optionalString), so EVM's match is
 * case-insensitive; Solana's base58 is case-sensitive, exact match.
 * .limit(1) instead of .maybeSingle() — a user who already tracks the same
 * address under two different EVM labels (or created a duplicate by hand)
 * would trigger .maybeSingle()'s "more than one match" error.
 */
export async function findExistingTrackedWallet(
  db: Db,
  chain: WalletChain,
  address: string,
  userId?: string,
): Promise<string | null> {
  let base = db.from("wallets").select("id").eq("active", true).order("created_at", { ascending: true });
  if (userId) base = base.eq("user_id", userId);
  const query = chain === "ETH" ? base.ilike("address", address) : base.eq("chain", chain).eq("address", address);
  const { data } = await query.limit(1);
  return data?.[0]?.id ?? null;
}

/**
 * Finds-or-creates the tracked wallet for (chain, address), returning its
 * id. Throws the raw insert error on failure — callers decide how to
 * present that (settings' flow wraps it with more context and lets it
 * propagate; the sign-in flow swallows it to null, since a failed
 * portfolio-tracking side effect shouldn't block signing in).
 *
 * userId omitted (settings' flow, via userDb()): the wallets.user_id
 * column's own `default auth.uid()` applies under the real session that
 * flow runs under. userId given (the sign-in flow, via serviceDb(), no
 * session to default from): set explicitly on both the lookup and the
 * insert.
 */
export async function ensureTrackedWallet(db: Db, chain: WalletChain, address: string, userId?: string): Promise<string> {
  const existing = await findExistingTrackedWallet(db, chain, address, userId);
  if (existing) return existing;

  const row: Record<string, unknown> = { chain, address, mode: "auto", name: truncateAddress(address) };
  if (userId) row.user_id = userId;

  const { data, error } = await db.from("wallets").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  return data.id;
}
