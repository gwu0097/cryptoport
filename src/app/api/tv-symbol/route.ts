import type { NextRequest } from "next/server";
import { resolveTradingViewSymbol } from "@/lib/adapters/exchangeListings";

// GET /api/tv-symbol?t=WEN&t=BTC -> { "WEN": { symbol: "MEXC:WENUSDT", exchange: "MEXC" }, ... }
// A route handler, not a Server Action: Server Actions share one sequential
// queue per client with navigation (CLAUDE.md), and expanding a table row
// shouldn't be able to stall the app. Public, read-only, bounded input.
const TICKER = /^[A-Za-z0-9]{1,20}$/;

export async function GET(request: NextRequest): Promise<Response> {
  const tickers = [...new Set(request.nextUrl.searchParams.getAll("t"))].filter((t) => TICKER.test(t)).slice(0, 3);
  if (tickers.length === 0) return Response.json({ error: "t (ticker) required" }, { status: 400 });
  const entries = await Promise.all(tickers.map(async (t) => [t.toUpperCase(), await resolveTradingViewSymbol(t)] as const));
  return Response.json(Object.fromEntries(entries));
}
