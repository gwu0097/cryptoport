import "server-only";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2sh, p2wpkh } from "@scure/btc-signer";
import { mapWithConcurrency } from "./http";
import { fetchAddressStats, satsFromStats } from "./bitcoinShared";

export type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh";

// SLIP-132 extended-key version bytes. @scure/bip32's HDKey.fromExtendedKey
// only recognizes the plain BIP32 xpub/xprv bytes by default — ypub/zpub
// need their version bytes passed explicitly or decoding fails outright.
//
// ypub/zpub unambiguously mean BIP49/BIP84 (that's the whole point of the
// SLIP-132 prefix). Plain "xpub" does NOT reliably mean BIP44/legacy,
// though — confirmed against a real Ledger Native SegWit account: Ledger's
// own xpub-export feature uses the generic "xpub" prefix regardless of the
// account's actual type, so a plain xpub is derived and checked under all
// three script types below (unless a cached type is already known — see
// scanExtendedKey) rather than assumed to be legacy P2PKH.
const XPUB_VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };
const EXTENDED_KEY_FORMATS: Record<
  string,
  { versions: { private: number; public: number }; scriptTypes: ScriptType[] }
> = {
  xpub: { versions: XPUB_VERSIONS, scriptTypes: ["p2wpkh", "p2sh-p2wpkh", "p2pkh"] }, // ambiguous — try all
  ypub: { versions: { private: 0x049d7878, public: 0x049d7cb2 }, scriptTypes: ["p2sh-p2wpkh"] }, // BIP49
  zpub: { versions: { private: 0x04b2430c, public: 0x04b24746 }, scriptTypes: ["p2wpkh"] }, // BIP84
};

const EXTENDED_PUBLIC_KEY_RE = /^(xpub|ypub|zpub)[1-9A-HJ-NP-Za-km-z]{100,116}$/;

export function isExtendedPublicKey(value: string): boolean {
  return EXTENDED_PUBLIC_KEY_RE.test(value);
}

function deriveAddress(hdkey: HDKey, scriptType: ScriptType): string {
  const pubkey = hdkey.publicKey;
  if (!pubkey) throw new Error("Derived HD key has no public key.");
  if (scriptType === "p2wpkh") return p2wpkh(pubkey).address!;
  if (scriptType === "p2pkh") return p2pkh(pubkey).address!;
  return p2sh(p2wpkh(pubkey)).address!;
}

// Standard BIP44/49/84 "gap limit" convention (same value Electrum, Ledger
// Live, and most wallets use): stop scanning a chain once this many
// consecutive addresses in a row have never had a transaction. Scanned in
// gap-limit-sized batches (checked concurrently) rather than strictly one
// at a time — an entire empty batch is treated as "found the gap", which
// matches the convention closely enough for any wallet that isn't
// deliberately working around gap-limit scanning itself.
const GAP_LIMIT = 20;
const MAX_INDEX = 2000; // hard ceiling per chain — safety valve, not a real-world limit
// Lower than the EVM adapter's CHUNK_CONCURRENCY (5) — confirmed empirically
// that mempool.space's anonymous tier 429s under fully unthrottled
// sequential calls, and this is a brand-new adapter with no prior tuning
// history the way the EVM one had. fetchWithRetry's backoff is still the
// main defense; this and the inter-batch pause just reduce how often it
// needs to kick in.
const ADDRESS_CONCURRENCY = 3;
const BATCH_PAUSE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanChain(chainKey: HDKey, scriptType: ScriptType): Promise<{ sats: number; used: boolean }> {
  let totalSats = 0;
  let anyUsed = false;

  for (let batchStart = 0; batchStart < MAX_INDEX; batchStart += GAP_LIMIT) {
    if (batchStart > 0) await sleep(BATCH_PAUSE_MS);

    const indexes = Array.from({ length: GAP_LIMIT }, (_, i) => batchStart + i);
    const batch = await mapWithConcurrency(indexes, ADDRESS_CONCURRENCY, async (i) => {
      const address = deriveAddress(chainKey.deriveChild(i), scriptType);
      const stats = await fetchAddressStats(address);
      const used = stats.chain_stats.tx_count > 0 || stats.mempool_stats.tx_count > 0;
      return { used, sats: satsFromStats(stats) };
    });

    totalSats += batch.reduce((sum, r) => sum + r.sats, 0);
    if (batch.some((r) => r.used)) anyUsed = true;
    if (batch.every((r) => !r.used)) break; // a full gap-limit window with nothing used — done
  }

  return { sats: totalSats, used: anyUsed };
}

export interface ScanResult {
  sats: number;
  /** Which script type actually has activity — null only when the key is
   * genuinely ambiguous *and* nothing was found under any type checked
   * (either a fresh/empty wallet, or real funds spread across more than
   * one format, which is rare but real: caching a single type there would
   * silently under-report the other from then on, so it's deliberately
   * left uncached and every sync keeps checking all three). */
  detectedScriptType: ScriptType | null;
}

/**
 * Scans an HD wallet account (xpub/ypub/zpub) the way Ledger Live/Electrum
 * do: derive every address on both the external (receive, chain 0) and
 * internal (change, chain 1) chains up to the gap limit, sum whatever has
 * a balance. Public-key-only derivation (BIP32 CKDpub) — no private key
 * material is ever involved, this can only ever read balances.
 *
 * `cachedScriptType` (from a wallet's previously-detected btc_script_type —
 * see wallets/actions.ts) skips straight to that one format instead of
 * checking all three, since real funds only ever show up under the format
 * the account was actually built with — cuts the address-lookup count
 * (and the wall-clock time, given each one is a real, deliberately-paced
 * network call) by roughly two-thirds on every sync after the first.
 * `forceFullScan` ignores the cache and re-checks everything, for e.g. a
 * wallet that's switched to a different address format.
 */
export async function scanExtendedKey(
  extendedKey: string,
  options: { cachedScriptType?: ScriptType | null; forceFullScan?: boolean } = {},
): Promise<ScanResult> {
  const format = EXTENDED_KEY_FORMATS[extendedKey.slice(0, 4)];
  if (!format) throw new Error(`Unrecognized extended public key prefix in "${extendedKey.slice(0, 4)}...".`);

  const account = HDKey.fromExtendedKey(extendedKey, format.versions);
  const external = account.deriveChild(0);
  const internal = account.deriveChild(1);

  const scriptTypes =
    !options.forceFullScan && options.cachedScriptType ? [options.cachedScriptType] : format.scriptTypes;

  const chainScans = scriptTypes.flatMap((scriptType) => [
    { scriptType, run: () => scanChain(external, scriptType) },
    { scriptType, run: () => scanChain(internal, scriptType) },
  ]);
  // A plain xpub with no cache means up to 6 chain-scans (3 script types x
  // 2 chains) — concurrency capped so this can't multiply with
  // ADDRESS_CONCURRENCY into a much bigger burst than the single-type
  // (cached, ypub, or zpub) case already runs safely.
  const results = await mapWithConcurrency(chainScans, 2, (s) =>
    s.run().then((r) => ({ ...r, scriptType: s.scriptType })),
  );

  const sats = results.reduce((sum, r) => sum + r.sats, 0);
  const usedTypes = [...new Set(results.filter((r) => r.used).map((r) => r.scriptType))];
  const detectedScriptType =
    scriptTypes.length === 1 ? scriptTypes[0] : usedTypes.length === 1 ? usedTypes[0] : null;

  return { sats, detectedScriptType };
}
