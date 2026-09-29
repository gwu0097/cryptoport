import "server-only";
import { jupiterFetch } from "./jupiterFetch";
import { serviceDb } from "../supabase";
import { mintsToLookUp, mintsToShieldCheck, type CachedTokenInfo } from "../solanaTokenCache";
import type { AdapterHolding } from "./types";

// lite-api.jup.ag (this file's original host for all three endpoints below)
// is being deprecated in favor of api.jup.ag + an API key — live-confirmed
// (2026-09): lite-api still works today, but Jupiter's own migration docs
// say its rate limit will be "progressively reduced" before full retirement,
// with no fixed deadline. Migrated proactively rather than waiting for it to
// start failing. api.jup.ag serves the identical endpoints/response shapes
// (verified live, same data back from all three) and works keyless too —
// JUPITER_API_KEY just unlocks a higher rate limit, same optional-with-
// fallback pattern as HELIUS_API_KEY elsewhere in this app.
const API_HOST = "https://api.jup.ag";
const BALANCES_URL = `${API_HOST}/ultra/v1/balances`;
// Not the endpoint originally specified (price/v3) — that one doesn't return
// a symbol at all, only usdPrice/liquidity, and this project needs a human
// ticker for display and as the prices-table key. tokens/v2/search returns
// symbol + usdPrice + liquidity together; spot-checked its price/liquidity
// against price/v3 for the same mints and they matched exactly (same
// underlying feed), so this replaces price/v3 rather than adding a second
// call.
const TOKEN_SEARCH_URL = `${API_HOST}/tokens/v2/search`;
// Live-verified this session: a real, liquid, Jupiter-"verified" token
// (ORCA) comes back with only info-severity warnings (e.g.
// HAS_MINT_AUTHORITY — common, not disqualifying), while a copycat/spam
// mint that had cleared TOKEN_USD_FLOOR/LIQUIDITY_FLOOR (liquidity can be
// briefly wash-traded above a fixed $ floor, then withdrawn — a floor
// alone is gameable) came back with a "critical"-severity NOT_SELLABLE
// warning, matching the exact "Not Sellable"/JupShield panel Jupiter's own
// swap UI shows for it. This is that same signal, at sync time.
const SHIELD_URL = `${API_HOST}/ultra/v1/shield`;
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const SEARCH_BATCH_SIZE = 100;
// Live-verified via bisection (not documented anywhere): SHIELD_URL silently
// caps its response at 30 mints per call regardless of how many were
// requested in the query string — no error, no truncation flag, it just
// returns fewer warning entries than asked for. A wallet with >30 SPL
// balances sent through in one SEARCH_BATCH_SIZE-sized (100) batch had a
// real critical-severity NOT_SELLABLE mint silently missing from the
// response, so fetchUnsellableMints never flagged it and the unsellable
// token was shown as a normal priced holding. Keep this smaller than
// SEARCH_BATCH_SIZE (which tokens/v2/search does honor up to 100 for).
const SHIELD_BATCH_SIZE = 30;
const TOKEN_USD_FLOOR = 5;
// Not specified by the user (only "use liquidity as the spam filter"
// qualitatively) — chosen to clear the one confirmed pump-and-dump example
// ($324 position, $17,019 liquidity) with real margin. Tunable. Kept as a
// second layer alongside the shield check above, not a replacement for it.
const LIQUIDITY_FLOOR = 100_000;

interface JupiterBalance {
  amount: string;
  uiAmount: number;
  isFrozen: boolean;
}

export interface JupiterTokenInfo {
  id: string;
  symbol?: string;
  usdPrice?: number;
  liquidity?: number;
  /** Free — already part of tokens/v2/search's response, no extra call
   * needed (unlike EVM, where icons come from a separate CoinGecko call). */
  icon?: string;
  /** Also free — same response already carries 24h/6h/1h/5m stats; only
   * the 24h price change is used (see assetPrices.ts's jupiter lane, which
   * prices `jup:<mint>` keys), the rest isn't captured here since nothing
   * in this app uses it. */
  stats24h?: { priceChange?: number };
  /** Circulating supply — Wallet Watch alerts' market cap at a trade's price. */
  circSupply?: number;
  /** Market cap (price × circulating supply), stored with the price. */
  mcap?: number;
}

