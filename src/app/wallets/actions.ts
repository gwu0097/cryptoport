"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { portfolioDb } from "@/lib/supabase";
import { refreshPrices } from "@/lib/prices";
import { fetchEvmHoldings } from "@/lib/adapters/evm";
import { fetchJupiterHoldings } from "@/lib/adapters/jupiter";
import { fetchBitcoinHoldingsForSync } from "@/lib/adapters/bitcoin";
import type { ScriptType } from "@/lib/adapters/bitcoinXpub";
import { fetchCardanoHoldingsForSync } from "@/lib/adapters/cardano";
import { fetchCosmosHoldings } from "@/lib/adapters/cosmos";
import { fetchNearHoldings } from "@/lib/adapters/near";
import { fetchSuiHoldings } from "@/lib/adapters/sui";
import { fetchFilecoinHoldings } from "@/lib/adapters/filecoin";
import { fetchBitcoinCashHoldings } from "@/lib/adapters/bitcoincash";
import { fetchSubstrateHoldings } from "@/lib/adapters/substrate";
import { fetchNeoHoldings } from "@/lib/adapters/neo";
import { fetchTonHoldings } from "@/lib/adapters/ton";
import { fetchAptosHoldings } from "@/lib/adapters/aptos";
import { fetchXrpHoldings } from "@/lib/adapters/xrp";
import { fetchIcpHoldings } from "@/lib/adapters/icp";
import { refreshTokenRegistry } from "@/lib/adapters/coingecko";
import { isEvmChainId } from "@/lib/adapters/evmChains";
import type { AdapterHolding } from "@/lib/adapters/types";
import type { WalletMode } from "@/lib/types";

// The EVM sync (evm.ts -> multicallEvm.ts) reads on-chain balances only for
// tokens already in cryptoport.token_registry — this is what populates it,
// from CoinGecko's coins/list. Manual/on-demand rather than automatic: it's
// slow (every EVM chain's full token list, tens of thousands of rows for
// Ethereum) and registry data doesn't need to be fresher than "before your
// next EVM wallet sync."
export async function refreshTokenRegistryAction() {
  await refreshTokenRegistry();
  revalidatePath("/wallets");
}

export async function refreshPricesAction() {
  const results = await refreshPrices();
  const failed = results.filter((r) => !r.ok);
  const status =
    results.length === 0
      ? "no priced holdings"
      : failed.length === 0
        ? "ok"
        : `${failed.length}/${results.length} ticker(s) failed`;

  // Prices are keyed by ticker, not wallet — refreshPrices() touches the
  // shared `prices` table, never a specific wallet's own holdings. This
  // used to stamp every active wallet's last_refresh_at/last_refresh_status
  // instead of using its own state, which conflated "prices were refreshed"
  // with "this wallet was synced" into one column (a wallet's real sync
  // status kept getting overwritten by an unrelated price refresh). One
  // singleton row instead — see price_refresh_state in schema.sql.
  const { error } = await portfolioDb()
    .from("price_refresh_state")
    .update({ refreshed_at: new Date().toISOString(), status })
    .eq("id", 1);
  if (error) throw new Error(`Failed to record price refresh: ${error.message}`);

  revalidatePath("/wallets");
}

// Same global refresh (prices are keyed by ticker, not wallet — there's no
// such thing as "refresh prices for just this wallet") — just also
// revalidates this one wallet's own page, so clicking "Refresh prices" from
// the wallet detail page (came up directly: a freshly-synced ADA holding
// showed unpriced with no obvious way to fix it short of navigating back
// to the wallets list) reflects the update immediately instead of needing
// a manual reload.
export async function refreshPricesForWalletAction(walletId: string) {
  await refreshPricesAction();
  revalidatePath(`/wallets/${walletId}`);
}

