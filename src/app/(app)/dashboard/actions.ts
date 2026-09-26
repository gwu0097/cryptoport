"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { isEvmChainId } from "@/lib/adapters/evmChains";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { fetchHyperliquidHoldings } from "@/lib/adapters/hyperliquid";
import { fetchLighterHoldings } from "@/lib/adapters/lighter";
import { fetchPolymarketHoldings } from "@/lib/adapters/polymarket";
import { fetchAsterHoldings } from "@/lib/adapters/aster";
import { fetchJupiterPerps } from "@/lib/adapters/jupiterPerps";
import { fetchJupiterPrediction } from "@/lib/adapters/jupiterPrediction";
import { withPriceKeys } from "@/lib/adapters/assetKeys";
import { carryForward, type KeepableRow, type KeepScope } from "@/lib/carryForward";
import { venueOwns, venuesToRefresh, type PositionVenue } from "@/lib/perpPositions";
import { markVenueActivity, readVenueActivity } from "@/lib/venueActivity";
import type { AdapterHolding } from "@/lib/adapters/types";

export interface PositionsRefreshResult {
  /** Venue accounts re-read and saved. */
  accounts: number;
  /** "<wallet> · <venue>: <why>" for each account left as it was. */
  failed: string[];
}

const MAX_PARALLEL = 10;

// The columns a kept row is re-saved with (replace_venue_holdings inserts these).
const ROW_COLUMNS =
  "ticker, qty, usd_override, contract, category, chain, icon_url, protocol, protocol_url, position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd, position_pnl_percent, position_tpsl, display_label, protocol_section";

type StoredRow = AdapterHolding & KeepableRow;

/** One venue account, fresh: the same adapter the wallet sync uses. A part of
 * a Hyperliquid read that failed (vaults, referral rewards) keeps its previous
 * rows, as in the sync (carryForward.ts). Throws if the account can't be read. */
async function freshVenueRows(venue: PositionVenue, address: string, previous: StoredRow[]): Promise<AdapterHolding[]> {
  switch (venue.id) {
    case "hyperliquid": {
      const r = await fetchHyperliquidHoldings(address);
      return carryForward(r.holdings as StoredRow[], previous, r.keep as KeepScope[]).holdings;
    }
    case "lighter":
      return fetchLighterHoldings(address);
    case "aster":
      return (await fetchAsterHoldings(address)).holdings;
    case "polymarket":
      return fetchPolymarketHoldings(address);
    case "jupiter-perps":
      return (await fetchJupiterPerps(address)).holdings;
    case "jupiter-prediction":
      return (await fetchJupiterPrediction(address)).holdings;
  }
}

/**
 * "Refresh positions" on the Dashboard: re-reads only the venue accounts
 * (perpPositions.ts POSITION_VENUES) where the user has an open position — or
 * had one in the last 30 days (wallet_venue_activity), so a position opened
 * after the last one closed is still found — one
 * account call each, and replaces that venue's rows for that wallet —
 * positions, cash and margin together, so wallet totals stay right (a perp's
 * PnL lands in its account's cash rows). No chain scan, no price refresh, no
 * CoinGecko. A position opened or closed on that venue shows up; the wallet's
 * other rows and its last-synced time are untouched. Usually about a second,
 * so it runs in the request (SubmitButton shows it's working).
 */
export async function refreshOpenPositions(): Promise<PositionsRefreshResult> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("wallets").select(`id, name, chain, address, holdings(${ROW_COLUMNS}, source)`).eq("active", true);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);

  type Wallet = { id: string; name: string; chain: string; address: string | null; holdings: (StoredRow & { source: string })[] };
  // Venues with an open position now, plus those that had one in the last 30
  // days — a position opened after the last one closed is still found.
  const activity = await readVenueActivity(db, (data as Wallet[]).map((w) => w.id));
  const now = Date.now();
  const tasks = (data as Wallet[]).flatMap((w) => {
    const kind = w.chain === "SOL" ? "solana" : isEvmChainId(w.chain) ? "evm" : null;
    if (!w.address || !kind) return [];
    const auto = w.holdings.filter((h) => h.source === "auto");
    return venuesToRefresh(auto, activity.get(w.id) ?? new Map(), now)
      .filter((venue) => venue.wallet === kind)
      .map((venue) => ({ wallet: w, venue, previous: auto.filter((h) => venueOwns(venue, h)) }));
  });

  // Every account at once (up to MAX_PARALLEL): they're different wallets and
  // venues, each one light call, so the refresh takes as long as the slowest
  // account, not their sum (4 accounts: 0.9 s, 2026-09-26).
  const results = await mapWithConcurrency(tasks, MAX_PARALLEL, async ({ wallet, venue, previous }) => {
    try {
      const rows = (await freshVenueRows(venue, wallet.address!, previous)).filter((h) => venueOwns(venue, h));
      const keyed = await withPriceKeys(rows, "auto");
      // p_protocol only for a venue that shares its chain (replace_venue_holdings v2).
      const { error: rpcError } = await db.rpc("replace_venue_holdings", {
        p_wallet_id: wallet.id,
        p_chain: venue.chain,
        p_holdings: keyed,
        ...(venue.protocol ? { p_protocol: venue.protocol } : {}),
      });
      if (rpcError) throw new Error(rpcError.message);
      await markVenueActivity(db, wallet.id, rows);
      return null;
    } catch (e) {
      return `${wallet.name} · ${venue.id}: ${(e as Error).message}`;
    }
  });

  revalidatePath("/", "layout");
  const failed = results.filter((r): r is string => r !== null);
  return { accounts: tasks.length - failed.length, failed };
}
