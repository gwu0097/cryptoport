import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !serviceRoleKey || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY. Set them in .env.local.",
  );
}

const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

/**
 * The service_role client — bypasses RLS entirely, so it's only for
 * genuinely shared/global data with no owner (prices, token_registry,
 * chain_icons, price_refresh_state) and one-off admin scripts (see the
 * data-migration script this multi-tenant pass shipped with). Never use
 * this for wallets/holdings/tags — those are per-user and go through
 * userDb() so RLS actually applies. Renamed from the old portfolioDb()
 * now that there are two clients with different trust levels — the old
 * name no longer says which one it is.
 */
export function serviceDb() {
  return serviceClient.schema("cryptoport");
}

/**
 * A per-request client authenticated as the signed-in user (their session
 * read from cookies, via @supabase/ssr) — Postgres sees this as the
 * `authenticated` role with auth.uid() set to their real id, so RLS
 * policies on wallets/holdings/tags are enforced by Postgres itself, not
 * just by this app remembering to filter. Every wallet/holding/tag query
 * and action goes through this instead of serviceDb().
 *
 * setAll is wrapped in try/catch because a Server Component is not
 * allowed to write cookies (only Server Actions/Route Handlers/Proxy can)
 * — this is the standard @supabase/ssr pattern, safe to ignore there
 * because proxy.ts already refreshes the session cookie on every request,
 * so a Server Component never needs to write it itself.
 */
export async function userDb() {
  const cookieStore = await cookies();
  const client = createServerClient(supabaseUrl!, anonKey!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — see doc comment above.
        }
      },
    },
  });
  return client.schema("cryptoport");
}

/**
 * The service_role client's auth.admin namespace — createUser/generateLink/
 * getUserById/deleteUser, for the wallet sign-in flow (see
 * src/app/(auth)/walletActions.ts). There is no session at that point in
 * the flow, so this is the one place admin-level auth access is needed;
 * serviceClient itself stays module-private so nothing else can reach past
 * serviceDb()'s cryptoport-schema scoping by accident.
 */
export function serviceAuth() {
  return serviceClient.auth.admin;
}

/** Absolute base URL for building auth email redirect links
 * (emailRedirectTo/resetPasswordForEmail's redirectTo) — those have to be
 * a full URL, not a path, and Server Actions have no reliable notion of
 * "the current origin" the way a browser does. Set NEXT_PUBLIC_SITE_URL
 * in production (Vercel's own VERCEL_URL is the preview/deploy host, not
 * necessarily the canonical domain); falls back to localhost for dev. */
export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

/** The same per-request client, unscoped to the cryptoport schema — used
 * only for auth.* calls (supabase.auth.signIn/signUp/getUser/...), which
 * live outside any Postgres schema this app owns. */
export async function userAuth() {
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl!, anonKey!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — see userDb's doc comment.
        }
      },
    },
  });
}
