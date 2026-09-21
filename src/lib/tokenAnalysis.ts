import "server-only";
import { serviceDb } from "./supabase";
import { analyzeToken, type TokenAnalysis } from "./adapters/perplexity";
import { JOB_STALE_MS } from "./jobStatus";

export interface TokenAnalysisRow {
  status: string | null;
  startedAt: string | null;
  computedAt: string | null;
  /** null until the first successful run ever completes — a claimed-but-
   * still-running or never-attempted token has nothing to show yet. */
  data: TokenAnalysis | null;
}

interface RawRow {
  status: string | null;
  started_at: string | null;
  computed_at: string | null;
  catalysts: TokenAnalysis["catalysts"] | null;
  social_momentum: TokenAnalysis["socialMomentum"] | null;
  onchain_activity: TokenAnalysis["onchainActivity"] | null;
  tokenomics_note: string | null;
  narrative_position: string | null;
  risks: string[] | null;
  bull_case: string | null;
  bear_case: string | null;
  confidence: TokenAnalysis["confidence"] | null;
  sources: TokenAnalysis["sources"] | null;
}

function toTokenAnalysisRow(row: RawRow): TokenAnalysisRow {
  const hasData = row.social_momentum !== null && row.onchain_activity !== null && row.bull_case !== null;
  return {
    status: row.status,
    startedAt: row.started_at,
    computedAt: row.computed_at,
    data: hasData
      ? {
          catalysts: row.catalysts ?? [],
          socialMomentum: row.social_momentum!,
          onchainActivity: row.onchain_activity!,
          tokenomicsNote: row.tokenomics_note ?? "",
          narrativePosition: row.narrative_position ?? "",
          risks: row.risks ?? [],
          bullCase: row.bull_case!,
          bearCase: row.bear_case ?? "",
          confidence: row.confidence ?? "low",
          sources: row.sources ?? [],
        }
      : null,
  };
}

/**
 * Global, coingecko_id-keyed cache — see the SQL this feature shipped
 * with for why (deliberately the same shape as trend_explanations: a
 * future "token encyclopedia" lookup page can read this exact table by
 * id, no rework needed). Read via serviceDb() always — callers (the
 * Server Actions below) are what gate this behind requireUser(), not RLS,
 * same pattern trendPeers.ts's own getCachedExplanation already uses.
 */
export async function getTokenAnalysis(coingeckoId: string): Promise<TokenAnalysisRow | null> {
  const { data, error } = await serviceDb()
    .from("token_analyses")
    .select(
      "status, started_at, computed_at, catalysts, social_momentum, onchain_activity, tokenomics_note, narrative_position, risks, bull_case, bear_case, confidence, sources",
    )
    .eq("coingecko_id", coingeckoId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load token_analyses: ${error.message}`);
  if (!data) return null;
  return toTokenAnalysisRow(data as RawRow);
}

/**
 * CAS claim, same "update a stale/idle row, or insert if none exists yet"
 * shape as every other job in this app — the wrinkle here (unlike a
 * wallet's sync columns, which always already exist by the time a sync is
 * attempted) is that a token's very first-ever analysis has no row to
 * update at all, so a plain UPDATE...WHERE can't tell "doesn't exist" from
 * "already running" on its own; this checks for that explicitly before
 * falling back to INSERT. `status: "refreshing"` is deliberately one of
 * jobStatus.ts's own IN_PROGRESS_STATUSES strings (not a bespoke value),
 * so this table's rows can be read with the exact same deriveJobStatus
 * this app's every other job button already uses.
 */
export async function claimTokenAnalysis(coingeckoId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - JOB_STALE_MS).toISOString();

  const { data: claimed, error: updateError } = await serviceDb()
    .from("token_analyses")
    .update({ status: "refreshing", started_at: nowIso })
    .eq("coingecko_id", coingeckoId)
    .or(`status.is.null,status.neq.refreshing,started_at.lt.${staleBefore}`)
    .select("coingecko_id");
  if (updateError) throw new Error(`Failed to claim token_analyses: ${updateError.message}`);
  if (claimed && claimed.length > 0) return true;

  const { data: existing, error: existingError } = await serviceDb()
    .from("token_analyses")
    .select("coingecko_id")
    .eq("coingecko_id", coingeckoId)
    .maybeSingle();
  if (existingError) throw new Error(`Failed to check token_analyses: ${existingError.message}`);
  if (existing) return false; // genuinely already running, not stale — someone else has the claim

  const { error: insertError } = await serviceDb()
    .from("token_analyses")
    .insert({ coingecko_id: coingeckoId, status: "refreshing", started_at: nowIso });
  if (insertError) {
    // A unique-violation here means another request's own insert won the
    // race between our existence check and this insert — same "someone
    // else already claimed it" outcome, not a real failure.
    if (insertError.code === "23505") return false;
    throw new Error(`Failed to claim token_analyses: ${insertError.message}`);
  }
  return true;
}

/** The actual Perplexity call + write — only ever invoked from inside a
 * Server Action's after() (see watchlist/actions.ts's refreshTokenAnalysis),
 * never awaited directly, for the same "don't freeze the app's whole
 * navigation queue on a ~20-30s call" reason every other slow action in
 * this app already follows. Failure still writes a real status (never
 * leaves the row stuck on "refreshing" forever) so the claim can be
 * retried instead of permanently wedged. */
export async function runTokenAnalysis(coingeckoId: string, ticker: string, name: string): Promise<void> {
  try {
    const result = await analyzeToken(ticker, name);
    if (!result) {
      const { error } = await serviceDb()
        .from("token_analyses")
        .update({ status: "error: Perplexity lookup failed or timed out" })
        .eq("coingecko_id", coingeckoId);
      if (error) throw new Error(`Failed to save token_analyses failure: ${error.message}`);
      return;
    }
    const { error } = await serviceDb()
      .from("token_analyses")
      .update({
        status: "ok",
        catalysts: result.catalysts,
        social_momentum: result.socialMomentum,
        onchain_activity: result.onchainActivity,
        tokenomics_note: result.tokenomicsNote,
        narrative_position: result.narrativePosition,
        risks: result.risks,
        bull_case: result.bullCase,
        bear_case: result.bearCase,
        confidence: result.confidence,
        sources: result.sources,
        computed_at: new Date().toISOString(),
      })
      .eq("coingecko_id", coingeckoId);
    if (error) throw new Error(`Failed to save token_analyses: ${error.message}`);
  } catch (e) {
    await serviceDb()
      .from("token_analyses")
      .update({ status: `error: ${(e as Error).message}` })
      .eq("coingecko_id", coingeckoId);
  }
}
