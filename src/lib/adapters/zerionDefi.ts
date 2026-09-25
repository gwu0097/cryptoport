import "server-only";
import { fetchWithRetry } from "./http";
import { createTtlCache } from "../ttlCache";
import { EVM_CHAINS } from "./evmChains";
import { ZERION_PROTOCOL_NAMES as HYPERLIQUID_PROTOCOL_NAMES } from "./hyperliquid";
import { ZERION_PROTOCOL_NAMES as AXIE_PROTOCOL_NAMES } from "./axieStaking";
import { ZERION_PROTOCOL_NAMES as SUPERVERSE_PROTOCOL_NAMES } from "./superverseStaking";
import { ZERION_PROTOCOL_NAMES as POLYMARKET_PROTOCOL_NAMES } from "./polymarket";
import type { AdapterHolding } from "./types";

const API_BASE = "https://api.zerion.io/v1";

/**
 * Every protocol this app already has its own dedicated, hand-verified
 * adapter for — Zerion must never write a row for these, even if it starts
 * indexing them, or the wallet's total silently double-counts the same
 * real position (sync_defi_holdings' source='auto_defi' delete-scope is
 * deliberately disjoint from the regular sync's source='auto', so nothing
 * would ever catch or dedupe the overlap — see the "auto_defi" doc comment
 * on holdings.source in schema.sql).
 *
 * Unioned from each adapter's own `ZERION_PROTOCOL_NAMES` export rather
 * than hand-maintained as a separate list here — a real gap found live:
 * this file used to own that list directly, and SuperVerse's own adapter
 * shipped without anyone remembering to add it here until a stale, already-
 * double-counting-risk Zerion row was found by chance in the database
 * afterward. Colocating the exclusion with the adapter that needs it means
 * the next dedicated adapter naturally follows the same pattern when its
 * author copies an existing one as a template, rather than depending on
 * them separately remembering to come edit this file too. Every one of
 * these entries is a best guess at Zerion's own protocol-name string,
 * documented per-adapter for exactly how (un)verified it is — see each
 * adapter's own ZERION_PROTOCOL_NAMES comment. Polymarket's entry is not a
 * guess: found live via the database as a real, active double-count (two
 * wallets each carrying the same pUSD deposit counted under both this
 * app's own adapter and Zerion, ~$1,467 and ~$168) — Zerion does actively
 * index Polymarket, unlike Hyperliquid/SuperVerse's purely defensive
 * entries.
 */
const NATIVELY_COVERED_PROTOCOLS = new Set([
  ...HYPERLIQUID_PROTOCOL_NAMES,
  ...AXIE_PROTOCOL_NAMES,
  ...SUPERVERSE_PROTOCOL_NAMES,
  ...POLYMARKET_PROTOCOL_NAMES,
]);

export interface ZerionDefiResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

