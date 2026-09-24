import { Suspense } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SignalsChart } from "@/components/smc/SignalsChart";
import { WatchlistSignalsTable } from "@/components/smc/WatchlistSignalsTable";
import { getIndicatorChart, getWatchlistSignals } from "@/lib/smc/signals";
import { fetchPerpNames } from "@/lib/smc/hyperliquid";
import { TIMEFRAMES, type ChartTimeframe } from "@/lib/smc/engine";
import { formatPrice } from "@/lib/format";
import { getWatchlists } from "@/lib/queries";
import { SignalsWatchlistFilter } from "@/components/smc/SignalsWatchlistFilter";
import { SignalTime, UntilTime } from "@/components/smc/SignalTime";
import { IndicatorSelect } from "@/components/smc/IndicatorSelect";
import { INDICATORS, indicatorById } from "@/lib/smc/indicators";
import { TriggerText } from "@/components/smc/TriggerText";
import { stateToneClass } from "@/components/smc/stateTone";
import type { IndicatorId } from "@/lib/signals/rules";

export const dynamic = "force-dynamic";
export const metadata = { title: "Signals · CryptoPort" };

const TF_OPTIONS = Object.keys(TIMEFRAMES) as ChartTimeframe[];

// loading.tsx only shows on a first visit to this route; switching token or
// timeframe only changes search params, so each section gets its own keyed
// Suspense (CLAUDE.md, Loading feedback — same fix as trend-finder/page.tsx).
function SectionFallback({ text }: { text: string }) {
  return (
    <Panel className="mb-6 flex flex-col items-center gap-3 py-12 text-center">
      <Loader2 className="size-6 animate-spin text-accent" aria-hidden="true" />
      <p className="text-sm text-fg-muted">{text}</p>
    </Panel>
  );
}

/** What has to close past a trigger: SMC decides per 3× block, the others per bar. */
const closeUnitFor = (ind: IndicatorId, tf: ChartTimeframe) => (ind === "smc" ? `${TIMEFRAMES[tf].blockLabel} block` : `${tf} bar`);

/**
 * Signals — read-only indicators computed on Hyperliquid's own candles, the
 * venue trading would eventually use: a port of the user's TradingView SMC
 * Bot Replica v4.2, plus four standard bar-close indicators (RSI(2),
 * Bollinger, MA pullback, Donchian) whose pre-registered backtest is
 * deferred. Each indicator is shown on its own; none has a measured edge.
 * Public market data — no login needed for the chart; the watchlist table
 * is per-user. No CoinGecko calls anywhere on this page.
 */
