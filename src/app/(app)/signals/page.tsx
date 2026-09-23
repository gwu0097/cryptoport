import { Suspense } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SmcChart } from "@/components/smc/SmcChart";
import { WatchlistSignalsTable } from "@/components/smc/WatchlistSignalsTable";
import { getSmcChart, getWatchlistSignals } from "@/lib/smc/signals";
import { fetchPerpNames } from "@/lib/smc/hyperliquid";
import { TIMEFRAMES, type ChartTimeframe } from "@/lib/smc/engine";
import { formatPrice } from "@/lib/format";
import { getWatchlists } from "@/lib/queries";
import { SignalsWatchlistFilter } from "@/components/smc/SignalsWatchlistFilter";
import { SignalTime, UntilTime } from "@/components/smc/SignalTime";
import { IndicatorSelect } from "@/components/smc/IndicatorSelect";
import { INDICATORS, DEFAULT_INDICATOR } from "@/lib/smc/indicators";

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

/**
 * SMC signals — a read-only port of the user's TradingView indicator (SMC Bot
 * Replica v4.2) computed on Hyperliquid's own candles, the venue trading
 * would eventually use (BACKLOG: "SMC signal engine"; trading is a later,
 * separately planned phase). Public market data — no login needed for the
 * chart; the watchlist table is per-user.
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
  const indicator = INDICATORS.find((i) => i.id === params.ind) ?? DEFAULT_INDICATOR;

  return (
    <>
      <PageHeader title="Signals" subtitle={`${indicator.description} Computed on Hyperliquid perps.`} />

      <Panel className="mb-4 border-warning/40">
        <p className="text-sm text-warning">
          Visual reference only — not a trading strategy or a recommendation. Figures from an external backtest
          (methodology unrecorded); not reproduced in this app: profit factor 0.88 on BTC at 6bps round trip, and a
          random-entry control beat it in 41% of trials. Never validated on any other token.
        </p>
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
        <Suspense key={`chart:${coin}:${tf}`} fallback={<SectionFallback text={`Loading ${coin} ${tf} candles from Hyperliquid…`} />}>
          <ChartSection coin={coin} tf={tf} />
        </Suspense>
      ) : (
        <Panel className="mb-6 text-center">
          <p className="text-sm text-fg-muted">
            &ldquo;{requested}&rdquo; isn&rsquo;t an active Hyperliquid perp — signals are computed on the venue you&rsquo;d
            trade on, so only listed perps have one.
          </p>
        </Panel>
      )}

      <Suspense key={`watchlist:${tf}:${selectedList?.id ?? "all"}`} fallback={<SectionFallback text={`Computing ${tf} signals for your watchlist…`} />}>
        <WatchlistSection
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
        Computed from Hyperliquid candles on each page load. Blocks are epoch-aligned ({TIMEFRAMES[tf].blockLabel} for{" "}
        {tf}); only completed blocks count, and the ribbon shows the last completed block (Delay = 1), so a printed
        signal never moves. The trigger price is exact: the forming block&rsquo;s close alone decides the next state.
        Research tool, not financial advice.
      </p>
    </>
  );
}

async function ChartSection({ coin, tf }: { coin: string; tf: ChartTimeframe }) {
  let data;
  try {
    data = await getSmcChart(coin, tf);
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
  const { candles, result } = data;
  const last = candles.at(-1);
  const { state, trigger } = result;
  const distance = trigger && last ? ((trigger.price - last.c) / last.c) * 100 : null;
  const blockLabel = TIMEFRAMES[tf].blockLabel;

  return (
    <Panel className="mb-6" title={`${coin} · ${tf} (${blockLabel} blocks)`}>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          State:{" "}
          {state ? (
            <span className={state.bull ? "font-medium text-positive" : "font-medium text-negative"}>{state.bull ? "Bull" : "Bear"}</span>
          ) : (
            <span className="text-fg-muted">— (not enough completed blocks)</span>
          )}
        </span>
        {state?.lastFlip && (
          <span className="text-fg-muted">
            Last signal:{" "}
            <SignalTime
              sec={state.lastFlip.time}
              side={state.lastFlip.side}
              barSeconds={TIMEFRAMES[tf].candleSeconds}
              price={formatPrice(state.lastFlip.price)}
            />
          </span>
        )}
        {trigger && (
          <span className="text-fg-muted">
            Next:{" "}
            <span className={trigger.flipTo === "BUY" ? "text-positive" : "text-negative"}>
              {trigger.flipTo === "BUY" ? "Buy" : "Sell"} if this {blockLabel} block closes {trigger.flipIfClose}{" "}
              {formatPrice(trigger.price)}
            </span>{" "}
            (decided <UntilTime sec={trigger.formingBlockEnd} />
            {last && distance !== null ? `; last ${formatPrice(last.c)}, ${distance > 0 ? "+" : ""}${distance.toFixed(1)}% away` : ""})
          </span>
        )}
      </div>
      <SmcChart candles={candles} ribbon={result.ribbon} flips={result.flips} trigger={trigger} blockLabel={blockLabel} />
    </Panel>
  );
}

async function WatchlistSection({ tf, listId, filter }: { tf: ChartTimeframe; listId?: string; filter: React.ReactNode }) {
  const rows = await getWatchlistSignals(tf, listId);
  return (
    <Panel
      title={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>Your watchlist · {tf}</span>
          {filter}
        </div>
      }
      description="Each watchlist token's current state and the price its forming block has to close past to flip. Sorted by distance to that trigger by default."
    >
      {rows === null ? (
        <p className="text-sm text-fg-muted">Log in and add tokens to a watchlist to see their signals here.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {listId ? "This watchlist is empty" : "Your watchlists are empty"} — add tokens on the Watchlist page.
        </p>
      ) : (
        <WatchlistSignalsTable rows={rows} tf={tf} listQuery={listId ? `&list=${encodeURIComponent(listId)}` : ""} />
      )}
    </Panel>
  );
}
