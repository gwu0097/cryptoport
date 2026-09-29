import Link from "next/link";
import { Eye } from "lucide-react";
import { getUser } from "@/lib/auth";
import { getDirectory } from "@/lib/watchQuery";
import { formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SignInPrompt } from "@/components/SignInPrompt";
import { AddSharedButton } from "@/components/walletWatch/AddSharedButton";
import { tableClass, theadRowClass, thClass, trClass, tdClass, hideOnMobileClass } from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const metadata = { title: "KOL directory · CryptoPort" };

const SUBTITLE = "Known traders and their wallets, kept up to date in one place — add one and it follows the list";

/**
 * The KOL directory (docs/wallet-watch/DIRECTORY.md): the owner's curated
 * influencers. Adding one makes a copy in the viewer's Wallet Watch that
 * follows this entry's addresses; their groups and notes stay their own,
 * and anyone can keep their own influencers outside the directory.
 */
export default async function DirectoryPage() {
  if (!(await getUser())) return <SignInPrompt message="Log in to browse the KOL directory." />;
  const entries = await getDirectory();
  return (
    <>
      <PageHeader title="KOL directory" subtitle={SUBTITLE} />
      <Panel description="Wallets are added by CryptoPort after checking them. Adding a KOL puts it in your Wallet Watch; wallets added or removed here change in yours too, until you choose Stop following on its page.">
        {entries.length === 0 ? (
          <p className="text-sm text-fg-muted">No KOLs in the directory yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>KOL</th>
                  <th className={thClass}>Wallets</th>
                  <th className={thClass}>Value</th>
                  <th className={`${thClass} ${hideOnMobileClass}`}>Top holdings</th>
                  <th className={`${thClass} text-right`} />
                </tr>
              </thead>
              <tbody>
                {entries.map(({ influencer: i, mineId, own }) => (
                  <tr key={i.id} className={trClass}>
                    <td className={tdClass}>
                      <Link href={`/wallet-watch/shared/${i.shareToken}`} className="font-medium text-fg hover:underline">
                        {i.name}
                      </Link>
                      {i.link && (
                        <a href={i.link} target="_blank" rel="noreferrer" className="block text-xs text-fg-muted hover:underline">
                          {i.link.replace(/^https?:\/\/(www\.)?/, "")}
                        </a>
                      )}
                    </td>
                    <td className={`${tdClass} text-fg-muted`}>
                      {i.addresses.length} · {[...new Set(i.addresses.map((a) => a.chain))].join(", ")}
                    </td>
                    <td className={`${tdClass} tabular-nums`}>{i.valueUsd !== null ? formatUsd(i.valueUsd) : "—"}</td>
                    <td className={`${tdClass} ${hideOnMobileClass} text-xs text-fg-muted`}>{i.topHoldings.slice(0, 3).map((h) => h.ticker).join(", ") || "—"}</td>
                    <td className={`${tdClass} text-right`}>
                      {own ? (
                        <Link href={`/wallet-watch/${i.id}`} className="text-sm text-accent hover:underline">
                          Yours — edit
                        </Link>
                      ) : mineId ? (
                        <Link href={`/wallet-watch/${mineId}`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
                          <Eye className="size-3.5" aria-hidden="true" /> In your Wallet Watch
                        </Link>
                      ) : (
                        i.shareToken && <AddSharedButton token={i.shareToken} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
