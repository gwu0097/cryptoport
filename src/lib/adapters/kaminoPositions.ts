import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterHolding } from "./types";

const API_BASE = "https://api.kamino.finance";
// No per-position deep link in the API response — every Kamino product
// lives at its own top-level app route, but guessing exact sub-paths risks
// a dead/wrong link; the app root is always correct.
const APP_URL = "https://app.kamino.finance";

interface PositionAsset {
  mint: string;
  symbol: string;
  amount: string;
  value: string | null;
}

// Shared by lending, multiply, and leverage — same section shape per
// Kamino's OpenAPI spec (PortfolioLendingPosition).
interface LendingLikePosition {
  tag: string; // "Vanilla" | "Multiply" | "Leverage" | ...
  netValue: string | null;
  deposits: PositionAsset[];
  borrows: PositionAsset[];
}

interface EarnPosition {
  tokenMint: string;
  symbol: string;
  amount: string;
  netValue: string | null;
}

interface LiquidityPosition {
  strategy: string;
  netValue: string | null;
}

interface StakingPosition {
  mint: string;
  symbol: string;
  amount: string;
  value: string | null;
}

interface SectionState {
  indexed: boolean;
  errors: string[];
}

interface PortfolioResponse {
  sections: Record<string, SectionState>;
  lending?: LendingLikePosition[];
  multiply?: LendingLikePosition[];
  leverage?: LendingLikePosition[];
  earn?: EarnPosition[];
  liquidity?: LiquidityPosition[];
  staking?: StakingPosition[];
}

export interface KaminoPositionsResult {
  holdings: AdapterHolding[];
  warnings: string[];
}

function num(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Deposit-only obligations (the common case — a plain lending deposit with
// no borrow against it) are really just the underlying tokens held
// elsewhere, same treatment as Jupiter Earn's single-asset vaults: real
// ticker/qty/contract, priced normally. A leveraged obligation (deposits
// AND borrows both present) can't be decomposed that way — the two
// interact, so only the obligation's own netValue is trustworthy; that
// becomes one synthetic usd_override holding instead.
function lendingLikeHoldings(
  positions: LendingLikePosition[] | undefined,
  protocolPrefix: string,
): AdapterHolding[] {
  const holdings: AdapterHolding[] = [];
  for (const p of positions ?? []) {
    const protocol = p.tag && p.tag !== "Vanilla" ? `${protocolPrefix} ${p.tag}` : protocolPrefix;
    if (p.borrows.length === 0) {
      for (const d of p.deposits) {
        const amount = num(d.amount);
        if (amount <= 0) continue;
        holdings.push({
          ticker: d.symbol,
          qty: amount,
          usd_override: null,
          contract: d.mint,
          category: "defi",
          chain: "solana-defi",
          icon_url: null,
          protocol,
          protocol_url: APP_URL,
        });
      }
    } else {
      const netValue = num(p.netValue);
      if (netValue === 0) continue;
      holdings.push({
        ticker: `KAMINO-${p.tag.toUpperCase()}`,
        qty: null,
        usd_override: netValue,
        contract: null,
        category: "defi",
        chain: "solana-defi",
        icon_url: null,
        protocol,
        protocol_url: APP_URL,
      });
    }
  }
  return holdings;
}

/**
 * Kamino Finance's public portfolio API — one endpoint covers every Kamino
 * product (lending, multiply, leverage, liquidity/CLMM vaults, earn
 * vaults, private credit, and KMNO staking), fully public and keyless
 * (verified: no auth header required, open CORS). Found and verified via
 * real requests against a real wallet — see commit message — after ruling
 * out the SonarWatch npm packages (deprecated, vulnerable) and confirming
 * Jupiter's own public positions API only covers Jupiter's own products.
 *
 * `sections.<name>.indexed: false` with an empty array means that product
 * was never used by this wallet — a real, legitimate $0, not a gap.
 * `sections.<name>.errors[]` (e.g. a stale-slot or reserve-accrual issue)
 * means that section's numbers can't be trusted for this refresh — surfaced
 * as a warning rather than silently shown as zero.
 */
export async function fetchKaminoPositions(address: string): Promise<KaminoPositionsResult> {
  const res = await fetchWithRetry(`${API_BASE}/portfolio/${address}`);
  if (!res.ok) throw new Error(`Kamino portfolio failed: HTTP ${res.status}`);
  const body: PortfolioResponse = await res.json();

  const warnings = Object.entries(body.sections ?? {})
    .filter(([, s]) => s.errors && s.errors.length > 0)
    .map(([name, s]) => `kamino ${name}: ${s.errors.join(", ")}`);

  const holdings: AdapterHolding[] = [
    ...lendingLikeHoldings(body.lending, "Kamino Lending"),
    ...lendingLikeHoldings(body.multiply, "Kamino Multiply"),
    ...lendingLikeHoldings(body.leverage, "Kamino Leverage"),
    ...(body.earn ?? [])
      .filter((e) => num(e.amount) > 0)
      .map(
        (e): AdapterHolding => ({
          ticker: e.symbol,
          qty: num(e.amount),
          usd_override: null,
          contract: e.tokenMint,
          category: "defi",
          chain: "solana-defi",
          icon_url: null,
          protocol: "Kamino Earn",
          protocol_url: APP_URL,
        }),
      ),
    ...(body.liquidity ?? [])
      .filter((l) => num(l.netValue) !== 0)
      .map(
        (l): AdapterHolding => ({
          ticker: "KAMINO-LP",
          qty: null,
          usd_override: num(l.netValue),
          contract: null,
          category: "defi",
          chain: "solana-defi",
          icon_url: null,
          protocol: "Kamino Liquidity",
          protocol_url: APP_URL,
        }),
      ),
    ...(body.staking ?? [])
      .filter((s) => num(s.amount) > 0)
      .map(
        (s): AdapterHolding => ({
          ticker: s.symbol,
          qty: num(s.amount),
          usd_override: null,
          contract: s.mint,
          category: "defi",
          chain: "solana-defi",
          icon_url: null,
          protocol: "Kamino Staking",
          protocol_url: APP_URL,
        }),
      ),
  ];

  return { holdings, warnings };
}
