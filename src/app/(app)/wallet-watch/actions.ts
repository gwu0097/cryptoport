"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { serviceDb, userDb } from "@/lib/supabase";
import { isAdminEmail, requireAdmin } from "@/lib/adminAuth";
import { solanaDayCount } from "@/lib/adapters/solanaActivityRate";
import { evmDayCount } from "@/lib/adapters/evmActivityRate";
import { LIVE_DAY_MAX, monthlyCredits } from "@/lib/liveBudget";
import { syncLiveWebhook } from "@/lib/webhookSync";
import { syncAlchemyWebhooks } from "@/lib/alchemyWebhookSync";
import { clearLiveCache } from "@/lib/liveActivity";
import { syncCopies } from "@/lib/watchCopySync";
import { summarizeLinks, type LinkEvidence } from "@/lib/walletLinks";
import { evmLinkTransfers, solanaLinkTransfers } from "@/lib/adapters/walletLinkReads";
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

// Shared groups (docs/wallet-watch/SHARED_GROUPS.md): a member can see
// another member's influencers, but only their creator changes them. RLS
// makes such an update match no row — silently — so every owner-only write
// names the owner and checks that a row came back.
const NOT_YOURS = "Only whoever added it can change that — it's shared with you.";
const NOT_YOUR_GROUP = "Only the group's creator can do that.";
/** Influencers a user can watch (owner 2026-09-30: was 25); the database
 * trigger watch_enforce_caps holds the same number. */
const INFLUENCER_MAX = 40;

