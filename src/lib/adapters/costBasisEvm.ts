import "server-only";
import { fetchWithRetry } from "./http";
import { ALCHEMY_HOSTS } from "./alchemy";

// One EVM token's history in one wallet, for its cost basis (costBasis.ts):
// the token's own transfers in and out (alchemy_getAssetTransfers filtered to
// its contract — two calls, paged), then, for each transaction that brought
// it in, what the wallet paid in it: the ETH it sent (the transaction's value,
// when the wallet sent it) and any other token it sent out (the receipt's
// Transfer logs from the wallet) — one batched request for all of them.
// Raw amounts; the caller values them at that day's close.

const KEY = process.env.ALCHEMY_API_KEY;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAGES = 5;

export interface PaidLeg {
  /** null: the chain's native coin (ETH). */
  contract: string | null;
  /** Base units (wei, or the token's smallest unit). */
  raw: bigint;
}

export interface RawCostEvent {
  at: string;
  txHash: string;
  /** Signed, in the token's units. */
  qty: number;
  /** What the wallet sent in the transaction (ins only); empty = nothing seen. */
  paid: PaidLeg[];
}

interface Transfer {
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  metadata?: { blockTimestamp?: string };
}

async function rpc<T>(host: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`https://${host}.g.alchemy.com/v2/${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (!res.ok) throw new Error(`Alchemy (${host}): HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function transfers(host: string, direction: "fromAddress" | "toAddress", address: string, contract: string): Promise<{ list: Transfer[]; partial: boolean }> {
  const list: Transfer[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const body = await rpc<{ result?: { transfers: Transfer[]; pageKey?: string }; error?: { message: string } }>(host, {
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getAssetTransfers",
      params: [{ [direction]: address, contractAddresses: [contract], category: ["erc20"], withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", order: "asc", ...(pageKey ? { pageKey } : {}) }],
    });
    if (body.error) throw new Error(`Alchemy (${host}): ${body.error.message}`);
    list.push(...(body.result?.transfers ?? []));
    pageKey = body.result?.pageKey;
    if (!pageKey) return { list, partial: false };
  }
  return { list, partial: true };
}

/** The token's movements in the wallet, each in with what was paid. Throws
 * when the chain isn't served or a read fails (never "no history"). */
export async function evmCostEvents(address: string, chain: string, contract: string): Promise<{ events: RawCostEvent[]; partial: boolean }> {
  const host = ALCHEMY_HOSTS[chain];
  if (!host || !KEY) throw new Error(`Cost basis isn't available on ${chain} yet`);
  const me = address.toLowerCase();
  const token = contract.toLowerCase();
  const [ins, outs] = await Promise.all([transfers(host, "toAddress", address, contract), transfers(host, "fromAddress", address, contract)]);

  // Net per transaction (a route can pass the token through the wallet).
  const byTx = new Map<string, { at: string; qty: number }>();
  for (const t of [...ins.list, ...outs.list]) {
    if (t.value === null || !t.metadata?.blockTimestamp) continue;
    const into = t.to?.toLowerCase() === me;
    const out = t.from.toLowerCase() === me;
    if (into === out) continue;
    const cur = byTx.get(t.hash) ?? { at: new Date(t.metadata.blockTimestamp).toISOString(), qty: 0 };
    cur.qty += into ? t.value : -t.value;
    byTx.set(t.hash, cur);
  }
  const inHashes = [...byTx].filter(([, v]) => v.qty > 0).map(([h]) => h);

  // What the wallet sent in each of those transactions: one batch request.
  const paid = new Map<string, PaidLeg[]>();
  for (let i = 0; i < inHashes.length; i += 50) {
    const chunk = inHashes.slice(i, i + 50);
    const batch = chunk.flatMap((h, j) => [
      { jsonrpc: "2.0", id: j * 2, method: "eth_getTransactionByHash", params: [h] },
      { jsonrpc: "2.0", id: j * 2 + 1, method: "eth_getTransactionReceipt", params: [h] },
    ]);
    const answers = await rpc<{ id: number; result?: unknown; error?: { message: string } }[]>(host, batch);
    const byId = new Map(answers.map((a) => [a.id, a.result]));
    chunk.forEach((h, j) => {
      const tx = byId.get(j * 2) as { from?: string; value?: string } | null | undefined;
      const receipt = byId.get(j * 2 + 1) as { logs?: { address: string; topics: string[]; data: string }[] } | null | undefined;
      const legs: PaidLeg[] = [];
      if (tx?.from?.toLowerCase() === me && tx.value && BigInt(tx.value) > BigInt(0)) legs.push({ contract: null, raw: BigInt(tx.value) });
      for (const log of receipt?.logs ?? []) {
        if (log.topics[0] !== TRANSFER || log.topics.length < 3 || log.address.toLowerCase() === token) continue;
        if (`0x${log.topics[1].slice(26)}`.toLowerCase() !== me) continue;
        if (log.data && log.data !== "0x") legs.push({ contract: log.address.toLowerCase(), raw: BigInt(log.data) });
      }
      paid.set(h, legs);
    });
  }

  const events = [...byTx].map(([txHash, v]) => ({ at: v.at, txHash, qty: v.qty, paid: v.qty > 0 ? (paid.get(txHash) ?? []) : [] }));
  return { events, partial: ins.partial || outs.partial };
}
