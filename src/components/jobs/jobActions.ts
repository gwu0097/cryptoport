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
 * Revalidates the ROOT LAYOUT (`revalidatePath("/", "layout")`), which
 * covers every page under it, dynamic ones included. It used to list
 * literal paths ("/wallets", "/assets", ...), and a Server Action's
 * revalidatePath only "updates the UI immediately (if viewing the affected
 * path)" (Next's revalidatePath docs): a literal "/wallets" does not cover
 * "/wallets/<id>". So on a wallet's own page a sync that had finished never
 * refreshed the view: the button stayed on "Syncing…" and the new holdings
 * stayed hidden until a manual reload (reported 2026-09-23, a 1.2s Arweave
 * sync stuck "syncing" for over a minute). The layout form refreshes
 * whichever page the user is actually on. It isn't a wider purge than
 * before: revalidatePath already purges the whole client Router Cache
 * (still "temporary" per the docs).
 */
export async function notifyJobsComplete(): Promise<void> {
  revalidatePath("/", "layout");
}
