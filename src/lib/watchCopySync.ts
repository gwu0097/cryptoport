import "server-only";
import { serviceDb } from "./supabase";

// Shared influencers' copies follow the original's addresses (owner
// 2026-09-28; DJ's VirtualBacon, copied from a share, never got the second
// wallet the owner added later). A copy made through a share link records
// its source (`watch_influencers.copied_from`); when the source's owner adds
// or removes an address, the same change is made on every copy — while the
// source is still shared. Only the change is applied, so an address a
// copier removed stays removed, and one they added themselves stays. An
// influencer someone created themselves has no source and never changes.
// Copies of copies follow too (a copy can be shared on).

const MAX_DEPTH = 3;

export async function syncCopies(sourceId: string, change: { kind: "add" | "remove"; chain: string; address: string }, depth = 0): Promise<{ updated: number; failed: string[] }> {
  const db = serviceDb();
  // One request when nobody copied it (the usual case).
  const { data: copies, error } = await db.from("watch_influencers").select("id, user_id").eq("copied_from", sourceId);
  if (error) throw new Error(`Failed to load copies: ${error.message}`);
  if (!copies || copies.length === 0) return { updated: 0, failed: [] };
  const { data: source } = await db.from("watch_influencers").select("share_token").eq("id", sourceId).maybeSingle();
  if (!source?.share_token) return { updated: 0, failed: [] }; // unshared: copies keep what they have

  let updated = 0;
  const failed: string[] = [];
  for (const c of copies as { id: string; user_id: string }[]) {
    if (change.kind === "add") {
      // One copy at a time: a copy already at its 5-address cap fails alone.
      const { error: addError } = await db
        .from("watch_influencer_addresses")
        .upsert({ user_id: c.user_id, influencer_id: c.id, chain: change.chain, address: change.address }, { onConflict: "influencer_id,chain,address", ignoreDuplicates: true });
      if (addError) failed.push(`${c.id}: ${addError.message}`);
      else updated++;
    } else {
      const { error: removeError } = await db.from("watch_influencer_addresses").delete().eq("influencer_id", c.id).eq("chain", change.chain).eq("address", change.address);
      if (removeError) failed.push(`${c.id}: ${removeError.message}`);
      else updated++;
    }
    if (depth + 1 < MAX_DEPTH) {
      const next = await syncCopies(c.id, change, depth + 1);
      updated += next.updated;
      failed.push(...next.failed);
    }
  }
  return { updated, failed };
}
