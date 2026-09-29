"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { serviceDb, userDb } from "@/lib/supabase";
import { requireAdmin } from "@/lib/adminAuth";
import { syncLiveWebhook } from "@/lib/webhookSync";
import { syncAlchemyWebhooks } from "@/lib/alchemyWebhookSync";
import { clearLiveCache } from "@/lib/liveActivity";
import { syncCopies } from "@/lib/watchCopySync";
import { detectChain } from "@/lib/lookup";
import { normalizeWatchAddress } from "@/lib/watchSnapshot";
import { claimWatchedAddresses, ensureWatchedAddress, refreshWatchedAddresses, type WatchedKey } from "@/lib/watchRefresh";
import type { JobStartResult } from "@/lib/jobStatus";
import { getSharedInfluencer } from "@/lib/watchQuery";

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
  // Copies of this influencer made from its share link get it too.
  if (!created) await syncCopies(influencerId, { kind: "add", chain: parsed.chain, address: parsed.address }).catch((e) => console.error(`Copies not updated: ${(e as Error).message}`));

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
  const { data, error } = await db.from("watch_influencer_addresses").delete().eq("id", addressId).select("chain, address");
  if (error) return { ok: false, error: error.message };
  const removed = (data as { chain: string; address: string }[] | null)?.[0];
  // Copies of this influencer made from its share link lose it too.
  if (removed) await syncCopies(influencerId, { kind: "remove", ...removed }).catch((e) => console.error(`Copies not updated: ${(e as Error).message}`));
  revalidate(influencerId);
  return { ok: true };
}

/** A copy stops following the shared list it came from: its addresses are
 * then its own. */
export async function stopFollowing(influencerId: string): Promise<WatchActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_influencers").update({ copied_from: null }).eq("id", influencerId);
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

/** Creates (or returns) the influencer's share token: a random, unguessable
 * id any signed-in user can open at /wallet-watch/shared/<token>. */
export async function shareInfluencer(id: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_influencers").select("share_token").eq("id", id).single();
  if (error) return { ok: false, error: error.message };
  if (data.share_token) return { ok: true, token: data.share_token as string };
  const token = crypto.randomUUID();
  const { error: updateError } = await db.from("watch_influencers").update({ share_token: token }).eq("id", id);
  if (updateError) return { ok: false, error: updateError.message };
  revalidate(id);
  return { ok: true, token };
}

/** Owner only: puts one of the owner's influencers in the KOL directory
 * (docs/wallet-watch/DIRECTORY.md), or takes it out. An entry is always
 * shared, so copies made from it follow it; taking it out leaves the share
 * link and existing copies as they are. The directory table is written with
 * the service role — no user can. */
export async function setInDirectory(influencerId: string, on: boolean): Promise<WatchActionResult> {
  await requireAdmin();
  const db = await userDb();
  const { data, error } = await db.from("watch_influencers").select("id").eq("id", influencerId).maybeSingle(); // the owner's own (RLS)
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Not one of your influencers." };
  if (on) {
    const shared = await shareInfluencer(influencerId);
    if (!shared.ok) return { ok: false, error: shared.error };
    const { error: addError } = await serviceDb().from("watch_directory").upsert({ influencer_id: influencerId }, { onConflict: "influencer_id", ignoreDuplicates: true });
    if (addError) return { ok: false, error: addError.message };
  } else {
    const { error: removeError } = await serviceDb().from("watch_directory").delete().eq("influencer_id", influencerId);
    if (removeError) return { ok: false, error: removeError.message };
  }
  revalidate(influencerId);
  revalidatePath("/wallet-watch/directory");
  return { ok: true, influencerId };
}

/** Turns the share link off; the old link stops working at once. */
export async function unshareInfluencer(id: string): Promise<WatchActionResult> {
  await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_influencers").update({ share_token: null }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate(id);
  return { ok: true };
}

/** Adds a shared influencer to the viewer's own Wallet Watch: the same name,
 * link and addresses (not the sharer's note or groups), following the
 * sharer's later address changes. The addresses are already read (one
 * shared row each), so nothing is re-read. */
export async function addSharedInfluencer(token: string): Promise<WatchActionResult> {
  await requireUser();
  const shared = await getSharedInfluencer(token);
  if (!shared) return { ok: false, error: "This share link no longer works." };
  const db = await userDb();
  // Remembers its source: the sharer's later address changes follow (watchCopySync.ts).
  const { data, error } = await db.from("watch_influencers").insert({ name: shared.influencer.name, link: shared.influencer.link, copied_from: shared.influencer.id }).select("id").single();
  if (error) return { ok: false, error: friendly(error.message) };
  const influencerId = data.id as string;
  const { error: addrError } = await db
    .from("watch_influencer_addresses")
    .insert(shared.influencer.addresses.map((a) => ({ influencer_id: influencerId, chain: a.chain, address: a.address })));
  if (addrError) {
    await db.from("watch_influencers").delete().eq("id", influencerId);
    return { ok: false, error: friendly(addrError.message) };
  }
  revalidate(influencerId);
  return { ok: true, influencerId };
}

/**
 * Owner only (it spends the owner's Helius credits and Alchemy compute
 * units): live updates for an influencer's Solana addresses via the app's
 * Helius webhook (docs/wallet-watch/PLAN.md, phase 5) and its EVM addresses
 * via the Alchemy webhooks for Ethereum, Arbitrum and Robinhood Chain
 * (phase 6). If a provider refuses, that chain's addresses go back to how
 * they were. live_since starts after the webhook's propagation time: a
 * trade in that gap (Hash's NIBS sale, 23 s after turning on) isn't a miss.
 */
const WEBHOOK_PROPAGATION_MS = 2 * 60 * 1000;
const LIVE_SYNC: Record<"SOL" | "ETH", () => Promise<unknown>> = { SOL: syncLiveWebhook, ETH: syncAlchemyWebhooks };

export async function setInfluencerLive(influencerId: string, on: boolean): Promise<WatchActionResult> {
  await requireAdmin();
  const db = await userDb();
  const { data, error } = await db.from("watch_influencer_addresses").select("chain, address").eq("influencer_id", influencerId).in("chain", ["SOL", "ETH"]);
  if (error) return { ok: false, error: error.message };
  const rows = data as { chain: "SOL" | "ETH"; address: string }[];
  if (rows.length === 0) return { ok: false, error: "Live updates cover Solana and EVM addresses — this influencer has neither." };
  const svc = serviceDb();
  const errors: string[] = [];
  for (const chain of ["SOL", "ETH"] as const) {
    const addresses = rows.filter((r) => r.chain === chain).map((r) => r.address);
    if (addresses.length === 0) continue;
    const { error: setError } = await svc
      .from("watched_addresses")
      .update(on ? { live: true, live_since: new Date(Date.now() + WEBHOOK_PROPAGATION_MS).toISOString() } : { live: false, live_since: null })
      .eq("chain", chain)
      .in("address", addresses);
    if (setError) {
      errors.push(setError.message);
      continue;
    }
    clearLiveCache();
    try {
      await LIVE_SYNC[chain]();
    } catch (e) {
      await svc.from("watched_addresses").update(on ? { live: false, live_since: null } : { live: true }).eq("chain", chain).in("address", addresses);
      errors.push((e as Error).message);
    }
  }
  clearLiveCache();
  revalidate(influencerId);
  return errors.length > 0 ? { ok: false, error: errors.join(" · ") } : { ok: true, influencerId };
}
