import "server-only";
import { serviceDb } from "./supabase";
import { refreshTokenRegistry } from "./adapters/coingecko";
import { refreshLiquidStakingTokens } from "./adapters/liquidStakingRegistry";
import { JOB_STALE_MS } from "./jobStatus";

// The token list (token_registry: CoinGecko's contract -> coin map for every
// supported chain, plus the liquid staking list) refreshes itself — there's
// no button (2026-09-25: an 80-second button a user had to remember):
//  - weekly, from its own cron (/api/cron/token-registry);
//  - after a Solana/Sui sync meets a token the list doesn't know, at most
//    once a day (refreshTokenRegistryIfStale from wallets/actions.ts).
// One CoinGecko call maps every contract on every chain, which is far
// cheaper than looking tokens up one by one as they appear. For EVM wallets
// the list is also the set of tokens a sync checks balances for (a chain
// can't list an address's tokens), and the spam filter.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Claims the one app-wide refresh (compare-and-set on token_registry_state,
 * recovering a claim stuck past JOB_STALE_MS). False = one is running. */
async function claim(): Promise<boolean> {
  const now = Date.now();
  const staleBefore = new Date(now - JOB_STALE_MS).toISOString();
  const { data, error } = await serviceDb()
    .from("token_registry_state")
    .update({ status: "refreshing", started_at: new Date(now).toISOString() })
    .eq("id", 1)
    .or(`status.neq.refreshing,status.is.null,started_at.lt.${staleBefore}`)
    .select("id");
  if (error) throw new Error(`Failed to claim token list refresh: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** The refresh itself. Never throws: the outcome is token_registry_state's
 * status. */
async function run(): Promise<string> {
  try {
    const results = await refreshTokenRegistry();
    const totalCount = results.reduce((sum, r) => sum + r.count, 0);
    const lst = await refreshLiquidStakingTokens().then(
      (r) => `${r.tokens} liquid staking tokens`,
      (e: Error) => `liquid staking tokens failed: ${e.message}`,
    );
    const status = `ok (${totalCount} tokens across ${results.length} chains; ${lst})`;
    await serviceDb().from("token_registry_state").update({ refreshed_at: new Date().toISOString(), status }).eq("id", 1);
    return status;
  } catch (e) {
    const status = `error: ${(e as Error).message}`;
    await serviceDb().from("token_registry_state").update({ status }).eq("id", 1);
    return status;
  }
}

/** Refreshes when the last successful refresh is older than maxAgeMs (and no
 * other refresh is running). Returns what happened. */
export async function refreshTokenRegistryIfStale(maxAgeMs: number): Promise<string> {
  const { data, error } = await serviceDb().from("token_registry_state").select("refreshed_at").eq("id", 1).maybeSingle();
  if (error) throw new Error(`Failed to read token list state: ${error.message}`);
  const last = data?.refreshed_at ? Date.parse(data.refreshed_at as string) : 0;
  if (Date.now() - last < maxAgeMs) return "fresh";
  if (!(await claim())) return "already running";
  return run();
}

export const TOKEN_LIST_DAILY = DAY_MS;
export const TOKEN_LIST_WEEKLY = 6 * DAY_MS; // the weekly cron: anything under a week old is fresh enough
