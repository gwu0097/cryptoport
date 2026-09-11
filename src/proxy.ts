import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// This is a Next.js "proxy" file — the successor to middleware.ts, renamed
// in Next 16 (middleware.ts still works but is deprecated). Proxy now
// defaults to the Node.js runtime rather than Edge.

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
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
 * supabase.auth.getUser() runs unconditionally — it transparently refreshes
 * an expiring session token and rewrites the cookie onto the response,
 * which matters for every request regardless of whether the page itself
 * needs a session (skipping this is a well-known Supabase+Next.js gotcha
 * that silently logs users out once their access token expires, even
 * though their refresh token is still good). PROTECTED_PATHS is checked
 * only for the one page that actually needs to deny an unauthenticated
 * visitor; every other route falls through untouched.
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

  return response;
}
