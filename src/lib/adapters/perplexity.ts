import "server-only";

const API_URL = "https://api.perplexity.ai/v1/agent";
const API_KEY = process.env.PERPLEXITY_API_KEY ?? "";

export interface AiPeerTicker {
  ticker: string;
  /** Why the AI named this specific ticker — e.g. "Avalanche RWA credit hub
   * and institutional collateral-lending push," not just "same category."
   * Shown per-row in TrendPeerTable's expandable reason (see that
   * component and trend-finder/page.tsx) — reported directly: the AI was
   * already reasoning per-ticker in its prose summary, just not returning
   * that structurally, so there was no way to show *why* a specific row
   * was suggested without parsing free text. Prompted to be relational
   * ("Same driver as <seed> (<catalyst>): <this token's exposure>") —
   * reported directly (ZRO example): peer reasons that only stated the
   * peer's own catalyst left the reader to connect it back to the seed. */
  reason: string;
  /** "peer" = named as a same-category peer; "other_category" = named only
   * as part of the same news from a different category (context, not a
   * peer). Absent on explanations stored before this split existed.
   * Advisory only — trendPeers.ts decides peer status itself from
   * CoinGecko category membership, never from this label. */
  relation?: "peer" | "other_category";
}

export interface TrendExplanation {
  reasonSummary: string;
  narrativeTags: string[];
  categoryGuess: string | null;
  aiTickers: AiPeerTicker[];
  confidence: "high" | "medium" | "low";
  sources: { title: string; url: string }[];
}

// Live-verified this session (see trendPeers.ts's own doc comment) against
// the CURRENT Perplexity API — csp-screener's own working Perplexity
// integration (src/lib/perplexity.ts there) calls the *old* Sonar Chat
// Completions endpoint (api.perplexity.ai/chat/completions, model:
// "sonar"), which Perplexity's docs say sunsets 2026-09-27. This uses the
// successor Agent API instead. The exact request shape below was found by
// hitting real 400s and fixing them, not by trusting docs alone: the docs'
// own example response_format omits the required `json_schema` wrapper key
// (a bare `{type:"json_schema", schema:{...}}` 400s with "unknown field
// schema" — Perplexity's Agent API mirrors OpenAI's actual nested
// Structured Outputs shape, {type:"json_schema", json_schema:{name,
// schema}}, not its own simplified one).
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reason_summary: { type: "string" },
    narrative_tags: { type: "array", items: { type: "string" } },
    category_guess: { type: "string" },
    related_tickers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ticker", "reason"],
      },
    },
    other_category_tickers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ticker: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ticker", "reason"],
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["reason_summary", "narrative_tags", "category_guess", "related_tickers", "other_category_tickers", "confidence"],
};

/** `functionalCategories` are the seed's own CoinGecko categories after
 * categoryFilter.ts drops chain-ecosystem/investor/index tags. They anchor
 * the peer search on what the token DOES — reported directly: without
 * this, ZRO's "peers" were other Circle Arc launch partners (MORPHO, AERO,
 * UNI), which share a news event, not a function. The category comes
 * from CoinGecko first and goes into the search, not the reverse (the old
 * flow guessed a category from the AI's narrative afterwards). */
function buildPrompt(symbol: string, name: string, functionalCategories: readonly string[]): string {
  const classification =
    functionalCategories.length > 0
      ? `${symbol} is classified by CoinGecko under these functional categories: ${functionalCategories.join(", ")}.`
      : `CoinGecko gives ${symbol} no functional category, so judge what kind of project it is from what it actually does.`;
  return `Why has the crypto token ${name} (${symbol}) been moving in price recently? Search for current news and explain the specific catalyst — clearly distinguish a token-specific/company-specific reason from general crypto market beta (the whole market moving together isn't a real answer here).

${classification}

Then name PEERS: other tokens that do the same kind of thing as ${symbol} — direct competitors or same-function projects in the categories above (for example, a cross-chain messaging protocol's peers are other bridges and interoperability protocols) — that are exposed to the same driver or currently moving for a similar reason. Do NOT name a token as a peer just because it was part of the same news event, partnered with the same company, or launched on the same chain: being a launch partner on the same chain is not being a peer. For EACH peer, write its reason in relational terms — connect it back to ${symbol} explicitly. Shape: "Same driver as ${symbol} (<the shared catalyst>): <how this token, as a same-function project, is exposed to it>." If a same-category token only shares a broader theme rather than the same specific catalyst, say that plainly ("Broader theme, not the same catalyst: ...") instead of implying a direct link. Never pad the list — fewer, genuinely comparable peers are better than a longer list.

Separately, under other_category_tickers, list tokens from OTHER categories that were part of the same news (for example other partners in the same launch), each with one sentence on their role in that news. These are context for the reader, not peers.

Also give your single best guess at a short category/theme name (2-5 words, the kind of phrase a taxonomy like "Real World Assets" or "Privacy Coins" would use) that best captures this narrative.

Return ONLY this JSON:
{
  "reason_summary": "2-4 sentences explaining the specific catalyst, with dates where known",
  "narrative_tags": ["short tag", "short tag", ...],
  "category_guess": "short category/theme name",
  "related_tickers": [{"ticker": "TICKER", "reason": "1-2 sentences: the driver it shares with ${symbol}, then this same-function token's own exposure to it"}, ...],
  "other_category_tickers": [{"ticker": "TICKER", "reason": "1 sentence: its role in the same news"}, ...],
  "confidence": "high|medium|low"
}`;
}

