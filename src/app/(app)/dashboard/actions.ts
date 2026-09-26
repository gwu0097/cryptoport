"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { isEvmChainId } from "@/lib/adapters/evmChains";
import { mapWithConcurrency } from "@/lib/adapters/http";
import { fetchHyperliquidHoldings } from "@/lib/adapters/hyperliquid";
import { fetchLighterHoldings } from "@/lib/adapters/lighter";
import { fetchPolymarketHoldings } from "@/lib/adapters/polymarket";
import { withPriceKeys } from "@/lib/adapters/assetKeys";
import { carryForward, type KeepableRow, type KeepScope } from "@/lib/carryForward";
import { venuesWithOpenPositions, type PositionVenue } from "@/lib/perpPositions";
import type { AdapterHolding } from "@/lib/adapters/types";

export interface PositionsRefreshResult {
  /** Venue accounts re-read and saved. */
  accounts: number;
  /** "<wallet> · <venue>: <why>" for each account left as it was. */
  failed: string[];
}

// The columns a kept row is re-saved with (replace_venue_holdings inserts these).
const ROW_COLUMNS =
  "ticker, qty, usd_override, contract, category, chain, icon_url, protocol, protocol_url, position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd, position_pnl_percent, display_label, protocol_section";

type StoredRow = AdapterHolding & KeepableRow;

/** One venue account, fresh: the same adapter the wallet sync uses. A part of
 * a Hyperliquid read that failed (vaults, referral rewards) keeps its previous
 * rows, as in the sync (carryForward.ts). Throws if the account can't be read. */
async function freshVenueRows(venue: PositionVenue, address: string, previous: StoredRow[]): Promise<AdapterHolding[]> {
  if (venue === "hyperliquid") {
    const r = await fetchHyperliquidHoldings(address);
    return carryForward(r.holdings as StoredRow[], previous, r.keep as KeepScope[]).holdings;
  }
  if (venue === "lighter") return fetchLighterHoldings(address);
  return fetchPolymarketHoldings(address);
}

/**
 * "Refresh positions" on the Dashboard: re-reads only the venue accounts
 * (Hyperliquid, Lighter, Polymarket) where the user has an open position, one
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
  const tasks = (data as Wallet[]).flatMap((w) => {
    if (!w.address || !isEvmChainId(w.chain)) return [];
    const auto = w.holdings.filter((h) => h.source === "auto");
    return venuesWithOpenPositions(auto).map((venue) => ({ wallet: w, venue, previous: auto.filter((h) => h.chain === venue) }));
  });

  const results = await mapWithConcurrency(tasks, 4, async ({ wallet, venue, previous }) => {
    try {
      const rows = (await freshVenueRows(venue, wallet.address!, previous)).filter((h) => h.chain === venue);
      const keyed = await withPriceKeys(rows, "auto");
      const { error: rpcError } = await db.rpc("replace_venue_holdings", { p_wallet_id: wallet.id, p_chain: venue, p_holdings: keyed });
      if (rpcError) throw new Error(rpcError.message);
      return null;
    } catch (e) {
      return `${wallet.name} · ${venue}: ${(e as Error).message}`;
    }
  });

  revalidatePath("/", "layout");
  const failed = results.filter((r): r is string => r !== null);
  return { accounts: tasks.length - failed.length, failed };
}
