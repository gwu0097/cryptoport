import "server-only";
import { userDb } from "./supabase";
import { isEvmChainId } from "./adapters/evmChains";
import { fetchHyperliquidHoldings } from "./adapters/hyperliquid";
import { fetchLighterHoldings } from "./adapters/lighter";
import { fetchPolymarketHoldings } from "./adapters/polymarket";
import { fetchAsterHoldings } from "./adapters/aster";
import { fetchJupiterPerps } from "./adapters/jupiterPerps";
import { fetchJupiterPrediction } from "./adapters/jupiterPrediction";
import { withPriceKeys } from "./adapters/assetKeys";
import { carryForward, type KeepableRow, type KeepScope } from "./carryForward";
import { venueOwns, venuesToRefresh, type PositionVenue } from "./perpPositions";
import { markVenueActivity, readVenueActivity } from "./venueActivity";
import type { AdapterHolding } from "./adapters/types";

// "Refresh positions" (Dashboard, streamed by api/positions/refresh): re-reads
// only the venue accounts (perpPositions.ts POSITION_VENUES) where the user has
// an open position — or had one in the last 30 days (wallet_venue_activity), so
// a position opened after the last one closed is still found — one account
// call each, and replaces that venue's rows for that wallet: positions, cash and
// margin together, so wallet totals stay right (a perp's PnL lands in its
// account's cash rows). No chain scan, no price refresh, no CoinGecko. The
// wallet's other rows and its last-synced time are untouched.

type Db = Awaited<ReturnType<typeof userDb>>;

// The columns a kept row is re-saved with (replace_venue_holdings inserts these).
const ROW_COLUMNS =
  "ticker, qty, usd_override, contract, category, chain, icon_url, protocol, protocol_url, position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd, position_pnl_percent, position_tpsl, display_label, protocol_section";

type StoredRow = AdapterHolding & KeepableRow & { source?: string; updated_at?: string };

export interface RefreshTask {
  wallet: { id: string; name: string; address: string };
  venue: PositionVenue;
  previous: StoredRow[];
}

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

/** The venue accounts to re-read for the signed-in user's active wallets. */
export async function planPositionRefresh(db: Db): Promise<RefreshTask[]> {
  const { data, error } = await db.from("wallets").select(`id, name, chain, address, holdings(${ROW_COLUMNS}, source, updated_at)`).eq("active", true);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);
  type Wallet = { id: string; name: string; chain: string; address: string | null; holdings: StoredRow[] };
  const wallets = data as Wallet[];
  const activity = await readVenueActivity(db, wallets.map((w) => w.id));
  const now = Date.now();
  return wallets.flatMap((w) => {
    const kind = w.chain === "SOL" ? "solana" : isEvmChainId(w.chain) ? "evm" : null;
    if (!w.address || !kind) return [];
    const auto = w.holdings.filter((h) => h.source === "auto");
    return venuesToRefresh(auto, activity.get(w.id) ?? new Map(), now)
      .filter((venue) => venue.wallet === kind)
      .map((venue) => ({ wallet: { id: w.id, name: w.name, address: w.address! }, venue, previous: auto.filter((h) => venueOwns(venue, h)) }));
  });
}

/** Re-reads one venue account and saves it (replace_venue_holdings). Throws
 * on failure — the account's saved rows are then left as they were. */
export async function refreshVenue(db: Db, { wallet, venue, previous }: RefreshTask): Promise<void> {
  const rows = (await freshVenueRows(venue, wallet.address, previous)).filter((h) => venueOwns(venue, h));
  const keyed = await withPriceKeys(rows, "auto");
  // p_protocol only for a venue that shares its chain (replace_venue_holdings v2).
  const { error } = await db.rpc("replace_venue_holdings", {
    p_wallet_id: wallet.id,
    p_chain: venue.chain,
    p_holdings: keyed,
    ...(venue.protocol ? { p_protocol: venue.protocol } : {}),
  });
  if (error) throw new Error(error.message);
  // The venue had a position at least until it was last read: a position that
  // closed since still counts, as of that read (else closing the last position
  // would drop the venue from the next refresh at once).
  const lastRead = previous.map((h) => h.updated_at).filter((t): t is string => !!t).sort().at(-1);
  if (lastRead) await markVenueActivity(db, wallet.id, previous, lastRead);
  await markVenueActivity(db, wallet.id, rows);
}