// The non-EVM chains with an actual adapter — a wallet's `chain` field
// itself isn't restricted to these (see Wallet.chain in types.ts): auto
// mode is, checked both here (isAutoCapableChain, used by
// createWallet/updateWallet and again defensively in syncWalletHoldings)
// and client-side in ChainModeFields (which disables the "auto" option
// for anything else, so this server check is belt-and-suspenders rather
// than the only guard). EVM chains aren't listed here — any of the 31
// chains in evmChains.ts is auto-capable, checked dynamically via
// isEvmChainId, since a wallet's EVM-format address is scanned across
// every configured EVM chain regardless of which one it's labeled with
// (e.g. a Ronin-focused wallet can say "RON" instead of the generic
// "ETH" and still auto-sync exactly the same way).
const AUTO_CAPABLE_CHAINS = [
  "BTC",
  "SOL",
  "ADA",
  "ATOM",
  "INJ",
  "NEAR",
  "SUI",
  "FIL",
  "BCH",
  "DOT",
  "TAO",
  "NEO",
  "XRP",
  "TON",
  "APT",
  "ICP",
] as const;
const MODES: readonly WalletMode[] = ["manual", "auto"];
const HOLDING_KINDS = ["qty", "usd"] as const;

function isAutoCapableChain(chain: string): boolean {
  return (AUTO_CAPABLE_CHAINS as readonly string[]).includes(chain) || isEvmChainId(chain);
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

// Replaces the old fixed personal/biz "account" select with a free-text tag
// — typing a name that already exists reuses that tag, typing a new one
// creates it on the spot (no separate "manage tags" page). Upsert on the
// unique `name` column rather than select-then-insert: atomic, so two
// wallets saved with the same brand-new tag name at once can't race into
// duplicate tag rows.
async function resolveTagId(formData: FormData): Promise<string | null> {
  const name = optionalString(formData, "tag");
  if (!name) return null;

  const { data, error } = await portfolioDb()
    .from("tags")
    .upsert({ name }, { onConflict: "name" })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to resolve tag: ${error.message}`);
  return data.id;
}

// Chain is free text now (RON, NEAR, whatever — manual tracking works for
// anything), but auto mode only actually works for AUTO_CAPABLE_CHAINS —
// enforced here too, not just by ChainModeFields disabling the option
// client-side, since a direct form POST could otherwise bypass that.
function requireChainAndMode(formData: FormData): { chain: string; mode: WalletMode } {
  const chain = requireString(formData, "chain").toUpperCase();
  const mode = requireOneOf(formData, "mode", MODES);
  if (mode === "auto" && !isAutoCapableChain(chain)) {
    throw new Error(
      `Auto mode isn't available for "${chain}" — only ${AUTO_CAPABLE_CHAINS.join(", ")}, or any EVM chain (ETH, RON, SEI, ARB, ...), have a sync adapter. Use manual mode instead.`,
    );
  }
  return { chain, mode };
}

