import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { userAuth } from "./supabase";

/** The signed-in user, from the session's verified token: its id, email and
 * the metadata set at sign-up (walletDisplay.ts). */
export interface SessionUser {
  id: string;
  email?: string;
  user_metadata: { wallet_address?: string; wallet_chain?: string; [key: string]: unknown };
}

/**
 * The signed-in user, or null. Uses auth.getClaims(), which verifies the
 * session token's signature locally against the project's published signing
 * key (asymmetric JWT keys; the key set is fetched once and cached
 * process-wide for 10 minutes by auth-js) — a tampered or expired token is
 * still rejected, as with getUser(), without a request to Supabase Auth on
 * every page load. getUser() made one per call, and with proxy.ts doing the
 * same on every request (link prefetches and API routes included) it was ~60%
 * of the project's log volume (DECISIONS: 2026-09-26 Supabase log ingestion).
 * Never getSession() for a decision: it doesn't verify the token. Cached
 * per request via React's cache().
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await userAuth();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const { sub, email, user_metadata } = data.claims;
  return { id: sub, email: typeof email === "string" ? email : undefined, user_metadata: (user_metadata as SessionUser["user_metadata"]) ?? {} };
});

/**
 * Every Server Action/query that touches owned data (wallets, holdings,
 * tags) calls this first — defense in depth alongside RLS, not instead of
 * it: RLS is what actually stops a cross-tenant read/write even if this
 * check were somehow skipped, but failing fast here gives a clean
 * redirect instead of an empty result or a Postgres permission error.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}
