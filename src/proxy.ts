import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// This is a Next.js "proxy" file — the successor to middleware.ts, renamed
// in Next 16 (middleware.ts still works but is deprecated). Proxy now
// defaults to the Node.js runtime rather than Edge (setting `runtime` in
// config here throws), but this still avoids Node-only APIs in favor of
// Web-standard ones (TextEncoder, atob) so it stays portable either way.

export const config = {
  // Protects everything — pages, API routes, and Server Functions (which
  // are POSTs to the page that defines them, not separate routes) — except
  // Next's own static/image assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const length = Math.max(aBytes.length, bBytes.length);

  // XOR every byte position regardless of where a mismatch occurs, and fold
  // the length difference into the same accumulator, so nothing here
  // branches or returns early based on *where* the comparison failed.
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="cryptoport"' },
  });
}

export function proxy(request: NextRequest): NextResponse {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;

  // Fail closed: a missing or empty secret must never mean "let everyone
  // in" — that's the classic way this kind of gate ends up deployed wide
  // open.
  if (!user || !password) {
    return unauthorized();
  }

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

  // Compared as one combined string so both fields are checked in a single
  // constant-time pass, rather than two comparisons that could vary in
  // timing between a wrong username and a wrong password.
  const suppliedCombined = `${suppliedUser}:${suppliedPassword}`;
  const expectedCombined = `${user}:${password}`;

  if (!timingSafeEqual(suppliedCombined, expectedCombined)) {
    return unauthorized();
  }

  return NextResponse.next();
}
