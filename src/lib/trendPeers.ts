import "server-only";
import {
  fetchSeedInfo,
  fetchCategoryStats,
  fetchCategoryMembers,
  fetchMarketsByIds,
  fetchCoinCategories,
  searchCoins,
  type SeedInfo,
  type CategoryStat,
} from "./adapters/coingecko";
import { explainTrend, type TrendExplanation, type AiPeerTicker } from "./adapters/perplexity";
import { rankPeers, type PeerRow } from "./trendFinder";
import { anchorCategories } from "./categoryFilter";
import { pickBestMatch } from "./watchlistInput";
import { serviceDb } from "./supabase";
import { JOB_STALE_MS } from "./jobStatus";

export interface TrendExplanationRow {
  status: string | null;
  startedAt: string | null;
  /** When this explanation was last (re)computed — shown next to "Why is
   * this moving" so a viewer can tell a same-day scan from an old one.
   * Global/shared across all users, same table as everything else here. */
  computedAt: string | null;
  /** null until the first successful scan ever completes — a claimed-but-
   * still-running or never-attempted token has nothing to show yet. */
  data: TrendExplanation | null;
}

interface RawExplanationRow {
  status: string | null;
  started_at: string | null;
  reason_summary: string | null;
  narrative_tags: string[] | null;
  category_guess: string | null;
  ai_tickers: AiPeerTicker[] | null;
  confidence: "high" | "medium" | "low" | null;
  sources: { title: string; url: string }[] | null;
  computed_at: string | null;
}

function toTrendExplanationRow(row: RawExplanationRow): TrendExplanationRow {
  const hasData = row.reason_summary !== null;
  return {
    status: row.status,
    startedAt: row.started_at,
    computedAt: row.computed_at,
    data: hasData
      ? {
          reasonSummary: row.reason_summary!,
          narrativeTags: row.narrative_tags ?? [],
          categoryGuess: row.category_guess,
          aiTickers: row.ai_tickers ?? [],
          confidence: row.confidence ?? "low",
          sources: row.sources ?? [],
        }
      : null,
  };
}

/**
 * Read-only, on-demand cache read — no TTL, no auto-recompute. A
 * previously-scanned token's explanation is reused forever until a user
 * explicitly clicks Refresh (see claimTrendExplanation/runTrendExplanation
 * below). This replaces the old 24h-TTL silent-recompute design: that was
 * the actual cause of "I thought we said everything should be stored" — a
 * token that had genuinely been searched before still paid a live 20-30s
 * Perplexity call on a plain page load once its row crossed 24h old. See
 * CLAUDE.md's Caching section — research artifacts are stored once and
 * reused until asked for a refresh, same as token_analyses.
 */