export async function createWallet(formData: FormData) {
  const name = requireString(formData, "name");
  const { chain, mode } = requireChainAndMode(formData);
  const address = optionalString(formData, "address");
  const tag_id = await resolveTagId(formData);

  const { data, error } = await portfolioDb()
    .from("wallets")
    .insert({ name, chain, mode, tag_id, address })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create wallet: ${error.message}`);

  revalidatePath("/wallets");
  redirect(`/wallets/${data.id}`);
}

export async function updateWallet(walletId: string, formData: FormData) {
  const name = requireString(formData, "name");
  const { chain, mode } = requireChainAndMode(formData);
  const address = optionalString(formData, "address");
  const tag_id = await resolveTagId(formData);

  const { error } = await portfolioDb()
    .from("wallets")
    .update({ name, chain, mode, tag_id, address })
    .eq("id", walletId);
  if (error) throw new Error(`Failed to update wallet: ${error.message}`);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// A manual wallet's holdings are entered by hand, as either a typed quantity
// (priced on every refresh) or a fixed USD value (source='manual_usd', which
// bypasses pricing entirely — see valuation.ts). This is the only place that
// decides which of the two a new holding is.
export async function addHolding(walletId: string, formData: FormData) {
  const ticker = requireString(formData, "ticker").toUpperCase();
  const kind = requireOneOf(formData, "kind", HOLDING_KINDS);

  const insert: {
    wallet_id: string;
    ticker: string;
    source: "manual_usd" | "manual_qty";
    qty: string | null;
    usd_override: string | null;
  } =
    kind === "usd"
      ? {
          wallet_id: walletId,
          ticker,
          source: "manual_usd",
          usd_override: requireString(formData, "usd_override"),
          qty: null,
        }
      : {
          wallet_id: walletId,
          ticker,
          source: "manual_qty",
          qty: requireString(formData, "qty"),
          usd_override: null,
        };

  const { error } = await portfolioDb().from("holdings").insert(insert);
  if (error) throw new Error(`Failed to add holding: ${error.message}`);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// Auto holdings are refresh-owned (source='auto'); the UI must never write to
// them, mirroring the rule that the refresh job may never touch manual rows.
async function requireEditableHolding(holdingId: string) {
  const { data, error } = await portfolioDb()
    .from("holdings")
    .select("source")
    .eq("id", holdingId)
    .single();
  if (error) throw new Error(`Failed to load holding: ${error.message}`);
  if (data.source === "auto") {
    throw new Error("Auto holdings are refresh-owned and cannot be edited by hand.");
  }
  return data.source;
}

export async function updateHolding(holdingId: string, walletId: string, formData: FormData) {
  const source = await requireEditableHolding(holdingId);

  const update =
    source === "manual_usd"
      ? { usd_override: requireString(formData, "usd_override") }
      : { qty: requireString(formData, "qty") };

  const { error } = await portfolioDb().from("holdings").update(update).eq("id", holdingId);
  if (error) throw new Error(`Failed to update holding: ${error.message}`);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

export async function deleteHolding(holdingId: string, walletId: string) {
  await requireEditableHolding(holdingId);

  const { error } = await portfolioDb().from("holdings").delete().eq("id", holdingId);
  if (error) throw new Error(`Failed to delete holding: ${error.message}`);

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// Solana sync only captures plain token balances — LP/DeFi positions
// (Meteora, DLMM, etc.) aren't token accounts and Jupiter's balances
// endpoint won't return them. Recorded in the wallet's notes rather than
// silently under-reporting with no explanation.
const SOL_SYNC_NOTE =
  "Auto-synced token balances only — LP/DeFi positions (e.g. Meteora, DLMM) are not captured by this sync.";

interface AdapterFetchResult {
  holdings: AdapterHolding[];
  /** Partial, non-fatal failures (e.g. one EVM chain's public RPC had a bad
   * moment) — the sync still saves whatever it did get. */
  warnings: string[];
}

// BTC isn't dispatched through here — see syncWalletHoldings, which calls
// fetchBitcoinHoldingsForSync directly so it can pass the wallet's cached
// script type through and get the detected one back.
async function fetchAdapterHoldings(chain: string, address: string): Promise<AdapterFetchResult> {
  // Sei is the one chain with two entirely different address formats
  // pointing at two different balances (see cosmos.ts's "SEI" entry) — a
  // bech32 sei1... address can only ever mean the Cosmos-native side,
  // checked before the generic EVM check below (which would otherwise
  // also claim "SEI" — evmChains.ts has its own "sei" entry for the EVM
  // side of the same chain).
  if (chain === "SEI" && address.startsWith("sei1")) {
    return { holdings: await fetchCosmosHoldings("SEI", address), warnings: [] };
  }
  if (isEvmChainId(chain)) return fetchEvmHoldings(address);
  if (chain === "SOL") return { holdings: await fetchJupiterHoldings(address), warnings: [] };
  if (chain === "NEAR") return { holdings: await fetchNearHoldings(address), warnings: [] };
  if (chain === "SUI") return { holdings: await fetchSuiHoldings(address), warnings: [] };
  if (chain === "FIL") return { holdings: await fetchFilecoinHoldings(address), warnings: [] };
  if (chain === "BCH") return { holdings: await fetchBitcoinCashHoldings(address), warnings: [] };
  if (chain === "DOT" || chain === "TAO") {
    return { holdings: await fetchSubstrateHoldings(chain, address), warnings: [] };
  }
  if (chain === "ATOM" || chain === "INJ") {
    return { holdings: await fetchCosmosHoldings(chain, address), warnings: [] };
  }
  if (chain === "NEO") return { holdings: await fetchNeoHoldings(address), warnings: [] };
  if (chain === "XRP") return { holdings: await fetchXrpHoldings(address), warnings: [] };
  if (chain === "TON") return { holdings: await fetchTonHoldings(address), warnings: [] };
  if (chain === "APT") return { holdings: await fetchAptosHoldings(address), warnings: [] };
  if (chain === "ICP") return { holdings: await fetchIcpHoldings(address), warnings: [] };
  throw new Error(`No sync adapter for chain "${chain}".`);
}

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
export async function syncWalletHoldings(walletId: string, forceFullScan = false) {
  const { data: wallet, error: walletError } = await portfolioDb()
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
  const { error: markError } = await portfolioDb()
    .from("wallets")
    .update({ last_refresh_status: "syncing", sync_started_at: new Date(syncStartedAt).toISOString() })
    .eq("id", walletId);
  if (markError) throw new Error(`Failed to start sync: ${markError.message}`);

  after(async () => {
    try {
      let holdings: AdapterHolding[];
      let warnings: string[] = [];
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
      } else {
        ({ holdings, warnings } = await fetchAdapterHoldings(wallet.chain, wallet.address!));
      }

      const status = warnings.length === 0 ? "ok" : `partial — ${warnings.join("; ")}`;
      const { error: syncError } = await portfolioDb().rpc("sync_auto_holdings", {
        p_wallet_id: walletId,
        p_holdings: holdings,
        p_status: status,
      });
      if (syncError) throw new Error(`Failed to save synced holdings: ${syncError.message}`);

      if (wallet.chain === "SOL") {
        await portfolioDb().from("wallets").update({ notes: SOL_SYNC_NOTE }).eq("id", walletId);
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
      await portfolioDb().from("wallets").update(updates).eq("id", walletId);
    } catch (e) {
      await portfolioDb()
        .from("wallets")
        .update({
          last_refresh_status: `error: ${(e as Error).message}`,
          last_sync_duration_ms: Date.now() - syncStartedAt,
        })
        .eq("id", walletId);
    } finally {
      revalidatePath(`/wallets/${walletId}`);
      revalidatePath("/wallets");
    }
  });

  revalidatePath(`/wallets/${walletId}`);
  revalidatePath("/wallets");
}

// Kicks off a sync for every active auto-mode wallet not already syncing —
// each one still runs the same way a single "Sync" click does (marked
// 'syncing' fast, real fetch work happens in its own after() background
// task, see syncWalletHoldings above), so this loop itself finishes in
// well under a second regardless of wallet count: it's only doing N fast
// DB writes, not waiting on N real syncs. All of those background tasks
// then genuinely run concurrently — bounded by whichever single wallet is
// slowest (a full BTC xpub scan, typically a few minutes), not by their
// sum — comfortably inside this page's 300s maxDuration even with every
// wallet syncing at once. No cross-wallet throttling: individual syncs
// already retry through free-RPC flakiness on their own (see
// fetchWithRetry/mapWithConcurrency), and this app's wallet count is
// small enough that hammering a shared provider with a few more
// concurrent callers hasn't been an issue in practice.
export async function syncAllWallets() {
  const { data: wallets, error } = await portfolioDb()
    .from("wallets")
    .select("id, last_refresh_status")
    .eq("mode", "auto")
    .eq("active", true);
  if (error) throw new Error(`Failed to load wallets: ${error.message}`);

  for (const wallet of wallets) {
    if (wallet.last_refresh_status === "syncing") continue; // already in flight, don't double-trigger
    await syncWalletHoldings(wallet.id, false);
  }
}

// Soft delete: wallets.active already exists for exactly this (the wallets
// list already filters on it) — no schema change needed, and it keeps a
// wallet's holding history around instead of cascading a hard delete.
export async function deleteWallet(walletId: string) {
  const { error } = await portfolioDb()
    .from("wallets")
    .update({ active: false })
    .eq("id", walletId);
  if (error) throw new Error(`Failed to delete wallet: ${error.message}`);

  revalidatePath("/wallets");
  redirect("/wallets");
}
