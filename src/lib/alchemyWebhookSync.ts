import "server-only";
import { serviceDb } from "./supabase";
import { fetchWithRetry } from "./adapters/http";
import { WEBHOOK_NETWORKS } from "./alchemyWebhookTx";

// Keeps the app's Alchemy Address Activity webhooks in step with the live
// EVM addresses (docs/wallet-watch/PLAN.md, phase 6): one per network
// (Ethereum, Arbitrum, Robinhood Chain — the free plan allows 5), created
// the first time, its address list patched on every change, deleted when
// nothing is live. Every live address is on all three: an address costs
// nothing until it moves (~40 CU per delivered event). Each webhook's id,
// signing key and addresses are kept in app_settings.

const API = "https://dashboard.alchemy.com/api";
const SETTING = "alchemy_webhooks";

export interface AlchemyWebhook {
  id: string;
  signingKey: string;
  addresses: string[];
}
/** Per network (our chain id). */
export type AlchemyWebhooks = Record<string, AlchemyWebhook>;

async function notifyCall(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const token = process.env.ALCHEMY_NOTIFY_TOKEN;
  if (!token) throw new Error("ALCHEMY_NOTIFY_TOKEN isn't set");
  const res = await fetchWithRetry(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Alchemy-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Alchemy webhook ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json().catch(() => null);
}

/** The stored webhooks (for the delivery route's signature check). */
export async function loadAlchemyWebhooks(): Promise<AlchemyWebhooks> {
  const { data, error } = await serviceDb().from("app_settings").select("value").eq("key", SETTING).maybeSingle();
  if (error) throw new Error(`Failed to load Alchemy webhooks: ${error.message}`);
  return (data?.value as AlchemyWebhooks | undefined) ?? {};
}

/** The live EVM addresses' webhooks, created, patched or removed to match. */
export async function syncAlchemyWebhooks(): Promise<{ addresses: number; actions: string[] }> {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  if (!site.startsWith("https://") || site.includes("localhost")) {
    throw new Error("Live updates need the deployed site: Alchemy can't deliver to this address. Turn it on from the live site.");
  }
  const db = serviceDb();
  const [{ data: live, error }, stored] = await Promise.all([db.from("watched_addresses").select("address").eq("chain", "ETH").eq("live", true), loadAlchemyWebhooks()]);
  if (error) throw new Error(`Failed to load live addresses: ${error.message}`);
  const addresses = (live as { address: string }[]).map((r) => r.address.toLowerCase());
  const next: AlchemyWebhooks = { ...stored };
  const actions: string[] = [];
  // Saved after each network, so a failure part-way still records what exists.
  const save = async () => {
    const { error: saveError } = await db.from("app_settings").upsert({ key: SETTING, value: next, updated_at: new Date().toISOString() });
    if (saveError) throw new Error(`Alchemy webhooks changed but not saved: ${saveError.message}`);
  };

  for (const [chain, network] of Object.entries(WEBHOOK_NETWORKS)) {
    const current = next[chain];
    if (addresses.length === 0) {
      if (!current) continue;
      await notifyCall("DELETE", `/delete-webhook?webhook_id=${encodeURIComponent(current.id)}`);
      delete next[chain];
      actions.push(`${chain} deleted`);
    } else if (!current) {
      const created = (await notifyCall("POST", "/create-webhook", {
        network,
        webhook_type: "ADDRESS_ACTIVITY",
        webhook_url: `${site.replace(/\/$/, "")}/api/wallet-watch/evm-webhook`,
        name: `CryptoPort Wallet Watch (${chain})`,
        addresses,
      })) as { data?: { id?: string; signing_key?: string } } | null;
      if (!created?.data?.id || !created.data.signing_key) throw new Error(`Alchemy didn't return a webhook id and signing key for ${network}`);
      next[chain] = { id: created.data.id, signingKey: created.data.signing_key, addresses };
      actions.push(`${chain} created`);
    } else {
      const have = new Set(current.addresses);
      const want = new Set(addresses);
      const add = addresses.filter((a) => !have.has(a));
      const remove = current.addresses.filter((a) => !want.has(a));
      if (add.length === 0 && remove.length === 0) continue;
      await notifyCall("PATCH", "/update-webhook-addresses", { webhook_id: current.id, addresses_to_add: add, addresses_to_remove: remove });
      next[chain] = { ...current, addresses };
      actions.push(`${chain} updated`);
    }
    await save();
  }
  return { addresses: addresses.length, actions };
}

/** Each of our webhooks as Alchemy has it now (one free Notify call):
 * Alchemy deactivates a webhook on its own after repeated failed deliveries
 * (Robinhood Chain, 2026-10-02, while Vercel had paused the site). */
export async function alchemyWebhookStates(): Promise<{ network: string; active: boolean; reason: string | null }[]> {
  const stored = await loadAlchemyWebhooks();
  const ours = new Map(Object.entries(stored).map(([chain, w]) => [w.id, WEBHOOK_NETWORKS[chain as keyof typeof WEBHOOK_NETWORKS] ?? chain]));
  if (ours.size === 0) return [];
  const list = (await notifyCall("GET", "/team-webhooks")) as { data?: { id: string; is_active: boolean; deactivation_reason?: string | null }[] } | null;
  if (!list?.data) throw new Error("Alchemy didn't list its webhooks");
  const seen = new Map(list.data.map((w) => [w.id, w]));
  return [...ours].map(([id, network]) => {
    const w = seen.get(id);
    return w ? { network, active: w.is_active, reason: w.deactivation_reason ?? null } : { network, active: false, reason: "not found" };
  });
}
