import "server-only";
import { after } from "next/server";
import { serviceDb } from "./supabase";

// Calls per day to a metered API, by feature (Owner's console → API list):
// which part of the app spends CoinGecko's 10,000 a month (2026-09-29: the
// backup key used ~525 a day and only the price refresh logged its calls).
// Counted in memory and written once per request, after the response (one
// Supabase request however many calls it made); counts from an instance
// that dies before writing are lost — an undercount, never a double one.

const pending = new Map<string, number>();
let scheduled = false;

export function countApiCall(service: string, feature: string): void {
  const k = `${service}|${feature}`;
  pending.set(k, (pending.get(k) ?? 0) + 1);
  if (scheduled) return;
  scheduled = true;
  try {
    after(flushApiCalls); // inside a request or cron: after its response
  } catch {
    setTimeout(() => void flushApiCalls(), 5_000); // a script: a few seconds later
  }
}

export async function flushApiCalls(): Promise<void> {
  scheduled = false;
  if (pending.size === 0) return;
  const rows = [...pending].map(([k, calls]) => {
    const [service, feature] = k.split("|");
    return { service, feature, calls };
  });
  pending.clear();
  const { error } = await serviceDb().rpc("add_api_calls", { p_day: new Date().toISOString().slice(0, 10), p_rows: rows });
  if (error) console.error(`API call counts not saved: ${error.message}`);
}

/** The last `days` days' counts for a service, by feature. */
export async function getApiCallCounts(service: string, days: number): Promise<{ feature: string; calls: number; byDay: Record<string, number> }[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await serviceDb().from("api_call_counts").select("day, feature, calls").eq("service", service).gte("day", since);
  if (error) throw new Error(`Failed to load API call counts: ${error.message}`);
  const by = new Map<string, { feature: string; calls: number; byDay: Record<string, number> }>();
  for (const r of data as { day: string; feature: string; calls: number }[]) {
    const f = by.get(r.feature) ?? { feature: r.feature, calls: 0, byDay: {} };
    f.calls += r.calls;
    f.byDay[r.day] = (f.byDay[r.day] ?? 0) + r.calls;
    by.set(r.feature, f);
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls);
}
