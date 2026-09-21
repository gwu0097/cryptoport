import Link from "next/link";

const TABS = [
  { suffix: "", label: "Dashboard" },
  { suffix: "/wallets", label: "Wallets" },
  { suffix: "/assets", label: "Assets" },
] as const;

/** The one thing every /admin/[userId]/* page renders first — impossible
 * to miss that this is someone else's data, not the admin's own. Read-only
 * by construction (see adminQueries.ts/queries.ts's own opts.userId doc
 * comments) — this banner is the visual reminder, not the enforcement. */
export function AdminUserBanner({ userId, displayName, active }: { userId: string; displayName: string; active: string }) {
  return (
    <div className="mb-6 rounded-xl border border-warning/40 bg-warning/10 p-4">
      <p className="text-sm font-medium text-warning">
        Viewing {displayName} — read-only
      </p>
      <div className="mt-3 flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <Link
            key={tab.suffix}
            href={`/admin/${userId}${tab.suffix}`}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              active === tab.suffix ? "bg-warning/20 font-medium text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