const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const HEADERS: Record<string, string> = {
  "User-Agent": "cryptoport/1.0",
  ...(JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}),
};

async function fetchBalances(address: string): Promise<Record<string, JupiterBalance>> {
  const res = await jupiterFetch(`${BALANCES_URL}/${address}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Jupiter balances failed: HTTP ${res.status}`);
  return res.json();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Exported for assetPrices.ts's jupiter lane (prices `jup:<mint>` keys)
 * and solanaStaking.ts's SOL icon lookup. */
export async function fetchTokenInfo(mints: string[]): Promise<Map<string, JupiterTokenInfo>> {
  if (mints.length === 0) return new Map();
  const info = new Map<string, JupiterTokenInfo>();
  for (const batch of chunk(mints, SEARCH_BATCH_SIZE)) {
    const url = `${TOKEN_SEARCH_URL}?query=${encodeURIComponent(batch.join(","))}`;
    const res = await jupiterFetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Jupiter tokens/v2/search failed: HTTP ${res.status}`);
    const results: JupiterTokenInfo[] = await res.json();
    for (const t of results) info.set(t.id, t);
  }
  return info;
}

interface ShieldWarning {
  type: string;
  severity: "critical" | "warning" | "info";
}

/** Mints with at least one critical-severity Shield warning (currently just
 * NOT_SELLABLE, but this checks severity rather than the specific type so a
 * future critical Jupiter adds is caught automatically) — see this file's
 * SHIELD_URL comment. */
async function fetchUnsellableMints(mints: string[]): Promise<Set<string>> {
  if (mints.length === 0) return new Set();
  const unsellable = new Set<string>();
  for (const batch of chunk(mints, SHIELD_BATCH_SIZE)) {
    const url = `${SHIELD_URL}?mints=${batch.join(",")}`;
    const res = await jupiterFetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Jupiter shield failed: HTTP ${res.status}`);
    const { warnings }: { warnings: Record<string, ShieldWarning[]> } = await res.json();
    for (const [mint, mintWarnings] of Object.entries(warnings)) {
      if (mintWarnings.some((w) => w.severity === "critical")) unsellable.add(mint);
    }
  }
  return unsellable;
}

/**
 * Every SPL balance the wallet holds, priced where Jupiter has a market for
 * it. A holding Jupiter has a *name* for but no live price is still
 * included as unpriced — "no price" is a real, visible state elsewhere in
 * this app, not silence, and a named-but-unpriced token (e.g. real but
 * thinly traded) is still worth knowing about. A holding with no metadata
 * at all — no symbol, nothing — is dropped entirely rather than shown as a
 * bare mint address: in practice this is almost always an NFT (amount=1 is
 * the classic tell) or a dead/never-indexed mint, and a raw base58 string
 * with no name and no price tells the user nothing they can act on.
 * Native SOL comes back under the literal key "SOL" and is mapped to the
 * wrapped-SOL mint only for the metadata/price lookup — the stored ticker
 * stays "SOL".
 *
 * Also excluded regardless of price/liquidity: any mint Jupiter's own
 * Shield flags as critically unsellable (see SHIELD_URL's comment) — a
 * spoofed-symbol/copycat token that a user can't actually trade away, which
 * TOKEN_USD_FLOOR/LIQUIDITY_FLOOR alone don't reliably catch (liquidity can
 * be briefly wash-traded above a fixed floor). Checked before either the
 * priced or named-but-unpriced branch below, since a spoofed-symbol scam
 * mint with no Jupiter price of its own is the easier way to sneak past
 * (see the ticker-collision note in valuation.ts's doc comment).
 */
export async function fetchJupiterHoldings(address: string): Promise<AdapterHolding[]> {
  return (await readJupiterWallet(address)).holdings;
}

/** A token the wallet holds that isn't shown (under the value or liquidity
 * floor, unnamed and unpriced, or flagged by Shield), with its amount. */
