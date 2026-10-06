import { revalidatePath } from "next/cache";
import { getUser } from "@/lib/auth";
import { guardUser } from "@/lib/abuseGuard";
import { runScan, type ScanProgress } from "@/lib/perpScoutScan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Perp Scout's Scan button, streamed (perpScoutScan.ts runScan): one JSON
 * line per step so the button can count up — {type:"progress", ...} — then
 * {type:"end", status, failed} or {type:"end", error}. A route handler, not
 * a Server Action: a scan takes up to a few minutes and actions run one at a
 * time per tab.
 */
export async function POST(): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "Sign in to scan" }, { status: 401 });
  const guard = await guardUser("perpScout", user);
  if (!guard.ok) return Response.json({ error: guard.error }, { status: 429 });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        const result = await runScan((p: ScanProgress) => send({ type: "progress", ...p }));
        if (result.status === "done") revalidatePath("/perp-scout");
        send({ type: "end", ...result });
      } catch (e) {
        console.error(`[perp-scout] scan failed: ${(e as Error).message}`);
        send({ type: "end", error: (e as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
