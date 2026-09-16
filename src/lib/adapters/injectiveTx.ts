import "server-only";
import { fetchWithRetry } from "./http";
import type { AdapterTransaction } from "./types";

// Injective's own public indexer — NOT the generic Cosmos SDK LCD
// tx-search (`/cosmos/tx/v1beta1/txs?query=...`), which live-verified
// (2026-09) as returning zero results against a real wallet in this app
// with 52 known signed transactions, on both injective-rest.publicnode.com
// and cosmos-rest.publicnode.com's equivalent for ATOM — see
// transactionsChainBacklog memory for the fuller writeup. This indexer,
// by contrast, correctly returned all 88 real transactions for the same
// test wallet. Keyless, no auth header needed.
const API_BASE = "https://sentry.exchange.grpc-web.injective.network/api/explorer/v1";
const EXPLORER_BASE = "https://explorer.injective.network/transaction";
const NATIVE_DENOM = "inj";
const INJ_DECIMALS = 1e18;
const PAGE_LIMIT = 50;

interface Coin {
  denom: string;
  amount: string;
}

interface MsgSendValue {
  from_address: string;
  to_address: string;
  amount: Coin[];
}

interface MsgMultiSendValue {
  inputs: { address: string; coins: Coin[] }[];
  outputs: { address: string; coins: Coin[] }[];
}

interface Message {
  type: string;
  value: unknown;
}

interface AccountTx {
  hash: string;
  block_timestamp: string;
  code: number;
  gas_fee: { amount: Coin[]; payer: string };
  messages: Message[];
}

interface AccountTxsResponse {
  paging: { total: number };
  data: AccountTx[];
}

function nativeAmount(coins: Coin[]): number {
  return coins.filter((c) => c.denom === NATIVE_DENOM).reduce((sum, c) => sum + Number(c.amount), 0) / INJ_DECIMALS;
}

/** Net native-INJ effect on `address` from a single message, or null if
 * this message type doesn't move native coin at all (the common case on
 * Injective — see this file's own doc comment: exchange/order/staking
 * messages carry no plain transfer semantics, and guessing at one would
 * be exactly the "plausible-looking wrong number" this app's data-
 * correctness rule forbids). Handles the two message types that do:
 * MsgSend (a single sender/recipient pair) and MsgMultiSend (Injective's
 * own indexer showed this is actually the dominant real pattern — often a
 * batch airdrop-style distribution to many recipients at once, so this
 * sums every input/output leg touching `address` rather than assuming
 * exactly one of each). */
function nativeEffect(msg: Message, address: string): { net: number; counterparty: string | null } | null {
  if (msg.type === "/cosmos.bank.v1beta1.MsgSend") {
    const v = msg.value as MsgSendValue;
    const amount = nativeAmount(v.amount ?? []);
    if (amount === 0) return null;
    if (v.to_address === address) return { net: amount, counterparty: v.from_address };
    if (v.from_address === address) return { net: -amount, counterparty: v.to_address };
    return null;
  }
  if (msg.type === "/cosmos.bank.v1beta1.MsgMultiSend") {
    const v = msg.value as MsgMultiSendValue;
    let net = 0;
    let counterparty: string | null = null;
    for (const input of v.inputs ?? []) {
      if (input.address === address) net -= nativeAmount(input.coins ?? []);
      else if (!counterparty) counterparty = input.address;
    }
    for (const output of v.outputs ?? []) {
      if (output.address === address) net += nativeAmount(output.coins ?? []);
      else if (!counterparty) counterparty = output.address;
    }
    if (net === 0) return null;
    return { net, counterparty };
  }
  return null;
}

/**
 * A wallet's Injective transaction history — native INJ only (same
 * native-only scope as cosmos.ts's balance tracking; CW20/EVM-side
 * tokens are a separate backlog item). Most real activity on this chain
 * is exchange/order/staking messages with no plain transfer semantics —
 * those still appear as a row (hash/timestamp/fee), just with
 * ticker/amount/counterparty left null rather than guessed at, same
 * pattern as Solana's multi-account swap legs.
 */
export async function fetchInjectiveTransactions(address: string): Promise<AdapterTransaction[]> {
  const res = await fetchWithRetry(`${API_BASE}/accountTxs/${address}?limit=${PAGE_LIMIT}`);
  if (!res.ok) throw new Error(`Injective explorer accountTxs failed: HTTP ${res.status}`);
  const body: AccountTxsResponse = await res.json();

  return (body.data ?? [])
    .filter((tx) => tx.code === 0) // failed txs still cost gas but moved no funds
    .map((tx) => {
      let net = 0;
      let ticker: string | null = null;
      let counterparty: string | null = null;
      for (const msg of tx.messages ?? []) {
        const effect = nativeEffect(msg, address);
        if (effect) {
          net += effect.net;
          ticker = "INJ";
          if (!counterparty) counterparty = effect.counterparty;
        }
      }

      const payer = tx.gas_fee?.payer;
      const fee = payer === address ? nativeAmount(tx.gas_fee?.amount ?? []) : null;

      return {
        txHash: tx.hash,
        chain: "injective",
        occurredAt: new Date(tx.block_timestamp).toISOString(),
        direction: ticker === null ? "unknown" : net > 0 ? "in" : net < 0 ? "out" : "self",
        ticker,
        amount: ticker === null ? null : Math.abs(net),
        counterparty,
        explorerUrl: `${EXPLORER_BASE}/${tx.hash}`,
        fee,
      } satisfies AdapterTransaction;
    });
}
