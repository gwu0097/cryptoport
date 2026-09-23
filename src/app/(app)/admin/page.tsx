import Link from "next/link";
import { requireAdmin } from "@/lib/adminAuth";
import { listAdminUsers } from "@/lib/adminQueries";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { formatUsd, formatStaleness } from "@/lib/format";
import { getEffectiveTimeZone } from "@/lib/preferences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · CryptoPort" };

/**
 * Who's using cryptoport — the entry point into the read-only admin view
 * (see src/lib/adminAuth.ts's requireAdmin, called first, no exceptions,
 * and the plan this feature shipped from). Click a row to see that user's
 * Dashboard/Wallets/Assets, read-only.
 */
export default async function AdminPage() {
  await requireAdmin();
  const users = await listAdminUsers();
  // A signup DATE in the viewer's own timezone — this renders on the server, where a bare toLocaleDateString() meant UTC.
  const { tz } = await getEffectiveTimeZone();
  const signupDate = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });

  return (
    <>
      <PageHeader title="Admin" subtitle="Who's using cryptoport, and a read-only peek at what they see." />

      {users.length === 0 ? (
        <Panel className="text-center">
          <p className="text-sm text-fg-muted">No registered users yet.</p>
        </Panel>
      ) : (
        <Panel padding={false} className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>User</th>
                  <th className={`${thClass} ${hideOnMobileClass}`}>Signed up</th>
                  <th className={`${thClass} ${hideOnMobileClass}`}>Last active</th>
                  <th className={thClass}>Wallets</th>
                  <th className={thClass}>Value</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={trClass}>
                    <td className={tdClass}>
                      <Link href={`/admin/${u.id}`} className="font-medium text-fg hover:text-accent">
                        {u.displayName}
                      </Link>
                    </td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>
                      {signupDate.format(new Date(u.createdAt))}
                    </td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>
                      {u.lastActiveAt ? formatStaleness(u.lastActiveAt) : "Never active"}
                    </td>
                    <td className={`${tdClass} text-fg-muted`}>{u.walletCount}</td>
                    <td className={`${tdClass} tabular-nums`}>{u.totalUsd > 0 ? formatUsd(u.totalUsd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