/** The database's own messages for its caps and checks, in plain words. */
function friendly(message: string): string {
  if (/up to \d+ influencers|up to 5 addresses|limit of watched addresses|unsaved wallet searches/.test(message)) return message.replace(/^.*?(You can|An influencer|Wallet Watch)/, "$1");
  if (/duplicate key/.test(message)) return "That address is already on this influencer.";
  if (/row-level security/.test(message)) return NOT_YOURS;
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
  /** A Wallet search: watched like any address, but unsaved until named. */
  unsaved?: boolean;
}): Promise<WatchActionResult> {
  const user = await requireUser();
  const parsed = parseAddress(input.address);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const db = await userDb();
  if (input.influencerId) {
    const { data: own } = await db.from("watch_influencers").select("id").eq("id", input.influencerId).eq("user_id", user.id).maybeSingle();
    if (!own) return { ok: false, error: NOT_YOURS };
  }

  let influencerId = input.influencerId;
  const created = !influencerId;
  if (!influencerId) {
    const name = input.name?.trim();
    if (!name) return { ok: false, error: "Give the influencer a name." };
    const link = cleanLink(input.link);
    if (link && typeof link === "object") return { ok: false, error: link.error };
    const { data, error } = await db.from("watch_influencers").insert({ name, link, ...(input.unsaved ? { unsaved_since: new Date().toISOString() } : {}) }).select("id").single();
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

/** How many unsaved Wallet searches a user keeps; a new one past this
 * replaces the oldest — never blocked. The owner keeps every search until
 * it's 10 days old (owner 2026-09-30); the database's backstop is 200. */
const UNSAVED_MAX = 10;

/**
 * Wallet search (owner 2026-09-30): opens any address on the influencer
 * page, exactly as if it were watched — read now, its trading record a
 * click away — but unsaved: no name (its short address stands in), no
 * group, not in the list. Naming it saves it (renameInfluencer); unsaved
 * ones go after 10 days (the daily tick). An address the user already
 * watches opens its own page instead.
 */
export async function searchWallet(form: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = parseAddress(String(form.get("address") ?? ""));
  if ("error" in parsed) redirect(`/wallet-watch?searchError=${encodeURIComponent(parsed.error)}`);
  const db = await userDb();
  // Already watched by you (not a shared group's): open it.
  const { data: mine } = await db.from("watch_influencer_addresses").select("influencer_id").eq("chain", parsed.chain).eq("address", parsed.address).eq("user_id", user.id).limit(1);
  const existing = (mine as { influencer_id: string }[] | null)?.[0]?.influencer_id;
  if (existing) redirect(`/wallet-watch/${existing}`);
  // Room for it: the oldest unsaved searches go first (not the owner's).
  if (!isAdminEmail(user.email, process.env.ADMIN_EMAIL)) {
    const { data: unsaved } = await db.from("watch_influencers").select("id").eq("user_id", user.id).not("unsaved_since", "is", null).order("unsaved_since");
    const over = ((unsaved ?? []) as { id: string }[]).slice(0, Math.max(0, (unsaved?.length ?? 0) - (UNSAVED_MAX - 1)));
    if (over.length > 0) await db.from("watch_influencers").delete().in("id", over.map((u) => u.id));
  }
  const short = parsed.address.length > 12 ? `${parsed.address.slice(0, 6)}…${parsed.address.slice(-4)}` : parsed.address;
  const r = await watchAddress({ address: parsed.address, name: short, unsaved: true });
  if (!r.ok) redirect(`/wallet-watch?searchError=${encodeURIComponent(r.error)}`);
  redirect(`/wallet-watch/${r.influencerId}`);
}

/** Link and note (the name is renamed beside it: renameInfluencer). */
export async function updateInfluencer(id: string, input: { link?: string; note?: string }): Promise<WatchActionResult> {
  const user = await requireUser();
  const link = cleanLink(input.link);
  if (link && typeof link === "object") return { ok: false, error: link.error };
  const db = await userDb();
  const { data, error } = await db
    .from("watch_influencers")
    .update({ link, note: input.note?.trim() || null })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id");
  if (error) return { ok: false, error: friendly(error.message) };
  if (!data?.length) return { ok: false, error: NOT_YOURS };
  revalidate(id);
  return { ok: true };
}

export async function renameInfluencer(id: string, name: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the influencer a name." };
  const db = await userDb();
  // Naming an unsaved Wallet search saves it — within the 40 the list allows
  // (the database checks that only when a row is added).
  const { data: row } = await db.from("watch_influencers").select("unsaved_since").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!row) return { ok: false, error: NOT_YOURS };
  const saving = !!row.unsaved_since;
  if (saving) {
    const { count } = await db.from("watch_influencers").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("unsaved_since", null);
    if ((count ?? 0) >= INFLUENCER_MAX) return { ok: false, error: `You can watch up to ${INFLUENCER_MAX} influencers — remove one to save this wallet.` };
  }
  const { error } = await db.from("watch_influencers").update({ name: clean, ...(saving ? { unsaved_since: null } : {}) }).eq("id", id).eq("user_id", user.id);
  if (error) return { ok: false, error: friendly(error.message) };
  revalidate(id);
  return { ok: true };
}

export async function removeInfluencer(id: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_influencers").delete().eq("id", id).eq("user_id", user.id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: NOT_YOURS };
  revalidate();
  return { ok: true };
}

/** Stops watching several influencers at once (the list's select-and-delete). */
export async function removeInfluencers(ids: string[]): Promise<WatchActionResult> {
  const user = await requireUser();
  if (ids.length === 0) return { ok: true };
  const db = await userDb();
  const { data, error } = await db.from("watch_influencers").delete().in("id", ids).eq("user_id", user.id).select("id");
  if (error) return { ok: false, error: error.message };
  revalidate();
  const skipped = ids.length - (data?.length ?? 0);
  if (skipped > 0) return { ok: false, error: `${skipped} shared with you ${skipped === 1 ? "wasn't" : "weren't"} removed — only whoever added them can.` };
  return { ok: true };
}

export async function removeWatchedAddress(addressId: string, influencerId: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_influencer_addresses").delete().eq("id", addressId).eq("user_id", user.id).select("chain, address");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: NOT_YOURS };
  const removed = (data as { chain: string; address: string }[] | null)?.[0];
  // Copies of this influencer made from its share link lose it too.
  if (removed) await syncCopies(influencerId, { kind: "remove", ...removed }).catch((e) => console.error(`Copies not updated: ${(e as Error).message}`));
  revalidate(influencerId);
  return { ok: true };
}

/** A copy stops following the shared list it came from: its addresses are
 * then its own. */
export async function stopFollowing(influencerId: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_influencers").update({ copied_from: null }).eq("id", influencerId).eq("user_id", user.id);
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
  const user = await requireUser();
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the group a name." };
  const db = await userDb();
  const { data, error } = await db.from("watch_groups").update({ name: clean }).eq("id", id).eq("user_id", user.id).select("id");
  if (error) return { ok: false, error: friendly(error.message) };
  if (!data?.length) return { ok: false, error: NOT_YOUR_GROUP };
  revalidate();
  return { ok: true };
}

export async function deleteGroup(id: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_groups").delete().eq("id", id).eq("user_id", user.id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: NOT_YOUR_GROUP };
  revalidate();
  return { ok: true };
}

/** Shares a group (docs/wallet-watch/SHARED_GROUPS.md): its invite link's
 * token, made on first share. The group's creator only. */
export async function shareGroup(id: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_groups").select("share_token").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: NOT_YOUR_GROUP };
  if (data.share_token) return { ok: true, token: data.share_token as string };
  const token = crypto.randomUUID();
  const { error: saveError } = await db.from("watch_groups").update({ share_token: token }).eq("id", id).eq("user_id", user.id);
  if (saveError) return { ok: false, error: saveError.message };
  revalidate();
  return { ok: true, token };
}

/** Stops sharing: the link stops working and every member is removed (a
 * later share starts with a new link and no members). */
export async function stopSharingGroup(id: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const { data, error } = await db.from("watch_groups").update({ share_token: null }).eq("id", id).eq("user_id", user.id).select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: NOT_YOUR_GROUP };
  // The members' wallets leave the group with them (they stay theirs).
  const { error: linksError } = await db.from("watch_group_influencers").delete().eq("group_id", id).neq("user_id", user.id);
  if (linksError) return { ok: false, error: linksError.message };
  const { error: membersError } = await db.from("watch_group_members").delete().eq("group_id", id);
  if (membersError) return { ok: false, error: membersError.message };
  revalidate();
  return { ok: true };
}

