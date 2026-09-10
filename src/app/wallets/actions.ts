"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { portfolioDb } from "@/lib/supabase";
import { refreshPrices } from "@/lib/prices";
import type { Account, Chain, WalletMode } from "@/lib/types";

export async function refreshPricesAction() {
  await refreshPrices();
  revalidatePath("/wallets");
}

const CHAINS: readonly Chain[] = ["BTC", "ETH", "SOL"];
const MODES: readonly WalletMode[] = ["manual", "auto"];
const ACCOUNTS: readonly Account[] = ["personal", "biz"];
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

export async function createWallet(formData: FormData) {
  const name = requireString(formData, "name");
  const chain = requireOneOf(formData, "chain", CHAINS);
  const mode = requireOneOf(formData, "mode", MODES);
  const account = requireOneOf(formData, "account", ACCOUNTS);
  const address = optionalString(formData, "address");

  const { data, error } = await portfolioDb()
    .from("wallets")
    .insert({ name, chain, mode, account, address })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create wallet: ${error.message}`);

  revalidatePath("/wallets");
  redirect(`/wallets/${data.id}`);
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
