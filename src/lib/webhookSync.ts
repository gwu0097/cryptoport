import "server-only";
import { serviceDb } from "./supabase";
import { fetchWithRetry } from "./adapters/http";

// Keeps the app's one Helius webhook in step with the live addresses
// (docs/wallet-watch/PLAN.md, phase 5): created the first time, its address
// list replaced on every change, deleted when nothing is live. Each create,
// edit or delete costs 100 Helius credits; each delivered transaction 1.

const API = "https://api-mainnet.helius-rpc.com/v0/webhooks";
const SETTING = "helius_webhook";

async function heliusCall(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("Helius: no API key");
  const res = await fetchWithRetry(`${API}${path}?api-key=${key}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Helius webhook ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return method === "DELETE" ? null : res.json();
}

/** The live addresses' webhook, created, updated or removed to match. */
export async function syncLiveWebhook(): Promise<{ addresses: number; action: "created" | "updated" | "deleted" | "none" }> {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  if (!site.startsWith("https://") || site.includes("localhost")) {
    throw new Error("Live updates need the deployed site: Helius can't deliver to this address. Turn it on from the live site.");
  }
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) throw new Error("HELIUS_WEBHOOK_SECRET isn't set");
  const db = serviceDb();
  const [{ data: live, error }, { data: setting }] = await Promise.all([
    db.from("watched_addresses").select("address").eq("chain", "SOL").eq("live", true),
    db.from("app_settings").select("value").eq("key", SETTING).maybeSingle(),
  ]);
  if (error) throw new Error(`Failed to load live addresses: ${error.message}`);
  const addresses = (live as { address: string }[]).map((r) => r.address);
  const id = (setting?.value as { id?: string } | undefined)?.id;

  if (addresses.length === 0) {
    if (!id) return { addresses: 0, action: "none" };
    await heliusCall("DELETE", `/${id}`);
    await db.from("app_settings").delete().eq("key", SETTING);
    return { addresses: 0, action: "deleted" };
  }
  const body = { webhookURL: `${site.replace(/\/$/, "")}/api/wallet-watch/webhook`, transactionTypes: ["ANY"], accountAddresses: addresses, webhookType: "raw", authHeader: secret };
  if (id) {
    await heliusCall("PUT", `/${id}`, body);
    return { addresses: addresses.length, action: "updated" };
  }
  const created = (await heliusCall("POST", "", body)) as { webhookID?: string };
  if (!created.webhookID) throw new Error("Helius didn't return a webhook id");
  const { error: saveError } = await db.from("app_settings").upsert({ key: SETTING, value: { id: created.webhookID }, updated_at: new Date().toISOString() });
  if (saveError) throw new Error(`Webhook created (${created.webhookID}) but not saved: ${saveError.message}`);
  return { addresses: addresses.length, action: "created" };
}
