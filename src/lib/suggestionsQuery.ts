import "server-only";
import { serviceAuth, serviceDb, userDb } from "./supabase";
import type { LinkEvidence } from "./walletLinks";

// KOL directory suggestions (docs/wallet-watch/DIRECTORY.md, phase 2).

export interface WalletSuggestion {
  id: string;
  influencerId: string;
  chain: string;
  address: string;
  reason: string | null;
  sourceLink: string | null;
  status: "pending" | "approved" | "rejected";
  evidence: LinkEvidence | null;
  createdAt: string;
  decidedAt: string | null;
}

type Row = { id: string; influencer_id: string; user_id: string; chain: string; address: string; reason: string | null; source_link: string | null; status: WalletSuggestion["status"]; evidence: LinkEvidence | null; created_at: string; decided_at: string | null };
const COLUMNS = "id, influencer_id, user_id, chain, address, reason, source_link, status, evidence, created_at, decided_at";
const toSuggestion = (r: Row): WalletSuggestion => ({ id: r.id, influencerId: r.influencer_id, chain: r.chain, address: r.address, reason: r.reason, sourceLink: r.source_link, status: r.status, evidence: r.evidence, createdAt: r.created_at, decidedAt: r.decided_at });

/** The viewer's own suggestions, newest first (RLS: their rows only). */
export async function getMySuggestions(): Promise<WalletSuggestion[]> {
  const { data, error } = await (await userDb()).from("watch_suggestions").select(COLUMNS).order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(`Failed to load your suggestions: ${error.message}`);
  return (data as Row[]).map(toSuggestion);
}

/** Owner's console (caller has called requireAdmin): every pending
 * suggestion, then the last 30 decided, with the KOL's name and who
 * suggested it. */
export async function getSuggestionQueue(): Promise<(WalletSuggestion & { influencerName: string; knownAddresses: number; suggestedBy: string })[]> {
  const db = serviceDb();
  const [pending, decided] = await Promise.all([
    db.from("watch_suggestions").select(COLUMNS).eq("status", "pending").order("created_at"),
    db.from("watch_suggestions").select(COLUMNS).neq("status", "pending").order("decided_at", { ascending: false }).limit(30),
  ]);
  for (const r of [pending, decided]) if (r.error) throw new Error(`Failed to load suggestions: ${r.error.message}`);
  const rows = [...(pending.data as Row[]), ...(decided.data as Row[])];
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.influencer_id))];
  const [{ data: infs }, { data: addrs }, { data: users }] = await Promise.all([
    db.from("watch_influencers").select("id, name").in("id", ids),
    db.from("watch_influencer_addresses").select("influencer_id").in("influencer_id", ids),
    serviceAuth().listUsers(),
  ]);
  const name = new Map(((infs ?? []) as { id: string; name: string }[]).map((i) => [i.id, i.name]));
  const known = new Map<string, number>();
  for (const a of (addrs ?? []) as { influencer_id: string }[]) known.set(a.influencer_id, (known.get(a.influencer_id) ?? 0) + 1);
  const email = new Map((users?.users ?? []).map((u) => [u.id, u.email ?? u.id.slice(0, 8)]));
  return rows.map((r) => ({ ...toSuggestion(r), influencerName: name.get(r.influencer_id) ?? "(removed)", knownAddresses: known.get(r.influencer_id) ?? 0, suggestedBy: email.get(r.user_id) ?? r.user_id.slice(0, 8) }));
}
