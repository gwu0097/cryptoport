import { timingSafeEqual } from "node:crypto";
import { saveDelivery } from "@/lib/liveActivity";
import type { RawWebhookTx } from "@/lib/webhookTx";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Helius's webhook for live Wallet Watch activity (docs/wallet-watch/PLAN.md,
 * phase 5). Helius sends the secret we set on the webhook as the
 * Authorization header; anything else is refused. A 500 makes Helius retry —
 * safe, since legs are deduped by transaction.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  const given = request.headers.get("authorization") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as RawWebhookTx[] | null;
  if (!Array.isArray(body)) return Response.json({ error: "Expected an array of transactions" }, { status: 400 });
  try {
    return Response.json(await saveDelivery(body));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
