import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Every page in (app)/ is force-dynamic (personalized, per-user data).
    // The client Router Cache's "dynamic" bucket — what a repeat visit to
    // a force-dynamic page reuses — defaults to 0 seconds as of Next
    // 15+, meaning every single click back to a page you were just on
    // re-fetches from scratch, even a few seconds later. Bumped to 60s so
    // "click Portfolio, click Dashboard, click Portfolio again" shows the
    // already-rendered page instantly instead of re-running every query.
    // Safe for this app's per-user financial data specifically because
    // every mutating Server Action already calls revalidatePath, which —
    // per Next's own current documented behavior — invalidates the
    // client cache for every previously-visited page, not just the one
    // path passed in; a real balance/holdings change is never masked by
    // this window. See CLAUDE.md's Caching section for the fuller note.
    staleTimes: {
      dynamic: 60,
    },
  },
};

export default nextConfig;
