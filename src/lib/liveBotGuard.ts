import "server-only";
import { serviceDb } from "./supabase";
import { solanaDayCount } from "./adapters/solanaActivityRate";
import { evmDayCount } from "./adapters/evmActivityRate";
import { syncLiveWebhook } from "./webhookSync";
import { alchemyWebhookStates, syncAlchemyWebhooks } from "./alchemyWebhookSync";
import { webhookProblems, type WebhookState } from "./webhookHealth";
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
    const message = (e as Error).message;
    console.error(`[bot-guard] ${chain}:${address} not turned off: ${message}`);
    await alarm(`🚨 Couldn't take \`${address}\` off the ${chain === "SOL" ? "Helius" : "Alchemy"} webhook (${why}): ${message.slice(0, 160)}. Its deliveries keep costing credits and Vercel runs — disable the webhook in the ${chain === "SOL" ? "Helius" : "Alchemy"} dashboard now.`);
  }
}

/** A loud Discord line, at most once an hour per message kind. */
const alarmedAt = new Map<string, number>();
async function alarm(text: string): Promise<void> {
  const kind = text.slice(0, 40);
  if (Date.now() - (alarmedAt.get(kind) ?? 0) < 60 * 60_000) return;
  alarmedAt.set(kind, Date.now());
  const url = process.env.DISCORD_WATCH_WEBHOOK_URL;
  if (url) await postDiscord(url, text, null).catch((e: Error) => console.error(`[bot-guard] Discord: ${e.message}`));
}

/** Addresses nobody watches any more come off live (and the providers'
 * webhooks): a deleted influencer or address left its address live, paying
 * per delivery with no switch left to turn it off (audit 2026-10-02). */
export async function releaseUnwatched(keys: readonly { chain: string; address: string }[], clearCache: () => void = () => {}): Promise<number> {
  const db = serviceDb();
  let released = 0;
  const chains = new Set<"SOL" | "ETH">();
  for (const k of keys) {
    if (k.chain !== "SOL" && k.chain !== "ETH") continue;
    const { count } = await db.from("watch_influencer_addresses").select("id", { count: "exact", head: true }).eq("chain", k.chain).eq("address", k.address);
    if ((count ?? 0) > 0) continue;
    const { data } = await db.from("watched_addresses").update({ live: false, live_since: null }).eq("chain", k.chain).eq("address", k.address).eq("live", true).select("address");
    if (data?.length) {
      released++;
      chains.add(k.chain);
    }
  }
  if (released > 0) {
    clearCache();
    for (const chain of chains) await (chain === "SOL" ? syncLiveWebhook() : syncAlchemyWebhooks()).catch((e: Error) => alarm(`🚨 Couldn't update the ${chain === "SOL" ? "Helius" : "Alchemy"} webhook after removing a watched address: ${e.message.slice(0, 160)}`));
  }
  return released;
}

/**
 * The daily live-set sweep (the morning tick's first run; audit 2026-10-02):
 * every live address no one watches comes off, every one whose last 24 hours
 * are over LIVE_DAY_MAX comes off, then both providers' webhooks are synced
 * to the database (so a list that drifted — an edit that failed, a hand
 * change — is corrected daily), and one Discord line says what's live.
 * Within `budgetMs`; whatever isn't reached is checked tomorrow.
 */
export async function sweepLive(budgetMs = 80_000): Promise<void> {
  const t0 = Date.now();
  const db = serviceDb();
  const { data } = await db.from("watched_addresses").select("chain, address").eq("live", true);
  const live = (data ?? []) as { chain: "SOL" | "ETH"; address: string }[];
  const orphans = await releaseUnwatched(live);
  const offs: string[] = [];
  const counts: string[] = [];
  for (const r of live) {
    if (Date.now() - t0 > budgetMs) break;
    const day = await (r.chain === "SOL" ? solanaDayCount(r.address) : evmDayCount(r.address)).catch(() => null);
    if (!day) continue;
    counts.push(`${r.address.slice(0, 6)} ${day.count.toLocaleString()}`);
    if (day.overLimit) {
      stopped.delete(`${r.chain}|${r.address}`);
      await turnLiveOff(r.chain, r.address, `over ${LIVE_DAY_MAX.toLocaleString()} transactions in the last 24 hours (daily sweep)`, () => {});
      offs.push(r.address.slice(0, 6));
    }
  }
  const synced: string[] = [];
  // Whether each provider still delivers: Helius's state comes back with the
  // update it gets anyway (no extra credit), Alchemy's from one free list call.
  const states: WebhookState[] = [];
  await syncLiveWebhook()
    .then((r) => {
      synced.push(`Helius ${r.addresses}`);
      if (r.state) states.push({ provider: "Helius", active: r.state.active, reason: r.state.disabledReason });
    })
    .catch((e: Error) => alarm(`🚨 Daily sweep couldn't sync the Helius webhook: ${e.message.slice(0, 160)}`));
  await syncAlchemyWebhooks().then((r) => synced.push(`Alchemy ${r.addresses}`)).catch((e: Error) => alarm(`🚨 Daily sweep couldn't sync the Alchemy webhooks: ${e.message.slice(0, 160)}`));
  await alchemyWebhookStates()
    .then((list) => states.push(...list.map((w) => ({ provider: "Alchemy" as const, network: w.network, active: w.active, reason: w.reason }))))
    .catch((e: Error) => console.error(`[live-sweep] Alchemy webhook states: ${e.message}`));
  for (const problem of webhookProblems(states)) await alarm(`🚨 ${problem}`);
  const line = `🧹 Live sweep: ${live.length - orphans - offs.length} live (${synced.join(", ") || "webhooks not synced"})${orphans ? ` · ${orphans} unwatched turned off` : ""}${offs.length ? ` · bots turned off: ${offs.join(", ")}` : ""} · 24h transactions: ${counts.join(" · ") || "—"}`;
  console.log(`[live-sweep] ${line}`);
  const url = process.env.DISCORD_WATCH_WEBHOOK_URL;
  if (url) await postDiscord(url, line.slice(0, 1900), null).catch(() => {});
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
