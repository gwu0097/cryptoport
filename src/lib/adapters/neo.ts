import "server-only";
import { formatUnits } from "viem";
import { fetchWithRetry } from "./http";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

// Free, keyless NEO N3 public RPC nodes — tried in order, same "don't
// depend on one free provider's uptime" reasoning as BTC/BCH/Substrate.
const RPCS = ["https://mainnet1.neo.coz.io:443/", "http://seed1.neo.org:10332"];

// NEO N3 mainnet's own getnep17balances call returns EVERY NEP-17 token an
// address holds, symbol/name included — both attacker-controlled fields on
// an arbitrary token contract. Verified live against a real wallet: its
// balances included a token literally named "GAS Airdrop Ticket" with
// symbol "$GAS Airdrop | stadlelabs.com", and a second contract also
// claiming symbol "GAS" with an implausible 100,000,000-unit balance —
// both spoofing the real GAS token. Only these two canonical native
// contract hashes (well-known, unchanging NEO N3 constants) are trusted;
// everything else this call returns is ignored, same "don't trust
// on-chain symbol claims" reasoning as the EVM adapter's CoinGecko-sourced
// token registry.
const NEO_HASH = "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5";
const GAS_HASH = "0xd2a4cff31913016155e38e474a2c06d08be276cf";

const NEO_ADDRESS_RE = /^N[1-9A-HJ-NP-Za-km-z]{33}$/;

export function isNeoAddress(value: string): boolean {
  return NEO_ADDRESS_RE.test(value);
}

interface Nep17Balance {
  assethash: string;
  amount: string;
}
interface GetNep17BalancesResult {
  balance: Nep17Balance[];
}
interface RpcResponse {
  result?: GetNep17BalancesResult;
  error?: { message: string };
}

async function getNep17Balances(address: string): Promise<Nep17Balance[]> {
  const errors: string[] = [];
  for (const rpc of RPCS) {
    try {
      const res = await fetchWithRetry(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "getnep17balances", params: [address], id: 1 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: RpcResponse = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result?.balance ?? [];
    } catch (e) {
      errors.push(`${rpc}: ${(e as Error).message}`);
    }
  }
  throw new Error(`All NEO RPC endpoints failed — ${errors.join("; ")}`);
}

/**
 * Only NEO and GAS (native, canonical contracts) are tracked here — same
 * native-asset-only scope as every other adapter in this app, and the
 * only way to avoid the spoofed-symbol problem documented above without
 * building out a full trusted-token-registry (CoinGecko doesn't track
 * NEP-17 contract addresses the way it does EVM/Solana tokens).
 */
export async function fetchNeoHoldings(address: string): Promise<AdapterHolding[]> {
  const balances = await getNep17Balances(address);
  const holdings: AdapterHolding[] = [];
  const images = await fetchTokenImages(["neo", "gas"]).catch(() => new Map<string, string>());

  const neo = balances.find((b) => b.assethash.toLowerCase() === NEO_HASH);
  if (neo && Number(neo.amount) > 0) {
    holdings.push({
      ticker: "NEO",
      qty: Number(neo.amount), // NEO is indivisible — 0 decimals
      usd_override: null,
      contract: null,
      category: "token",
      chain: "neo",
      icon_url: images.get("neo") ?? null,
    });
  }

  const gas = balances.find((b) => b.assethash.toLowerCase() === GAS_HASH);
  if (gas) {
    const qty = Number(formatUnits(BigInt(gas.amount), 8));
    if (qty > 0) {
      holdings.push({
        ticker: "GAS",
        qty,
        usd_override: null,
        contract: null,
        category: "token",
        chain: "neo",
        icon_url: images.get("gas") ?? null,
      });
    }
  }

  return holdings;
}
