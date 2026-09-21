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
   * was suggested without parsing free text. */
  reason: string;
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
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["reason_summary", "narrative_tags", "category_guess", "related_tickers", "confidence"],
};

function buildPrompt(symbol: string, name: string): string {
  return `Why has the crypto token ${name} (${symbol}) been moving in price recently? Search for current news and explain the specific catalyst — clearly distinguish a token-specific/company-specific reason from general crypto market beta (the whole market moving together isn't a real answer here).

Then name other crypto tokens that are CURRENTLY moving for a similar underlying reason (the same narrative or catalyst type, not just tokens that happen to share a category tag) — for EACH one, give its own specific 1-sentence reason (e.g. "an Avalanche RWA credit hub with an institutional collateral-lending push," not "same category" or "also RWA-related").

Also give your single best guess at a short category/theme name (2-5 words, the kind of phrase a taxonomy like "Real World Assets" or "Privacy Coins" would use) that best captures this narrative.

Return ONLY this JSON:
{
  "reason_summary": "2-4 sentences explaining the specific catalyst, with dates where known",
  "narrative_tags": ["short tag", "short tag", ...],
  "category_guess": "short category/theme name",
  "related_tickers": [{"ticker": "TICKER", "reason": "1 sentence specific to this token, not generic"}, ...],
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
export async function explainTrend(symbol: string, name: string): Promise<TrendExplanation | null> {
  if (!API_KEY) {
    console.warn("[perplexity] PERPLEXITY_API_KEY not set");
    return null;
  }

  const body = {
    input: buildPrompt(symbol, name),
    preset: "low",
    max_output_tokens: 1500,
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
  const messageItem = output.find((o): o is MessageItem => o.type === "message");
  const text = messageItem?.content?.find((c) => typeof c.text === "string")?.text;
  if (!text) return null;

  let parsed: {
    reason_summary?: unknown;
    narrative_tags?: unknown;
    category_guess?: unknown;
    related_tickers?: unknown; // { ticker: string; reason: string }[]
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
  const asAiTickers = (v: unknown): AiPeerTicker[] => {
    if (!Array.isArray(v)) return [];
    const result: AiPeerTicker[] = [];
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const ticker = typeof o.ticker === "string" ? o.ticker.trim().toUpperCase() : "";
      const reason = typeof o.reason === "string" ? o.reason.trim() : "";
      if (ticker && reason) result.push({ ticker, reason });
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

  // Sources come from the top-level search_results output items (their
  // title/url), not the message item's own `annotations` array — live-
  // verified this session that annotations came back empty while
  // search_results carried the real, dated citation list.
  const sources = output
    .filter((o): o is SearchResultItem => o.type === "search_results")
    .flatMap((o) => o.results ?? [])
    .filter((r): r is { title: string; url: string } => typeof r.title === "string" && typeof r.url === "string")
    .slice(0, 10);

  return {
    reasonSummary,
    narrativeTags: asStringArray(parsed.narrative_tags),
    categoryGuess,
    aiTickers: asAiTickers(parsed.related_tickers),
    confidence,
    sources,
  };
}
