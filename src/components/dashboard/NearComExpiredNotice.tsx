import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import type { ExpiredNearCom } from "@/lib/nearComExpiryQuery";

/** "near.com sign-in expired" on the Dashboard, one line per wallet, with a
 * link to its page (where Reconnect is). Shown only while expired. */
export function NearComExpiredNotice({ expired }: { expired: ExpiredNearCom[] }) {
  if (expired.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      {expired.map((e) => (
        <div key={e.walletId} className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-warning">
            {e.name}: near.com sign-in expired{e.since ? ` on ${new Date(e.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""} — its balances aren&apos;t updating.
          </span>
          <Link href={`/wallets/${e.walletId}`} className={buttonClass("secondary", "sm")}>
            Reconnect
          </Link>
        </div>
      ))}
    </div>
  );
}
