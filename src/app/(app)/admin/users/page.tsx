import Link from "next/link";
import { AgeText } from "@/components/AgeText";
import { requestNowSec } from "@/lib/requestClock";
import { requireAdmin } from "@/lib/adminAuth";
import { listAdminUsers } from "@/lib/adminQueries";
import { Panel } from "@/components/ui/Panel";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";
import { formatUsd } from "@/lib/format";
import { getEffectiveTimeZone } from "@/lib/preferences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users · Owner's console · CryptoPort" };

/**
 * Owner's console → Users: who's using cryptoport — the entry point into the read-only view
 * (see src/lib/adminAuth.ts's requireAdmin, called first, no exceptions,
 * and the plan this feature shipped from). Click a row to see that user's
 * Dashboard/Wallets/Assets, read-only.
 */
export default async function AdminUsersPage() {
  await requireAdmin();
  const users = await listAdminUsers();
  // A signup DATE in the viewer's own timezone — this renders on the server, where a bare toLocaleDateString() meant UTC.
  const { tz } = await getEffectiveTimeZone();
  const signupDate = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });

  return (
    <>
      <p className="mb-4 text-sm text-fg-muted">Who&apos;s using cryptoport. Open anyone for a read-only view of their Dashboard, Wallets and Assets.</p>

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
                      <Link href={`/admin/users/${u.id}`} className="font-medium text-fg hover:text-accent">
                        {u.displayName}
                      </Link>
                    </td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>
                      {signupDate.format(new Date(u.createdAt))}
                    </td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-fg-muted`}>
                      {u.lastActiveAt ? <AgeText at={u.lastActiveAt} serverNowSec={requestNowSec()} /> : "Never active"}
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
