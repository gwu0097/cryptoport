import Link from "next/link";
import { requireAdmin } from "@/lib/adminAuth";
import { getSuggestionQueue } from "@/lib/suggestionsQuery";
import { Panel } from "@/components/ui/Panel";
import { SuggestionReview } from "@/components/admin/SuggestionReview";
import { lookupPath } from "@/components/walletWatch/InfluencerSections";
import { tableClass, theadRowClass, thClass, trClass, tdClass } from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suggestions · Owner's console" };

/** Wallets users suggested for KOL directory entries (docs/wallet-watch/
 * DIRECTORY.md, phase 2): pending first, each with its evidence check and
 * approve / reject; then the last decided. */
export default async function SuggestionsPage() {
  await requireAdmin();
  const queue = await getSuggestionQueue();
  const pending = queue.filter((s) => s.status === "pending");
  const decided = queue.filter((s) => s.status !== "pending");
  return (
    <>
      <Panel
        title={`Waiting for review (${pending.length})`}
        description="Approve a wallet only with evidence: money moving both ways with the KOL's known wallets, their own post, or an explorer label. Approving adds it to the KOL and to every copy that follows it."
      >
        {pending.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing to review.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr className={theadRowClass}>
                  <th className={thClass}>KOL</th>
                  <th className={thClass}>Suggested wallet</th>
                  <th className={thClass}>From</th>
                  <th className={thClass}>Evidence and decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((s) => (
                  <tr key={s.id} className={`${trClass} align-top`}>
                    <td className={tdClass}>
                      <Link href={`/wallet-watch/${s.influencerId}`} className="font-medium text-fg hover:underline">
                        {s.influencerName}
                      </Link>
                      <span className="block text-xs text-fg-muted">{s.knownAddresses} known wallet{s.knownAddresses === 1 ? "" : "s"}</span>
                    </td>
                    <td className={tdClass}>
                      <span className="text-xs text-fg-muted">{s.chain}</span>{" "}
                      <Link href={lookupPath(s.address)} target="_blank" className="break-all font-mono text-xs text-fg hover:underline">
                        {s.address}
                      </Link>
                    </td>
                    <td className={`${tdClass} text-xs`}>
                      <span className="text-fg">{s.suggestedBy}</span>
                      {s.reason && <span className="block text-fg-muted">“{s.reason}”</span>}
                      {s.sourceLink && (
                        <a href={s.sourceLink} target="_blank" rel="noreferrer nofollow" className="block break-all text-accent hover:underline">
                          {s.sourceLink}
                        </a>
                      )}
                    </td>
                    <td className={tdClass}>
                      <SuggestionReview id={s.id} pending evidence={s.evidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {decided.length > 0 && (
        <Panel title="Decided recently">
          <ul className="space-y-1 text-xs">
            {decided.map((s) => (
              <li key={s.id} className="flex flex-wrap gap-x-2">
                <span className={s.status === "approved" ? "text-positive" : "text-negative"}>{s.status}</span>
                <span className="text-fg">{s.influencerName}</span>
                <span className="break-all font-mono text-fg-muted">{s.address}</span>
                <span className="text-fg-muted">by {s.suggestedBy}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