export async function getTrendExplanation(seedId: string): Promise<TrendExplanationRow> {
  const { data, error } = await serviceDb()
    .from("trend_explanations")
    .select(
      "status, started_at, reason_summary, narrative_tags, category_guess, ai_tickers, confidence, sources, computed_at",
    )
    .eq("seed_id", seedId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load trend_explanations: ${error.message}`);
  if (!data) return { status: null, startedAt: null, computedAt: null, data: null };
  return toTrendExplanationRow(data as RawExplanationRow);
}

/**
 * CAS claim, same "update a stale/idle row, or insert if none exists yet"
 * shape as tokenAnalysis.ts's claimTokenAnalysis — see that function's own
 * doc comment for why a plain UPDATE...WHERE can't tell "doesn't exist"
 * from "already running" on its own. `status: "refreshing"` is
 * deliberately one of jobStatus.ts's own IN_PROGRESS_STATUSES strings.
 */
export async function claimTrendExplanation(seedId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();

  const { data: claimed, error: updateError } = await serviceDb()
    .from("trend_explanations")
    .update({ status: "refreshing", started_at: nowIso })
    .eq("seed_id", seedId)
    .or(`status.is.null,status.neq.refreshing,started_at.lt.${staleBefore}`)
    .select("seed_id");
  if (updateError) throw new Error(`Failed to claim trend_explanations: ${updateError.message}`);
  if (claimed && claimed.length > 0) return true;

  const { data: existing, error: existingError } = await serviceDb()
    .from("trend_explanations")
    .select("seed_id")
    .eq("seed_id", seedId)
    .maybeSingle();
  if (existingError) throw new Error(`Failed to check trend_explanations: ${existingError.message}`);
  if (existing) return false; // genuinely already running, not stale — someone else has the claim

  const { error: insertError } = await serviceDb()
    .from("trend_explanations")
    .insert({ seed_id: seedId, status: "refreshing", started_at: nowIso });
  if (insertError) {
    // A unique-violation here means another request's own insert won the
    // race between our existence check and this insert.
    if (insertError.code === "23505") return false;
    throw new Error(`Failed to claim trend_explanations: ${insertError.message}`);
  }
  return true;
}

/** The actual Perplexity call + write — only ever invoked from inside a
 * Server Action's after() (see trend-finder/actions.ts's
 * refreshTrendExplanation), never awaited directly, matching every other
 * slow job in this app (CLAUDE.md's Loading Feedback section). Failure
 * still writes a real status (never leaves the row stuck on "refreshing"
 * forever) so the claim can be retried instead of permanently wedged. */
export async function runTrendExplanation(seedId: string, symbol: string, name: string): Promise<void> {
  try {
    // Unknown categories (CoinGecko error) shouldn't block the scan — the
    // prompt then asks the AI to judge the token's function itself, and
    // findTrendPeers says the peer list couldn't be category-checked.
    // The same-category members are handed to the prompt as a starting
    // list to assess, not a boundary — it's told to look beyond it too.
    const ctx = await loadCategoryContext(seedId).catch(() => null);
    const knownPeers = ctx
      ? [...ctx.membersById.values()]
          .filter((m) => m.id !== seedId)
          .sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1))
          .slice(0, PROMPT_MEMBER_LIMIT)
          .map((m) => ({ symbol: m.symbol, name: m.name }))
      : [];
    const result = await explainTrend(symbol, name, ctx?.anchorCategoryNames ?? [], knownPeers);
    if (!result) {
      const { error } = await serviceDb()
        .from("trend_explanations")
        .update({ status: "error: Perplexity lookup failed or timed out" })
        .eq("seed_id", seedId);
      if (error) throw new Error(`Failed to save trend_explanations failure: ${error.message}`);
      return;
    }
    const { error } = await serviceDb()
      .from("trend_explanations")
      .update({
        status: "ok",
        reason_summary: result.reasonSummary,
        narrative_tags: result.narrativeTags,
        category_guess: result.categoryGuess,
        ai_tickers: result.aiTickers,
        confidence: result.confidence,
        sources: result.sources,
        computed_at: new Date().toISOString(),
      })
      .eq("seed_id", seedId);
    if (error) throw new Error(`Failed to save trend_explanations: ${error.message}`);
  } catch (e) {
    await serviceDb()
      .from("trend_explanations")
      .update({ status: `error: ${(e as Error).message}` })
      .eq("seed_id", seedId);
  }
}

// Category membership changes on the order of months; a stale list only
// shifts which tokens count as peers, it never shows a wrong price.
const COIN_CATEGORIES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A coin's raw CoinGecko category names, cached in coin_categories (the
 * existing 7-day-TTL table — slow-changing reference data, CLAUDE.md
 * caching rule 2). Live fetch on a miss or a stale row; if the live fetch
 * fails, a stale row is still used rather than nothing. null = unknown
 * (no row and the live fetch failed, or CoinGecko has no such coin). */
export async function getCoinCategories(coingeckoId: string): Promise<string[] | null> {
  const db = serviceDb();
  const { data: row, error } = await db
    .from("coin_categories")
    .select("categories, updated_at")
    .eq("coingecko_id", coingeckoId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read coin_categories: ${error.message}`);
  const cached = row && Array.isArray(row.categories) ? (row.categories as string[]) : null;
  const fresh = row?.updated_at && Date.now() - new Date(row.updated_at as string).getTime() < COIN_CATEGORIES_TTL_MS;
  if (cached && fresh) return cached;

  try {
    const live = await fetchCoinCategories(coingeckoId);
    if (live === null) return cached;
    const { error: upsertError } = await db
      .from("coin_categories")
      .upsert({ coingecko_id: coingeckoId, categories: live, updated_at: new Date().toISOString() });
    if (upsertError) console.warn(`[trendPeers] coin_categories upsert(${coingeckoId}) failed: ${upsertError.message}`);
    return live;
  } catch (e) {
    console.warn(`[trendPeers] fetchCoinCategories(${coingeckoId}) failed: ${(e as Error).message}`);
    return cached;
  }
}

