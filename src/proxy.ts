import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// This is a Next.js "proxy" file — the successor to middleware.ts, renamed
// in Next 16 (middleware.ts still works but is deprecated). Proxy now
// defaults to the Node.js runtime rather than Edge.

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

// Reachable without a session. /auth/confirm has to be here — it's the
// route that *creates* the session (Supabase's confirmation/reset email
// links land there). /update-password is deliberately NOT here: reaching
// it means following a password-reset email link, which itself creates a
// temporary session via /auth/confirm first, so treating it as a normal
// protected route is correct, not an oversight. /lookup is here on
// purpose too — it's read-only (see its own layout's doc comment) and
// meant to work for a signed-out visitor, same as DeBank/Rabby's address
// search.
const PUBLIC_PATHS = ["/login", "/signup", "/forgot-password", "/auth/confirm", "/lookup"];
const AUTH_LANDING_PATHS = ["/login", "/signup", "/forgot-password"];

function isPath(pathname: string, list: string[]): boolean {
  return list.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Optimistic only — a cheap cookie-based check that redirects obviously
 * unauthenticated requests before they render anything, per Next's own
 * guidance (node_modules/next/dist/docs/01-app/02-guides/authentication.md
 * — "Proxy should not be your only line of defense"). Real enforcement is
 * RLS at the data layer (see db/schema.sql, src/lib/supabase.ts's
 * userDb()) plus requireUser() in every Server Action (src/lib/auth.ts) —
 * this can't be bypassed by a client that skips Proxy some other way.
 *
 * supabase.auth.getUser() here also transparently refreshes an expiring
 * session token and rewrites the cookie onto the response — skipping this
 * is a well-known Supabase+Next.js gotcha that silently logs users out
 * once their access token expires, even though their refresh token is
 * still good.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && !isPath(path, PUBLIC_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isPath(path, AUTH_LANDING_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/wallets";
    return NextResponse.redirect(url);
  }

  return response;
}