function authHeader(): string {
  const apiKey = process.env.ZERION_API_KEY;
  if (!apiKey) throw new Error("ZERION_API_KEY is not set.");
  // HTTP Basic: API key as username, empty password — Zerion's own
  // documented auth scheme, not a generic Bearer token.
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

interface ZerionChain {
  id: string; // Zerion's own internal chain id, e.g. "ethereum" — NOT
  // assumed human-readable or matching this app's own evmChains.ts ids;
  // only ever used as a lookup key into the map built below.
  attributes?: { external_id?: string }; // hex chain id, e.g. "0x1"
}

/**
 * Zerion's own internal chain ids aren't documented to match anything this
 * app already knows (they might coincide with human-readable names like
 * "ethereum", but that's never assumed/guessed — see this app's own
 * "unknown beats a wrong guess" rule, the same one that governs
 * resolveCoingeckoKey). Cross-referenced instead via the numeric EVM chain
 * id both sides genuinely share: Zerion's /v1/chains/ exposes each chain's
 * `external_id` as a hex chain id, matched against evmChains.ts's own
 * numeric `chainId`. Static reference data, cached in memory for a day
 * (CHAIN_MAP_CACHE) so each wallet sync spends one Zerion call (its
 * positions), not two.
 */
const CHAIN_MAP_CACHE = createTtlCache<Map<string, string>>(24 * 60 * 60 * 1000, 1);
const fetchZerionChainIdMap = () => CHAIN_MAP_CACHE.get("chains", loadZerionChainIdMap).then((r) => r.value);

async function loadZerionChainIdMap(): Promise<Map<string, string>> {
  const res = await fetchWithRetry(`${API_BASE}/chains/`, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Zerion chains lookup failed: HTTP ${res.status}`);
  const body: { data: ZerionChain[] } = await res.json();

  const byNumericId = new Map(EVM_CHAINS.map((c) => [c.chainId, c.id]));
  const map = new Map<string, string>();
  for (const chain of body.data ?? []) {
    const hex = chain.attributes?.external_id;
    if (!hex) continue;
    const numericId = Number.parseInt(hex, 16);
    const ourId = byNumericId.get(numericId);
    if (ourId) map.set(chain.id, ourId);
  }
  return map;
}

interface ZerionPosition {
  attributes?: {
    value?: number | null;
    quantity?: { float?: number | null };
    protocol?: string | null;
    application_metadata?: { name?: string | null; icon?: { url?: string | null } | null; url?: string | null } | null;
    fungible_info?: {
      symbol?: string | null;
      name?: string | null;
      icon?: { url?: string | null } | null;
      /** The token's contract on each chain (address null = the chain's native coin). */
      implementations?: { chain_id?: string | null; address?: string | null }[] | null;
    } | null;
    /** deposit | loan | locked | staked | reward | investment | wallet */
    position_type?: string | null;
    /** The protocol contract the position lives in — for liquid staking this
     * is the receipt token itself (Stader's pool is MaticX). */
    pool_address?: string | null;
  };
  relationships?: { chain?: { data?: { id?: string | null } } };
}

/**
 * Every complex (non-plain-balance) DeFi position Zerion knows about for an
 * EVM address, across every chain it indexes — lending deposits/borrows,
 * staked assets, LP shares, vaults, already resolved and USD-valued by
 * Zerion itself. This app's own regular EVM sync (multicallEvm.ts) only
 * ever reads plain token/native balances plus Hyperliquid specifically;
 * every other EVM protocol (Aave, Morpho, LP positions, ...) was untracked
 * before this, and hand-building one adapter per protocol the way this
 * session's Solana adapters were built would take a long time to reach
 * comparable coverage — see the "Add EVM DeFi position sync via Zerion"
 * plan for the full comparison against DeBank/Zapper/Covalent.
 *
 * Part of an EVM wallet's regular sync (syncWalletHoldings), fetched in
 * parallel with its balances so a liquid staking receipt and its position
 * are compared on one sync's fresh data (receiptDedupe.ts) — it used to be
 * a separate DeFi sync, which left the two out of step (2026-09-25). One
 * Zerion call per wallet sync; the free tier is 300 calls/day and 1/second
 * app-wide (fetchWithRetry retries its 429). Zerion only fills gaps: every
 * protocol a native adapter covers is skipped (NATIVELY_COVERED_PROTOCOLS).
 *
 * usd_override is Zerion's own resolved value, used only as the stored
 * fallback: each row is one coin's quantity in a protocol, so it's priced
 * by its coin's price_key like any other holding when one resolves
 * (assetIdentity.ts's isPositionValue), and by this value otherwise.
 */
const SECTIONS: Record<string, string> = {
  deposit: "Deposit",
  loan: "Borrowed",
  locked: "Locked",
  staked: "Staked",
  reward: "Rewards",
  investment: "Investment",
};
function sectionFor(positionType: string | null | undefined): string | null {
  return positionType ? (SECTIONS[positionType] ?? null) : null;
}

export async function fetchZerionDefiPositions(address: string): Promise<ZerionDefiResult> {
  const warnings: string[] = [];
  const [positionsRes, chainIdMap] = await Promise.all([
    fetchWithRetry(
      `${API_BASE}/wallets/${address}/positions/` +
        `?filter[positions]=only_complex` +
        `&filter[position_types][]=deposit&filter[position_types][]=loan&filter[position_types][]=locked` +
        `&filter[position_types][]=staked&filter[position_types][]=reward&filter[position_types][]=investment` +
        `&currency=usd`,
      { headers: { Authorization: authHeader(), Accept: "application/json" } },
    ),
    fetchZerionChainIdMap(),
  ]);
  if (!positionsRes.ok) throw new Error(`Zerion positions lookup failed: HTTP ${positionsRes.status}`);
  const body: { data: ZerionPosition[] } = await positionsRes.json();

  const holdings: AdapterHolding[] = [];
  for (const position of body.data ?? []) {
    const a = position.attributes;
    const zerionChainId = position.relationships?.chain?.data?.id;
    const ourChain = zerionChainId ? chainIdMap.get(zerionChainId) : undefined;
    if (!ourChain) {
      // Not necessarily a bug — Zerion indexes chains this app doesn't
      // (or, for something like Hyperliquid, a chain that already has its
      // own dedicated adapter) — dropped rather than guessed at, consistent
      // with this app's own "unknown beats a wrong guess" rule.
      warnings.push(`zerion: skipped a position on unrecognized chain "${zerionChainId ?? "unknown"}"`);
      continue;
    }

    const ticker = a?.fungible_info?.symbol;
    const usd = a?.value;
    if (!ticker || usd == null) {
      warnings.push(`zerion: skipped a position with no symbol/value on ${ourChain}`);
      continue;
    }

    const protocol = a?.application_metadata?.name ?? a?.protocol ?? "Unknown";
    if (NATIVELY_COVERED_PROTOCOLS.has(protocol.toLowerCase())) continue; // owned by a native adapter, see doc comment above

    // Each Zerion position is one token amount inside a protocol (a
    // deposit, a stake, rewards, a loan) — a coin quantity, priced by its
    // coin like any balance (docs/pricing/PLAN.md), so its contract is kept
    // (null = the chain's native coin). A loan is a debt: negative quantity
    // and value, so it's subtracted, not counted as owned (it used to be
    // stored positive, 2026-09-25).
    const impl = a?.fungible_info?.implementations?.find((i) => i.chain_id === zerionChainId);
    const isLoan = a?.position_type === "loan";
    const sign = isLoan ? -1 : 1;
    const qty = a?.quantity?.float;
    holdings.push({
      ticker,
      qty: qty == null ? null : sign * Math.abs(qty),
      usd_override: sign * Math.abs(usd),
      contract: impl?.address ? impl.address.toLowerCase() : null,
      category: "defi",
      chain: ourChain,
      icon_url: a?.fungible_info?.icon?.url ?? null,
      protocol,
      protocol_url: a?.application_metadata?.url ?? null,
      protocol_section: sectionFor(a?.position_type),
      pool_contract: a?.pool_address ? a.pool_address.toLowerCase() : null,
    });
  }

  return { holdings, warnings };
}