/** Resolves the AI's raw {ticker, reason} pairs to real CoinGecko coin
 * ids — a ticker that doesn't resolve confidently is dropped, never
 * guessed at. Two steps:
 *
 * 1. The seed's own category members first (`members`), by exact symbol,
 *    highest market cap winning a symbol shared within them. The category
 *    is the right context for an ambiguous ticker. Found live on
 *    2026-09-22: CoinGecko's /search for the one-letter "W" doesn't return
 *    Wormhole at all, so the search path resolved the AI's "W" to WhiteBIT
 *    and Wormhole — a real same-category peer — landed in "different
 *    category".
 * 2. Otherwise /search, accepted only on an exact symbol match.
 *    pickBestMatch falls back to the top result when nothing matches
 *    exactly (right for Watchlist bulk-add, where a human reviews what
 *    gets added), which here silently turned a ticker into a different
 *    coin.
 *
 * One /search call per ticker not found among members (no batch
 * endpoint) — bounded by how many tickers the AI names. Returns id ->
 * {reason, relation} so each row can show its own justification. */
interface ResolvedAiTicker {
  reason: string;
  relation: AiPeerTicker["relation"];
}

async function resolveAiTickers(
  tickers: AiPeerTicker[],
  members: ReadonlyMap<string, PeerRow>,
): Promise<Map<string, ResolvedAiTicker>> {
  const memberBySymbol = new Map<string, PeerRow>();
  for (const m of members.values()) {
    const sym = m.symbol.toUpperCase();
    const current = memberBySymbol.get(sym);
    if (!current || (m.marketCap ?? -1) > (current.marketCap ?? -1)) memberBySymbol.set(sym, m);
  }

  const resolvedById = new Map<string, ResolvedAiTicker>();
  for (const { ticker, reason, relation } of tickers) {
    const sym = ticker.toUpperCase();
    let id = memberBySymbol.get(sym)?.id ?? null;
    if (!id) {
      const match = pickBestMatch(ticker, await searchCoins(ticker));
      if (match && match.symbol.toUpperCase() === sym) id = match.id;
    }
    if (id && !resolvedById.has(id)) resolvedById.set(id, { reason, relation });
  }
  return resolvedById;
}

// Cap on how many of the seed's functional categories get their member
// list fetched (one /coins/markets call each). Most tokens have 1-3; a
// broad multi-narrative L1 (NEAR has 6) shouldn't fan out unbounded.
const MAX_ANCHOR_CATEGORIES = 6;

interface CategoryContext {
  /** null = the seed's categories couldn't be determined (lookup failed). */
  seedCategories: string[] | null;
  anchorCategoryNames: string[];
  categories: CategoryStat[];
  membersById: Map<string, PeerRow>;
}

/** The seed's functional categories and their members (top 250 by market
 * cap per category) — shared by the page render (findTrendPeers) and the
 * AI scan (runTrendExplanation, which hands the members to the prompt), so
 * both work from the same list. */
async function loadCategoryContext(seedId: string): Promise<CategoryContext> {
  const [seedCategories, categoryStats] = await Promise.all([
    getCoinCategories(seedId).catch(() => null),
    fetchCategoryStats(),
  ]);
  const anchorCategoryNames = anchorCategories(seedCategories ?? []);
  const statByName = new Map(categoryStats.map((c) => [c.name, c]));
  const categories = anchorCategoryNames
    .map((n) => statByName.get(n))
    .filter((c): c is CategoryStat => c !== undefined)
    .slice(0, MAX_ANCHOR_CATEGORIES);
  const memberLists = await Promise.all(categories.map((c) => fetchCategoryMembers(c.id)));
  const membersById = new Map<string, PeerRow>();
  for (const list of memberLists) for (const m of list) membersById.set(m.id, m);
  return { seedCategories, anchorCategoryNames, categories, membersById };
}

// How many same-category tokens (largest market cap first) the AI scan is
// given to assess — enough to cover the real competitors, short enough to
// keep the prompt focused.
const PROMPT_MEMBER_LIMIT = 20;

export type TrendPeersResult =
  | { status: "no-seed-data"; seedId: string }
  | {
      status: "ok";
      seed: SeedInfo;
      explanation: TrendExplanationRow;
      /** The seed's functional CoinGecko categories (see categoryFilter.ts)
       * — what a peer must share. Empty when CoinGecko gives none, or when
       * the lookup failed (`categoryCheck === false` distinguishes). */
      anchorCategoryNames: string[];
      /** Anchor categories resolved to real CoinGecko category ids — the
       * ones whose members were actually fetched. */
      categories: CategoryStat[];
      /** false = categories couldn't be determined, so AI suggestions
       * below are NOT category-checked (the UI says so). */
      categoryCheck: boolean;
      categoryPeers: PeerRow[];
      /** AI-named tokens that share a functional category with the seed. */
      aiPeers: PeerRow[];
      /** Tokens the AI named as same-function peers that CoinGecko doesn't
       * list in the seed's categories — its tagging is incomplete, so these
       * are shown, but as the AI's judgement, not a verified peer. */
      aiDiscovered: PeerRow[];
      /** AI-named tokens from a different category — same news, not peers. */
      aiOtherCategory: PeerRow[];
      /** id -> the AI's specific reason for naming that token (both lists). */
      aiPeerReasons: Map<string, string>;
      /** The OLDEST real CoinGecko fetch time among every price shown (seed,
       * categories, members, AI peers) — the page's "priced X ago" caption,
       * so a cached response never looks fresher than it is. */
      pricedAtMs: number;
    };

