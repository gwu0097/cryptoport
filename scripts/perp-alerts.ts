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
// minute of the IP's 1,200), plus per change 20–60 more (the fills for a
// close, the account value and TP/SL for an open). Free, keyless.
// Safeguards: at most 10 messages per trader an hour (the rest counted and
// summed in one line), posts spaced 2 s (Discord allows ~30 a minute), every
// request times out after 15 s, a failed read keeps the trader's last book
// (no false "closed").

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { alertMessage, closeResult, diffBook, takeBudget, type AlertMessage, type Book, type Change, type ReadPosition } from "../src/lib/perpScout/alerts.ts";
import { parseFills, type Fill, type ScoutAccountState } from "../src/lib/perpScout/entries.ts";
import { FOLLOWED, mergeFollowed, type FollowedTrader } from "../src/lib/perpScout/followed.ts";
import { createPacer } from "../src/lib/perpScout/pacer.ts";
import { parsePortfolio } from "../src/lib/perpScout/portfolio.ts";
import { hyperliquidTpsl, nearestTpsl, type HyperliquidOrder } from "../src/lib/tpsl.ts";

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
async function post(msg: AlertMessage): Promise<void> {
  const content = msg.ping && ROLE ? `<@&${ROLE}>` : "";
  if (DRY) return log(`DRY ${content ? "(ping) " : ""}${msg.embed.title}\n    ${msg.embed.description.replace(/\n/g, "\n    ")}`);
  await sleep(Math.max(0, lastPostAt + POST_SPACING_MS - Date.now()));
  lastPostAt = Date.now();
  const body = JSON.stringify({ content, embeds: [msg.embed], allowed_mentions: { parse: [], roles: msg.ping && ROLE ? [ROLE] : [] } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 2);
      await sleep(Math.min(30, wait) * 1000);
      continue;
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

/** The extra reads one trader's changes need, then its messages. */
async function report(trader: FollowedTrader, changes: Change[], state: State, nowMs: number, lateMs: number): Promise<number> {
  const exits = changes.filter((c) => c.kind === "closed" || c.kind === "flipped");
  const opens = changes.filter((c) => c.kind === "opened");
  let fills: Fill[] | null = null;
  if (exits.length) {
    const since = Math.min(...exits.map((c) => ("was" in c ? c.was.alertedAt : nowMs))) - 1_000;
    fills = await fillsSince(trader.address, since).catch((e: Error) => (log(`${trader.name}: fills not read (${e.message})`), null));
  }
  let accountValue: number | null = null;
  let orders: HyperliquidOrder[] | null = null;
  if (opens.length) {
    accountValue = await info<unknown>({ type: "portfolio", user: trader.address }, 20)
      .then((raw) => parsePortfolio(raw).accountValue.at(-1)?.[1] ?? null)
      .catch(() => null);
    orders = await info<HyperliquidOrder[]>({ type: "frontendOpenOrders", user: trader.address }, 20).catch(() => null);
  }
  let posted = 0;
  const sent = (state.sent[trader.address] ??= []);
  for (const change of changes) {
    if (!takeBudget(sent, nowMs)) {
      state.muted[trader.address] = (state.muted[trader.address] ?? 0) + 1;
      continue;
    }
    const msg = alertMessage(change, {
      traderName: trader.name,
      address: trader.address,
      accountValue,
      tpsl: change.kind === "opened" && orders ? (({ tp, sl }) => ({ tp, sl }))(nearestTpsl(hyperliquidTpsl(orders, change.coin, change.side), change.side)) : undefined,
      result: "was" in change && (change.kind === "closed" || change.kind === "flipped") ? (fills ? closeResult(fills, change.was) : null) : undefined,
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
