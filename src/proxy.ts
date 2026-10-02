import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAdminEmail } from "./lib/adminEmail";

// This is a Next.js "proxy" file — the successor to middleware.ts, renamed
// in Next 16 (middleware.ts still works but is deprecated). Proxy now
// defaults to the Node.js runtime rather than Edge.

export const config = {
  // Not the webhook receivers, the morning read's tick/read or the crons:
  // they check their own secret and need no session, and each delivery
  // paid a second invocation here (audit 2026-10-02).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/wallet-watch/webhook|api/wallet-watch/evm-webhook|api/wallet-watch/tick|api/wallet-watch/read|api/cron/).*)"],
};

// Every page in the app is viewable without a session — only saving
// anything requires an account, enforced by RLS + requireUser() at the
// data layer (src/lib/queries.ts, every Server Action), not by gating
// pages here. The one exception is /update-password: reaching it means
// following a password-reset email link, which mints a temporary session
// via /auth/confirm first — without that session there's nothing valid to
// update, so it stays denylisted rather than open like everything else.
const PROTECTED_PATHS = ["/update-password"];
const AUTH_LANDING_PATHS = ["/login", "/signup", "/forgot-password"];

function isPath(pathname: string, list: string[]): boolean {
  return list.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * supabase.auth.getClaims() runs unconditionally — it transparently refreshes
 * an expiring session token (through getSession) and rewrites the cookie onto
 * the response, then verifies the token locally against the project's
 * signing key rather than calling Supabase Auth on every request (auth.ts
 * getUser explains why). The refresh matters for every request regardless of whether the page itself
 * needs a session (skipping this is a well-known Supabase+Next.js gotcha
 * that silently logs users out once their access token expires, even
 * though their refresh token is still good). PROTECTED_PATHS is checked
 * only for the one page that actually needs to deny an unauthenticated
 * visitor; every other route falls through untouched.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  // The page's path and request kind, for its render's [render] log line
  // (renderMeter.ts): a full page load, or the router's fetch (a
  // navigation or refresh — Next removes its rsc header before this runs).
  const kind = request.headers.get("next-action") ? "action" : request.headers.get("sec-fetch-dest") === "document" ? "load" : "nav";
  request.headers.set("x-cp-path", `${request.nextUrl.pathname} ${kind}`);
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const user = data?.claims?.sub ? { email: typeof data.claims.email === "string" ? data.claims.email : undefined } : null;

  const path = request.nextUrl.pathname;

  if (!user && isPath(path, PROTECTED_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isPath(path, AUTH_LANDING_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/wallets";
    return NextResponse.redirect(url);
  }

  // /admin's own requireAdmin() (src/lib/adminAuth.ts) already calls
  // notFound() and is what actually keeps another user's data out of a
  // non-admin's response — verified live that it does. But live-verified
  // just as directly (checked this exact Next 16 version's own docs,
  // node_modules/next/dist/docs/.../not-found.md, not assumed from
  // training data) that once a page has started streaming its response as
  // 200, notFound() can change what renders but never the status code
  // that already went out — the docs' own fix for that is to run this
  // check in proxy instead, before any streaming starts, which is what
  // this block is. Kept in both places on purpose: this is what makes the
  // status code a real 404 (matters for anything watching status codes —
  // scanners, monitoring, search crawlers), requireAdmin() is what
  // actually guarantees no data leak if this check is ever bypassed
  // (a future matcher change, a route this doesn't cover) — same
  // "defense in depth, not instead of" relationship RLS has with
  // requireUser() elsewhere in this app.
  if (isPath(path, ["/admin"]) && !isAdminEmail(user?.email, process.env.ADMIN_EMAIL)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  return response;
}
