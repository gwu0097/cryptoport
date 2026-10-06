import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { trackTrade, untrackTrade } from "@/lib/perpScoutScan";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's tracked trades in Perp Scout: POST {trade} marks one
 * (perpScout/tracked.ts TrackedTrade), DELETE {key} untracks one (trackedKey).
 * Each user's own list; nothing external is called.
 */
async function signedIn() {
  const user = await getUser();
  if (!user) return { user: null, denied: Response.json({ error: "Sign in to track trades" }, { status: 401 }) };
  const guard = await guardUser("perpScoutPrices", user);
  return guard.ok ? { user, denied: null } : { user: null, denied: Response.json({ error: guard.error }, { status: 429 }) };
}

export async function POST(request: Request): Promise<Response> {
  const { user, denied } = await signedIn();
  if (!user) return denied!;
  const body = (await request.json().catch(() => ({}))) as { trade?: unknown };
  const result = await trackTrade(user.id, body.trade);
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: 400 });
}

export async function DELETE(request: Request): Promise<Response> {
  const { user, denied } = await signedIn();
  if (!user) return denied!;
  const body = (await request.json().catch(() => ({}))) as { key?: unknown };
  if (typeof body.key !== "string") return Response.json({ error: "No trade given" }, { status: 400 });
  await untrackTrade(user.id, body.key);
  return Response.json({ ok: true });
}
