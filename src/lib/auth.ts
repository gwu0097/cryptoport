import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { userAuth } from "./supabase";

/**
 * The signed-in user, or null. Deliberately calls auth.getUser() (which
 * re-validates the session's JWT against Supabase's Auth server) rather
 * than the cheaper auth.getSession() (which just decodes the cookie
 * without verifying it wasn't tampered with) — this is Supabase's own
 * documented recommendation for anywhere a decision is actually being
 * made server-side, not just an optimistic UI check (that's what
 * proxy.ts's cookie-presence check is for). Cached per-request via
 * React's cache() so calling this from several places in one render
 * (layout, page, a query, an action) only hits Supabase once.
 */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await userAuth();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error) return null;
  return user;
});

/**
 * Every Server Action/query that touches owned data (wallets, holdings,
 * tags) calls this first — defense in depth alongside RLS, not instead of
 * it: RLS is what actually stops a cross-tenant read/write even if this
 * check were somehow skipped, but failing fast here gives a clean
 * redirect instead of an empty result or a Postgres permission error.
 */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}
