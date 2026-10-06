import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { isAdminEmail } from "@/lib/adminEmail";
import { guardUser } from "@/lib/abuseGuard";
import { addTrader, importTraders, removeTrader, renameTrader } from "@/lib/perpScoutScan";
import { MAX_FOLLOWED } from "@/lib/perpScout/followed";

export const dynamic = "force-dynamic";
/** An import reads each new trader's record, one at a time (~1 s each). */
export const maxDuration = 120;

/**
 * Perp Scout's list, changed on the page: POST {address, name?} adds a
 * trader (one Hyperliquid read for its record), POST {import: [{address,
 * name}]} adds several (Import, at most MAX_FOLLOWED a call; the results per
 * address come back), PATCH {address, name} renames one, DELETE {address}
 * removes one. Owner only — the list is shared by every viewer.
 */
async function owner(): Promise<Response | null> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (!isAdminEmail(user.email ?? null, process.env.ADMIN_EMAIL)) return Response.json({ error: "Only the site owner can change the list" }, { status: 403 });
  const guard = await guardUser("perpScoutPrices", user);
  return guard.ok ? null : Response.json({ error: guard.error }, { status: 429 });
}

async function body(request: Request): Promise<{ address?: unknown; name?: unknown; import?: unknown }> {
  return (await request.json().catch(() => ({}))) as { address?: unknown; name?: unknown; import?: unknown };
}

export async function POST(request: Request): Promise<Response> {
  const denied = await owner();
  if (denied) return denied;
  const { address, name, import: list } = await body(request);
  if (Array.isArray(list)) {
    if (list.length === 0 || list.length > MAX_FOLLOWED) return Response.json({ error: `Import 1 to ${MAX_FOLLOWED} traders at a time` }, { status: 400 });
    const items = list.map((x) => {
      const r = (x ?? {}) as { address?: unknown; name?: unknown };
      return { address: typeof r.address === "string" ? r.address : "", name: typeof r.name === "string" ? r.name : null };
    });
    const { results } = await importTraders(items);
    if (results.some((r) => r.ok)) revalidatePath("/perp-scout");
    return Response.json({ results });
  }
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

export async function PATCH(request: Request): Promise<Response> {
  const denied = await owner();
  if (denied) return denied;
  const { address, name } = await body(request);
  if (typeof address !== "string" || typeof name !== "string") return Response.json({ error: "No address or name given" }, { status: 400 });
  const result = await renameTrader(address, name);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
  revalidatePath("/perp-scout");
  return Response.json({ ok: true });
}
