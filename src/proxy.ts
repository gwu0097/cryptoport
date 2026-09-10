import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyLogin } from "@/lib/authCredentials";

// This is a Next.js "proxy" file — the successor to middleware.ts, renamed
// in Next 16 (middleware.ts still works but is deprecated). Proxy now
// defaults to the Node.js runtime rather than Edge, which is what makes it
// safe to call the database below (Edge Middleware historically couldn't).

export const config = {
  // Protects everything — pages, API routes, and Server Functions (which
  // are POSTs to the page that defines them, not separate routes) — except
  // Next's own static/image assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="cryptoport"' },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const authHeader = (request.headers.get("authorization") ?? "").trim();
  const spaceIndex = authHeader.indexOf(" ");
  const scheme = spaceIndex === -1 ? authHeader : authHeader.slice(0, spaceIndex);
  const encoded = spaceIndex === -1 ? "" : authHeader.slice(spaceIndex + 1).trim();

  if (scheme.toLowerCase() !== "basic" || !encoded) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return unauthorized();
  }

  const separatorIndex = decoded.indexOf(":");
  const suppliedUser = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
  const suppliedPassword = separatorIndex === -1 ? "" : decoded.slice(separatorIndex + 1);

  // The login lives in cryptoport.app_credentials (see authCredentials.ts) so
  // it can be changed from /settings without an env var edit + redeploy.
  // Fail closed: any lookup error denies the request, same as a wrong
  // password — never falls open.
  let ok: boolean;
  try {
    ok = await verifyLogin(suppliedUser, suppliedPassword);
  } catch {
    ok = false;
  }
  if (!ok) {
    return unauthorized();
  }

  return NextResponse.next();
}
