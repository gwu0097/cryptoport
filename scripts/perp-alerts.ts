// Perp Scout alerts (owner 2026-10-07; docs/perp-scout/PLAN.md "Alerts"):
// polls the followed traders' Hyperliquid positions every 30 s and posts
// each change to Discord — opened (pings the role), closed with its result,
// flipped, and adds/trims of ≥ 25% (pure src/lib/perpScout/alerts.ts).
// Runs on the owner's Mac mini, not Vercel (owner: no Vercel or Supabase per
// poll): state lives in a local JSON file; Supabase is read only for the
// trader list, once an hour (24 requests a day), never written.
//
//   node --env-file=.env.local --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/perp-alerts.ts [--dry-run] [--once]
//
// --dry-run prints messages instead of posting (also when
// DISCORD_PERP_WEBHOOK_URL isn't set); --once polls once and exits. The first
// read of each trader only sets its baseline. One instance at a time (a lock
// file beside the state). launchd keeps it running:
// scripts/launchd/com.cryptoport.perp-alerts.plist.
//
// Cost per poll: 2 Hyperliquid weight per trader (22 traders: 44, ~88 a
// minute of the IP's 1,200), plus per trader with a change 20–160 more (the
// fills since the last alert, the account value — kept 10 min — the TP/SL for
// an open, and once per older position its opening). Free, keyless.
// Safeguards: at most 10 messages per trader an hour (the rest counted and
// summed in one line), posts spaced 2 s (Discord allows ~30 a minute), every
// request times out after 15 s, a failed read keeps the trader's last book
// (no false "closed").

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addPrice, alertMessage, closeResult, diffBook, takeBudget, type AlertMessage, type Book, type Change, type ReadPosition } from "../src/lib/perpScout/alerts.ts";
import { parseFills, positionOpening, type Fill, type ScoutAccountState } from "../src/lib/perpScout/entries.ts";
import { FOLLOWED, mergeFollowed, type FollowedTrader } from "../src/lib/perpScout/followed.ts";
import { createPacer } from "../src/lib/perpScout/pacer.ts";
import { parsePortfolio } from "../src/lib/perpScout/portfolio.ts";
import { hyperliquidTpsl, nearestTpsl, type HyperliquidOrder } from "../src/lib/tpsl.ts";
import { renderAlertCard } from "./perp-alert-card.ts";

const args = new Set(process.argv.slice(2));
const WEBHOOK = process.env.DISCORD_PERP_WEBHOOK_URL?.trim() ?? "";
const ROLE = (process.env.DISCORD_PERP_ROLE_ID ?? process.env.DISCORD_WATCH_ROLE_ID ?? "").trim() || null;
const DRY = args.has("--dry-run") || !WEBHOOK;
const ONCE = args.has("--once");
const INTERVAL_MS = 30_000;
const LIST_MAX_AGE_MS = 3_600_000;
const TIMEOUT_MS = 15_000;
const POST_SPACING_MS = 2_000;
const STATE_FILE = process.env.PERP_ALERTS_STATE ?? join(homedir(), ".cryptoport", "perp-alerts.json");
const LOCK_FILE = `${STATE_FILE}.lock`;
const INFO_URL = "https://api.hyperliquid.xyz/info";
const DISCORD_WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

interface State {
  v: 1;
  polledAt: number | null;
  /** Per trader address: its positions at the last read. */
  books: Record<string, Book>;
  /** Per trader: when its messages this hour were sent. */
  sent: Record<string, number[]>;
  /** Per trader: moves not posted (over the hourly cap), said once the hour turns. */
  muted: Record<string, number>;
}

