import { getUser } from "@/lib/auth";
import { readPerpScout, type ScoutScan } from "@/lib/perpScoutScan";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ScanButton } from "@/components/perpScout/ScanButton";
import { PerpScoutView } from "@/components/perpScout/PerpScoutView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Perp Scout · CryptoPort" };

const SUBTITLE = "Followed Hyperliquid traders, what they have open, and where price is against their entry";

/**
 * Perp Scout (docs/perp-scout/PLAN.md). Public market data from the last
 * scan of the followed traders (followed.ts) — one app_settings read — so
 * guests see it too; scanning needs an account.
 */
export default async function PerpScoutPage() {
  const [user, result] = await Promise.all([getUser(), readPerpScout().then((d): ScoutScan | null | Error => d, (e: Error) => e)]);
  const nowSec = requestNowSec();
  const scan = result instanceof Error ? null : result;
  return (
    <>
      <PageHeader title="Perp Scout" subtitle={SUBTITLE} actions={<ScanButton signedIn={!!user} scannedAt={scan?.scannedAt ?? null} serverNowSec={nowSec} />} />
      {result instanceof Error ? (
        <Panel>
          <p className="text-sm text-warning">Couldn&apos;t load the last scan: {result.message}</p>
        </Panel>
      ) : (
        <PerpScoutView scan={scan} signedIn={!!user} serverNowSec={nowSec} />
      )}
    </>
  );
}