interface SearchResultItem {
  type?: "search_results";
  results?: { title?: string; url?: string }[];
}
interface MessageItem {
  type?: "message";
  content?: { type?: string; text?: string }[];
}
type OutputItem = SearchResultItem | MessageItem;

/** The two bits of Agent API response parsing every caller in this file
 * needs identically (extractMessageText/extractSources below) — factored
 * out once analyzeToken became the second function needing them, same
 * "two is fine, three is the extraction trigger" threshold as everywhere
 * else in this app. Each function's own prompt/schema/return-shape stays
 * separate, since those genuinely differ. */
function extractMessageText(output: OutputItem[]): string | null {
  const messageItem = output.find((o): o is MessageItem => o.type === "message");
  const text = messageItem?.content?.find((c) => typeof c.text === "string")?.text;
  return text ?? null;
}

/** Sources come from the top-level search_results output items (their
 * title/url), not the message item's own `annotations` array — live-
 * verified this session that annotations came back empty while
 * search_results carried the real, dated citation list. */
function extractSources(output: OutputItem[]): { title: string; url: string }[] {
  return output
    .filter((o): o is SearchResultItem => o.type === "search_results")
    .flatMap((o) => o.results ?? [])
    .filter((r): r is { title: string; url: string } => typeof r.title === "string" && typeof r.url === "string")
    .slice(0, 10);
}

/**
 * Explains why a token is moving right now, and names other tokens moving
 * for a similar reason — the live-web-search-grounded half of Trend Finder
 * (see trendFinder.ts's doc comment for why price correlation alone can't
 * do this: a narrative-driven move like a protocol shipping a new feature
 * has no price history to find). `null` on any failure (HTTP error,
 * timeout, malformed response) — the caller shows an honest "couldn't
 * determine a reason," never a fabricated one. Hard timeout via
 * AbortSignal.timeout: a hung call would otherwise hold the page's render
 * open past its own maxDuration (same reasoning as csp-screener's own
 * askPerplexityRaw, which this mirrors).
 */
export async function explainTrend(
  symbol: string,
  name: string,
  functionalCategories: readonly string[],
): Promise<TrendExplanation | null> {
  if (!API_KEY) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not set");
    return null;
  }

  const body = {
    input: buildPrompt(symbol, name, functionalCategories),
    preset: "low",
    max_output_tokens: 2000, // was 1500; the response now carries a second ticker list
    tools: [{ type: "web_search" }],
    response_format: { type: "json_schema", json_schema: { name: "trend_reason", schema: RESPONSE_SCHEMA } },
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.warn(`[perplexity] explainTrend(${symbol}) network/timeout error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  if (!res.ok) {
    const errText = await res.text();
    console.warn(`[perplexity] explainTrend(${symbol}) HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return null;
  }

  let json: { output?: OutputItem[] };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }

  const output = json.output ?? [];
  const text = extractMessageText(output);
  if (!text) return null;

  let parsed: {
    reason_summary?: unknown;
    narrative_tags?: unknown;
    category_guess?: unknown;
    related_tickers?: unknown; // { ticker: string; reason: string }[]
    other_category_tickers?: unknown; // same shape
    confidence?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const reasonSummary = typeof parsed.reason_summary === "string" ? parsed.reason_summary.trim() : "";
  if (!reasonSummary) return null;

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const asAiTickers = (v: unknown, relation: AiPeerTicker["relation"]): AiPeerTicker[] => {
    if (!Array.isArray(v)) return [];
    const result: AiPeerTicker[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const ticker = typeof o.ticker === "string" ? o.ticker.trim().toUpperCase() : "";
      const reason = typeof o.reason === "string" ? o.reason.trim() : "";
      if (ticker && reason) result.push({ ticker, reason, relation });
    }
    return result;
  };
  const confidence: TrendExplanation["confidence"] =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";
  const categoryGuess =
    typeof parsed.category_guess === "string" && parsed.category_guess.trim().length > 0
      ? parsed.category_guess.trim()
      : null;

  return {
    reasonSummary,
    narrativeTags: asStringArray(parsed.narrative_tags),
    categoryGuess,
    aiTickers: [
      ...asAiTickers(parsed.related_tickers, "peer"),
      ...asAiTickers(parsed.other_category_tickers, "other_category"),
    ],
    confidence,
    sources: extractSources(output),
  };
}

