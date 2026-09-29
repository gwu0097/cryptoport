import "server-only";
import { fetchWithRetry } from "./http";

// Posts to a Discord channel webhook (Wallet Watch alerts, watchAlertSend.ts).
// Only Discord's own webhook URLs are accepted — the server makes this
// request. Pings nobody except the role named (never @everyone, whatever a
// token's name says). Discord allows ~30 messages a minute per webhook.

const DISCORD_WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** Discord's limit of cards (embeds) per message. */
export const DISCORD_MAX_EMBEDS = 10;

export async function postDiscord(url: string, content: string, roleId: string | null, embeds: readonly object[] = []): Promise<void> {
  if (!DISCORD_WEBHOOK.test(url.trim())) throw new Error("Not a Discord webhook URL");
  const res = await fetchWithRetry(url.trim(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, embeds, allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] } }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Discord: HTTP ${res.status}${res.status === 404 ? " (webhook deleted?)" : ""}`);
}