const log = (line: string) => console.log(`${new Date().toISOString()} [perp-alerts] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Below the IP's 1,200: the owner's own browsing of Hyperliquid shares it.
const pacer = createPacer(600);

async function info<T>(body: Record<string, unknown>, weight: number): Promise<T> {
  await pacer.reserve(weight);
  const res = await fetch(INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Hyperliquid ${body.type}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function positionsOf(state: ScoutAccountState): ReadPosition[] {
  const num = (x: unknown) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  return (state.assetPositions ?? []).map(({ position: p }) => {
    const szi = Number(p.szi);
    const entryPx = num(p.entryPx);
    return {
      coin: p.coin,
      szi,
      entryPx,
      leverage: num(p.leverage?.value),
      liquidationPx: num(p.liquidationPx),
      notionalUsd: num(p.positionValue) ?? (entryPx ? Math.abs(szi) * entryPx : null),
      unrealizedPnl: num(p.unrealizedPnl),
      roe: num(p.returnOnEquity),
    };
  });
}

// The list: followed.ts plus the owner's changes on the page (one read an hour).
let list: readonly FollowedTrader[] = FOLLOWED;
let listReadAt = 0;
async function refreshList(): Promise<void> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  listReadAt = Date.now();
  if (!base || !key) return log("no Supabase env: following followed.ts only");
  try {
    const res = await fetch(`${base}/rest/v1/app_settings?key=eq.perp_scout_added&select=value`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "cryptoport" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as { value: { traders?: FollowedTrader[]; removed?: string[]; names?: Record<string, string> } | null }[];
    const v = rows[0]?.value ?? {};
    list = mergeFollowed(FOLLOWED, v.traders ?? [], v.removed ?? [], v.names ?? {});
  } catch (e) {
    log(`trader list not read (${(e as Error).message}): keeping the last one`);
  }
}

let lastPostAt = 0;
/** Posts a card: the short title, then the image card (a real table) with
 * the links under it; the text card when the image can't be drawn. */
async function post(msg: Pick<AlertMessage, "ping" | "embed"> & Partial<Pick<AlertMessage, "card" | "links">>): Promise<void> {
  const content = msg.ping && ROLE ? `<@&${ROLE}>` : "";
  let image: ArrayBuffer | null = null;
  if (msg.card) image = await renderAlertCard(msg.card).catch((e: Error) => (log(`card image not drawn (${e.message}) — posting the text card`), null));
  const embed = image && msg.links !== undefined ? { ...msg.embed, description: msg.links, image: { url: "attachment://card.png" } } : msg.embed;
  if (DRY) {
    if (image && process.env.PERP_ALERTS_CARD_DIR) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${process.env.PERP_ALERTS_CARD_DIR}/${msg.embed.title.replace(/[^\w]+/g, "_").slice(0, 60)}.png`, Buffer.from(image));
    }
    return log(`DRY ${content ? "(ping) " : ""}${msg.embed.title}${image ? ` [image ${Math.round(image.byteLength / 1024)} KB]` : ""}\n    ${embed.description.replace(/\n/g, "\n    ")}`);
  }
  await sleep(Math.max(0, lastPostAt + POST_SPACING_MS - Date.now()));
  lastPostAt = Date.now();
  const payload = JSON.stringify({ content, embeds: [embed], allowed_mentions: { parse: [], roles: msg.ping && ROLE ? [ROLE] : [] } });
  for (let attempt = 0; attempt < 2; attempt++) {
    // With an image: multipart, the file the embed points at (attachment://).
    let init: RequestInit;
    if (image) {
      const form = new FormData();
      form.set("payload_json", payload);
      form.set("files[0]", new Blob([image], { type: "image/png" }), "card.png");
      init = { method: "POST", body: form };
    } else {
      init = { method: "POST", headers: { "content-type": "application/json" }, body: payload };
    }
    const res = await fetch(WEBHOOK, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 2);
      await sleep(Math.min(30, wait) * 1000);
      continue;
    }
    // Discord refused the upload itself: the text card instead, never no alert.
    if (image) {
      log(`card image refused (HTTP ${res.status}) — posting the text card`);
      return post({ ping: msg.ping, embed: msg.embed });
    }
    throw new Error(`Discord: HTTP ${res.status}`);
  }
}

/** Fills after `sinceMs`, oldest first. Hyperliquid answers at most 2,000 a
 * call, so it's read forward page by page; past 5 pages (a busy trader's
 * long hold) the exit isn't known rather than computed from part of it. */
async function fillsSince(address: string, sinceMs: number): Promise<Fill[]> {
  const fills: Fill[] = [];
  let start = sinceMs;
  for (let page = 0; page < 5; page++) {
    const raw = await info<unknown[]>({ type: "userFillsByTime", user: address, startTime: start }, 20);
    if (Array.isArray(raw)) pacer.charge(Math.ceil(raw.length / 20));
    const batch = parseFills(raw);
    fills.push(...batch);
    if (!Array.isArray(raw) || raw.length < 2_000) return fills;
    start = Math.max(...batch.map((f) => f.time)) + 1;
  }
  throw new Error("over 10,000 fills since the last alert");
}

