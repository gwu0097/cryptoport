import "server-only";
import { serviceDb } from "./supabase";
import { postDiscord, DISCORD_MAX_EMBEDS } from "./adapters/discordWebhook";
import { coinDays, type TxActivity } from "./watchActivity";
import { alertEmbed, watchAlerts } from "./watchAlerts";

// Posts a live delivery's alerts to the owner's Discord channel
// (DISCORD_WATCH_WEBHOOK_URL) as cards; the ones watchAlerts marks ping
// DISCORD_WATCH_ROLE_ID.
// Every live address posts — whatever the webhooks deliver. Only when there
// is something to say is the trader's name read (one request). A failure is
// logged, never thrown: the trade is saved either way, and a retried delivery
// adds no new legs, so it can't post twice.

export async function sendWatchAlerts(chain: string, address: string, before: TxActivity | null, after: TxActivity, newTxIds: ReadonlySet<string>): Promise<void> {
  const url = process.env.DISCORD_WATCH_WEBHOOK_URL;
  if (!url) return;
  try {
    const own = new Set([address]);
    const empty: TxActivity = { boundary: after.boundary, legs: [], base: after.base };
    const alerts = watchAlerts(coinDays([before ?? empty], own), coinDays([after], own), newTxIds);
    if (alerts.length === 0) return;

    const { data, error } = await serviceDb().from("watch_influencer_addresses").select("influencer_id, watch_influencers(name)").eq("chain", chain).eq("address", address);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as { influencer_id: string; watch_influencers: { name: string } | null }[];
    const names = [...new Set(rows.map((r) => r.watch_influencers?.name).filter((n): n is string => !!n))];
    const trader = names.join(" / ") || `${address.slice(0, 4)}…${address.slice(-4)}`;
    const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
    const link = site.startsWith("https://") && rows[0] ? `${site}/wallet-watch/${rows[0].influencer_id}` : null;
    const roleId = process.env.DISCORD_WATCH_ROLE_ID || null;

    // One post per delivery (up to 10 cards each); the role is mentioned in
    // the post's text, since a mention inside a card doesn't ping.
    for (let i = 0; i < alerts.length; i += DISCORD_MAX_EMBEDS) {
      const batch = alerts.slice(i, i + DISCORD_MAX_EMBEDS);
      const content = roleId && batch.some((a) => a.ping) ? `<@&${roleId}>` : "";
      await postDiscord(url, content, roleId, batch.map((a) => alertEmbed(trader, a, link)));
    }
  } catch (e) {
    console.error(`Wallet Watch alert for ${chain}:${address} not sent: ${(e as Error).message}`);
  }
}