export interface TokenCatalyst {
  event: string;
  timing: string;
  category: "unlock" | "listing" | "launch" | "partnership" | "governance" | "other";
}

export interface DirectionalNote {
  summary: string;
  direction: "building" | "fading" | "flat" | "unclear" | "up" | "down";
}

export interface TokenAnalysis {
  catalysts: TokenCatalyst[];
  socialMomentum: DirectionalNote;
  onchainActivity: DirectionalNote;
  tokenomicsNote: string;
  narrativePosition: string;
  risks: string[];
  bullCase: string;
  bearCase: string;
  confidence: "high" | "medium" | "low";
  sources: { title: string; url: string }[];
}

const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    catalysts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          event: { type: "string" },
          timing: { type: "string" },
          category: {
            type: "string",
            enum: ["unlock", "listing", "launch", "partnership", "governance", "other"],
          },
        },
        required: ["event", "timing", "category"],
      },
    },
    social_momentum: {
      type: "object",
      properties: {
        summary: { type: "string" },
        direction: { type: "string", enum: ["building", "fading", "flat", "unclear"] },
      },
      required: ["summary", "direction"],
    },
    onchain_activity: {
      type: "object",
      properties: {
        summary: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "flat", "unclear"] },
      },
      required: ["summary", "direction"],
    },
    tokenomics_note: { type: "string" },
    narrative_position: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    bull_case: { type: "string" },
    bear_case: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "catalysts",
    "social_momentum",
    "onchain_activity",
    "tokenomics_note",
    "narrative_position",
    "risks",
    "bull_case",
    "bear_case",
    "confidence",
  ],
};

function buildAnalysisPrompt(symbol: string, name: string): string {
  return `You are analyzing the crypto token ${name} (${symbol}) for someone deciding whether it's worth watching or acting on. Search for current, dated information — do not rely on general knowledge alone.

Cover each of these, based only on what you can find with real dates/sources:

1. UPCOMING CATALYSTS — token unlocks/vesting cliffs, mainnet or feature launches, exchange listings (confirmed or rumored), partnership announcements, governance votes, or any other dated event in the next 1-3 months that could move price. Say clearly if you find nothing concrete.

2. SOCIAL MOMENTUM — is there real, current chatter about this token (crypto Twitter/X, Reddit, Telegram, or news coverage of that chatter)? Is it building, fading, or flat? Distinguish organic interest from an obvious paid/bot campaign if you can tell.

3. ON-CHAIN / NETWORK ACTIVITY — recent trading volume trend, TVL trend if it's a DeFi protocol, active-address or transaction-count trend, whale/large-holder movement if reported. Say clearly what you couldn't find data for rather than guessing.

4. TOKENOMICS PRESSURE — upcoming unlock size relative to circulating supply/float, inflation rate, any recent large sell-offs by insiders or the team.

5. COMPETITIVE / NARRATIVE POSITION — is this token riding a live narrative? Is it a leader or laggard in its niche right now?

6. RISKS — anything concrete working against it: security incidents, regulatory exposure, team/community drama, technical issues, or simply "no known risks found."

Then give a balanced take — this is not a recommendation, it's context for someone else's decision:

BULL CASE: 2-3 sentences, the strongest concrete case for why this could move up.
BEAR CASE: 2-3 sentences, the strongest concrete case for why it might not, or could move down.

Return ONLY this JSON:
{
  "catalysts": [{"event": "...", "timing": "a date if known, else 'near-term'/'unclear'", "category": "unlock|listing|launch|partnership|governance|other"}],
  "social_momentum": {"summary": "...", "direction": "building|fading|flat|unclear"},
  "onchain_activity": {"summary": "...", "direction": "up|down|flat|unclear"},
  "tokenomics_note": "1-2 sentences, or 'nothing notable found'",
  "narrative_position": "1-2 sentences",
  "risks": ["short risk", ...],
  "bull_case": "2-3 sentences",
  "bear_case": "2-3 sentences",
  "confidence": "high|medium|low"
}`;
}

