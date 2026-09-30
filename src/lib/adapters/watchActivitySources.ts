import "server-only";
import { fetchWithRetry } from "./http";
import { ALCHEMY_HOSTS, blockTimes } from "./alchemy";
import { fetchBitcoinTransactions } from "./bitcoinTx";
import { isRouteResidue, type RawChange } from "../watchActivity";

// The activity check's reads (docs/wallet-watch/PLAN.md, phase 4): an
// address's transactions from its cursor (where the last check stopped) —
// or, never checked, back to the last full read's start — reduced to each
// coin's change for the address. Checked live 2026-09-28: Helius 0.6–1 s a
// page of 100, Alchemy ~0.9 s a chain. A failure throws (the address is
// then "not checked" and its cursor stays): an error is never an empty
// result (CLAUDE.md §4.3).

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

/** Pages read per source per check (100 transactions each). Past it the
 * cursor still moves to the newest, and the address says "partial". */
export const MAX_PAGES = 5;
/** Alchemy reports a router's native payout ("internal") only on these
 * (checked live on all 20 hosts, 2026-09-28); elsewhere a token sold for
 * the native coin looks one-sided (watchActivity.ts "unclear"). */
export const INTERNAL_TRANSFER_CHAINS: ReadonlySet<string> = new Set(["eth", "base", "matic"]);
/** Re-read this many blocks behind an EVM cursor: a block re-organized after
 * the last check is read again (legs are deduped by transaction). */
const REORG_BLOCKS = 20;
const WSOL = "So11111111111111111111111111111111111111112";

export interface SourceRead {
  changes: RawChange[];
  /** Where this read stopped (null: nothing was ever seen). */
  cursor: string | null;
  /** The page cap was reached: older transactions since the boundary weren't read. */
  partial: boolean;
  /** EVM: the oldest block and time among the transfers read (Recent
   * trades' stored coverage, watchHistory.ts); null when none were. */
  oldestBlock?: string | null;
  oldestAt?: string | null;
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  fee: number;
  feePayer: string;
  transactionError: unknown;
  accountData?: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
  }[];
  tokenTransfers?: { fromUserAccount: string | null; toUserAccount: string | null; mint: string }[];
  nativeTransfers?: { fromUserAccount: string | null; toUserAccount: string | null; amount: number }[];
}

async function heliusPage(address: string, query: Record<string, string>): Promise<HeliusTx[]> {
  if (!HELIUS_API_KEY) throw new Error("Helius: no API key");
  const params = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: "100", ...query });
  const res = await fetchWithRetry(`https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Helius: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`Helius: ${JSON.stringify(body).slice(0, 120)}`);
  return body as HeliusTx[];
}

/** The other side of a one-way move, when there's a single one. */
function otherSide(list: readonly { fromUserAccount: string | null; toUserAccount: string | null }[], owner: string): string | null {
  const sides = new Set(list.flatMap((t) => (t.fromUserAccount === owner ? [t.toUserAccount] : t.toUserAccount === owner ? [t.fromUserAccount] : [])).filter((a): a is string => !!a && a !== owner));
  return sides.size === 1 ? [...sides][0] : null;
}

/** A Solana address via Helius's parsed transactions: the owner's own
 * balance changes per transaction (tokens, and SOL with the fee added back —
 * wrapped SOL counts as SOL). */
export async function readSolana(address: string, cursor: string | null, boundaryMs: number, maxPages = MAX_PAGES, startBefore?: string | null): Promise<SourceRead> {
  const txs: HeliusTx[] = [];
  // `startBefore`: read older than this signature (a backfill extending the
  // stored history back); `cursor`: stop at this one (only what's newer).
  let before: string | undefined = startBefore ?? undefined;
  let partial = false;
  for (let page = 0; page < maxPages; page++) {
    const list = await heliusPage(address, { ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) });
    txs.push(...list);
    if (list.length < 100) break;
    if (!cursor && list.at(-1)!.timestamp * 1000 < boundaryMs) break;
    before = list.at(-1)!.signature;
    if (page === maxPages - 1) partial = true;
  }
  const changes: RawChange[] = [];
  for (const tx of txs) {
    if (tx.transactionError || tx.timestamp * 1000 < boundaryMs) continue;
    const at = new Date(tx.timestamp * 1000).toISOString();
    let lamports = tx.accountData?.find((a) => a.account === address)?.nativeBalanceChange ?? 0;
    if (tx.feePayer === address) lamports += tx.fee;
    const byMint = new Map<string, { raw: number; decimals: number }>();
    for (const c of (tx.accountData ?? []).flatMap((a) => a.tokenBalanceChanges ?? [])) {
      if (c.userAccount !== address) continue;
      const raw = Number(c.rawTokenAmount.tokenAmount);
      if (c.mint === WSOL) lamports += raw * 10 ** (9 - c.rawTokenAmount.decimals);
      else byMint.set(c.mint, { raw: (byMint.get(c.mint)?.raw ?? 0) + raw, decimals: c.rawTokenAmount.decimals });
    }
    if (lamports !== 0) {
      changes.push({ txId: tx.signature, at, chain: "solana", contract: null, symbol: "SOL", qty: lamports / 1e9, counterparty: otherSide(tx.nativeTransfers ?? [], address) });
    }
    for (const [mint, { raw, decimals }] of byMint) {
      if (raw === 0 || isRouteResidue(raw, decimals)) continue;
      const qty = raw / 10 ** decimals;
      const moves = (tx.tokenTransfers ?? []).filter((t) => t.mint === mint);
      changes.push({ txId: tx.signature, at, chain: "solana", contract: mint, symbol: null, qty, counterparty: otherSide(moves, address) });
    }
  }
  const oldest = txs.at(-1);
  return { changes, cursor: txs[0]?.signature ?? cursor, partial, oldestBlock: oldest?.signature ?? null, oldestAt: oldest ? new Date(oldest.timestamp * 1000).toISOString() : null };
}

interface AlchemyTransfer {
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  rawContract: { address: string | null };
  blockNum: string;
  metadata: { blockTimestamp: string } | null;
}

async function alchemyPage(host: string, params: Record<string, unknown>): Promise<{ transfers: AlchemyTransfer[]; pageKey: string | null }> {
  const res = await fetchWithRetry(`https://${host}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [params] }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Alchemy (${host}): HTTP ${res.status}`);
  const body: { result?: { transfers: AlchemyTransfer[]; pageKey?: string }; error?: { message: string } } = await res.json();
  if (body.error) throw new Error(`Alchemy (${host}): ${body.error.message}`);
  return { transfers: body.result?.transfers ?? [], pageKey: body.result?.pageKey ?? null };
}