/** A member leaves a shared group, or its creator removes a member. */
export async function removeGroupMember(groupId: string, userId?: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const who = userId ?? user.id;
  // The wallets they added leave the group with them (they stay theirs) —
  // while they're still a member, so the delete is allowed.
  const { error: linksError } = await db.from("watch_group_influencers").delete().eq("group_id", groupId).eq("user_id", who);
  if (linksError) return { ok: false, error: linksError.message };
  const { data, error } = await db.from("watch_group_members").delete().eq("group_id", groupId).eq("user_id", who).select("user_id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: userId ? NOT_YOUR_GROUP : "You're not a member of that group." };
  revalidate();
  return { ok: true };
}

/** Who's in a group you're in: each person's name (the part of their email
 * before the @) and whether they created it. One request. */
export async function groupPeople(groupId: string): Promise<{ ok: true; people: { userId: string; name: string; isCreator: boolean; isYou: boolean }[] } | { ok: false; error: string }> {
  const user = await requireUser();
  const db = await userDb();
  const { data, error } = await db.rpc("watch_group_people", { p_group: groupId });
  if (error) return { ok: false, error: error.message };
  const rows = (data ?? []) as { user_id: string; name: string; is_creator: boolean }[];
  return { ok: true, people: rows.map((r) => ({ userId: r.user_id, name: r.name, isCreator: r.is_creator, isYou: r.user_id === user.id })).sort((a, b) => Number(b.isCreator) - Number(a.isCreator) || a.name.localeCompare(b.name)) };
}

/** Joins the group an invite link names; to it on Wallet Watch. */
export async function joinGroup(token: string): Promise<void> {
  await requireUser();
  const db = await userDb();
  const { data, error } = await db.rpc("join_watch_group", { p_token: token });
  if (error) redirect(`/wallet-watch?searchError=${encodeURIComponent(error.message.replace(/^.*?(This group)/, "$1"))}`);
  if (!data) redirect(`/wallet-watch?searchError=${encodeURIComponent("That invite link is no longer valid.")}`);
  revalidate();
  redirect(`/wallet-watch?group=${data as string}`);
}

/** Puts an influencer in a group or takes it out — one link at a time (a
 * shared group's other links belong to its other members). Adding needs the
 * influencer to be yours; any member takes one out (RLS). */
export async function setInfluencerGroup(influencerId: string, groupId: string, on: boolean): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  if (on) {
    const { error } = await db.from("watch_group_influencers").upsert({ group_id: groupId, influencer_id: influencerId, user_id: user.id }, { onConflict: "group_id,influencer_id", ignoreDuplicates: true });
    if (error) return { ok: false, error: /row-level security/.test(error.message) ? NOT_YOURS : friendly(error.message) };
  } else {
    const { data, error } = await db.from("watch_group_influencers").delete().eq("group_id", groupId).eq("influencer_id", influencerId).select("group_id");
    if (error) return { ok: false, error: error.message };
    if (!data?.length) return { ok: false, error: "That group isn't one you're in." };
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
  const { data, error } = await db.from("watch_influencers").select("share_token").eq("id", id).eq("user_id", (await requireUser()).id).single();
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
  const { data, error } = await db.from("watch_influencers").select("id").eq("id", influencerId).eq("user_id", (await requireUser()).id).maybeSingle(); // the owner's own
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

/** A user suggests a wallet for a KOL in the directory (docs/wallet-watch/
 * DIRECTORY.md, phase 2). It reaches nobody until the owner approves it. */
const MAX_PENDING_SUGGESTIONS = 20;
export async function suggestWallet(input: { influencerId: string; address: string; reason?: string; link?: string }): Promise<WatchActionResult> {
  const user = await requireUser();
  const parsed = parseAddress(input.address);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const link = cleanLink(input.link);
  if (link && typeof link === "object") return { ok: false, error: link.error };
  const reason = input.reason?.trim().slice(0, 500) || null;
  const svc = serviceDb();
  const [{ data: entry }, { data: existing }, { count }] = await Promise.all([
    svc.from("watch_directory").select("influencer_id").eq("influencer_id", input.influencerId).maybeSingle(),
    svc.from("watch_influencer_addresses").select("id").eq("influencer_id", input.influencerId).eq("chain", parsed.chain).eq("address", parsed.address).maybeSingle(),
    svc.from("watch_suggestions").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "pending"),
  ]);
  if (!entry) return { ok: false, error: "That KOL isn't in the directory." };
  if (existing) return { ok: false, error: "That wallet is already on this KOL." };
  if ((count ?? 0) >= MAX_PENDING_SUGGESTIONS) return { ok: false, error: `You have ${MAX_PENDING_SUGGESTIONS} suggestions waiting — wait for those to be reviewed.` };
  const db = await userDb();
  const { error } = await db.from("watch_suggestions").insert({ influencer_id: input.influencerId, ...parsed, reason, source_link: link });
  if (error) return { ok: false, error: /duplicate key/.test(error.message) ? "You've already suggested that wallet." : error.message };
  revalidatePath("/wallet-watch/directory");
  revalidatePath("/admin/suggestions");
  return { ok: true };
}

/** Owner only: reads the transfers between a suggested wallet and the KOL's
 * known wallets (walletLinkReads.ts) and stores what they show. */
export async function checkSuggestion(id: string): Promise<{ ok: true; evidence: LinkEvidence } | { ok: false; error: string }> {
  await requireAdmin();
  const svc = serviceDb();
  const { data: s, error } = await svc.from("watch_suggestions").select("influencer_id, chain, address").eq("id", id).single();
  if (error) return { ok: false, error: error.message };
  const { data: known } = await svc.from("watch_influencer_addresses").select("chain, address").eq("influencer_id", s.influencer_id).eq("chain", s.chain);
  const knownAddresses = ((known ?? []) as { address: string }[]).map((k) => k.address);
  if (knownAddresses.length === 0) return { ok: false, error: `The KOL has no ${s.chain} wallet to compare with.` };
  try {
    const transfers = s.chain === "ETH" ? await evmLinkTransfers(knownAddresses, s.address) : s.chain === "SOL" ? await solanaLinkTransfers(s.address) : null;
    if (!transfers) return { ok: false, error: `No automatic check for ${s.chain} wallets yet.` };
    const evidence = summarizeLinks(transfers, knownAddresses, s.address, new Date().toISOString());
    await svc.from("watch_suggestions").update({ evidence }).eq("id", id);
    revalidatePath("/admin/suggestions");
    return { ok: true, evidence };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Owner only: approves a suggestion — the wallet is added to the directory
 * KOL (read now, and added to every copy that follows it) — or rejects it. */
export async function decideSuggestion(id: string, approve: boolean): Promise<WatchActionResult> {
  await requireAdmin();
  const svc = serviceDb();
  const { data: s, error } = await svc.from("watch_suggestions").select("influencer_id, chain, address, status").eq("id", id).single();
  if (error) return { ok: false, error: error.message };
  if (s.status !== "pending") return { ok: false, error: `Already ${s.status}.` };
  if (approve) {
    const key = { chain: s.chain as string, address: s.address as string };
    const { data: owner } = await svc.from("watch_influencers").select("user_id").eq("id", s.influencer_id).single();
    try {
      await ensureWatchedAddress(key);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { error: addError } = await svc.from("watch_influencer_addresses").upsert({ user_id: owner!.user_id, influencer_id: s.influencer_id, ...key }, { onConflict: "influencer_id,chain,address", ignoreDuplicates: true });
    if (addError) return { ok: false, error: friendly(addError.message) };
    await syncCopies(s.influencer_id, { kind: "add", ...key }).catch((e) => console.error(`Copies not updated: ${(e as Error).message}`));
    await startRefresh([key]);
  }
  const { error: decideError } = await svc.from("watch_suggestions").update({ status: approve ? "approved" : "rejected", decided_at: new Date().toISOString() }).eq("id", id);
  if (decideError) return { ok: false, error: decideError.message };
  revalidate(s.influencer_id);
  revalidatePath("/admin/suggestions");
  revalidatePath("/wallet-watch/directory");
  return { ok: true };
}

/** Turns the share link off; the old link stops working at once. */
export async function unshareInfluencer(id: string): Promise<WatchActionResult> {
  const user = await requireUser();
  const db = await userDb();
  const { error } = await db.from("watch_influencers").update({ share_token: null }).eq("id", id).eq("user_id", user.id);
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
  // An address that's really a bot pays a credit per transaction (one used
  // ~577K of Helius's 1M monthly credits in hours, 2026-10-02): its last 24
  // hours are counted first (liveBudget.ts — a day, not a minute: traders
  // trade in bursts). Too busy, or unknown, isn't turned on.
  if (on) {
    for (const r of rows) {
      const day = await (r.chain === "SOL" ? solanaDayCount(r.address) : evmDayCount(r.address)).catch(() => undefined);
      if (!day) return { ok: false, error: `Couldn't check how busy ${r.address.slice(0, 6)}… is — try again in a minute.` };
      if (day.overLimit) {
        return { ok: false, error: `${r.address.slice(0, 6)}… made over ${LIVE_DAY_MAX.toLocaleString()} transactions in the last 24 hours — a bot or exchange, not a trader. Live would cost ${day.count >= LIVE_DAY_MAX ? "hundreds of thousands of" : `~${monthlyCredits(day.count).toLocaleString()}`} credits a month; left off.` };
      }
    }
  }
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