/**
 * The Trend Finder orchestrator. Peers are anchored on the seed's OWN
 * CoinGecko functional categories (categoryFilter.ts), not on the AI's
 * narrative: reported directly (ZRO example), the old flow let the AI's
 * news story define both panels — its free-text category guess picked the
 * "category" panel, and every Circle Arc launch partner became an "AI
 * peer" — so a cross-chain messaging token got a lending protocol and two
 * DEXes as peers. Now: the seed's functional categories define the
 * category panel (their members), are passed into the AI search (see
 * runTrendExplanation), and gate the AI's suggestions in code — an AI-
 * named token counts as a peer only if it's a member of one of those
 * categories; the rest are shown separately as "same news, different
 * category". Membership comes from each category's top 250 by market cap
 * (one /coins/markets call per category), so a genuine peer ranked below
 * that in a very large category would land in the "different category"
 * list — acceptable at this scale, noted rather than hidden.
 *
 * The AI explanation itself is never fetched live here — `explanation` is
 * always just a read of whatever's cached. The live Perplexity call only
 * ever happens via the explicit Refresh action (runTrendExplanation).
 */
export async function findTrendPeers({
  coingeckoId,
  mcapFloor,
  seed: knownSeed,
}: {
  coingeckoId: string;
  mcapFloor: number;
  /** The seed's info when the caller already fetched it (Encyclopedia's page
   * shell) — saves a second /coins/markets call for the same coin. */
  seed?: SeedInfo | null;
}): Promise<TrendPeersResult> {
  const seed = knownSeed !== undefined ? knownSeed : await fetchSeedInfo(coingeckoId);
  if (!seed) return { status: "no-seed-data", seedId: coingeckoId };

  const [explanation, ctx] = await Promise.all([getTrendExplanation(coingeckoId), loadCategoryContext(coingeckoId)]);
  const data = explanation.data;
  const { anchorCategoryNames, categories, membersById } = ctx;
  const categoryCheck = ctx.seedCategories !== null && categories.length > 0;

  // After members are known — they're the first place an AI ticker is resolved.
  const resolved = data ? await resolveAiTickers(data.aiTickers, membersById) : new Map<string, ResolvedAiTicker>();
  const aiPeerReasons = new Map([...resolved].map(([id, r]) => [id, r.reason]));
  const aiPeerInfo = await fetchMarketsByIds([...resolved.keys()]);

  // Peer status is decided here, from CoinGecko membership — the AI's own
  // relation label only separates "claimed peer" from "same news" among
  // non-members. Scans stored before the label existed have none, so their
  // non-members stay in "same news" rather than being promoted.
  const bucket = (p: PeerRow): "peer" | "discovered" | "other" => {
    if (!categoryCheck || membersById.has(p.id)) return "peer";
    return resolved.get(p.id)?.relation === "peer" ? "discovered" : "other";
  };
  const inBucket = (b: ReturnType<typeof bucket>) => aiPeerInfo.filter((p) => bucket(p) === b);

  const pricedAtMs = Math.min(
    seed.fetchedAtMs,
    ...categories.map((c) => c.fetchedAtMs),
    ...[...membersById.values(), ...aiPeerInfo].flatMap((p) => (p.fetchedAtMs !== undefined ? [p.fetchedAtMs] : [])),
  );

  return {
    status: "ok",
    seed,
    explanation,
    pricedAtMs,
    anchorCategoryNames,
    categories,
    categoryCheck,
    categoryPeers: rankPeers([...membersById.values()], { seedId: coingeckoId, mcapFloor }),
    aiPeers: rankPeers(inBucket("peer"), { seedId: coingeckoId, mcapFloor }),
    aiDiscovered: rankPeers(inBucket("discovered"), { seedId: coingeckoId, mcapFloor }),
    aiOtherCategory: rankPeers(inBucket("other"), { seedId: coingeckoId, mcapFloor }),
    aiPeerReasons,
  };
}