/** The whole account's value (portfolio, weight 20), kept 10 minutes per
 * trader: every card says what share of the account a position is. */
const accountCache = new Map<string, { at: number; value: number | null }>();
async function accountValueOf(address: string, nowMs: number): Promise<number | null> {
  const hit = accountCache.get(address);
  if (hit && nowMs - hit.at < 600_000) return hit.value;
  const value = await info<unknown>({ type: "portfolio", user: address }, 20)
    .then((raw) => parsePortfolio(raw).accountValue.at(-1)?.[1] ?? null)
    .catch(() => null);
  accountCache.set(address, { at: nowMs, value });
  return value;
}

/** The extra reads one trader's changes need, then its messages. Every read
 * here happens only when something posts. */
async function report(trader: FollowedTrader, changes: Change[], state: State, nowMs: number, lateMs: number): Promise<number> {
  const withWas = changes.filter((c): c is Exclude<Change, { kind: "opened" }> => c.kind !== "opened");
  const opens = changes.filter((c) => c.kind === "opened");
  // When a position open since before the script started was opened: its
  // latest 2,000 fills, once per position (then kept in the state). First,
  // because a close's result reads every fill since then.
  const unknown = withWas.filter((c) => c.was.openedAt === undefined);
  if (unknown.length) {
    const recent = await info<unknown[]>({ type: "userFills", user: trader.address }, 20)
      .then((raw) => {
        if (Array.isArray(raw)) pacer.charge(Math.ceil(raw.length / 20));
        return parseFills(raw);
      })
      .catch(() => null);
    if (recent) {
      for (const c of unknown) {
        const o = positionOpening(recent, c.coin, c.was.szi);
        c.was.openedAt = o.openedAt;
        c.was.openedBefore = o.openedBefore;
        const kept = state.books[trader.address]?.[c.coin];
        if (kept && c.kind !== "flipped") Object.assign(kept, { openedAt: o.openedAt, openedBefore: o.openedBefore });
      }
    }
  }
  // A close's or flip's result covers the whole position (since it opened);
  // a trim's and an add's, the fills since the last alert.
  const fromOf = (c: (typeof withWas)[number]) => (c.kind === "closed" || c.kind === "flipped" ? (c.was.openedAt ?? c.was.openedBefore ?? c.was.alertedAt) : c.was.alertedAt);
  let fills: Fill[] | null = null;
  if (withWas.length) {
    const since = Math.min(...withWas.map(fromOf)) - 1_000;
    fills = await fillsSince(trader.address, since).catch((e: Error) => (log(`${trader.name}: fills not read (${e.message})`), null));
  }
  const accountValue = await accountValueOf(trader.address, nowMs);
  const orders = opens.length ? await info<HyperliquidOrder[]>({ type: "frontendOpenOrders", user: trader.address }, 20).catch(() => null) : null;
  let posted = 0;
  const sent = (state.sent[trader.address] ??= []);
  for (const change of changes) {
    if (!takeBudget(sent, nowMs)) {
      state.muted[trader.address] = (state.muted[trader.address] ?? 0) + 1;
      continue;
    }
    const was = change.kind === "opened" ? null : change.was;
    const msg = alertMessage(change, {
      traderName: trader.name,
      address: trader.address,
      accountValue,
      tpsl: change.kind === "opened" && orders ? (({ tp, sl }) => ({ tp, sl }))(nearestTpsl(hyperliquidTpsl(orders, change.coin, change.side), change.side)) : undefined,
      result: was && change.kind !== "added" ? (fills ? closeResult(fills, was, fromOf(change as (typeof withWas)[number])) : null) : undefined,
      addPx: was && change.kind === "added" && fills ? addPrice(fills, was) : undefined,
      openedAt: was?.openedAt,
      openedBefore: was?.openedBefore,
      nowMs,
      lateMs,
    });
    await post(msg).then(() => posted++, (e: Error) => log(`${trader.name}: not posted (${e.message}): ${msg.embed.title}`));
  }
  return posted;
}

async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8")) as State;
    if (s.v === 1) return s;
  } catch {
    // No state yet (first run) or unreadable: start from a fresh baseline.
  }
  return { v: 1, polledAt: null, books: {}, sent: {}, muted: {} };
}

async function saveState(state: State): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state));
  await rename(`${STATE_FILE}.tmp`, STATE_FILE); // never a half-written file
}

