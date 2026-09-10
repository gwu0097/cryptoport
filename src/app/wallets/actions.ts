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
import { refreshTokenRegistry } from "@/lib/adapters/coingecko";
import type { AdapterHolding } from "@/lib/adapters/types";
import type { Chain, WalletMode } from "@/lib/types";

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

  // refreshPrices() updates the shared `prices` table (keyed by ticker, not
  // wallet), so there's no single wallet it "belongs" to — stamp every
  // active wallet so the "Refreshed" column reflects that a refresh ran.
  const { error } = await portfolioDb()
    .from("wallets")
    .update({ last_refresh_at: new Date().toISOString(), last_refresh_status: status })
    .eq("active", true);
  if (error) throw new Error(`Failed to record refresh status: ${error.message}`);

  revalidatePath("/wallets");
}

const CHAINS: readonly Chain[] = ["BTC", "ETH", "SOL"];
const MODES: readonly WalletMode[] = ["manual", "auto"];
const HOLDING_KINDS = ["qty", "usd"] as const;

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

export async function createWallet(formData: FormData) {
  const name = requireString(formData, "name");
  const chain = requireOneOf(formData, "chain", CHAINS);
  const mode = requireOneOf(formData, "mode", MODES);
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
  const chain = requireOneOf(formData, "chain", CHAINS);
  const mode = requireOneOf(formData, "mode", MODES);
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
async function fetchAdapterHoldings(chain: "ETH" | "SOL", address: string): Promise<AdapterFetchResult> {
  if (chain === "ETH") return fetchEvmHoldings(address);
  return { holdings: await fetchJupiterHoldings(address), warnings: [] };
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
    .select("chain, address, mode, btc_script_type")
    .eq("id", walletId)
    .single();
  if (walletError) throw new Error(`Failed to load wallet: ${walletError.message}`);
  if (wallet.mode !== "auto") throw new Error("Only auto wallets can be synced.");
  if (!wallet.address) throw new Error("This wallet has no address set.");

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

      if (wallet.chain === "BTC") {
        ({ holdings, detectedScriptType } = await fetchBitcoinHoldingsForSync(
          wallet.address!,
          wallet.btc_script_type as ScriptType | null,
          forceFullScan,
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

      const updates: { last_sync_duration_ms: number; btc_script_type?: ScriptType | null } = {
        last_sync_duration_ms: Date.now() - syncStartedAt,
      };
      if (wallet.chain === "BTC") updates.btc_script_type = detectedScriptType;
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
