"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { serviceDb, userDb } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { captureUserSnapshot } from "@/lib/snapshots";
import { fetchEvmHoldings } from "@/lib/adapters/evm";
import { fetchZerionDefiPositions } from "@/lib/adapters/zerionDefi";
import { EXCHANGE_ADAPTERS } from "@/lib/exchangeAdapters";
import { encryptSecret, decryptSecret } from "@/lib/cryptoSecrets";
import { fetchBitcoinHoldingsForSync } from "@/lib/adapters/bitcoin";
import type { ScriptType } from "@/lib/adapters/bitcoinXpub";
import { fetchCardanoHoldingsForSync } from "@/lib/adapters/cardano";
import { fetchCosmosHoldings } from "@/lib/adapters/cosmos";
import { NON_EVM_DISPATCH, type AdapterFetchResult } from "@/lib/adapters/nonEvmDispatch";
import { fetchSeiStakingHoldings } from "@/lib/adapters/seiStaking";
import { fetchCosmosMultiHoldings } from "@/lib/adapters/cosmosMulti";
import type { CosmosHolding } from "@/lib/cosmosMulti";
import { carryForward, keptNote, protocolScope, type KeepScope } from "@/lib/carryForward";
import { withPriceKeys } from "@/lib/adapters/assetKeys";
import { refreshAssetPrices, ensureAssetPrices, refreshAssetPricesIfOlderThan, readAssetVolumes, type OnLane } from "@/lib/adapters/assetPrices";
import { dropTradableReceiptPositions, dropUntradableReceiptTokens, receiptKey } from "@/lib/receiptDedupe";
import type { PriceRefreshPhases } from "@/lib/queries";
import { NON_EVM_CHAINS, findNonEvmChain } from "@/lib/adapters/nonEvmChains";
import { searchCoins, type CoinSearchResult } from "@/lib/adapters/coingecko";
import { refreshTokenRegistryIfStale, TOKEN_LIST_DAILY, TOKEN_LIST_WEEKLY } from "@/lib/tokenRegistryRefresh";
import { refreshExchangeAssetsIfStale } from "@/lib/adapters/exchangeTickers";
import { isEvmChainId } from "@/lib/adapters/evmChains";
import type { AdapterHolding } from "@/lib/adapters/types";
import { isSyncOwned, type WalletMode, type HoldingSource } from "@/lib/types";
import { JOB_STALE_MS, type JobStartResult } from "@/lib/jobStatus";


// Prices are global (one shared asset_prices row per price_key — never
// just one wallet), so every page that
// shows a price needs revalidating, not just /wallets.
function revalidateAllPriceConsumers() {
  revalidatePath("/wallets");
  revalidatePath("/assets");
  revalidatePath("/portfolio");
  revalidatePath("/defi");
  revalidatePath("/dashboard");
  // Now that a price refresh also writes today's snapshot (see
  // captureUserSnapshot), Analytics' own value-history chart needs
  // revalidating too — it wasn't a price consumer before this.
  revalidatePath("/analytics");
  // Watchlist coins are priced in the same pass (see runPriceRefresh).
  revalidatePath("/watchlist");
}

/** The actual work — resolved either by refreshPricesAction or
 * refreshPricesForWalletAction, each inside its own after() so the extra
 * path either one also needs to revalidate (a specific wallet page, for
 * the latter) fires only once the real result exists, not on the
 * near-instant initial response. One pricing pass (refreshAssetPrices):
 * every held coin and every watchlist coin, each from its one source. Its
 * lanes' progress goes to price_refresh_state.phases as they run (the
 * button shows it live). Never throws — a failure is recorded as this
 * singleton row's own status instead, same as every other sync action. */
