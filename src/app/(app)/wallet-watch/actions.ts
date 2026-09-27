"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { detectChain } from "@/lib/lookup";
import { normalizeWatchAddress } from "@/lib/watchSnapshot";
import { claimWatchedAddresses, ensureWatchedAddress, refreshWatchedAddresses, type WatchedKey } from "@/lib/watchRefresh";
import type { JobStartResult } from "@/lib/jobStatus";

// Wallet Watch (docs/wallet-watch/PLAN.md). The user's own rows go through
// userDb() (owner-only RLS; the caps are a database trigger); the shared
// per-address row is created and refreshed with the service role
// (watchRefresh.ts). Reading an address is slow, so it runs in after() and
// JobPoller reports when it lands (CLAUDE.md §6).

export type WatchActionResult = { ok: true; influencerId?: string } | { ok: false; error: string };

/** The database's own messages for its caps and checks, in plain words. */
function friendly(message: string): string {
  if (/up to 25 influencers|up to 5 addresses|limit of watched addresses/.test(message)) return message.replace(/^.*?(You can|An influencer|Wallet Watch)/, "$1");
  if (/duplicate key/.test(message)) return "That address is already on this influencer.";
  if (/check constraint/.test(message)) return "Please check the name and link (names up to 80 characters).";
  return message;
}

function parseAddress(raw: string): WatchedKey | { error: string } {
  const address = normalizeWatchAddress(raw);
  const chain = detectChain(address);
  if (!chain) return { error: "That doesn't look like a supported wallet address." };
  return { chain, address };
}

function cleanLink(raw: string | undefined): string | null | { error: string } {
  const link = raw?.trim();
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "The link must start with https://." };
    return url.toString();
  } catch {
    return { error: "That link isn't a valid URL." };
  }
}

/** Claims the addresses now — so the page this action re-renders already
 * shows them as refreshing and JobPoller watches for the result — and reads
 * them in the background. Two clicks never read one address twice. */
async function startRefresh(keys: WatchedKey[]): Promise<number> {
  const claimed = await claimWatchedAddresses(keys);
  if (claimed.length > 0) after(() => refreshWatchedAddresses(claimed));
  return claimed.length;
}

function revalidate(influencerId?: string) {
  revalidatePath("/wallet-watch");
  if (influencerId) revalidatePath(`/wallet-watch/${influencerId}`);
}

/**
 * Watches an address: under a new influencer (`name`) or an existing one
 * (`influencerId`), in the chosen groups, and reads it right away.
 */
export async function watchAddress(input: {
  address: string;
  influencerId?: string;
  name?: string;
  link?: string;
  groupIds?: string[];
}): Promise<WatchActionResult> {
  await requireUser();
  const parsed = parseAddress(input.address);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const db = await userDb();

  let influencerId = input.influencerId;
  const created = !influencerId;
  if (!influencerId) {
    const name = input.name?.trim();
    if (!name) return { ok: false, error: "Give the influencer a name." };
    const link = cleanLink(input.link);
    if (link && typeof link === "object") return { ok: false, error: link.error };
    const { data, error } = await db.from("watch_influencers").insert({ name, link }).select("id").single();
    if (error) return { ok: false, error: friendly(error.message) };
    influencerId = data.id as string;
  }

  // A new influencer whose first address can't be saved isn't kept.
  const fail = async (message: string): Promise<WatchActionResult> => {
    if (created) await db.from("watch_influencers").delete().eq("id", influencerId!);
    return { ok: false, error: message };
  };
  try {
    await ensureWatchedAddress(parsed);
  } catch (e) {
    return fail((e as Error).message);
  }
  const { error } = await db.from("watch_influencer_addresses").insert({ influencer_id: influencerId, ...parsed });
  if (error) return fail(friendly(error.message));

  if (input.groupIds?.length) {
    const { error: groupError } = await db
      .from("watch_group_influencers")
      .upsert(input.groupIds.map((group_id) => ({ group_id, influencer_id: influencerId })), { onConflict: "group_id,influencer_id", ignoreDuplicates: true });
    if (groupError) return { ok: false, error: friendly(groupError.message) };
  }

  await startRefresh([parsed]);
  revalidate(influencerId);
  return { ok: true, influencerId };
}

export async function updateInfluencer(id: string, input: { name: string; link?: string; note?: string }): Promise<WatchActionResult> {
  await requireUser();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the influencer a name." };
  const link = cleanLink(input.link);
  if (link && typeof link === "object") return { ok: false, error: link.error };
  const db = await userDb();
  const { error } = await db
    .from("watch_influencers")
    .update({ name, link, note: input.note?.trim() || null })
    .eq("id", id);
  if (error) return { ok: false, error: friendly(error.message) };
  revalidate(id);
  return { ok: true };
}

export async function removeInfluencer(id: string): Promise<WatchActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_influencers").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function removeWatchedAddress(addressId: string, influencerId: string): Promise<WatchActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_influencer_addresses").delete().eq("id", addressId);
  if (error) return { ok: false, error: error.message };
  revalidate(influencerId);
  return { ok: true };
}

export async function createGroup(name: string): Promise<WatchActionResult> {
  await requireUser();
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the group a name." };
  const db = await userDb();
  const { error } = await db.from("watch_groups").insert({ name: clean });
  if (error) return { ok: false, error: friendly(error.message) };
  revalidate();
  return { ok: true };
}

export async function renameGroup(id: string, name: string): Promise<WatchActionResult> {
  await requireUser();
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the group a name." };
  const db = await userDb();
  const { error } = await db.from("watch_groups").update({ name: clean }).eq("id", id);
  if (error) return { ok: false, error: friendly(error.message) };
  revalidate();
  return { ok: true };
}

export async function deleteGroup(id: string): Promise<WatchActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_groups").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Sets exactly which groups an influencer is in. */
export async function setInfluencerGroups(influencerId: string, groupIds: string[]): Promise<WatchActionResult> {
  await requireUser();
  const db = await userDb();
  const { error: delError } = await db.from("watch_group_influencers").delete().eq("influencer_id", influencerId);
  if (delError) return { ok: false, error: delError.message };
  if (groupIds.length > 0) {
    const { error } = await db.from("watch_group_influencers").insert(groupIds.map((group_id) => ({ group_id, influencer_id: influencerId })));
    if (error) return { ok: false, error: friendly(error.message) };
  }
  revalidate(influencerId);
  return { ok: true };
}

/** Re-reads every address of an influencer (or of several). */
export async function refreshInfluencers(influencerIds: string[]): Promise<JobStartResult> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_influencer_addresses").select("chain, address").in("influencer_id", influencerIds);
  if (error) throw new Error(`Failed to load addresses: ${error.message}`);
  const keys = [...new Map((data as WatchedKey[]).map((k) => [`${k.chain}|${k.address}`, k])).values()];
  if (keys.length === 0) return { started: false, reason: "No addresses to refresh." };
  if ((await startRefresh(keys)) === 0) return { started: false, reason: "Already refreshing." };
  revalidate(influencerIds.length === 1 ? influencerIds[0] : undefined);
  return { started: true };
}