export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ coin?: string; tf?: string; list?: string; ind?: string }>;
}) {
  const params = await searchParams;
  const tf: ChartTimeframe = TF_OPTIONS.includes(params.tf as ChartTimeframe) ? (params.tf as ChartTimeframe) : "1H";
  // A Hyperliquid failure (e.g. a rate limit) must never take the page down —
  // the list only feeds the picker; the requested coin is still tried as typed.
  const [perps, watchlists] = await Promise.all([fetchPerpNames().catch(() => [] as string[]), getWatchlists()]);
  const requested = (params.coin ?? "BTC").trim();
  const coin = perps.length > 0 ? (perps.find((p) => p.toLowerCase() === requested.toLowerCase()) ?? null) : requested;
  // Never trusts ?list= blindly: a stale id (deleted list) falls back to "All".
  const selectedList = params.list ? watchlists.find((w) => w.id === params.list) : undefined;
  const listQuery = selectedList ? `&list=${encodeURIComponent(selectedList.id)}` : "";
  const indicator = indicatorById(params.ind);
  const closeUnit = closeUnitFor(indicator.id, tf);

  return (
    <>
      <PageHeader title="Signals" subtitle={`${indicator.description} Computed on Hyperliquid perps.`} />

      <Panel className="mb-4 border-warning/40">
        <p className="text-sm text-warning">{indicator.banner}</p>
      </Panel>

      <Panel className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <IndicatorSelect
            indicators={INDICATORS}
            selected={indicator.id}
            baseQuery={`coin=${encodeURIComponent(coin ?? requested)}&tf=${tf}${listQuery}`}
          />
          <form action="/signals" className="flex items-end gap-2">
            <input type="hidden" name="ind" value={indicator.id} />
            <input type="hidden" name="tf" value={tf} />
            {selectedList && <input type="hidden" name="list" value={selectedList.id} />}
            <label className="text-xs text-fg-muted">
              Hyperliquid perp
              <input
                name="coin"
                list="hl-perps"
                defaultValue={coin ?? requested}
                className="mt-1 block w-40 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg"
                autoComplete="off"
              />
            </label>
            <datalist id="hl-perps">
              {perps.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm text-fg hover:border-accent">
              Show
            </button>
          </form>
          <div className="flex gap-1">
            {TF_OPTIONS.map((t) => (
              <Link
                key={t}
                href={`/signals?ind=${indicator.id}&coin=${encodeURIComponent(coin ?? requested)}&tf=${t}${listQuery}`}
                className={`rounded-md px-3 py-1.5 text-sm ${t === tf ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:text-fg"}`}
              >
                {t}
              </Link>
            ))}
          </div>
        </div>
      </Panel>

      {coin ? (
        <Suspense key={`chart:${indicator.id}:${coin}:${tf}`} fallback={<SectionFallback text={`Loading ${coin} ${tf} candles from Hyperliquid…`} />}>
          <ChartSection ind={indicator.id} label={indicator.label} coin={coin} tf={tf} />
        </Suspense>
      ) : (
        <Panel className="mb-6 text-center">
          <p className="text-sm text-fg-muted">
            &ldquo;{requested}&rdquo; isn&rsquo;t an active Hyperliquid perp — signals are computed on the venue you&rsquo;d
            trade on, so only listed perps have one.
          </p>
        </Panel>
      )}

      <Suspense
        key={`watchlist:${indicator.id}:${tf}:${selectedList?.id ?? "all"}`}
        fallback={<SectionFallback text={`Computing ${indicator.label} ${tf} signals for your watchlist…`} />}
      >
        <WatchlistSection
          ind={indicator.id}
          label={indicator.label}
          closeUnit={closeUnit}
          tf={tf}
          listId={selectedList?.id}
          filter={
            watchlists.length > 0 ? (
              <SignalsWatchlistFilter
                watchlists={watchlists}
                selected={selectedList?.id}
                hasListParam={params.list !== undefined}
                baseQuery={`ind=${indicator.id}&coin=${encodeURIComponent(coin ?? requested)}&tf=${tf}`}
              />
            ) : null
          }
        />
      </Suspense>

      <p className="mt-4 text-xs text-fg-muted">
        {indicator.label}: computed from Hyperliquid candles on each page load. {indicator.method} Research tool, not
        financial advice.
      </p>
    </>
  );
}

async function ChartSection({ ind, label, coin, tf }: { ind: IndicatorId; label: string; coin: string; tf: ChartTimeframe }) {
  let data;
  try {
    data = await getIndicatorChart(ind, coin, tf);
  } catch (e) {
    const rateLimited = (e as Error).message.includes("429");
    return (
      <Panel className="mb-6 text-center">
        <p className="text-sm text-warning">
          {rateLimited
            ? "Hyperliquid is rate-limiting requests right now — try again in a minute."
            : `Couldn't load ${coin} candles from Hyperliquid.`}
        </p>
      </Panel>
    );
  }
  const { candles, view } = data;
  // The render's own clock, so "(x ago)" and the stale flag are in the server HTML.
  const nowSec = Math.floor(Date.parse(data.computedAt) / 1000);
  const last = candles.at(-1);
  const { state, trigger } = view;
  const lastSignal = view.signals.at(-1);
  const distance = trigger?.kind === "price" && last ? ((trigger.price - last.c) / last.c) * 100 : null;
  const title = ind === "smc" ? `${coin} · ${tf} (${TIMEFRAMES[tf].blockLabel} blocks) · ${label}` : `${coin} · ${tf} · ${label}`;

  return (
    <Panel className="mb-6" title={title}>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          State:{" "}
          {state ? (
            <span className={`font-medium ${stateToneClass(state)}`}>{state.label}</span>
          ) : (
            <span className="text-fg-muted">
              — (not enough Hyperliquid history: {view.venueBars} {ind === "smc" ? "completed blocks" : `${tf} bars`})
            </span>
          )}
        </span>
        {lastSignal && (
          <span className="text-fg-muted">
            Last signal:{" "}
            <SignalTime sec={lastSignal.time} side={lastSignal.side} barSeconds={TIMEFRAMES[tf].candleSeconds} serverNowSec={nowSec} price={formatPrice(lastSignal.price)} />
          </span>
        )}
        {trigger && (
          <span className="text-fg-muted">
            Next: <TriggerText trigger={trigger} closeUnit={view.closeUnit} />
            {view.decidedAt !== null && (
              <>
                {" "}
                (decided <UntilTime sec={view.decidedAt} serverNowSec={nowSec} />
                {last && distance !== null ? `; last ${formatPrice(last.c)}, ${distance > 0 ? "+" : ""}${distance.toFixed(1)}% away` : ""})
              </>
            )}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        Current values (last completed {ind === "smc" ? "block" : "bar"}):{" "}
        {view.readout.map((r, i) => (
          <span key={r.label}>
            {i > 0 && " · "}
            {r.label} {r.value === null ? "—" : r.label === "RSI(2)" ? r.value.toFixed(1) : r.label === "%B" ? r.value.toFixed(2) : formatPrice(r.value)}
          </span>
        ))}
      </p>
      <SignalsChart candles={candles} overlays={view.overlays} signals={view.signals} trigger={trigger} closeUnit={view.closeUnit} />
    </Panel>
  );
}

async function WatchlistSection({
  ind,
  label,
  closeUnit,
  tf,
  listId,
  filter,
}: {
  ind: IndicatorId;
  label: string;
  closeUnit: string;
  tf: ChartTimeframe;
  listId?: string;
  filter: React.ReactNode;
}) {
  const result = await getWatchlistSignals(ind, tf, listId);
  const rows = result?.rows ?? null;
  // The computation's own clock, so "(x ago)" and the stale flag are in the server HTML.
  const nowSec = result ? Math.floor(Date.parse(result.computedAt) / 1000) : 0;
  return (
    <Panel
      title={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Your watchlist · {label} · {tf}
          </span>
          {filter}
        </div>
      }
      description={`Each watchlist token's current ${label} state and what the forming ${closeUnit} has to close at for the next signal. Sorted by distance to an exact trigger by default; rows with no exact trigger sort last.`}
    >
      {rows === null ? (
        <p className="text-sm text-fg-muted">Log in and add tokens to a watchlist to see their signals here.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {listId ? "This watchlist is empty" : "Your watchlists are empty"} — add tokens on the Watchlist page.
        </p>
      ) : (
        <WatchlistSignalsTable rows={rows} ind={ind} tf={tf} serverNowSec={nowSec} closeUnit={closeUnit} listQuery={listId ? `&list=${encodeURIComponent(listId)}` : ""} />
      )}
    </Panel>
  );
}