let stats = { polls: 0, posts: 0, failedReads: 0, since: Date.now() };

async function poll(state: State): Promise<void> {
  if (Date.now() - listReadAt > LIST_MAX_AGE_MS) await refreshList();
  const nowMs = Date.now();
  const lateMs = state.polledAt ? Math.max(0, nowMs - state.polledAt - INTERVAL_MS) : 0;
  const listed = new Set(list.map((t) => t.address));
  let changed = 0;
  let failed = 0;
  for (const trader of list) {
    let account: ScoutAccountState;
    try {
      account = await info<ScoutAccountState>({ type: "clearinghouseState", user: trader.address }, 2);
    } catch (e) {
      failed++;
      if (failed <= 3) log(`${trader.name}: not read (${(e as Error).message}) — keeping its last positions`);
      continue;
    }
    const { changes, book } = diffBook(state.books[trader.address] ?? null, positionsOf(account), nowMs);
    state.books[trader.address] = book;
    if (changes.length === 0) continue;
    changed += changes.length;
    stats.posts += await report(trader, changes, state, nowMs, lateMs);
  }
  // A trader over its hourly cap gets one line once there's room again.
  for (const [address, n] of Object.entries(state.muted)) {
    const trader = list.find((t) => t.address === address);
    if (!n || !trader || !takeBudget((state.sent[address] ??= []), nowMs)) continue;
    await post({ ping: false, embed: { title: `⏸ ${trader.name}: ${n} more move${n === 1 ? "" : "s"} not posted`, url: `https://hyperdash.com/trader/${address}`, description: "Over 10 messages in an hour — see Perp Scout or HyperDash for them.", color: 0x9ca3af } }).catch((e: Error) => log(`muted line not posted (${e.message})`));
    delete state.muted[address];
  }
  for (const address of Object.keys(state.books)) if (!listed.has(address)) delete state.books[address];
  state.polledAt = nowMs;
  await saveState(state);
  stats.polls++;
  stats.failedReads += failed;
  if (changed || failed) log(`poll: ${list.length} traders · ${changed} change${changed === 1 ? "" : "s"}${failed ? ` · ${failed} not read` : ""}${lateMs > 60_000 ? ` · ${Math.round(lateMs / 60_000)} min since the last poll` : ""}`);
  if (Date.now() - stats.since > 3_600_000) {
    log(`alive: ${stats.polls} polls, ${stats.posts} posts, ${stats.failedReads} failed reads in the last hour`);
    stats = { polls: 0, posts: 0, failedReads: 0, since: Date.now() };
  }
}

/** One instance at a time: a second one would post every alert twice. */
function takeLock(): void {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(readFileSync(LOCK_FILE, "utf8"));
    let alive = false;
    try {
      if (pid) process.kill(pid, 0);
      alive = !!pid;
    } catch {
      alive = false;
    }
    if (alive && pid !== process.pid) {
      log(`another instance is running (pid ${pid}) — exiting`);
      process.exit(0);
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => {
    try {
      if (Number(readFileSync(LOCK_FILE, "utf8")) === process.pid) unlinkSync(LOCK_FILE);
    } catch {
      // already gone
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}

async function main(): Promise<void> {
  if (WEBHOOK && !DISCORD_WEBHOOK.test(WEBHOOK)) throw new Error("DISCORD_PERP_WEBHOOK_URL isn't a Discord webhook URL");
  await mkdir(dirname(STATE_FILE), { recursive: true });
  takeLock();
  let commit = "?";
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    // not a git checkout
  }
  await refreshList();
  const state = await loadState();
  log(`start · commit ${commit} · ${DRY ? "DRY RUN (printing, not posting)" : "posting to Discord"} · ping ${ROLE ? "role set" : "none"} · ${list.length} traders · every ${INTERVAL_MS / 1000}s · state ${STATE_FILE}${state.polledAt ? "" : " (first run: baseline only)"}`);
  for (;;) {
    const started = Date.now();
    try {
      await poll(state);
    } catch (e) {
      log(`poll failed: ${(e as Error).message}`);
    }
    if (ONCE) return;
    await sleep(Math.max(1_000, started + INTERVAL_MS - Date.now()));
  }
}

main().catch((e) => {
  log(`stopped: ${(e as Error).message}`);
  process.exit(1);
});
