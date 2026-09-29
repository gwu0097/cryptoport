import "server-only";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { serviceDb } from "./supabase";
import { captureUserSnapshot } from "./snapshots";
import { refreshAssetPrices, type OnLane } from "./adapters/assetPrices";
import { JOB_STALE_MS } from "./jobStatus";
import type { PriceRefreshPhases } from "./queries";

// The price refresh job: the Refresh prices button's route
// (api/prices/refresh) claims it, runs it inline and answers when prices are
// saved — a ~3 s job no longer needs polling (2026-09-29: a click took
// 9.9 s, 5.7 of them waiting for the next poll to notice). A refresh another
// tab started is still waited for by the button's useJob polling.

/** Claims the global price_refresh_state row (compare-and-set): false when
 * a refresh is already running (and isn't stale). */
export async function claimPriceRefresh(requestedAt: number): Promise<boolean> {
  const staleBefore = new Date(requestedAt - JOB_STALE_MS).toISOString();
  const { data: claimed, error } = await serviceDb()
    .from("price_refresh_state")
    .update({ status: "refreshing", started_at: new Date(requestedAt).toISOString() })
    .eq("id", 1)
    .or(`status.neq.refreshing,status.is.null,started_at.lt.${staleBefore}`)
    .select("id");
  if (error) throw new Error(`Failed to start price refresh: ${error.message}`);
  return !!claimed && claimed.length > 0;
}

// Prices are global (one shared asset_prices row per price_key — never
// just one wallet), so every page that
// shows a price needs revalidating, not just /wallets.
export function revalidateAllPriceConsumers() {
  revalidatePath("/wallets");
  revalidatePath("/assets");
  revalidatePath("/portfolio");
  revalidatePath("/defi");
  revalidatePath("/dashboard");
  // Now that a price refresh also writes today's snapshot (see
  // captureUserSnapshot), Performance' own value-history chart needs
  // revalidating too — it wasn't a price consumer before this.
  revalidatePath("/performance");
  // Watchlist coins are priced in the same pass (see runPriceRefresh).
  revalidatePath("/watchlist");
}

/** The actual work, awaited by api/prices/refresh. One pricing pass (refreshAssetPrices):
 * every held coin and every watchlist coin, each from its one source. Each
 * lane's time is saved once, with the result (the button shows it) — not
 * written as it runs: nobody polls for it now, and those ~8 sequential
 * writes held the answer back (2026-09-29). Never throws — a failure is
 * recorded as this singleton row's own status instead. */
export async function runPriceRefresh(requestedAt: number, userId: string, extraPaths: string[] = []): Promise<void> {
  const db = serviceDb();
  const phases: PriceRefreshPhases = {};
  const onLane: OnLane = (lane, status) => {
    phases[lane] = { status, ms: status === "running" ? null : Date.now() - requestedAt };
  };

  try {
    const { requested, laneErrors } = await refreshAssetPrices("refresh-prices", undefined, onLane);
    const status = laneErrors.length > 0 ? `partial — ${laneErrors.join("; ")}` : requested === 0 ? "no priced holdings" : "ok";
    const { error } = await db
      .from("price_refresh_state")
      // A failed lane means some prices weren't refreshed, so "Last priced"
      // doesn't move forward — only the status says what happened.
      .update(laneErrors.length > 0 ? { status, phases } : { refreshed_at: new Date().toISOString(), status, phases })
      .eq("id", 1);
    if (error) throw new Error(`Failed to record price refresh: ${error.message}`);
  } catch (e) {
    await db
      .from("price_refresh_state")
      .update({ status: `error: ${(e as Error).message}`, phases })
      .eq("id", 1);
  }

  // Nested after(), registered only now that prices are actually
  // refreshed — see scheduleUserSnapshot's doc comment.
  scheduleUserSnapshot(userId, extraPaths);
}

/**
 * Registers its own, separate after() call — from inside runPriceRefresh
 * (once the price update lands) and inside syncWalletHoldings' own
 * after() (once the synced holdings are saved), never awaited inline at
 * either call site. A real regression, reported directly ("had to wait
 * for processes to complete" just to navigate to Dashboard): an earlier
 * version awaited this snapshot capture directly inside the SAME after()
 * callback as the real refresh/sync work, so revalidateAllPriceConsumers()
 * (or the sync's own revalidatePath calls) — the signal that tells
 * useJob's polling "this job is done, stop refreshing" — didn't fire
 * until the snapshot capture ALSO finished, even though the actual
 * price/holdings update had already landed in the DB earlier. That
 * extended how long JobPoller kept calling router.refresh() for no
 * reason, which is exactly what collides with a real navigation click.
 * Next's own after() docs confirm nested/multiple after() registrations
 * each get their own independent waitUntil() — one running longer never
 * gates another's own revalidatePath calls, which is what makes calling
 * this via after() (not a plain await) the actual fix, not just moving
 * the call around. Still has to be called only once its own prerequisite
 * data (fresh prices, or freshly-saved holdings) is actually ready,
 * though — calling it concurrently with that work risks reading stale
 * data via its own getPriceMap()/holdings query, which is why this isn't
 * simply registered as a third, fully-independent after() at each outer
 * call site instead. Best-effort: a snapshot failure is a real but minor
 * degradation (the chart just stays one refresh further behind), never
 * something that should affect the actual refresh/sync's own reported
 * outcome.
 */
export function scheduleUserSnapshot(userId: string, extraPaths: string[] = []) {
  after(async () => {
    try {
      await captureUserSnapshot(userId);
      revalidatePath("/dashboard");
      revalidatePath("/performance");
      for (const path of extraPaths) revalidatePath(path);
    } catch {
      // swallowed — see comment above
    }
  });
}

