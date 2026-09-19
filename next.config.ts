import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Every page in (app)/ is force-dynamic (personalized, per-user data).
    // The client Router Cache's "dynamic" bucket — what a repeat visit to
    // a force-dynamic page reuses — defaults to 0 seconds as of Next 15+,
    // meaning every single click back to a page you were just on re-fetches
    // from scratch, even a few seconds later.
    //
    // Originally set to 60s specifically because that was the length of
    // time a real staleness bug could persist for: every mutating Server
    // Action calls revalidatePath, which purges the *entire* client cache
    // (still-global per Next's own current "temporary" docs) — but a
    // background job's own completion-time revalidatePath call lives
    // inside after(), which runs after that action's response has already
    // been sent, and Next attaches the client-cache-purge signal to that
    // response. So that call could never reach the browser at all — a
    // finished sync silently failed to invalidate any tab that wasn't the
    // one actively polling it, real staleness the 60s ceiling was only
    // ever a bound on, not a fix for (see JobPoller.tsx/jobActions.ts).
    //
    // Now that a job's completion reliably fires a live, reachable
    // notifyJobsComplete() call instead, every real data change purges the
    // cache on its own regardless of this window's length — nothing here
    // is covering for a gap anymore, so it can go up substantially. 30
    // minutes: long enough that normal within-session browsing basically
    // never pays a cold reload, short enough to self-correct within a
    // reasonable window if the new invalidation path ever has an edge case
    // this session didn't catch. See CLAUDE.md's Caching section.
    staleTimes: {
      dynamic: 1800,
    },
  },
};

export default nextConfig;