export interface HeldNotShown {
  chain: string;
  contract: string;
  symbol: string;
  amount: number;
}

/**
 * The shown holdings plus every held token left out — Wallet Watch keeps a
 * left-out token it stored before, so a token whose liquidity dips under the
 * floor between two reads isn't mistaken for a sale (GOON at $97,850 against
 * the $100,000 floor, 2026-09-27). A saved wallet's sync uses only the
 * holdings.
 */
/**
 * Token info for a wallet's mints, through solana_token_info
 * (solanaTokenCache.ts): only never-seen, worth-showing and expired mints
 * are looked up on Jupiter; what comes back (or doesn't — a dead mint is
 * remembered as unpriced) is saved for the next read, by any wallet. The
 * cache failing never fails the read: everything is looked up instead.
 */
async function tokenInfoCached(held: { mint: string; amount: number }[]): Promise<{ info: Map<string, JupiterTokenInfo>; cached: Map<string, CachedTokenInfo> | null }> {
  const db = serviceDb();
  const cached = new Map<string, CachedTokenInfo>();
  try {
    // An RPC with an array body (thousands of mints don't fit in a URL), a
    // thousand at a time: Supabase returns at most 1,000 rows per request —
    // 5,000 asked came back as 1,000, silently (2026-09-29).
    for (let i = 0; i < held.length; i += 1_000) {
      const { data, error } = await db.rpc("solana_token_info_get", { p_mints: held.slice(i, i + 1_000).map((h) => h.mint) });
      if (error) throw new Error(error.message);
      type Row = { mint: string; symbol: string | null; icon: string | null; usd_price: number | string | null; liquidity: number | string | null; checked_at: string; unsellable: boolean | null; shield_checked_at: string | null };
      for (const r of data as Row[]) {
        cached.set(r.mint, {
          mint: r.mint,
          symbol: r.symbol,
          icon: r.icon,
          usdPrice: r.usd_price === null ? null : Number(r.usd_price),
          liquidity: r.liquidity === null ? null : Number(r.liquidity),
          checkedAt: r.checked_at,
          unsellable: r.unsellable,
          shieldCheckedAt: r.shield_checked_at,
        });
      }
    }
  } catch (e) {
    console.error(`Solana token cache not read: ${(e as Error).message}`);
    return { info: await fetchTokenInfo(held.map((h) => h.mint)), cached: null };
  }
  const lookUp = mintsToLookUp(held, cached, Date.now());
  const fresh = await fetchTokenInfo(lookUp);
  const checkedAt = new Date().toISOString();
  const rows = lookUp.map((mint) => {
    const t = fresh.get(mint);
    return { mint, symbol: t?.symbol ?? null, icon: t?.icon ?? null, usd_price: t?.usdPrice ?? null, liquidity: t?.liquidity ?? null, checked_at: checkedAt };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("solana_token_info").upsert(rows.slice(i, i + 500), { onConflict: "mint" });
    if (error) console.error(`Solana token cache not saved: ${error.message}`);
  }
  // Fresh answers, else what was cached.
  const out = new Map<string, JupiterTokenInfo>();
  for (const [mint, c] of cached) {
    out.set(mint, { id: mint, symbol: c.symbol ?? undefined, icon: c.icon ?? undefined, usdPrice: c.usdPrice ?? undefined, liquidity: c.liquidity ?? undefined });
  }
  // Looked up again: Jupiter's answer replaces what was cached — and no
  // answer means no info now, as saved.
  for (const mint of lookUp) out.delete(mint);
  for (const [mint, t] of fresh) out.set(mint, t);
  // What's now stored, for the Shield verdicts saved next (full rows).
  for (const r of rows) cached.set(r.mint, { ...(cached.get(r.mint) ?? {}), mint: r.mint, symbol: r.symbol, icon: r.icon, usdPrice: r.usd_price, liquidity: r.liquidity, checkedAt: r.checked_at });
  return { info: out, cached };
}

/**
 * Shield verdicts for the show candidates, through the same cache: a priced
 * candidate is asked every read, a named but unpriced one weekly
 * (mintsToShieldCheck); the answers are saved. No cache: everyone is asked.
 */
async function unsellableCached(candidates: { mint: string; priced: boolean }[], cached: Map<string, CachedTokenInfo> | null): Promise<Set<string>> {
  if (!cached) return fetchUnsellableMints(candidates.map((c) => c.mint));
  const ask = mintsToShieldCheck(candidates, cached, Date.now());
  const fresh = await fetchUnsellableMints(ask);
  const unsellable = new Set(fresh);
  const asked = new Set(ask);
  for (const c of candidates) if (!asked.has(c.mint) && cached.get(c.mint)?.unsellable) unsellable.add(c.mint);
  const at = new Date().toISOString();
  // Whole rows: an upsert must satisfy the table's not-null columns even
  // where it only updates (verdict-only rows failed on checked_at).
  const rows = ask.flatMap((mint) => {
    const c = cached.get(mint);
    return c ? [{ mint, symbol: c.symbol, icon: c.icon, usd_price: c.usdPrice, liquidity: c.liquidity, checked_at: c.checkedAt, unsellable: fresh.has(mint), shield_checked_at: at }] : [];
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await serviceDb().from("solana_token_info").upsert(rows.slice(i, i + 500), { onConflict: "mint" });
    if (error) console.error(`Solana Shield verdicts not saved: ${error.message}`);
  }
  return unsellable;
}

export async function readJupiterWallet(address: string): Promise<{ holdings: AdapterHolding[]; heldNotShown: HeldNotShown[] }> {
  const balances = await fetchBalances(address);

  const entries = Object.entries(balances).filter(([, b]) => b.uiAmount > 0);
  const { info: tokenInfo, cached } = await tokenInfoCached(entries.map(([key, b]) => ({ mint: key === "SOL" ? WRAPPED_SOL_MINT : key, amount: b.uiAmount })));

  // What would be shown by price, liquidity and name alone; Shield is then
  // asked only about those (a row is shown only if it passes both, so the
  // result is the same). An active memecoin trader holds thousands of dead
  // mints — one wallet had ~2,700, and checking all of them was ~90 paced
  // Shield calls (~2 minutes) for 9 rows shown (2026-09-27).
  const shown = entries.filter(([key, balance]) => {
    const info = tokenInfo.get(key === "SOL" ? WRAPPED_SOL_MINT : key);
    const usd = info?.usdPrice != null ? info.usdPrice * balance.uiAmount : null;
    if (usd !== null) return usd > TOKEN_USD_FLOOR && (info?.liquidity ?? 0) >= LIQUIDITY_FLOOR;
    return key === "SOL" || !!info?.symbol; // no name, no price — nothing to show, see doc comment above
  });
  const unsellable = await unsellableCached(
    shown.map(([key]) => {
      const mint = key === "SOL" ? WRAPPED_SOL_MINT : key;
      return { mint, priced: tokenInfo.get(mint)?.usdPrice != null };
    }),
    cached,
  );

  const shownKeys = new Set(shown.map(([key]) => key));
  const heldNotShown: HeldNotShown[] = entries
    .filter(([key]) => key !== "SOL" && (!shownKeys.has(key) || unsellable.has(key)))
    .map(([key, balance]) => ({ chain: "solana", contract: key, symbol: tokenInfo.get(key)?.symbol ?? key.slice(0, 6), amount: balance.uiAmount }));

  const holdings: AdapterHolding[] = [];
  for (const [key, balance] of shown) {
    const mint = key === "SOL" ? WRAPPED_SOL_MINT : key;
    if (unsellable.has(mint)) continue;
    const info = tokenInfo.get(mint);

    holdings.push({
      ticker: key === "SOL" ? "SOL" : (info?.symbol ?? key),
      qty: balance.uiAmount,
      usd_override: null,
      contract: key === "SOL" ? null : key,
      category: "token",
      chain: "solana",
      icon_url: info?.icon ?? null,
    });
  }

  return { holdings, heldNotShown };
}
