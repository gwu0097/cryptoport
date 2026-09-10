import "server-only";
import { HDKey } from "@scure/bip32";
import { p2pkh, p2sh, p2wpkh } from "@scure/btc-signer";
import { mapWithConcurrency } from "./http";
import { fetchAddressStats, satsFromStats } from "./bitcoinShared";

type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh";

// SLIP-132 extended-key version bytes. @scure/bip32's HDKey.fromExtendedKey
// only recognizes the plain BIP32 xpub/xprv bytes by default — ypub/zpub
// need their version bytes passed explicitly or decoding fails outright.
//
// ypub/zpub unambiguously mean BIP49/BIP84 (that's the whole point of the
// SLIP-132 prefix). Plain "xpub" does NOT reliably mean BIP44/legacy,
// though — confirmed against a real Ledger Native SegWit account: Ledger's
// own xpub-export feature uses the generic "xpub" prefix regardless of the
// account's actual type, so a plain xpub is derived and checked under all
// three script types below rather than assumed to be legacy P2PKH.
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
// (see commit message) that mempool.space's anonymous tier 429s under fully
// unthrottled sequential calls, and this is a brand-new adapter with no
// prior tuning history the way the EVM one had. fetchWithRetry's backoff is
// still the main defense; this and the inter-batch pause just reduce how
// often it needs to kick in.
const ADDRESS_CONCURRENCY = 3;
const BATCH_PAUSE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanChain(chainKey: HDKey, scriptType: ScriptType): Promise<number> {
  let totalSats = 0;

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
    if (batch.every((r) => !r.used)) break; // a full gap-limit window with nothing used — done
  }

  return totalSats;
}

/**
 * Scans an HD wallet account (xpub/ypub/zpub) the way Ledger Live/Electrum
 * do: derive every address on both the external (receive, chain 0) and
 * internal (change, chain 1) chains up to the gap limit, sum whatever has
 * a balance. Public-key-only derivation (BIP32 CKDpub) — no private key
 * material is ever involved, this can only ever read balances.
 *
 * A plain xpub is scanned under all three script types (see
 * EXTENDED_KEY_FORMATS above) rather than one guessed type — real funds
 * only ever show up under the one the account was actually built with, the
 * other two just cost a quick empty gap-limit batch each.
 */
export async function scanExtendedKey(extendedKey: string): Promise<number> {
  const format = EXTENDED_KEY_FORMATS[extendedKey.slice(0, 4)];
  if (!format) throw new Error(`Unrecognized extended public key prefix in "${extendedKey.slice(0, 4)}...".`);

  const account = HDKey.fromExtendedKey(extendedKey, format.versions);
  const external = account.deriveChild(0);
  const internal = account.deriveChild(1);

  const chainScans = format.scriptTypes.flatMap((scriptType) => [
    () => scanChain(external, scriptType),
    () => scanChain(internal, scriptType),
  ]);
  // A plain xpub means up to 6 chain-scans (3 script types x 2 chains) —
  // capped so this can't multiply with ADDRESS_CONCURRENCY into a much
  // bigger burst than the ypub/zpub (1 script type, 2 chains) case already
  // runs safely.
  const totals = await mapWithConcurrency(chainScans, 2, (scan) => scan());

  return totals.reduce((sum, sats) => sum + sats, 0);
}
