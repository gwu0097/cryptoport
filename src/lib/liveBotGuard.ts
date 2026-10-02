import "server-only";
import { serviceDb } from "./supabase";
import { solanaDayCount } from "./adapters/solanaActivityRate";
import { evmDayCount } from "./adapters/evmActivityRate";
import { syncLiveWebhook } from "./webhookSync";
import { syncAlchemyWebhooks } from "./alchemyWebhookSync";
import { postDiscord } from "./adapters/discordWebhook";
import { LIVE_DAY_MAX } from "./liveBudget";

// Turns a live address off on its own when it turns out to be a bot (owner
// 2026-10-02): a receiver that sees SUSPECT_PER_HOUR deliveries for it in an
// hour asks here; its last 24 hours are counted (free public RPC for Solana,
// Alchemy for EVM) and only over LIVE_DAY_MAX is it taken off the webhook —
// a trader's burst never is. A Discord message says which and why.

const RECHECK_MS = 30 * 60_000;
const lastCheck = new Map<string, number>();
const stopped = new Set<string>();

/** Takes an address off live (database, the provider's webhook) and says so
 * on Discord. Once per address per instance. */
export async function turnLiveOff(chain: "SOL" | "ETH", address: string, why: string, clearCache: () => void): Promise<void> {
  const key = `${chain}|${address}`;
  if (stopped.has(key)) return;
  stopped.add(key);
  try {
    console.log(`[bot-guard] ${chain}:${address} turning live off: ${why}`);
    const db = serviceDb();
    const { error } = await db.from("watched_addresses").update({ live: false, live_since: null }).eq("chain", chain).eq("address", address);
    if (error) throw new Error(error.message);
    clearCache();
    await (chain === "SOL" ? syncLiveWebhook() : syncAlchemyWebhooks());
    const { data } = await db.from("watch_influencer_addresses").select("watch_influencers(name)").eq("chain", chain).eq("address", address);
    const names = [...new Set(((data ?? []) as unknown as { watch_influencers: { name: string } | null }[]).map((r) => r.watch_influencers?.name).filter(Boolean))].join(" / ") || address;
    const url = process.env.DISCORD_WATCH_WEBHOOK_URL;
    if (url) {
      await postDiscord(url, `⚠️ Live updates turned off for **${names}** (\`${address}\`): ${why} — a bot or exchange, not a trader; each transaction costs a webhook credit. Turn it back on from its page if that's wrong.`, null).catch((e: Error) => console.error(`[bot-guard] Discord: ${e.message}`));
    }
  } catch (e) {
    stopped.delete(key); // try again on the next delivery
    console.error(`[bot-guard] ${chain}:${address} not turned off: ${(e as Error).message}`);
  }
}

export async function checkSuspect(chain: "SOL" | "ETH", address: string, clearCache: () => void): Promise<void> {
  const key = `${chain}|${address}`;
  const now = Date.now();
  if (now - (lastCheck.get(key) ?? 0) < RECHECK_MS) return; // one check per half hour per address
  lastCheck.set(key, now);
  try {
    const day = await (chain === "SOL" ? solanaDayCount(address) : evmDayCount(address));
    console.log(`[bot-guard] ${chain}:${address} 24h=${day.count}${day.overLimit ? " OVER" : " ok"}`);
    if (day.overLimit) await turnLiveOff(chain, address, `over ${LIVE_DAY_MAX.toLocaleString()} transactions in the last 24 hours`, clearCache);
  } catch (e) {
    lastCheck.set(key, now - RECHECK_MS + 10 * 60_000); // couldn't tell: try again in 10 minutes
    console.error(`[bot-guard] ${chain}:${address} not checked: ${(e as Error).message}`);
  }
}
