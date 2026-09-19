"use server";

import { revalidatePath } from "next/cache";

/**
 * The real, reliable "something finished, purge every open tab's cache"
 * signal — called once by JobPoller.tsx's lightweight poll when it
 * observes a previously-running job transition to done, never from inside
 * a job's own after() callback. A completion signal from *inside* after()
 * can't reach the browser at all: Next attaches the client Router Cache
 * purge to the *response* of the Server Action that calls revalidatePath,
 * and after() runs strictly after that response has already been sent —
 * confirmed against Next's current docs, not assumed (a Server Action's
 * revalidatePath call "is communicated back to the browser in the
 * headers"; after() has no response left to attach anything to). This is
 * a live, synchronous Server Action instead, called from whichever tab's
 * own poll actually noticed the completion, so its own response carries
 * the purge every other open tab needs — the piece that was silently
 * missing before, not just a performance gap.
 *
 * Revalidates broadly (every page that could show synced/priced data)
 * rather than tracking exactly which job touched what — Next's own
 * revalidatePath still purges the *entire* client cache regardless of the
 * path argument given (confirmed still "temporary" per current docs), so
 * narrowing this list wouldn't actually narrow what gets purged today;
 * it's just future-proofing for whenever that becomes real per-path
 * scoping.
 */
export async function notifyJobsComplete(): Promise<void> {
  revalidatePath("/wallets");
  revalidatePath("/assets");
  revalidatePath("/portfolio");
  revalidatePath("/defi");
  revalidatePath("/dashboard");
  revalidatePath("/analytics");
  revalidatePath("/watchlist");
  revalidatePath("/transactions");
}
