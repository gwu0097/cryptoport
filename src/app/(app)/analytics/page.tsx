import { redirect } from "next/navigation";

// Analytics was renamed Performance (2026-09-26); old links and bookmarks,
// with their ?wallet=, land there. This route is kept for a real analytics
// page later.
export default async function AnalyticsRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of [v].flat()) if (x !== undefined) params.append(k, x);
  const qs = params.toString();
  redirect(qs ? `/performance?${qs}` : "/performance");
}
