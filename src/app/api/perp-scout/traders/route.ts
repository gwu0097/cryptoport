import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { isAdminEmail } from "@/lib/adminEmail";
import { guardUser } from "@/lib/abuseGuard";
import { addTrader, removeTrader } from "@/lib/perpScoutScan";

export const dynamic = "force-dynamic";

/**
 * Perp Scout's list, changed on the page: POST {address, name?} adds a
 * trader (one Hyperliquid read for its record), DELETE {address} removes one
 * added here. Owner only — the list is shared by every viewer.
 */
async function owner(): Promise<Response | null> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (!isAdminEmail(user.email ?? null, process.env.ADMIN_EMAIL)) return Response.json({ error: "Only the site owner can change the list" }, { status: 403 });
  const guard = await guardUser("perpScoutPrices", user);
  return guard.ok ? null : Response.json({ error: guard.error }, { status: 429 });
}

async function body(request: Request): Promise<{ address?: unknown; name?: unknown }> {
  return (await request.json().catch(() => ({}))) as { address?: unknown; name?: unknown };
}

export async function POST(request: Request): Promise<Response> {
  const denied = await owner();
  if (denied) return denied;
  const { address, name } = await body(request);
  if (typeof address !== "string") return Response.json({ error: "No address given" }, { status: 400 });
  const result = await addTrader(address, typeof name === "string" ? name : null);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  revalidatePath("/perp-scout");
  return Response.json({ ok: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await owner();
  if (denied) return denied;
  const { address } = await body(request);
  if (typeof address !== "string") return Response.json({ error: "No address given" }, { status: 400 });
  const result = await removeTrader(address);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  revalidatePath("/perp-scout");
  return Response.json({ ok: true });
}
