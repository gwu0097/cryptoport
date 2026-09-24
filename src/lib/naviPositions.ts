// Navi lending positions → holdings (adapters/naviLending.ts fetches them
// with Navi's own SDK, which reads the protocol's on-chain state; see
// naviPositions.test.ts). Navi deposits live inside the protocol, not as a
// coin in the wallet, so a Sui balance scan never sees them (reported
// 2026-09-24: a Ledger wallet's ~$327 Navi supply was missing).
//
// Same shape as kaminoPositions.ts: a supply-only account becomes one row
// per supplied token; an account that also borrows becomes ONE net row
// (supplied − borrowed), because the two interact — debt is never stored as
// its own negative row.
//
// Value = amount × the token's own price from Navi's market data. Not the
// SDK's `valueUSD`: for vSUI that is amount × SUI's price (Navi's
// conservative collateral valuation), $305.78 vs the $328.19 the 303.03
// vSUI are actually worth — Slush showed $327.52.

export interface NaviPositionLike {
  type: string; // "navi-lending-supply" | "navi-lending-borrow" | …
  [key: string]: unknown;
}

interface Leg {
  amount?: string | number;
  token?: { coinType?: string; symbol?: string; price?: string | number; logoUri?: string };
}

export interface NaviHolding {
  ticker: string;
  qty: number | null;
  usd_override: number;
  contract: string | null;
  category: "defi";
  chain: "sui";
  icon_url: string | null;
  protocol: "Navi";
  protocol_url: string;
  protocol_section: "Supplied" | "Net position";
  display_label: string | null;
}

const APP_URL = "https://app.naviprotocol.io/";
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function naviPositionsToHoldings(positions: readonly NaviPositionLike[]): { holdings: NaviHolding[]; unpriced: string[] } {
  const legs = positions.map((p) => ({ side: p.type.endsWith("-borrow") ? "borrow" : p.type.endsWith("-supply") ? "supply" : "other", leg: p[p.type] as Leg | undefined }));
  const unpriced: string[] = [];
  const valued = legs.flatMap(({ side, leg }) => {
    const amount = num(leg?.amount);
    const price = num(leg?.token?.price);
    if (side === "other" || !leg?.token || amount === null || amount <= 0) return [];
    if (price === null) {
      unpriced.push(`${side} ${leg.token.symbol ?? "?"}`);
      return [];
    }
    return [{ side, amount, usd: amount * price, token: leg.token }];
  });
  const borrows = valued.filter((v) => v.side === "borrow");
  const supplies = valued.filter((v) => v.side === "supply");
  const base = { category: "defi" as const, chain: "sui" as const, protocol: "Navi" as const, protocol_url: APP_URL };

  if (borrows.length === 0) {
    return {
      unpriced,
      holdings: supplies.map((s) => ({
        ...base,
        ticker: (s.token.symbol ?? "?").toUpperCase(),
        qty: s.amount,
        usd_override: s.usd,
        contract: s.token.coinType ?? null,
        icon_url: s.token.logoUri?.startsWith("http") ? s.token.logoUri : null,
        protocol_section: "Supplied" as const,
        display_label: null,
      })),
    };
  }
  const net = supplies.reduce((a, s) => a + s.usd, 0) - borrows.reduce((a, b) => a + b.usd, 0);
  const describe = (xs: typeof valued) => xs.map((x) => `${+x.amount.toPrecision(6)} ${x.token.symbol}`).join(", ") || "nothing";
  return {
    unpriced,
    holdings: [
      {
        ...base,
        ticker: "NAVI-NET",
        qty: null,
        usd_override: net,
        contract: null,
        icon_url: null,
        protocol_section: "Net position",
        display_label: `Navi net: supplied ${describe(supplies)} − borrowed ${describe(borrows)}`,
      },
    ],
  };
}
