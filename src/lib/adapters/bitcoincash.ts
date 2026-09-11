import "server-only";
import { createHash } from "crypto";
import { connect as tlsConnect } from "tls";
import { decode as cashaddrDecode } from "cashaddrjs";
import { formatUnits } from "viem";
import { fetchTokenImages } from "./coingecko";
import type { AdapterHolding } from "./types";

/**
 * Bitcoin Cash has no reliable free HTTP indexer left: Blockchair's keyless
 * tier hard-blacklists shared/cloud IPs (verified — got HTTP 430 from this
 * app's own network path on the very first call), fullstack.cash and
 * bitcoin.com's old Insight-style explorer API are both effectively dead.
 * The actual reliable path is the same one every real BCH wallet uses —
 * the Electrum protocol, spoken directly over TLS against a public Fulcrum
 * server (verified live end-to-end against a real wallet's balance). No
 * HTTP indexer in the loop at all, so no indexer-specific rate limit to
 * hit.
 *
 * Multiple independent, volunteer-run servers (not one operator) — same
 * "don't depend on a single free provider's uptime" lesson as BTC's
 * blockstream.info/mempool.space split, just with more redundancy since
 * these are less institutional and more likely to disappear individually.
 */
const ELECTRUM_SERVERS: { host: string; port: number }[] = [
  { host: "bch.imaginary.cash", port: 50002 },
  { host: "cashnode.bch.ninja", port: 50002 },
  { host: "bch.loping.net", port: 50002 },
  { host: "fulcrum.greyh.at", port: 50002 },
];

const CONNECT_TIMEOUT_MS = 6000;
const SATS_PER_BCH = 8;

const CASHADDR_RE = /^(?:bitcoincash:)?[qp][a-z0-9]{41}$/;

export function isBitcoinCashAddress(value: string): boolean {
  return CASHADDR_RE.test(value.toLowerCase());
}

/**
 * CashAddr encodes a payment hash (P2PKH or P2SH), not a scripthash — the
 * Electrum protocol indexes by scripthash instead (sha256 of the actual
 * locking script, byte-reversed, per the protocol spec), so this
 * reconstructs the real on-chain script before hashing rather than hashing
 * the payment hash directly. Verified byte-for-byte: this produces the
 * same scripthash a real Fulcrum server resolves a known funded address's
 * balance under.
 */
function scriptHashFor(address: string): string {
  const { hash, type } = cashaddrDecode(address);
  const hashBytes = Buffer.from(hash);
  const script =
    type === "P2SH"
      ? Buffer.concat([Buffer.from([0xa9, 0x14]), hashBytes, Buffer.from([0x87])])
      : Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hashBytes, Buffer.from([0x88, 0xac])]);
  return createHash("sha256").update(script).digest().reverse().toString("hex");
}

interface ScripthashBalance {
  confirmed: number;
  unconfirmed: number;
}

function queryScripthashBalance(host: string, port: number, scripthash: string): Promise<ScripthashBalance> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(port, host, { rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS });
    let buf = "";
    let settled = false;

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(e);
    };

    socket.once("secureConnect", () => {
      socket.write(
        JSON.stringify({ id: 1, method: "blockchain.scripthash.get_balance", params: [scripthash] }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (!buf.includes("\n")) return;
      settled = true;
      socket.end();
      try {
        const parsed = JSON.parse(buf.trim());
        if (parsed.error) throw new Error(JSON.stringify(parsed.error));
        resolve(parsed.result as ScripthashBalance);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    socket.on("error", fail);
    socket.on("timeout", () => fail(new Error(`Timed out connecting to ${host}:${port}`)));
  });
}

async function fetchBalanceWithFailover(scripthash: string): Promise<ScripthashBalance> {
  const errors: string[] = [];
  for (const { host, port } of ELECTRUM_SERVERS) {
    try {
      return await queryScripthashBalance(host, port, scripthash);
    } catch (e) {
      errors.push(`${host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`All Electrum servers failed — ${errors.join("; ")}`);
}

/**
 * A Bitcoin Cash wallet only ever has one holding tracked here (native
 * BCH) — same native-asset-only scope as bitcoin.ts (no CashTokens/SLP
 * scanning). Includes unconfirmed balance alongside confirmed, same
 * reasoning as everywhere else in this app that real pending economic
 * value isn't silently dropped.
 */
export async function fetchBitcoinCashHoldings(address: string): Promise<AdapterHolding[]> {
  const scripthash = scriptHashFor(address);
  const { confirmed, unconfirmed } = await fetchBalanceWithFailover(scripthash);
  const sats = confirmed + unconfirmed;
  if (sats <= 0) return [];

  const qty = Number(formatUnits(BigInt(sats), SATS_PER_BCH));
  const images = await fetchTokenImages(["bitcoin-cash"]).catch(() => new Map<string, string>());

  return [
    {
      ticker: "BCH",
      qty,
      usd_override: null,
      contract: null,
      category: "token",
      chain: "bitcoincash",
      icon_url: images.get("bitcoin-cash") ?? null,
    },
  ];
}
