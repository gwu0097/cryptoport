import "server-only";
import { serviceDb, userDb } from "./supabase";
import { getUser } from "./auth";
import { chainDisplayName } from "./chainNames";
import { displaySymbol, tokenAmount, type SpamSign, type UnrecognizedReason } from "./unrecognizedTokens.ts";
import { spamSign } from "./tokenSpam.ts";

export interface UnrecognizedTokenRow {
  chain: string;
  chainName: string;
  contract: string;
  symbol: string;
  /** Whole tokens; null when decimals couldn't be read. */
  amount: number | null;
  reason: UnrecognizedReason;
  spam: SpamSign | null;
  firstSeenAt: string;
}

type Stored = {
  wallet_id?: string;
  chain: string;
  contract: string;
  symbol: string | null;
  decimals: number | null;
  status: string;
  last_balance_raw: string | null;
  first_seen_at: string;
};

/** Upper-cased symbols of CoinGecko-listed tokens on each chain, limited to
 * the symbols in `rows` (token_registry — what spamSign's "impersonates"
 * check compares against). Shared table: service client. */
async function listedSymbolsByChain(rows: readonly Stored[]): Promise<Map<string, Set<string>>> {
  const db = serviceDb();
  const wanted = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = (r.symbol ?? "").trim().toUpperCase();
    if (s) wanted.set(r.chain, (wanted.get(r.chain) ?? new Set()).add(s));
  }
  // One query per chain per 200 symbols, all at once: run one after another
  // they added 3.1 s to every render of a 1,071-token wallet (2026-09-25).
  const batches: { chain: string; symbols: string[] }[] = [];
  for (const [chain, symbols] of wanted) {
    const list = [...symbols];
    for (let i = 0; i < list.length; i += 200) batches.push({ chain, symbols: list.slice(i, i + 200) });
  }
  const results = await Promise.all(
    batches.map(async (b) => {
      const { data, error } = await db.from("token_registry").select("symbol").eq("chain_id", b.chain).not("coingecko_id", "is", null).in("symbol", b.symbols);
      if (error) throw new Error(`Failed to read token list: ${error.message}`);
      return { chain: b.chain, symbols: (data as { symbol: string }[]).map((r) => r.symbol.toUpperCase()) };
    }),
  );
  const out = new Map<string, Set<string>>();
  for (const r of results) for (const sym of r.symbols) out.set(r.chain, (out.get(r.chain) ?? new Set()).add(sym));
  return out;
}

const NONE = new Set<string>();

function toRows(stored: readonly Stored[], listed: Map<string, Set<string>>): UnrecognizedTokenRow[] {
  return stored.map((r) => ({
    chain: r.chain,
    chainName: chainDisplayName(r.chain),
    contract: r.contract,
    symbol: displaySymbol(r.symbol),
    amount: tokenAmount(r.last_balance_raw, r.decimals),
    reason: r.status === "unpriced" ? "unpriced" : "unlisted",
    spam: spamSign(r.symbol, listed.get(r.chain) ?? NONE),
    firstSeenAt: r.first_seen_at,
  }));
}

const COLUMNS = "wallet_id, chain, contract, symbol, decimals, status, last_balance_raw, first_seen_at";

/** The tokens this wallet held at its last sync that aren't counted
 * (docs/sync/PLAN.md D3). Rows not seen last sync (zero_syncs > 0) are no
 * longer held and are left out. RLS: the owner's rows only. */
export async function getWalletUnrecognizedTokens(walletId: string): Promise<UnrecognizedTokenRow[]> {
  if (!(await getUser())) return [];
  const db = await userDb();
  const stored: Stored[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("wallet_discovered_tokens")
      .select(COLUMNS)
      .eq("wallet_id", walletId)
      .eq("zero_syncs", 0)
      .order("chain")
      .order("contract")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to load unrecognized tokens: ${error.message}`);
    stored.push(...(data as Stored[]));
    if (data.length < 1000) break;
  }
  return toRows(stored, await listedSymbolsByChain(stored));
}

export interface CoverageCandidate {
  chain: string;
  chainName: string;
  contract: string;
  symbol: string;
  reason: UnrecognizedReason;
  wallets: number;
}

export interface UnrecognizedCoverage {
  tokens: number;
  wallets: number;
  bySpam: Record<SpamSign | "none", number>;
  byChain: { chain: string; chainName: string; tokens: number; notSpam: number }[];
  /** Tokens that don't look like spam, most-held first — the ones worth
   * checking (a new listing, a receipt standard we don't read yet). */
  candidates: CoverageCandidate[];
}

/** Every user's unrecognized tokens, summarized for /admin/pricing.
 * Admin-only: callers must have called requireAdmin(). */
export async function getUnrecognizedCoverage(): Promise<UnrecognizedCoverage> {
  const db = serviceDb();
  const stored: Stored[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("wallet_discovered_tokens")
      .select(`${COLUMNS}, wallets!inner(active)`)
      .eq("wallets.active", true)
      .eq("zero_syncs", 0)
      .order("wallet_id")
      .order("chain")
      .order("contract")
      .range(from, from + 999);
    if (error) throw new Error(`Failed to read unrecognized tokens: ${error.message}`);
    stored.push(...(data as unknown as Stored[]));
    if (data.length < 1000) break;
  }
  const rows = toRows(stored, await listedSymbolsByChain(stored));
  const bySpam: Record<SpamSign | "none", number> = { advertises: 0, impersonates: 0, lookalike: 0, none: 0 };
  const chains = new Map<string, { tokens: number; notSpam: number }>();
  const byToken = new Map<string, CoverageCandidate>();
  for (const r of rows) {
    bySpam[r.spam ?? "none"]++;
    const c = chains.get(r.chain) ?? { tokens: 0, notSpam: 0 };
    c.tokens++;
    if (!r.spam) c.notSpam++;
    chains.set(r.chain, c);
    if (!r.spam) {
      const k = `${r.chain}|${r.contract}`;
      const t = byToken.get(k) ?? { chain: r.chain, chainName: r.chainName, contract: r.contract, symbol: r.symbol, reason: r.reason, wallets: 0 };
      t.wallets++;
      byToken.set(k, t);
    }
  }
  return {
    tokens: rows.length,
    wallets: new Set(stored.map((r) => r.wallet_id)).size,
    bySpam,
    byChain: [...chains].map(([chain, c]) => ({ chain, chainName: chainDisplayName(chain), ...c })).sort((a, b) => b.tokens - a.tokens),
    candidates: [...byToken.values()].sort((a, b) => b.wallets - a.wallets || a.symbol.localeCompare(b.symbol)).slice(0, 50),
  };
}
