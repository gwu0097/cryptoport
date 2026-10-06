import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { readPerpScout, runScan } from "@/lib/perpScoutScan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Tracked trades' Refresh: re-reads only the traders behind the user's
 * tracked trades (perpScoutScan.ts runScan with `only` — the same delta read
 * a Scan does: positions, fills since the last read, TP/SL when they
 * traded), so a close, add or trim shows without a full scan. The other
 * traders keep their last scan. Usually 1–3 s.
 */
export async function POST(): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Sign in to refresh" }, { status: 401 });
  const guard = await guardUser("perpScoutTracked", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  try {
    const { tracked } = await readPerpScout(user.id);
    const only = new Set(tracked.map((t) => t.address));
    if (only.size === 0) return Response.json({ status: "none", failed: 0 });
    const result = await runScan(() => {}, only);
    if (result.status === "done") revalidatePath("/perp-scout");
    return Response.json(result);
  } catch (e) {
    console.error(`[perp-scout] tracked refresh failed: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
