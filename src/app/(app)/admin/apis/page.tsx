import { requireAdmin } from "@/lib/adminAuth";
import { API_SERVICES, TIER_LABEL, UNLISTED_HOSTS, type ApiService, type ApiTier } from "@/lib/apiRegistry";
import { Panel } from "@/components/ui/Panel";
import { getApiCallCounts } from "@/lib/apiUsage";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";

export const metadata = { title: "API list · Owner's console · CryptoPort" };

const TIER_TONE: Record<ApiTier, string> = {
  "free-no-signup": "bg-surface-raised text-fg-muted",
  "free-signup": "bg-accent/15 text-accent",
  paid: "bg-warning/15 text-warning",
};
const CATEGORIES: ApiService["category"][] = ["Infrastructure", "Prices & market data", "Blockchain data", "Research & AI"];

/**
 * Every service that could need an upgrade as users grow (apiRegistry.ts):
 * its tier, plan, limits and what breaks first — for the day this becomes a
 * product. apiRegistry.test.ts keeps it complete: a new external host fails
 * the tests until it's listed here or named as not needing to be.
 */
export default async function ApiListPage() {
  await requireAdmin();
  const count = (t: ApiTier) => API_SERVICES.filter((s) => s.tier === t).length;
  const unconfirmed = API_SERVICES.filter((s) => s.unconfirmed);
  const coingecko = await getApiCallCounts("coingecko", 7);
  const total = coingecko.reduce((n, f) => n + f.calls, 0);
  const days = [...new Set(coingecko.flatMap((f) => Object.keys(f.byDay)))].sort();

  return (
    <>
      <p className="mb-4 text-sm text-fg-muted">Services that could need an upgrade as users grow — what we use, on which plan, and what breaks first.</p>
      <Panel
        className="mb-4"
        title="CoinGecko calls, last 7 days"
        description="What spends the free plan's 10,000 calls a month, by feature (counted since 2026-09-29; calls from a server instance that stopped before saving are missed)."
      >
        {coingecko.length === 0 ? (
          <p className="text-sm text-fg-muted">No calls counted yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>Feature</th>
                  <th className={`${thClass} text-right`}>Calls</th>
                  {days.map((d) => (
                    <th key={d} className={`${thClass} text-right`}>
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {coingecko.map((f) => (
                  <tr key={f.feature} className={trClass}>
                    <td className={tdClass}>{f.feature}</td>
                    <td className={`${tdClass} text-right tabular-nums`}>{f.calls.toLocaleString()}</td>
                    {days.map((d) => (
                      <td key={d} className={`${tdClass} text-right tabular-nums text-fg-muted`}>
                        {f.byDay[d] ?? "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-fg-muted">{total.toLocaleString()} in all — {Math.round((total / Math.max(1, days.length)) * 30).toLocaleString()} a month at this pace.</p>
          </div>
        )}
      </Panel>
      <Panel className="mb-4">
        <p className="text-sm text-fg">
          {API_SERVICES.length} services: {count("paid")} paid, {count("free-signup")} free with sign-up, {count("free-no-signup")} free without sign-up.
        </p>
        {unconfirmed.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-warning">
            {unconfirmed.map((s) => (
              <li key={s.name}>
                To confirm — {s.name}: {s.unconfirmed}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {CATEGORIES.map((category) => {
        const services = API_SERVICES.filter((s) => s.category === category);
        if (services.length === 0) return null;
        return (
          <Panel key={category} title={category} className="mb-4">
            <ul className="mt-2 divide-y divide-border/60">
              {services.map((s) => (
                <li key={s.name} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">{s.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${TIER_TONE[s.tier]}`}>{TIER_LABEL[s.tier]}</span>
                    <span className="text-xs text-fg-muted">{s.plan}</span>
                  </div>
                  <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
                    <dt className="text-fg-muted">Used for</dt>
                    <dd className="text-fg">{s.usedFor}</dd>
                    <dt className="text-fg-muted">Limits</dt>
                    <dd className="text-fg">{s.limits}</dd>
                    <dt className="text-fg-muted">As users grow</dt>
                    <dd className="text-fg">{s.scaling}</dd>
                    <dt className="text-fg-muted">Keys · code</dt>
                    <dd className="break-words text-xs text-fg-muted">
                      {s.env.length > 0 ? s.env.join(", ") : "no key"} · {s.code}
                    </dd>
                  </dl>
                </li>
              ))}
            </ul>
          </Panel>
        );
      })}

      <Panel title="Not listed, and why" description="Called or linked by the app, but free and not something to upgrade." className="mb-4">
        <ul className="mt-2 space-y-2 text-sm">
          {UNLISTED_HOSTS.map((u) => (
            <li key={u.reason}>
              <details>
                <summary className="cursor-pointer text-fg">
                  {u.reason} <span className="text-fg-muted">({u.hosts.length})</span>
                </summary>
                <p className="mt-1 break-words text-xs text-fg-muted">{u.hosts.join(", ")}</p>
              </details>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