/** Whether Alchemy serves this chain (the rest are "not checked"). */
export function evmCheckable(chain: string): boolean {
  return !!ALCHEMY_HOSTS[chain];
}

/** One EVM chain of an address via Alchemy's transfers, newest first, both
 * directions; the cursor is the newest block seen. */
export async function readEvmChain(address: string, chain: string, cursor: string | null, boundaryMs: number, maxPages = MAX_PAGES, toBlock?: string | null): Promise<SourceRead> {
  const host = ALCHEMY_HOSTS[chain];
  if (!host || !ALCHEMY_API_KEY) throw new Error(`Alchemy: ${chain} not served`);
  const lower = address.toLowerCase();
  const category = INTERNAL_TRANSFER_CHAINS.has(chain) ? ["external", "internal", "erc20"] : ["external", "erc20"];
  const fromBlock = cursor ? `0x${Math.max(0, parseInt(cursor, 16) - REORG_BLOCKS).toString(16)}` : undefined;
  let partial = false;
  const byId = new Map<string, AlchemyTransfer>();
  for (const direction of ["fromAddress", "toAddress"] as const) {
    let pageKey: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const r = await alchemyPage(host, {
        [direction]: address,
        category,
        order: "desc",
        maxCount: "0x64",
        withMetadata: true,
        excludeZeroValue: true,
        ...(fromBlock ? { fromBlock } : {}),
        ...(toBlock ? { toBlock } : {}),
        ...(pageKey ? { pageKey } : {}),
      });
      for (const t of r.transfers) byId.set(t.uniqueId, t);
      pageKey = r.pageKey;
      if (!pageKey) break;
      const last = r.transfers.at(-1)?.metadata?.blockTimestamp;
      if (!cursor && last && Date.parse(last) < boundaryMs) break;
      if (page === maxPages - 1) partial = true;
    }
  }
  const transfers = [...byId.values()];
  // Some networks return no timestamps (Scroll, zkSync, Linea, Avalanche).
  const untimed = transfers.filter((t) => !t.metadata?.blockTimestamp).map((t) => t.blockNum);
  const times = untimed.length > 0 ? await blockTimes(host, untimed) : new Map<string, string>();
  const changes: RawChange[] = [];
  for (const t of transfers) {
    if (t.value === null || t.value === 0) continue;
    const out = t.from.toLowerCase() === lower;
    const into = t.to?.toLowerCase() === lower;
    if (out === into) continue; // a self-transfer moves nothing
    const at = t.metadata?.blockTimestamp ?? times.get(t.blockNum)!;
    if (Date.parse(at) < boundaryMs) continue;
    changes.push({
      txId: t.hash,
      at: new Date(at).toISOString(),
      chain,
      contract: t.category === "erc20" ? (t.rawContract.address?.toLowerCase() ?? null) : null,
      symbol: t.asset,
      qty: out ? -t.value : t.value,
      counterparty: out ? t.to : t.from,
    });
  }
  const newest = transfers.reduce((m, t) => Math.max(m, parseInt(t.blockNum, 16)), cursor ? parseInt(cursor, 16) : 0);
  const oldest = transfers.reduce((m, t) => Math.min(m, parseInt(t.blockNum, 16)), Infinity);
  const oldestAt = changes.map((c) => c.at).sort()[0] ?? null;
  return { changes, cursor: newest > 0 ? `0x${newest.toString(16)}` : cursor, partial, oldestBlock: Number.isFinite(oldest) ? `0x${oldest.toString(16)}` : null, oldestAt };
}

/** A Bitcoin address (Blockstream, bitcoinTx.ts): its recent transactions
 * since the boundary. No cursor — the list is short and deduped by txid. */
export async function readBitcoin(address: string, boundaryMs: number): Promise<SourceRead> {
  const txs = await fetchBitcoinTransactions([address]);
  const changes: RawChange[] = txs
    .filter((t) => Date.parse(t.occurredAt) >= boundaryMs && t.amount !== null && (t.direction === "in" || t.direction === "out"))
    .map((t) => ({ txId: t.txHash, at: t.occurredAt, chain: "bitcoin", contract: null, symbol: "BTC", qty: t.direction === "out" ? -t.amount! : t.amount!, counterparty: t.counterparty }));
  return { changes, cursor: null, partial: false };
}