async function runPriceRefresh(requestedAt: number, userId: string, extraPaths: string[] = []): Promise<void> {
  const db = serviceDb();
  const phases: PriceRefreshPhases = {};
  // Writes queued in order, so a slow early write can't land after a later
  // one and roll the progress back. Best-effort: purely cosmetic status.
  let writes: Promise<unknown> = Promise.resolve();
  const onLane: OnLane = (lane, status) => {
    phases[lane] = { status, ms: status === "running" ? null : Date.now() - requestedAt };
    const snapshot = { ...phases };
    writes = writes.then(() => db.from("price_refresh_state").update({ phases: snapshot }).eq("id", 1)).catch(() => {});
  };

  try {
    const { requested, laneErrors } = await refreshAssetPrices("refresh-prices", undefined, onLane);
    await writes;
    const status = laneErrors.length > 0 ? `partial — ${laneErrors.join("; ")}` : requested === 0 ? "no priced holdings" : "ok";
    const { error } = await db
      .from("price_refresh_state")
      // A failed lane means some prices weren't refreshed, so "Last priced"
      // doesn't move forward — only the status says what happened.
      .update(laneErrors.length > 0 ? { status } : { refreshed_at: new Date().toISOString(), status })
      .eq("id", 1);
    if (error) throw new Error(`Failed to record price refresh: ${error.message}`);
  } catch (e) {
    await writes;
    await db
      .from("price_refresh_state")
      .update({ status: `error: ${(e as Error).message}` })
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
function scheduleUserSnapshot(userId: string, extraPaths: string[] = []) {
  after(async () => {
    try {
      await captureUserSnapshot(userId);
      revalidatePath("/dashboard");
      revalidatePath("/analytics");
      for (const path of extraPaths) revalidatePath(path);
    } catch {
      // swallowed — see comment above
    }
  });
}

/**
 * Same after() pattern as syncWalletHoldings, for the same reason: a real
 * refresh (517 distinct pricing operations on this app's own largest
 * portfolio, measured at ~30s before this app's pricing pipeline was
 * redesigned around CoinGecko, ~9s later — see assetPrices.ts's
 * refreshAssetPrices for today's one-pass version) used to be awaited
 * directly here, which froze every other click app-wide until it finished
 * (Server Actions and client-side navigations share one sequential
 * dispatch queue per client — see CLAUDE.md's Loading feedback section).
 *
 * Same compare-and-set claim as syncWalletHoldings, on price_refresh_state's
 * own started_at — this is a *global* singleton row (prices aren't
 * per-wallet), so the claim is what lets a second click, a second tab, or
 * a second user's own click all agree on whether a refresh is genuinely
 * already running, and recovers a refresh stuck showing "refreshing"
 * forever if an earlier run's after() got killed by the platform's own
 * time limit before its own catch block ran. Returns JobStartResult
 * (lib/jobStatus.ts) instead of throwing on "already refreshing".
 */
/**
 * The compare-and-set claim + after()-backgrounded kickoff, shared by
 * every caller that wants to trigger a price refresh — extracted once a
 * third caller (addHolding, below) needed the identical logic
 * refreshPricesAction/refreshPricesForWalletAction already had copy-pasted
 * between them, past this codebase's own "two is the threshold" rule for
 * duplicated logic. `extraPaths` are revalidated both immediately (so a
 * caller on e.g. a wallet detail page sees "refreshing" right away) and
 * again once the real refresh lands.
 */
async function tryStartPriceRefresh(userId: string, extraPaths: string[] = []): Promise<JobStartResult> {
  const requestedAt = Date.now();
  const staleBefore = new Date(requestedAt - JOB_STALE_MS).toISOString();
  const { data: claimed, error: markError } = await serviceDb()
    .from("price_refresh_state")
    .update({ status: "refreshing", started_at: new Date(requestedAt).toISOString() })
    .eq("id", 1)
    .or(`status.neq.refreshing,status.is.null,started_at.lt.${staleBefore}`)
    .select("id");
  if (markError) throw new Error(`Failed to start price refresh: ${markError.message}`);
  if (!claimed || claimed.length === 0) {
    return { started: false, reason: "A price refresh is already running." };
  }

  after(async () => {
    await runPriceRefresh(requestedAt, userId, extraPaths);
    revalidateAllPriceConsumers();
    for (const path of extraPaths) revalidatePath(path);
  });

  // No kickoff-time revalidation — see JobPoller.tsx's own doc comment.
  return { started: true };
}

export async function refreshPricesAction(): Promise<JobStartResult> {
  const user = await requireUser();
  return tryStartPriceRefresh(user.id);
}

// Same global refresh (prices are keyed by ticker, not wallet — there's no
// such thing as "refresh prices for just this wallet") — just also
// revalidates this one wallet's own page, so clicking "Refresh prices" from
// the wallet detail page (came up directly: a freshly-synced ADA holding
// showed unpriced with no obvious way to fix it short of navigating back
// to the wallets list) reflects the update immediately instead of needing
// a manual reload.
export async function refreshPricesForWalletAction(walletId: string): Promise<JobStartResult> {
  const user = await requireUser();
  return tryStartPriceRefresh(user.id, [`/wallets/${walletId}`]);
}

// A wallet's `chain` field itself isn't restricted to a fixed set (see
// Wallet.chain in types.ts) — auto mode is, checked both here
// (isAutoCapableChain, used by createWallet/updateWallet and again
// defensively in syncWalletHoldings) and client-side in ChainModeAddressFields
// (which disables the "auto" option for anything else, so this server
// check is belt-and-suspenders rather than the only guard). Non-EVM chains
// come from nonEvmChains.ts's single list (see that file's header — this
// used to be its own hand-copied array, kept in sync by hand with
// ChainModeAddressFields's copy). EVM chains aren't in that list — any of the 32
// chains in evmChains.ts is auto-capable, checked dynamically via
// isEvmChainId, since a wallet's EVM-format address is scanned across
// every configured EVM chain regardless of which one it's labeled with
// (e.g. a Ronin-focused wallet can say "RON" instead of the generic
// "ETH" and still auto-sync exactly the same way).
const MODES: readonly WalletMode[] = ["manual", "auto"];
const HOLDING_KINDS = ["qty", "usd"] as const;

function isAutoCapableChain(chain: string): boolean {
  return findNonEvmChain(chain) !== undefined || isEvmChainId(chain);
}

function requireString(formData: FormData, field: string): string {
  const value = formData.get(field);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required.`);
  }
  return value.trim();
}

function optionalString(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function requireOneOf<T extends string>(
  formData: FormData,
  field: string,
  allowed: readonly T[],
): T {
  const value = requireString(formData, field);
  if (!allowed.includes(value as T)) {
    throw new Error(`"${field}" must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

// TagPicker submits each selected tag as a repeated "tags" field — typing a
// name that already exists reuses that tag, typing a new one creates it on
// the spot (no separate "manage tags" page). One batched upsert on the
// unique (user_id, name) constraint rather than one call per tag or a
// select-then-insert: atomic, so two wallets saved with the same brand-new
// tag name at once can't race into duplicate tag rows, and a wallet with
// several new tags doesn't take a round trip per tag.
async function resolveTagIds(formData: FormData): Promise<string[]> {
  const names = [...new Set(formData.getAll("tags").map((v) => String(v).trim()).filter((v) => v !== ""))];
  if (names.length === 0) return [];

  // onConflict targets (user_id, name) — tag names are unique per user, not
  // globally (see db/schema.sql), so two different people can both have a
  // tag called "personal" without colliding. user_id itself isn't set here:
  // the column defaults to auth.uid(), same as wallets.user_id below.
  const db = await userDb();
  const { data, error } = await db
    .from("tags")
    .upsert(
      names.map((name) => ({ name })),
      { onConflict: "user_id,name" },
    )
    .select("id");
  if (error) throw new Error(`Failed to resolve tags: ${error.message}`);
  return data.map((row) => row.id);
}

// Replaces a wallet's full tag set with the given ids — delete-then-insert,
// same shape the sync RPCs already use for their own disjoint-source
// rewrites (see holdings.source's doc comment), simpler than diffing
// against whatever it had before. Scoped to this one wallet's rows only,
// same as every other per-wallet write in this file — RLS on wallet_tags
// (owner-only, see db/schema.sql) also backs this up server-side.
async function replaceWalletTags(walletId: string, tagIds: string[]): Promise<void> {
  const db = await userDb();
  const { error: deleteError } = await db.from("wallet_tags").delete().eq("wallet_id", walletId);
  if (deleteError) throw new Error(`Failed to clear wallet tags: ${deleteError.message}`);
  if (tagIds.length === 0) return;

  const { error: insertError } = await db
    .from("wallet_tags")
    .insert(tagIds.map((tag_id) => ({ wallet_id: walletId, tag_id })));
  if (insertError) throw new Error(`Failed to save wallet tags: ${insertError.message}`);
}

// Chain is free text now (RON, NEAR, whatever — manual tracking works for
// anything), but auto mode only actually works for a chain isAutoCapableChain
// recognizes — enforced here too, not just by ChainModeAddressFields disabling
// the option client-side, since a direct form POST could otherwise bypass
// that.
function requireChainAndMode(formData: FormData): { chain: string; mode: WalletMode } {
  const chain = requireString(formData, "chain").toUpperCase();
  const mode = requireOneOf(formData, "mode", MODES);
  if (mode === "auto" && !isAutoCapableChain(chain)) {
    const supported = NON_EVM_CHAINS.map((c) => c.id).join(", ");
    throw new Error(
      `Auto mode isn't available for "${chain}" — only ${supported}, or any EVM chain (ETH, RON, SEI, ARB, ...), have a sync adapter. Use manual mode instead.`,
    );
  }
  return { chain, mode };
}

export async function createWallet(formData: FormData) {
  await requireUser();
  const name = requireString(formData, "name");
  const { chain, mode } = requireChainAndMode(formData);
  const address = optionalString(formData, "address");
  const tagIds = await resolveTagIds(formData);

  // user_id isn't set explicitly — the column defaults to auth.uid() (see
  // db/schema.sql), so this insert only ever creates a row owned by
  // whoever's session userDb() is bound to.
  const db = await userDb();
  const { data, error } = await db.from("wallets").insert({ name, chain, mode, address }).select("id").single();
  if (error) throw new Error(`Failed to create wallet: ${error.message}`);
  await replaceWalletTags(data.id, tagIds);

  // A new auto wallet starts its first sync right away — having to click
  // "Sync holdings" on a wallet you just created was reported as silly.
  // Started here on the server, not via the ?autosync=1 client landing the
  // sign-in flow uses (AutoSyncOnMount), so the wallet page's first render
  // already shows "Syncing…" and the sync doesn't depend on that page
  // mounting. syncWalletHoldings only claims the job and returns; the slow
  // chain calls run in its after() (which Next runs even though this
  // action ends in redirect() — node_modules/next/dist/docs/.../after.md).
  // A failure to START never fails the creation: the wallet exists either
  // way and the Sync button still works.
  if (mode === "auto" && address) {
    try {
      await syncWalletHoldings(data.id);
    } catch (e) {
      console.warn(`[wallets] created ${data.id} but couldn't start its first sync: ${(e as Error).message}`);
    }
  }

  revalidatePath("/wallets");
  redirect(`/wallets/${data.id}`);
}

export async function updateWallet(walletId: string, formData: FormData) {
  await requireUser();
  const name = requireString(formData, "name");
  const tagIds = await resolveTagIds(formData);

  // EditWalletModal doesn't render chain/mode/address at all for a
  // connected exchange (see its own doc comment — "COINBASE" isn't a real
  // chain, requireChainAndMode correctly rejects it as an unsupported
  // auto-mode chain, which used to crash editing one of these). The
  // form's own absence of a "chain" field is what signals that case here,
  // rather than a second DB read to re-derive it — an exchange
  // connection's chain/mode/address are never user-editable, so there's
  // nothing to validate or update for those wallets at all.
  const update: { name: string; chain?: string; mode?: WalletMode; address?: string | null } = { name };
  if (formData.has("chain")) {
    const { chain, mode } = requireChainAndMode(formData);
    update.chain = chain;
    update.mode = mode;
    update.address = optionalString(formData, "address");
  }

  const db = await userDb();
  const { error } = await db.from("wallets").update(update).eq("id", walletId);
  if (error) throw new Error(`Failed to update wallet: ${error.message}`);
  await replaceWalletTags(walletId, tagIds);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// Thin wrapper around the same searchCoins() the Watchlist's own
// searchCoinsAction (watchlist/actions.ts) calls — duplicated as a wrapper
// rather than imported from there, so /wallets doesn't reach into another
// route's action module for something this small. Powers CoinSearchInput
// on the add-holding form (AddHoldingModal), same debounced typeahead
// pattern as Watchlist's AddCoinPanel.
export async function searchCoinsAction(query: string): Promise<CoinSearchResult[]> {
  await requireUser();
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  return searchCoins(trimmed);
}

// A manual wallet's holdings are entered by hand, as either a typed quantity
// (priced on every refresh) or a fixed USD value (source='manual_usd', which
// bypasses pricing entirely — see valuation.ts). This is the only place that
// decides which of the two a new holding is.
export async function addHolding(walletId: string, formData: FormData) {
  await requireUser();
  const ticker = requireString(formData, "ticker").toUpperCase();
  const kind = requireOneOf(formData, "kind", HOLDING_KINDS);
  // Set only when the coin picker (CoinSearchInput, in AddHoldingModal) was
  // actually used — a plain typed ticker with nothing picked leaves both
  // null, same as before this existed. It becomes the holding's price_key
  // (assetIdentity.ts's manual_qty branch) — the one thing that gives a
  // manual holding a collision-proof price; with no pick it would be
  // unpriced, never priced by ticker (the DOG-vs-DOG bug this exists to fix).
  const coingeckoId = optionalString(formData, "coingecko_id");
  const iconUrl = optionalString(formData, "icon_url");
  // A quantity is priced as qty × its coin's price: it needs the exact coin
  // (the form requires a pick; this guards the action itself).
  if (kind !== "usd" && !coingeckoId) throw new Error("Pick the coin from the list — a quantity needs its exact coin to be priced.");

  const insert: {
    wallet_id: string;
    ticker: string;
    source: "manual_usd" | "manual_qty";
    qty: string | null;
    usd_override: string | null;
    coingecko_id: string | null;
    icon_url: string | null;
    price_key: string | null;
  } =
    kind === "usd"
      ? {
          wallet_id: walletId,
          ticker,
          source: "manual_usd",
          usd_override: requireString(formData, "usd_override"),
          qty: null,
          coingecko_id: coingeckoId,
          icon_url: iconUrl,
          price_key: null, // a fixed USD value isn't priced
        }
      : {
          wallet_id: walletId,
          ticker,
          source: "manual_qty",
          qty: requireString(formData, "qty"),
          usd_override: null,
          coingecko_id: coingeckoId,
          icon_url: iconUrl,
          price_key: coingeckoId, // the picked coin (docs/pricing/PLAN.md)
        };

  const db = await userDb();
  const { error } = await db.from("holdings").insert(insert);
  if (error) throw new Error(`Failed to add holding: ${error.message}`);

  // A freshly-added manual holding used to just sit unpriced until the
  // user noticed and clicked "Refresh prices" themselves — reported
  // directly. Awaited inline here, NOT pushed to after() like
  // syncWalletHoldings' own scoped reprice: this is a plain form action
  // with no useJob-style polling to catch a later background completion
  // (unlike the Sync/Refresh buttons) — a reprice deferred to after()
  // would revalidate the server cache correctly, but the browser would
  // have no reason to ever re-fetch it, so the price would only show up
  // once some *other* action happened to refresh the page. A single new
  // ticker's price lookup is small/bounded (one CoinGecko/Coinbase call),
  // not the kind of multi-second work after() exists to avoid blocking
  // on. A fixed-USD holding never needs pricing at all (no price_key —
  // valuation.ts uses its stored usd_override), so skip this for those —
  // nothing for it to price.
  if (kind !== "usd") await ensureAssetPrices([coingeckoId], "manual").catch(() => {});

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// Auto holdings are refresh-owned (source='auto'); the UI must never write to
// them, mirroring the rule that the refresh job may never touch manual rows.
async function requireEditableHolding(holdingId: string) {
  const db = await userDb();
  const { data, error } = await db
    .from("holdings")
    .select("source")
    .eq("id", holdingId)
    .single();
  if (error) throw new Error(`Failed to load holding: ${error.message}`);
  if (isSyncOwned(data.source as HoldingSource)) {
    throw new Error("Sync-owned holdings cannot be edited by hand.");
  }
  return data.source;
}

export async function updateHolding(holdingId: string, walletId: string, formData: FormData) {
  await requireUser();
  const source = await requireEditableHolding(holdingId);

  const update =
    source === "manual_usd"
      ? { usd_override: requireString(formData, "usd_override") }
      : { qty: requireString(formData, "qty") };

  const db = await userDb();
  const { error } = await db.from("holdings").update(update).eq("id", holdingId);
  if (error) throw new Error(`Failed to update holding: ${error.message}`);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

export async function deleteHolding(holdingId: string, walletId: string) {
  await requireUser();
  await requireEditableHolding(holdingId);

  const db = await userDb();
  const { error } = await db.from("holdings").delete().eq("id", holdingId);
  if (error) throw new Error(`Failed to delete holding: ${error.message}`);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// Solana sync captures plain token balances plus Jupiter's own DeFi
// products (Earn, Limit Order, Perps, ...) via api.jup.ag/portfolio — but
// that API only covers Jupiter's own product suite, not third-party
// protocols (Meteora DLMM, Marinade, Kamino, Raydium, ...), which still
// aren't captured. Recorded in the wallet's notes rather than silently
// under-reporting with no explanation.
const SOL_SYNC_NOTE =
  "Auto-synced token balances + DeFi positions from Jupiter (Earn, Limit Order, Perps, DAO staking), Kamino (lending, multiply, leverage, earn, liquidity, staking), Wormhole (staked W), Meteora (open DLMM positions), and Parcl (margin) — other protocols are not yet captured by this sync.";

// BTC isn't dispatched through here — see syncWalletHoldings, which calls
// fetchBitcoinHoldingsForSync directly so it can pass the wallet's cached
// script type through and get the detected one back. ADA is the same
// story (fetchCardanoHoldingsForSync, cached stake address). Every other
// chain goes through NON_EVM_DISPATCH (nonEvmDispatch.ts) — the single
// table shared with lookup.ts's "search any address" feature.
async function fetchAdapterHoldings(chain: string, address: string): Promise<AdapterFetchResult> {
  // Sei is the one chain with two entirely different address formats
  // pointing at two different balances (see cosmos.ts's "SEI" entry) — a
  // bech32 sei1... address can only ever mean the Cosmos-native side,
  // checked before the generic EVM check below (which would otherwise
  // also claim "SEI" — evmChains.ts has its own "sei" entry for the EVM
  // side of the same chain). Not in NON_EVM_DISPATCH for the same reason.
  if (chain === "SEI") {
    const base: AdapterFetchResult = address.startsWith("sei1")
      ? { holdings: await fetchCosmosHoldings("SEI", address), warnings: [] }
      : await fetchEvmHoldings(address);
    return withSeiStaking(address, base);
  }
  if (isEvmChainId(chain)) return fetchEvmHoldings(address);
  const entry = NON_EVM_DISPATCH[chain];
  if (entry) return entry.fetch(address);
  throw new Error(`No sync adapter for chain "${chain}".`);
}

/** Adds a Sei wallet's native staking (delegations, rewards, unbonding —
 * Cosmos-side, so neither balance scan sees it; adapters/seiStaking.ts).
 * Valued like the native balance: by the SEI coin's one price (price_key).
 * A staking lookup failure is a warning only. */
async function withSeiStaking(address: string, base: AdapterFetchResult): Promise<AdapterFetchResult> {
  const native = base.holdings.find((h) => h.chain === "sei" && h.contract === null && h.qty);
  try {
    const stakes = await fetchSeiStakingHoldings(address, null, native?.icon_url ?? null);
    return { ...base, holdings: [...base.holdings, ...stakes] };
  } catch (e) {
    return {
      ...base,
      warnings: [...base.warnings, `Sei staking positions couldn't be loaded: ${(e as Error).message}`],
      keep: [...(base.keep ?? []), protocolScope("sei staking", "Sei native staking")],
    };
  }
}

/** The rows with their price_key (docs/pricing/PLAN.md phase 1: written
 * alongside today's pricing, read by nothing yet). A key lookup failure
 * saves the rows without keys rather than failing the sync — until phase 2
 * makes the keys load-bearing. */
async function keyed<T extends { ticker: string; chain: string | null; contract: string | null }>(
  rows: T[],
  source: HoldingSource,
): Promise<(T & { price_key?: string | null })[]> {
  try {
    const out = await withPriceKeys(rows, source);
    // A Solana/Sui token the token list doesn't know yet: refresh the list
    // in the background, at most once a day (lib/tokenRegistryRefresh.ts),
    // so it maps on the next pass. EVM wallets can't meet unknown tokens —
    // their sync only checks tokens already on the list.
    const unmapped = out.some(
      (r) => r.contract && (r.chain === "solana" || r.chain === "solana-defi" || r.chain === "sui") && (!r.price_key || r.price_key.startsWith("jup:")),
    );
    if (unmapped) after(() => refreshTokenRegistryIfStale(TOKEN_LIST_DAILY).catch(() => {}));
    // An exchange ticker with no coin: refresh the exchange mappings from
    // CoinGecko's exchange data (at most weekly), which re-keys it.
    if (source === "auto_exchange" && out.some((r) => !r.price_key)) {
      after(() => refreshExchangeAssetsIfStale(TOKEN_LIST_WEEKLY).catch(() => {}));
    }
    return out;
  } catch (e) {
    console.warn(`[pricing] price keys not set (${source}): ${(e as Error).message}`);
    return rows;
  }
}

/** Wallet sync side of receiptDedupe.ts: this wallet's DeFi rows' pools vs
 * the tokens about to be saved. A lookup failure keeps every token (never
 * drops value on an error). */
async function withoutUntradableReceipts<T extends AdapterHolding & { price_key?: string | null }>(
  db: Awaited<ReturnType<typeof userDb>>,
  walletId: string,
  tokens: T[],
): Promise<T[]> {
  try {
    const { data, error } = await db.from("holdings").select("chain, pool_contract").eq("wallet_id", walletId).eq("source", "auto_defi").not("pool_contract", "is", null);
    if (error) throw new Error(error.message);
    const pools = new Set((data as { chain: string | null; pool_contract: string }[]).filter((r) => r.chain).map((r) => receiptKey(r.chain!, r.pool_contract)));
    if (pools.size === 0) return tokens;
    return dropUntradableReceiptTokens(tokens, pools, await readAssetVolumes(tokens.map((t) => t.price_key)));
  } catch (e) {
    console.warn(`[receipts] wallet ${walletId}: ${(e as Error).message}`);
    return tokens;
  }
}

/** DeFi sync side of receiptDedupe.ts: this wallet's held tokens vs the
 * positions about to be saved. A lookup failure keeps every position. */
async function withoutTradableReceiptPositions<T extends AdapterHolding & { price_key?: string | null }>(
  db: Awaited<ReturnType<typeof userDb>>,
  walletId: string,
  positions: T[],
): Promise<T[]> {
  if (!positions.some((p) => p.pool_contract)) return positions;
  try {
    const { data, error } = await db.from("holdings").select("chain, contract, price_key").eq("wallet_id", walletId).eq("source", "auto").not("contract", "is", null);
    if (error) throw new Error(error.message);
    const held = new Map((data as { chain: string | null; contract: string; price_key: string | null }[]).filter((r) => r.chain).map((r) => [receiptKey(r.chain!, r.contract), r.price_key]));
    if (held.size === 0) return positions;
    return dropTradableReceiptPositions(positions, held, await readAssetVolumes([...held.values()]));
  } catch (e) {
    console.warn(`[receipts] wallet ${walletId}: ${(e as Error).message}`);
    return positions;
  }
}

/** Called by "Sync all" (components/jobs/SyncQueue.tsx) before its first
 * wallet: one pricing pass for every held coin (~1-2 CoinGecko calls,
 * ~3s) when the newest price is over 5 minutes old, so each wallet's own
 * post-sync pricing finds its coins fresh. Without it every wallet paid
 * its own small call — 33 in one Sync all (2026-09-25). */
export async function primeSyncPricesAction(): Promise<void> {
  await requireUser();
  await refreshAssetPricesIfOlderThan(5 * 60 * 1000, "sync-all").catch(() => {});
}

// Every column sync_auto_holdings / sync_cosmos_holdings (schema.sql)
// inserts — a kept row (carryForward.ts) is re-saved with all of them.
const AUTO_KEEP_COLUMNS =
  "ticker, qty, usd_override, contract, category, chain, icon_url, protocol, protocol_url, position_side, position_leverage, position_entry_price, position_liquidation_price, position_pnl_usd, position_pnl_percent, display_label, protocol_section";
const COSMOS_KEEP_COLUMNS =
  "ticker, qty, usd_override, contract, category, chain, icon_url, coingecko_id, display_label, protocol, protocol_url, protocol_section";

// Fetches fresh holdings from the wallet's adapter (Multicall3+CoinGecko+
// Hyperliquid for ETH, Jupiter for SOL, mempool.space/xpub-scan for BTC)
// and atomically replaces its auto-sourced holdings — see
// cryptoport.sync_auto_holdings in schema.sql for why this has to be a
// single DB function call rather than separate delete/insert calls from
// here. On a total failure (every source errored, nothing to save),
// holdings and last_refresh_at are left completely untouched (only
// last_refresh_status records that an attempt failed) — per the "a wallet
// that errors keeps its previous holdings and previous timestamp" rule, a
// failed sync must never be worse than not syncing. A partial failure
// (some chains ok, one flaked) still saves what succeeded, with the
// failure recorded in the status rather than silently dropped.
//
// The actual fetch runs in next/server's after() rather than being awaited
// inline — a multi-chain EVM wallet or a full xpub scan can take minutes,
// and awaiting that directly in a form-bound Server Action ties up the
// whole page's interactivity for that entire time (submitting a form
// action is a router-level transition, not scoped to just that one
// button). after() keeps the serverless function alive past this
// function's own return, so the triggering request completes almost
// immediately — the wallet is marked 'syncing' first so the UI reflects
// that a sync is in progress, and gets its real status once the
// background work finishes.
// forceFullScan is the "Full sync" action's escape hatch (BTC xpub wallets
// only) — ignores a cached btc_script_type and re-checks all three address
// formats, for a wallet that's switched to a different one. Bound
// directly as a second argument before the form's own FormData (see
// updateHolding/deleteHolding above for the same .bind(null, ...) shape).
//
// Returns JobStartResult (see lib/jobStatus.ts) instead of throwing for
// the expected "already syncing" case — useJob() reads that as a normal,
// displayable outcome, not a crash. The "mark syncing" write below is a
// real compare-and-set claim (only succeeds if the wallet isn't already
// actively syncing, or its claim has gone stale past JOB_STALE_MS), not a
// plain update — this is what makes a second click, a second tab, and
// "Sync all wallets" all agree on whether a sync is genuinely running,
// and it's also what recovers a wallet stuck showing "syncing" forever if
// an earlier run's after() got killed by the platform's own time limit
// before its own catch block ever ran.
export async function syncWalletHoldings(walletId: string, forceFullScan = false): Promise<JobStartResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("chain, address, mode, btc_script_type, cardano_stake_address")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (wallet.mode !== "auto") throw new Error("Only auto wallets can be synced.");
  if (!wallet.address) throw new Error("This wallet has no address set.");
  // Belt-and-suspenders — requireChainAndMode already prevents saving an
  // auto wallet with a non-adapter chain, so this should be unreachable for
  // any wallet actually created/edited through this app.
  if (!isAutoCapableChain(wallet.chain)) {
    throw new Error(`Auto mode isn't available for chain "${wallet.chain}".`);
  }

  const syncStartedAt = Date.now();
  const staleBefore = new Date(syncStartedAt - JOB_STALE_MS).toISOString();
  const { data: claimed, error: markError } = await db
    .from("wallets")
    .update({ last_refresh_status: "syncing", sync_started_at: new Date(syncStartedAt).toISOString() })
    .eq("id", walletId)
    .or(`last_refresh_status.neq.syncing,last_refresh_status.is.null,sync_started_at.lt.${staleBefore}`)
    .select("id");
  if (markError) throw new Error(`Failed to start sync: ${markError.message}`);
  if (!claimed || claimed.length === 0) {
    return { started: false, reason: "A sync is already running for this wallet." };
  }

  after(async () => {
    // A fresh userDb() call here, not the outer `db` closed over above —
    // Server Functions are explicitly allowed to call cookies()/headers()
    // (which userDb() does internally) from inside an after() callback per
    // Next's own docs (node_modules/next/dist/docs/.../functions/after.md),
    // but reusing a client built during the request rather than during the
    // after() callback isn't the documented pattern, so this builds its own
    // to stay on the supported path.
    const afterDb = await userDb();
    try {
      let holdings: AdapterHolding[];
      let warnings: string[] = [];
      // A Cosmos wallet's tokens across every coin-type-118 chain (Injective
      // excluded), stored as auto_cosmos rows by their own RPC — see
      // adapters/cosmosMulti.ts. Null for every other chain.
      let cosmosHoldings: CosmosHolding[] | null = null;
      // Rows a failed part of this sync owns — re-saved from the last sync
      // below instead of vanishing (carryForward.ts).
      let keep: KeepScope[] = [];
      let detectedScriptType: ScriptType | null = wallet.btc_script_type as ScriptType | null;
      let cardanoStakeAddress: string | null = wallet.cardano_stake_address;

      if (wallet.chain === "BTC") {
        ({ holdings, detectedScriptType } = await fetchBitcoinHoldingsForSync(
          wallet.address!,
          wallet.btc_script_type as ScriptType | null,
          forceFullScan,
        ));
      } else if (wallet.chain === "ADA") {
        ({ holdings, stakeAddress: cardanoStakeAddress } = await fetchCardanoHoldingsForSync(
          wallet.address!,
          wallet.cardano_stake_address,
        ));
      } else if (wallet.chain === "ATOM") {
        ({ holdings: cosmosHoldings, warnings, keep } = await fetchCosmosMultiHoldings(wallet.address!));
        holdings = []; // nothing here for the ticker-priced path below
      } else {
        ({ holdings, warnings, keep = [] } = await fetchAdapterHoldings(wallet.chain, wallet.address!));
      }

      let keptStatus = "";
      if (keep.length > 0) {
        const { data: previous, error: previousError } = await afterDb
          .from("holdings")
          .select(cosmosHoldings ? COSMOS_KEEP_COLUMNS : AUTO_KEEP_COLUMNS)
          .eq("wallet_id", walletId)
          .eq("source", cosmosHoldings ? "auto_cosmos" : "auto");
        if (previousError) {
          warnings = [...warnings, `previous rows couldn't be loaded to keep: ${previousError.message}`];
        } else if (cosmosHoldings) {
          const r = carryForward(cosmosHoldings, previous as unknown as CosmosHolding[], keep);
          cosmosHoldings = r.holdings;
          keptStatus = keptNote(r.kept);
        } else {
          const r = carryForward(holdings, previous as unknown as AdapterHolding[], keep);
          holdings = r.holdings;
          keptStatus = keptNote(r.kept);
        }
      }

      const status = warnings.length === 0 ? "ok" : `partial — ${[...warnings, keptStatus].filter(Boolean).join("; ")}`;
      let saved: { price_key?: string | null }[] = cosmosHoldings
        ? await keyed(cosmosHoldings, "auto_cosmos")
        : await keyed(holdings, "auto");
      // A token that is the receipt of one of this wallet's DeFi positions and
      // can't be traded is counted by that position instead (receiptDedupe.ts).
      if (!cosmosHoldings) saved = await withoutUntradableReceipts(afterDb, walletId, saved as (AdapterHolding & { price_key?: string | null })[]);
      const { error: syncError } = await afterDb.rpc(cosmosHoldings ? "sync_cosmos_holdings" : "sync_auto_holdings", {
        p_wallet_id: walletId,
        p_holdings: saved,
        p_status: status,
      });
      if (syncError) throw new Error(`Failed to save synced holdings: ${syncError.message}`);
      // This wallet's coins that have no fresh price yet, in one batched pass
      // (docs/pricing/PLAN.md) — coins another wallet priced minutes ago are
      // reused, so a Sync all prices each coin about once.
      await ensureAssetPrices(saved.map((r) => r.price_key), "sync").catch(() => {});

      if (wallet.chain === "SOL") {
        await afterDb.from("wallets").update({ notes: SOL_SYNC_NOTE }).eq("id", walletId);
      }

      const updates: {
        last_sync_duration_ms: number;
        btc_script_type?: ScriptType | null;
        cardano_stake_address?: string | null;
      } = {
        last_sync_duration_ms: Date.now() - syncStartedAt,
      };
      if (wallet.chain === "BTC") updates.btc_script_type = detectedScriptType;
      if (wallet.chain === "ADA") updates.cardano_stake_address = cardanoStakeAddress;
      await afterDb.from("wallets").update(updates).eq("id", walletId);

      // Nested after(), registered only now that holdings are actually
      // saved — not called unconditionally alongside the outer after()
      // above, which would let it start reading (stale, pre-sync)
      // holdings concurrently with this same sync still writing them.
      // Nesting after() inside another after() callback is Next's own
      // documented pattern for exactly this ("schedule more work once
      // this work is done, without blocking on it") — see
      // scheduleUserSnapshot's own doc comment for the regression this
      // whole two-after()-calls shape exists to avoid.
      scheduleUserSnapshot(user.id, [`/wallets/${walletId}`]);
    } catch (e) {
      await afterDb
        .from("wallets")
        .update({
          last_refresh_status: `error: ${(e as Error).message}`,
          last_sync_duration_ms: Date.now() - syncStartedAt,
        })
        .eq("id", walletId);
    } finally {
      revalidatePath(`/wallets/${walletId}`);
      revalidatePath("/wallets");
      // Now that a successful sync also writes today's snapshot (see
      // captureUserSnapshot above), Dashboard/Analytics need revalidating
      // too — harmless to call even on a failed sync (the snapshot write
      // just didn't happen, so there's nothing new for these to pick up).
      revalidatePath("/dashboard");
      revalidatePath("/analytics");
    }
  });

  // No kickoff-time revalidation — see JobPoller.tsx's own doc comment.
  return { started: true };
}

/**
 * A second, genuinely independent job on the same wallet row — same
 * after()/CAS-claim shape as syncWalletHoldings above and syncWalletTransactions
 * (transactions/actions.ts), but its own defi_sync_status/defi_sync_started_at
 * pair rather than reusing last_refresh_status/sync_started_at: this is a
 * different external source (Zerion, not this wallet's own on-chain
 * balances) on its own cadence, so it must be able to run, fail, or be
 * mid-flight independently of a regular holdings sync.
 *
 * Deliberately NOT wired into syncWalletHoldings, syncAllWallets, or any
 * other automatic trigger — see zerionDefi.ts's own doc comment for why:
 * Zerion's free tier is a real, shared monthly budget, and this button is
 * what keeps spending it under the user's explicit control rather than
 * burning it on every routine sync.
 *
 * Writes via cryptoport.sync_defi_holdings (schema.sql) — a near-duplicate
 * of sync_auto_holdings scoped to source='auto_defi' instead of 'auto', so
 * this sync's delete-then-insert can never touch (or be touched by) the
 * regular sync's own rows, including Hyperliquid's DeFi-category holdings.
 */
export async function syncWalletDefi(walletId: string): Promise<JobStartResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("chain, address, mode")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (wallet.mode !== "auto") throw new Error("Only auto wallets can sync DeFi positions.");
  if (!wallet.address) throw new Error("This wallet has no address set.");
  if (!isEvmChainId(wallet.chain)) throw new Error(`DeFi sync isn't available for chain "${wallet.chain}".`);

  const syncStartedAt = Date.now();
  const staleBefore = new Date(syncStartedAt - JOB_STALE_MS).toISOString();
  const { data: claimed, error: markError } = await db
    .from("wallets")
    .update({ defi_sync_status: "syncing", defi_sync_started_at: new Date(syncStartedAt).toISOString() })
    .eq("id", walletId)
    .or(`defi_sync_status.neq.syncing,defi_sync_status.is.null,defi_sync_started_at.lt.${staleBefore}`)
    .select("id");
  if (markError) throw new Error(`Failed to start DeFi sync: ${markError.message}`);
  if (!claimed || claimed.length === 0) {
    return { started: false, reason: "A DeFi sync is already running for this wallet." };
  }

  after(async () => {
    const afterDb = await userDb();
    try {
      const { holdings, warnings } = await fetchZerionDefiPositions(wallet.address!);
      const status = warnings.length === 0 ? "ok" : `partial — ${warnings.join("; ")}`;

      // A position whose receipt token this wallet holds and can trade is
      // already counted by that token (receiptDedupe.ts).
      const savedDefi: { price_key?: string | null }[] = await withoutTradableReceiptPositions(afterDb, walletId, await keyed(holdings, "auto_defi"));
      const { error: syncError } = await afterDb.rpc("sync_defi_holdings", {
        p_wallet_id: walletId,
        p_holdings: savedDefi,
        p_status: status,
      });
      if (syncError) throw new Error(`Failed to save DeFi holdings: ${syncError.message}`);
      await ensureAssetPrices(savedDefi.map((r) => r.price_key), "sync").catch(() => {});

      await afterDb
        .from("wallets")
        .update({ defi_sync_duration_ms: Date.now() - syncStartedAt })
        .eq("id", walletId);

      scheduleUserSnapshot(user.id, [`/wallets/${walletId}`]);
    } catch (e) {
      await afterDb
        .from("wallets")
        .update({
          defi_sync_status: `error: ${(e as Error).message}`,
          defi_sync_duration_ms: Date.now() - syncStartedAt,
        })
        .eq("id", walletId);
    } finally {
      revalidatePath(`/wallets/${walletId}`);
      revalidatePath("/wallets");
      revalidatePath("/dashboard");
      revalidatePath("/analytics");
    }
  });

  // No kickoff-time revalidation — see JobPoller.tsx's own doc comment.
  return { started: true };
}

// "Sync all" is run from the browser as a queue now (components/jobs/
// SyncQueue.tsx): one syncWalletHoldings/syncExchangeHoldings call per wallet,
// wallets sharing an API one at a time, so each gets its own time budget.

// Soft delete: wallets.active already exists for exactly this (the wallets
// list already filters on it) — no schema change needed, and it keeps a
// wallet's holding history around instead of cascading a hard delete.
export async function deleteWallet(walletId: string) {
  await requireUser();
  const db = await userDb();
  const { error } = await db
    .from("wallets")
    .update({ active: false })
    .eq("id", walletId);
  if (error) throw new Error(`Failed to delete wallet: ${error.message}`);

  revalidatePath("/wallets");
  redirect("/wallets");
}

export type ConnectExchangeFormState = { error?: string } | undefined;

/**
 * Connects an exchange account as a wallet with no on-chain address — see
 * cryptoSecrets.ts and exchangeAdapters.ts for the auth/encryption design.
 * OAuth2 turned out to require partner approval with no self-serve path
 * for both Coinbase (confirmed) and Kraken (unconfirmed either way, reads
 * the same); Gemini's OAuth sandbox is self-serve but production access
 * still isn't. Every provider here uses a user-generated, view-only API
 * key instead — the one path confirmed self-serve for all three.
 *
 * `providerId` is the *first*, pre-bound arg (see ConnectExchangeModal:
 * `connectExchange.bind(null, provider.id)`) — this is what makes this one
 * function work for every provider in EXCHANGE_ADAPTERS rather than one
 * hand-written copy per exchange (originally connectCoinbase; extracted
 * once Kraken and Gemini became the second and third near-duplicate).
 *
 * useActionState-compatible (returns {error} instead of throwing) so the
 * connect modal can show the exchange's own error inline — the key is
 * tested with a real live call *before* anything is saved, so a bad key
 * (wrong algorithm, wrong permission, already-deleted) never leaves a dead
 * connection behind for the user to discover on the next sync.
 *
 * exchange_connections has no grant to `authenticated` at all (see its own
 * schema.sql comment) — every read/write goes through serviceDb() here,
 * with the ownership check done in application code (user.id passed
 * explicitly) rather than relying on RLS, matching the security-definer
 * RPCs' own explicit-check pattern.
 */
export async function connectExchange(
  providerId: string,
  _prevState: ConnectExchangeFormState,
  formData: FormData,
): Promise<ConnectExchangeFormState> {
  const fetchBalances = EXCHANGE_ADAPTERS[providerId];
  if (!fetchBalances) return { error: `Unknown exchange "${providerId}".` };

  const user = await requireUser();
  const name = requireString(formData, "name");
  const keyName = requireString(formData, "keyName");
  const privateKey = requireString(formData, "privateKey");

  let testResult: Awaited<ReturnType<typeof fetchBalances>>;
  try {
    testResult = await fetchBalances(keyName, privateKey);
  } catch (e) {
    return { error: (e as Error).message };
  }

  const db = await userDb();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .insert({ name, chain: providerId.toUpperCase(), mode: "auto", provider: providerId, address: null })
    .select("id")
    .single();
  if (walletError) return { error: `Failed to create wallet: ${walletError.message}` };

  const svc = serviceDb();
  const { error: connError } = await svc.from("exchange_connections").insert({
    wallet_id: wallet.id,
    user_id: user.id,
    provider: providerId,
    key_name: keyName,
    encrypted_secret: encryptSecret(privateKey),
  });
  if (connError) {
    // Roll back rather than leave an orphaned, connection-less exchange
    // "wallet" behind — it would show up in the list but every sync would
    // just fail with "connection not found".
    await db.from("wallets").delete().eq("id", wallet.id);
    return { error: `Failed to save connection: ${connError.message}` };
  }

  // Save what the test call already fetched — a real first sync for free,
  // no need to immediately click "Sync" right after connecting.
  const firstSync: { price_key?: string | null }[] = await keyed(testResult.holdings, "auto_exchange");
  await db.rpc("sync_exchange_holdings", {
    p_wallet_id: wallet.id,
    p_holdings: firstSync,
    p_status: testResult.warnings.length === 0 ? "ok" : `partial — ${testResult.warnings.join("; ")}`,
  });
  await ensureAssetPrices(firstSync.map((r) => r.price_key), "sync").catch(() => {});

  revalidatePath("/wallets");
  redirect(`/wallets/${wallet.id}`);
}

/** Same CAS-claim/after() shape as syncWalletDefi, its own
 * exchange_sync_status/exchange_sync_started_at pair (a fourth independent
 * job on the wallet row — see holdings.source's "auto_exchange" doc
 * comment). Works for every provider in EXCHANGE_ADAPTERS — dispatches on
 * the wallet's own `provider` column, same reasoning as connectExchange's
 * own doc comment (originally syncCoinbaseHoldings). */
export async function syncExchangeHoldings(walletId: string): Promise<JobStartResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("provider")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  const fetchBalances = wallet.provider ? EXCHANGE_ADAPTERS[wallet.provider] : undefined;
  if (!fetchBalances) throw new Error("This wallet isn't a connected exchange.");

  const syncStartedAt = Date.now();
  const staleBefore = new Date(syncStartedAt - JOB_STALE_MS).toISOString();
  const { data: claimed, error: markError } = await db
    .from("wallets")
    .update({ exchange_sync_status: "syncing", exchange_sync_started_at: new Date(syncStartedAt).toISOString() })
    .eq("id", walletId)
    .or(`exchange_sync_status.neq.syncing,exchange_sync_status.is.null,exchange_sync_started_at.lt.${staleBefore}`)
    .select("id");
  if (markError) throw new Error(`Failed to start sync: ${markError.message}`);
  if (!claimed || claimed.length === 0) {
    return { started: false, reason: "A sync is already running for this wallet." };
  }

  after(async () => {
    const afterDb = await userDb();
    try {
      const svc = serviceDb();
      const { data: conn, error: connError } = await svc
        .from("exchange_connections")
        .select("key_name, encrypted_secret")
        .eq("wallet_id", walletId)
        .single();
      if (connError) throw new Error(`Failed to load connection: ${connError.message}`);

      const privateKey = decryptSecret(conn.encrypted_secret);
      const { holdings, warnings } = await fetchBalances(conn.key_name, privateKey);
      const status = warnings.length === 0 ? "ok" : `partial — ${warnings.join("; ")}`;

      const savedExchange: { price_key?: string | null }[] = await keyed(holdings, "auto_exchange");
      const { error: syncError } = await afterDb.rpc("sync_exchange_holdings", {
        p_wallet_id: walletId,
        p_holdings: savedExchange,
        p_status: status,
      });
      if (syncError) throw new Error(`Failed to save synced holdings: ${syncError.message}`);
      await ensureAssetPrices(savedExchange.map((r) => r.price_key), "sync").catch(() => {});

      await afterDb
        .from("wallets")
        .update({ exchange_sync_duration_ms: Date.now() - syncStartedAt })
        .eq("id", walletId);


      scheduleUserSnapshot(user.id, [`/wallets/${walletId}`]);
    } catch (e) {
      await afterDb
        .from("wallets")
        .update({
          exchange_sync_status: `error: ${(e as Error).message}`,
          exchange_sync_duration_ms: Date.now() - syncStartedAt,
        })
        .eq("id", walletId);
    } finally {
      revalidatePath(`/wallets/${walletId}`);
      revalidatePath("/wallets");
      revalidatePath("/dashboard");
      revalidatePath("/analytics");
    }
  });

  // No kickoff-time revalidation — see JobPoller.tsx's own doc comment.
  return { started: true };
}

/**
 * There's no Coinbase API to revoke a key programmatically (confirmed live
 * — revocation is portal-only), so this can only delete cryptoport's own
 * copy; the UI tells the user to also delete the key from Coinbase's own
 * portal if they want it fully dead. Soft-deletes the wallet, same as
 * deleteWallet above.
 */
export async function disconnectExchange(walletId: string) {
  const user = await requireUser();
  const db = await userDb();
  // RLS on wallets already scopes this select to the caller's own rows —
  // a wallet that isn't theirs simply won't be found.
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("provider")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (!wallet.provider) throw new Error("This wallet isn't a connected exchange.");

  const svc = serviceDb();
  const { error: connError } = await svc
    .from("exchange_connections")
    .delete()
    .eq("wallet_id", walletId)
    .eq("user_id", user.id);
  if (connError) throw new Error(`Failed to remove connection: ${connError.message}`);

  const { error: deactivateError } = await db.from("wallets").update({ active: false }).eq("id", walletId);
  if (deactivateError) throw new Error(`Failed to deactivate wallet: ${deactivateError.message}`);

  revalidatePath("/wallets");
  redirect("/wallets");
}
