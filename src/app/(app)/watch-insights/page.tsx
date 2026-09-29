import { Suspense } from "react";
import { scopePricesToUser } from "@/lib/queries";
import Link from "next/link";
import { getUser } from "@/lib/auth";
import { getWatchInsights, type InsightWindow, type InfluencerCard, type WatchInsights } from "@/lib/watchInsightsQuery";
import { requestNowSec } from "@/lib/requestClock";
import { formatUsd, formatUsdSigned } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { GuestBanner } from "@/components/GuestBanner";
import { AgeText } from "@/components/AgeText";

export const dynamic = "force-dynamic";
export const metadata = { title: "Watch Insights · CryptoPort" };

const SUBTITLE = "What the wallets you watch have in common, and how their moves have worked out";
const tab = (active: boolean) =>
  "rounded-lg px-3 py-1.5 text-sm transition " + (active ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-raised hover:text-fg");
const pct = (x: number | null, digits = 0) => (x === null ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`);
const share = (x: number) => `${(x * 100).toFixed(1)}%`;

export default async function WatchInsightsPage({ searchParams }: { searchParams: Promise<{ group?: string; window?: string }> }) {
  scopePricesToUser(true); // the user's own coins and the Wallet Watch coins they see (docs/perf/PRICES_READ.md)
  if (!(await getUser())) {
    return (
      <>
        <PageHeader title="Watch Insights" subtitle={SUBTITLE} />
        <GuestBanner message="Sign up to follow wallets and see what they have in common." />
        <Panel>
          <p className="text-sm text-fg-muted">Log in and watch a few wallets on Wallet Watch to see insights here.</p>
        </Panel>
      </>
    );
  }
  const { group, window: w } = await searchParams;
  const window: InsightWindow = w === "30d" ? "30d" : "7d";
  return (
    <Suspense key={`${group ?? "all"}|${window}`} fallback={<Panel><p className="text-sm text-fg-muted">Loading…</p></Panel>}>
      <Insights groupId={group} window={window} />
    </Suspense>
  );
}

function href(group: string | undefined, window: InsightWindow) {
  const q = new URLSearchParams();
  if (group) q.set("group", group);
  if (window !== "7d") q.set("window", window);
  const s = q.toString();
  return s ? `/watch-insights?${s}` : "/watch-insights";
}

async function Insights({ groupId, window }: { groupId?: string; window: InsightWindow }) {
  const data = await getWatchInsights(groupId, window);
  const nowSec = requestNowSec();
  const gid = data.selected?.id;

  return (
    <>
      <PageHeader title="Watch Insights" subtitle={SUBTITLE} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Link href={href(undefined, window)} className={tab(!data.selected)}>
            All
          </Link>
          {data.groups.map((g) => (
            <Link key={g.id} href={href(g.id, window)} className={tab(g.id === gid)}>
              {g.name}
            </Link>
          ))}
        </div>
        <div className="flex gap-2">
          {(["7d", "30d"] as const).map((x) => (
            <Link key={x} href={href(gid, x)} className={tab(window === x)}>
              {x.toUpperCase()}
            </Link>
          ))}
        </div>
      </div>

      {data.influencerCount === 0 ? (
        <Panel>
          <p className="text-sm text-fg-muted">
            No one to compare yet — add influencers on <Link href="/wallet-watch" className="text-accent hover:underline">Wallet Watch</Link>
            {data.selected ? ` and tick "${data.selected.name}"` : ""}.
          </p>
        </Panel>
      ) : (
        <>
          <Converging data={data} nowSec={nowSec} />
          <Shared data={data} />
          <Overlap data={data} />
          <Flows data={data} />
          <Panel title="Influencers" description={`Over the last ${window === "7d" ? "7" : "30"} days, from their daily reads. Track records count only positions opened since you started watching.`} className="mb-4">
            <div className="grid gap-4 lg:grid-cols-2">
              {data.cards.map((c) => (
                <Card key={c.influencer.id} card={c} window={window} />
              ))}
            </div>
          </Panel>
          <p className="text-xs text-fg-muted">
            Observations from wallet reads, not signals or advice. Moves are the change between two reads (daily, or a Refresh), sized at that read&apos;s
            price; illiquid airdrops and unpriced coins aren&apos;t counted.
          </p>
        </>
      )}
    </>
  );
}

function Empty({ data }: { data: WatchInsights }) {
  return (
    <p className="text-sm text-fg-muted">
      {data.movementsSince
        ? `Nothing yet in this window. Moves are on record since ${data.movementsSince.slice(0, 10)}.`
        : "No moves on record yet — they start with each wallet's second daily read, so this fills in over the coming days."}
    </p>
  );
}

function Converging({ data, nowSec }: { data: WatchInsights; nowSec: number }) {
  return (
    <Panel
      title="Bought by several"
      description={`Coins at least two of ${data.selected ? `"${data.selected.name}"` : "your influencers"} bought or added in this window — ranked by how many, then by net dollars.`}
      className="mb-4"
    >
      {data.converging.length === 0 ? (
        <Empty data={data} />
      ) : (
        <ul className="divide-y divide-border/60">
          {data.converging.map((c) => (
            <li key={c.assetKey} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
              <span>
                <span className="font-semibold text-fg">{c.ticker}</span>{" "}
                <span className="text-positive">{c.buyers.length} buyers</span>
                {c.sellers.length > 0 && <span className="text-negative"> · {c.sellers.length} selling</span>}
                <span className="ml-2 text-xs text-fg-muted">
                  {c.names.join(", ")} · first <AgeText at={c.firstBuyAt} serverNowSec={nowSec} />
                </span>
                {c.otherGroups.length > 0 && <span className="ml-2 text-xs text-accent">also in {c.otherGroups.join(", ")}</span>}
              </span>
              <span className="tabular-nums text-positive">{formatUsdSigned(c.netUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Shared({ data }: { data: WatchInsights }) {
  return (
    <Panel
      title="Held by several right now"
      description="Coins at least two of them hold today, each with at least 0.5% of their wallet in it. Conviction = the average share of their own wallets."
      className="mb-4"
    >
      {data.shared.length === 0 ? (
        <p className="text-sm text-fg-muted">No coin is held by two or more of them right now.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {data.shared.map((s) => (
            <li key={s.assetKey} className="py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span>
                  <span className="font-semibold text-fg">{s.ticker}</span> <span className="text-fg-muted">· {s.holders.length} hold it · conviction {share(s.avgShare)}</span>
                  {s.otherGroups.length > 0 && <span className="ml-2 text-xs text-accent">also in {s.otherGroups.join(", ")}</span>}
                </span>
                <span className="tabular-nums text-fg">{formatUsd(s.totalUsd)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-fg-muted">
                {s.holders.map((h) => (
                  <span key={h.influencerId}>
                    {h.name} {formatUsd(h.usd)} ({share(h.share)})
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Overlap({ data }: { data: WatchInsights }) {
  if (data.overlap.length === 0) return null;
  return (
    <Panel title="Your coins they moved" description="Coins in your portfolio that they bought or sold in this window." className="mb-4">
      <ul className="divide-y divide-border/60">
        {data.overlap.map((o) => (
          <li key={o.ticker} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm">
            <span>
              <span className="font-semibold text-fg">{o.ticker}</span> <span className="text-xs text-fg-muted">you hold {formatUsd(o.mineUsd)}</span>
              {o.buyers.length > 0 && <span className="ml-2 text-xs text-positive">added: {o.buyers.join(", ")}</span>}
              {o.sellers.length > 0 && <span className="ml-2 text-xs text-negative">trimmed: {o.sellers.join(", ")}</span>}
            </span>
            <span className={`tabular-nums ${o.netUsd >= 0 ? "text-positive" : "text-negative"}`}>{formatUsdSigned(o.netUsd)}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Flows({ data }: { data: WatchInsights }) {
  const top = [...data.flows].sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd)).slice(0, 12);
  return (
    <Panel title="Net flows" description="Where their money went in this window: dollars bought minus sold, per coin." className="mb-4">
      {top.length === 0 ? (
        <Empty data={data} />
      ) : (
        <ul className="divide-y divide-border/60">
          {top.map((f) => (
            <li key={f.assetKey} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm">
              <span>
                <span className="font-semibold text-fg">{f.ticker}</span>
                <span className="ml-2 text-xs text-fg-muted">
                  {f.buyers.length} buying · {f.sellers.length} selling
                </span>
              </span>
              <span className={`tabular-nums ${f.netUsd >= 0 ? "text-positive" : "text-negative"}`}>{formatUsdSigned(f.netUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Card({ card: c, window }: { card: InfluencerCard; window: InsightWindow }) {
  const r = c.record;
  const cashTrend = c.cashShare !== null && c.cashShareBefore !== null ? c.cashShare - c.cashShareBefore : null;
  return (
    <div className="rounded-lg border border-border bg-surface-raised/40 p-4 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <Link href={`/wallet-watch/${c.influencer.id}`} className="font-semibold text-fg hover:underline">
          {c.influencer.name}
        </Link>
        <span className="tabular-nums text-fg">{c.influencer.valueUsd === null ? "—" : formatUsd(c.influencer.valueUsd)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-fg-muted">Value, {window}</dt>
        <dd className={`text-right tabular-nums ${c.valueChangePct === null ? "text-fg-muted" : c.valueChangePct >= 0 ? "text-positive" : "text-negative"}`}>{pct(c.valueChangePct, 1)}</dd>
        <dt className="text-fg-muted" title="Coins that held within 2% of $1 — a wallet moving into cash is a risk-off tell">
          Cash-like
        </dt>
        <dd className="text-right tabular-nums">
          {c.cashShare === null ? "—" : share(c.cashShare)}
          {cashTrend !== null && Math.abs(cashTrend) >= 0.005 && <span className={cashTrend > 0 ? "text-warning" : "text-fg-muted"}> ({cashTrend > 0 ? "+" : ""}{(cashTrend * 100).toFixed(1)} pts)</span>}
        </dd>
        <dt className="text-fg-muted">Moves, {window}</dt>
        <dd className="text-right tabular-nums">
          <span className="text-positive">{c.moves.buys} buys {c.moves.boughtUsd > 0 && formatUsd(c.moves.boughtUsd)}</span> ·{" "}
          <span className="text-negative">{c.moves.sells} sells {c.moves.soldUsd < 0 && formatUsd(-c.moves.soldUsd)}</span>
        </dd>
        <dt className="text-fg-muted">Closed calls</dt>
        <dd className="text-right tabular-nums">{r.closed === 0 ? "none yet" : `${r.closed} · ${r.winRate === null ? "—" : share(r.winRate)} won`}</dd>
        <dt className="text-fg-muted">Median hold</dt>
        <dd className="text-right tabular-nums">{r.medianHoldDays === null ? "—" : `${r.medianHoldDays.toFixed(1)} days`}</dd>
        <dt className="text-fg-muted">Avg closed return</dt>
        <dd className="text-right tabular-nums">{pct(r.avgClosedReturn, 1)}</dd>
        {r.best && (
          <>
            <dt className="text-fg-muted">Best / worst call</dt>
            <dd className="text-right tabular-nums">
              <span className="text-positive">
                {r.best.ticker} {pct(r.best.returnPct)}
              </span>
              {r.worst && r.worst !== r.best && (
                <span className="text-negative">
                  {" "}
                  · {r.worst.ticker} {pct(r.worst.returnPct)}
                </span>
              )}
            </dd>
          </>
        )}
      </dl>
      {c.entries.length > 0 && (
        <div className="mt-3 text-xs">
          <p className="text-fg-muted" title="How far the coin had run in the 30 days before they bought, and since">
            Early or late (30 days before entry → since)
          </p>
          <ul className="mt-1 space-y-0.5">
            {c.entries.slice(0, 5).map((e) => (
              <li key={`${e.ticker}-${e.openedAt}`} className="flex justify-between tabular-nums">
                <span>{e.ticker}</span>
                <span>
                  {pct(e.before30d)} → {pct(e.since)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.openPerps.length > 0 && (
        <div className="mt-3 text-xs">
          <p className="text-fg-muted">Open perps</p>
          <ul className="mt-1 space-y-0.5">
            {c.openPerps.map((p) => (
              <li key={`${p.ticker}-${p.side}`} className="flex justify-between tabular-nums">
                <span className={p.side === "long" ? "text-positive" : "text-negative"}>
                  {p.ticker} {p.side}
                  {p.leverage !== null && ` ${p.leverage}x`}
                </span>
                <span className="text-fg-muted">
                  {p.sizeUsd === null ? "—" : formatUsd(p.sizeUsd)}
                  {p.liquidation !== null && ` · liq ${formatUsd(p.liquidation)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
