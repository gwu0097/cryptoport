import { alchemyWebhooks, saveEvmDelivery } from "@/lib/liveActivity";
import { validAlchemySignature, type AlchemyDelivery } from "@/lib/alchemyWebhookTx";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Alchemy's Address Activity webhooks for live Wallet Watch activity on EVM
 * chains (docs/wallet-watch/PLAN.md, phase 6). Each delivery is signed with
 * its webhook's signing key (X-Alchemy-Signature, HMAC-SHA256 of the raw
 * body); an unknown webhook or a bad signature is refused before anything is
 * read. A 500 makes Alchemy retry — safe, since legs are deduped by
 * transaction.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  let body: AlchemyDelivery;
  try {
    body = JSON.parse(raw) as AlchemyDelivery;
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }
  const signature = request.headers.get("x-alchemy-signature") ?? "";
  try {
    // A webhook created in the last minute isn't in this instance's cache yet.
    const find = (all: Awaited<ReturnType<typeof alchemyWebhooks>>) => Object.values(all).find((w) => w.id === body.webhookId);
    const webhook = find(await alchemyWebhooks()) ?? find(await alchemyWebhooks(true));
    if (!webhook || !validAlchemySignature(raw, signature, webhook.signingKey)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return Response.json(await saveEvmDelivery(body));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
