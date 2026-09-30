import "server-only";
import { fetchWithRetry } from "./http";

// Posts to a Discord channel webhook (Wallet Watch alerts, watchAlertSend.ts).
// Only Discord's own webhook URLs are accepted — the server makes this
// request. Pings nobody except the role named (never @everyone, whatever a
// token's name says). Discord allows ~30 messages a minute per webhook.

const DISCORD_WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** Discord's limit of cards (embeds) per message. */
export const DISCORD_MAX_EMBEDS = 10;

/** `files`: images sent with the message, which a card shows as
 * `attachment://<name>` (a closed position's PnL card). */
export async function postDiscord(url: string, content: string, roleId: string | null, embeds: readonly object[] = [], files: readonly { name: string; data: ArrayBuffer }[] = []): Promise<void> {
  if (!DISCORD_WEBHOOK.test(url.trim())) throw new Error("Not a Discord webhook URL");
  const payload = JSON.stringify({ content, embeds, allowed_mentions: { parse: [], roles: roleId ? [roleId] : [] } });
  let body: string | FormData = payload;
  if (files.length > 0) {
    const form = new FormData();
    form.set("payload_json", payload);
    files.forEach((f, i) => form.set(`files[${i}]`, new Blob([f.data], { type: "image/png" }), f.name));
    body = form;
  }
  const res = await fetchWithRetry(url.trim(), {
    method: "POST",
    ...(files.length > 0 ? {} : { headers: { "content-type": "application/json" } }),
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Discord: HTTP ${res.status}${res.status === 404 ? " (webhook deleted?)" : ""}`);
}