/**
 * Deep-dive analysis for one token — Watchlist's own on-demand "Get AI
 * analysis" button (reported directly, drafted collaboratively before
 * building this). Deliberately never run automatically: unlike Trend
 * Finder's explainTrend (awaited inline during page render, on a 24h TTL
 * auto-refresh), this is only ever invoked from a user click — see
 * tokenAnalysis.ts's own doc comment for the CAS-claim/after() shape that
 * makes a ~20-30s Agent API call here without freezing the app's
 * navigation queue.
 *
 * Same Agent API request shape as explainTrend (see that function's own
 * doc comment for how the exact shape was found — live 400s, not docs),
 * different prompt/schema/return type. `null` on any failure, same
 * "never fabricate, an honest missing beats a wrong guess" rule.
 */
export async function analyzeToken(symbol: string, name: string): Promise<TokenAnalysis | null> {
  if (!API_KEY) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not set");
    return null;
  }

  const body = {
    input: buildAnalysisPrompt(symbol, name),
    preset: "low",
    max_output_tokens: 2000,
    tools: [{ type: "web_search" }],
    response_format: { type: "json_schema", json_schema: { name: "token_analysis", schema: ANALYSIS_RESPONSE_SCHEMA } },
    stream: false,
  };

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    console.warn(`[perplexity] analyzeToken(${symbol}) network/timeout error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  if (!res.ok) {
    const errText = await res.text();
    console.warn(`[perplexity] analyzeToken(${symbol}) HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return null;
  }

  let json: { output?: OutputItem[] };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return null;
  }

  const output = json.output ?? [];
  const text = extractMessageText(output);
  if (!text) return null;

  let parsed: {
    catalysts?: unknown;
    social_momentum?: unknown;
    onchain_activity?: unknown;
    tokenomics_note?: unknown;
    narrative_position?: unknown;
    risks?: unknown;
    bull_case?: unknown;
    bear_case?: unknown;
    confidence?: unknown;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const asCatalysts = (v: unknown): TokenCatalyst[] => {
    if (!Array.isArray(v)) return [];
    const validCategories = new Set(["unlock", "listing", "launch", "partnership", "governance", "other"]);
    const result: TokenCatalyst[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const event = typeof o.event === "string" ? o.event.trim() : "";
      const timing = typeof o.timing === "string" ? o.timing.trim() : "";
      const category = typeof o.category === "string" && validCategories.has(o.category) ? o.category : "other";
      if (event) result.push({ event, timing: timing || "unclear", category: category as TokenCatalyst["category"] });
    }
    return result;
  };
  const asDirectionalNote = (v: unknown, validDirections: Set<string>): DirectionalNote | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const summary = typeof o.summary === "string" ? o.summary.trim() : "";
    if (!summary) return null;
    const direction = typeof o.direction === "string" && validDirections.has(o.direction) ? o.direction : "unclear";
    return { summary, direction: direction as DirectionalNote["direction"] };
  };

  const socialMomentum = asDirectionalNote(parsed.social_momentum, new Set(["building", "fading", "flat", "unclear"]));
  const onchainActivity = asDirectionalNote(parsed.onchain_activity, new Set(["up", "down", "flat", "unclear"]));
  const bullCase = typeof parsed.bull_case === "string" ? parsed.bull_case.trim() : "";
  const bearCase = typeof parsed.bear_case === "string" ? parsed.bear_case.trim() : "";
  // A response with neither a social nor on-chain read, and no bull/bear
  // case, isn't a usable analysis — same "reject a malformed/empty
  // response rather than show a mostly-blank panel" reasoning as
  // explainTrend's own reasonSummary check above.
  if (!socialMomentum || !onchainActivity || !bullCase || !bearCase) return null;

  const confidence: TokenAnalysis["confidence"] =
    parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "low";

  return {
    catalysts: asCatalysts(parsed.catalysts),
    socialMomentum,
    onchainActivity,
    tokenomicsNote: typeof parsed.tokenomics_note === "string" ? parsed.tokenomics_note.trim() : "",
    narrativePosition: typeof parsed.narrative_position === "string" ? parsed.narrative_position.trim() : "",
    risks: asStringArray(parsed.risks),
    bullCase,
    bearCase,
    confidence,
    sources: extractSources(output),
  };
}
