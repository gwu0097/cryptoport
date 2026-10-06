import { getUser } from "@/lib/auth";
import { readPerpScout, type PerpScoutData } from "@/lib/perpScoutScan";
import { requestNowSec } from "@/lib/requestClock";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { ScanButton } from "@/components/perpScout/ScanButton";
import { PerpScoutView } from "@/components/perpScout/PerpScoutView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Perp Scout · CryptoPort" };

const SUBTITLE = "Consistent Hyperliquid traders, what they have open, and where price is against their entry";

/**
 * Perp Scout (docs/perp-scout/PLAN.md). Public market data from the last
 * scan — one app_settings read — so guests see it too; scanning needs an
 * account.
 */
export default async function PerpScoutPage() {
  const [user, result] = await Promise.all([getUser(), readPerpScout().then((d): PerpScoutData | Error => d, (e: Error) => e)]);
  const nowSec = requestNowSec();
  const data = result instanceof Error ? null : result;
  return (
    <>
      <PageHeader
        title="Perp Scout"
        subtitle={SUBTITLE}
        actions={<ScanButton signedIn={!!user} scannedAt={data?.scan?.scannedAt ?? null} screenedAt={data?.screen?.screenedAt ?? null} serverNowSec={nowSec} />}
      />
      {data ? (
        <PerpScoutView data={data} signedIn={!!user} serverNowSec={nowSec} />
      ) : (
        <Panel>
          <p className="text-sm text-warning">Couldn&apos;t load the last scan: {(result as Error).message}</p>
        </Panel>
      )}
    </>
  );
}
