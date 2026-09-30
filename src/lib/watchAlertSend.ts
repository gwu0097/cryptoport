import "server-only";
import { serviceDb } from "./supabase";
import { postDiscord, DISCORD_MAX_EMBEDS } from "./adapters/discordWebhook";
import { coinDays, type CoinDay, type TxActivity } from "./watchActivity";
import { alertEmbed, watchAlerts } from "./watchAlerts";
import { renderCloseCard } from "./closeCardImage";
import { fetchTokenInfo } from "./adapters/jupiter";
import { getMarketFor } from "./queries";

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
    const beforeDays = coinDays([before ?? empty], own);
    const afterDays = coinDays([after], own);
    const first = watchAlerts(beforeDays, afterDays, newTxIds);
    if (first.length === 0) return;
    // With something to post: the coins' supply, for the market cap at each
    // card's price (one Jupiter call for Solana coins, one read for others).
    const posting = afterDays.filter((c) => first.some((a) => a.ticker === c.ticker && a.contract === c.contract));
    const supply = await supplies(posting).catch((e: Error) => {
      console.error(`Wallet Watch alert supply not read: ${e.message}`);
      return new Map<string, number>();
    });
    const alerts = watchAlerts(beforeDays, afterDays, newTxIds, (c) => supply.get(c.assetKey) ?? null);

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
      // A close carries its PnL image, drawn here (no extra request); a card
      // whose image fails posts without it.
      const files: { name: string; data: ArrayBuffer }[] = [];
      const embeds = [];
      for (const a of batch) {
        let image: string | undefined;
        if (a.card) {
          const name = `close-${files.length + 1}.png`;
          const data = await renderCloseCard(trader, a.card).catch((e: Error) => {
            console.error(`Close card not drawn: ${e.message}`);
            return null;
          });
          if (data) {
            files.push({ name, data });
            image = name;
          }
        }
        embeds.push(alertEmbed(trader, a, link, image));
      }
      await postDiscord(url, content, roleId, embeds, files);
    }
  } catch (e) {
    console.error(`Wallet Watch alert for ${chain}:${address} not sent: ${(e as Error).message}`);
  }
}

/** Each coin's circulating supply, by asset key: Jupiter's for a Solana
 * mint (new pump.fun coins included), else market cap ÷ price from
 * asset_prices (CoinGecko coins). A coin with neither has none — its card
 * shows no market cap rather than a guessed one. */
async function supplies(coins: readonly CoinDay[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const mints = coins.filter((c) => c.contractChain === "solana" && c.contract);
  if (mints.length > 0) {
    const info = await fetchTokenInfo(mints.map((c) => c.contract!));
    for (const c of mints) {
      const s = info.get(c.contract!)?.circSupply;
      if (typeof s === "number" && s > 0) out.set(c.assetKey, s);
    }
  }
  const rest = coins.filter((c) => !out.has(c.assetKey) && c.priceKey);
  if (rest.length > 0) {
    const { stats } = await getMarketFor(rest.map((c) => c.priceKey));
    for (const c of rest) {
      const st = stats.get(c.priceKey!);
      if (st?.marketCap && st.usd) out.set(c.assetKey, st.marketCap / st.usd);
    }
  }
  return out;
}
