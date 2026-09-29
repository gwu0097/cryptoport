import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { claimPriceRefresh, revalidateAllPriceConsumers, runPriceRefresh } from "@/lib/priceRefreshJob";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The Refresh prices button (PriceRefreshButton): runs the refresh inline
 * and answers when prices are saved — ~3 s, so no polling (2026-09-29: a
 * click took 9.9 s, 5.7 of them waiting for the next 2.5 s poll to notice).
 * A route handler, not a Server Action: it doesn't hold the tab's action
 * queue while it runs. `walletId`: that wallet's page is revalidated too.
 * Another tab's refresh already running: { started: false } — the button
 * then waits for it the old way (useJob's polling).
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { walletId?: string };
  const requestedAt = Date.now();
  if (!(await claimPriceRefresh(requestedAt))) return Response.json({ started: false, reason: "A price refresh is already running." });
  const extraPaths = body.walletId ? [`/wallets/${body.walletId}`] : [];
  await runPriceRefresh(requestedAt, user.id, extraPaths);
  revalidateAllPriceConsumers();
  for (const path of extraPaths) revalidatePath(path);
  return Response.json({ started: true, done: true });
}
