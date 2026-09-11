// No "server-only" marker (unlike supabase.ts/auth.ts): this module holds
// no secrets and does no I/O — just message-building, address
// normalization, and signature verification, so it stays plain and
// unit-testable with `node --test` outside of Next's bundler, same
// reasoning as coinbase.ts. The stateful half (issuing/reading the
// challenge cookie, which needs next/headers) lives in walletChallenge.ts
// instead.
import { createSiweMessage } from "viem/siwe";
import { recoverMessageAddress, isAddress, hexToBytes, type Hex } from "viem";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519";

export type WalletChain = "ETH" | "SOL";
export type ChallengePurpose = "signin" | "link";

/**
 * An RFC 2606 reserved TLD, so this can never resolve to a real mailbox.
 * Wallet-first accounts still need an auth.users row, which Supabase Auth
 * requires an email for — this is that placeholder. Deliberately random
 * (see generateSyntheticEmail), never derived from the wallet address:
 * an address-derived email would let anyone pre-register it through the
 * public /signup form and squat on a wallet's account before its real
 * owner ever connects.
 */
export const SYNTHETIC_WALLET_DOMAIN = "wallet.cryptoport.invalid";

export function generateSyntheticEmail(): string {
  return `${crypto.randomUUID()}@${SYNTHETIC_WALLET_DOMAIN}`;
}

export function isSyntheticEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${SYNTHETIC_WALLET_DOMAIN}`);
}

/** First5…last5, the same convention TruncatedAddress.tsx uses client-side
 * — this is the plain-string version for server-rendered contexts (TopBar,
 * the Account panel) that can't reach for a "use client" component. */
export function truncateAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

/** What to show instead of an email for a wallet-only account (a synthetic
 * @wallet.cryptoport.invalid address is meaningless to a person) — falls
 * back to null so callers keep showing the real email for every other
 * account. wallet_address/wallet_chain are set once, at account creation,
 * in completeWalletSignIn's admin.createUser call. */
export function walletDisplayName(user: {
  email?: string | null;
  user_metadata?: { wallet_address?: string; wallet_chain?: string };
}): string | null {
  if (!user.email || !isSyntheticEmail(user.email)) return null;
  const address = user.user_metadata?.wallet_address;
  return address ? truncateAddress(address) : null;
}

/**
 * Validates and canonicalizes an address for a given chain. Throws on
 * anything malformed — callers turn that into a user-facing error.
 *
 * EVM: isAddress(..., {strict: true}) accepts a plain lowercase address
 * (no checksum to check) or a correctly checksummed mixed-case one, and
 * rejects a mixed-case string with a corrupted checksum — plain isAddress()
 * would silently accept that. Stored lowercase either way: wallets.address
 * elsewhere in this app is stored exactly as typed with no normalization
 * (see (app)/wallets/actions.ts's optionalString), so this is the first
 * normalization of any address in the codebase, and it matters here
 * specifically because linked_wallets' (chain, address) uniqueness is only
 * meaningful against a canonical value.
 *
 * Solana: base58-decode and require exactly 32 bytes (an ed25519 public
 * key) — stored as-is, base58 is case-sensitive.
 */
export function normalizeAddress(chain: WalletChain, address: string): string {
  if (chain === "ETH") {
    if (!isAddress(address, { strict: true })) {
      throw new Error("That doesn't look like a valid Ethereum address.");
    }
    return address.toLowerCase();
  }

  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    throw new Error("That doesn't look like a valid Solana address.");
  }
  if (bytes.length !== 32) {
    throw new Error("That doesn't look like a valid Solana address.");
  }
  return address;
}

const STATEMENTS: Record<ChallengePurpose, string> = {
  signin: "Sign in to CryptoPort. This does not authorize any transaction or transfer of funds.",
  link: "Link this wallet to your CryptoPort account. This does not authorize any transaction or transfer of funds.",
};

export interface ChallengeParams {
  chain: WalletChain;
  /** Already normalized (see normalizeAddress). */
  address: string;
  nonce: string;
  /** The requesting page's actual host (e.g. from the Host header) — NOT
   * siteUrl(), which can point at a different origin than whatever's
   * actually running (prod URL configured while testing on localhost).
   * Wallets that parse SIWE messages show a mismatch/phishing warning when
   * this doesn't match the page's real origin. */
  domain: string;
  uri: string;
  purpose: ChallengePurpose;
  issuedAt: Date;
  expirationTime: Date;
  /** EVM only — the wallet's currently-connected chain id, so the message
   * doesn't claim "Chain ID: 1" while the wallet is actually on Base or
   * elsewhere (cosmetic, since verification is exact-message-match, not
   * chainId-aware — but some wallets flag a mismatch in their UI). Defaults
   * to 1 (Ethereum mainnet) when not supplied, e.g. in tests. */
  chainId?: number;
}

/**
 * Builds the exact text the wallet will show for signing. The server keeps
 * this string itself (see walletChallenge.ts's cookie) and later compares
 * the client's signature against it byte-for-byte — the client never sends
 * a message back for the server to re-parse, so there's no message-parsing
 * step in the trust boundary and no need for viem's parseSiweMessage/
 * validateSiweMessage.
 */
export function buildChallengeMessage(params: ChallengeParams): string {
  if (params.chain === "ETH") {
    return createSiweMessage({
      address: params.address as `0x${string}`,
      chainId: params.chainId ?? 1,
      domain: params.domain,
      uri: params.uri,
      nonce: params.nonce,
      version: "1",
      statement: STATEMENTS[params.purpose],
      issuedAt: params.issuedAt,
      expirationTime: params.expirationTime,
    });
  }

  // Hand-built SIWS-style layout mirroring EIP-4361's fields — there's no
  // standard library for Solana message signing the way viem covers EVM,
  // but since verification is exact-match (not a parsed/validated
  // standard), matching the shape is only about wallet UX, not correctness.
  return [
    `${params.domain} wants you to sign in with your Solana account:`,
    params.address,
    "",
    STATEMENTS[params.purpose],
    "",
    `URI: ${params.uri}`,
    `Version: 1`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt.toISOString()}`,
    `Expiration Time: ${params.expirationTime.toISOString()}`,
  ].join("\n");
}

export interface VerifySignatureParams {
  chain: WalletChain;
  /** Already normalized. */
  address: string;
  message: string;
  /** Hex-encoded, 0x-prefixed — the wire format both the EVM and Solana
   * branches of WalletButton.tsx use for a signature, so the server has one
   * decoding path instead of two. */
  signatureHex: string;
}

/** Recovers/verifies the signer and checks it matches `address`. Never
 * throws — a malformed signature is just "doesn't verify", same as a
 * mismatched one, so callers get one boolean instead of needing to
 * distinguish exception shapes. */
export async function verifyWalletSignature(params: VerifySignatureParams): Promise<boolean> {
  if (params.chain === "ETH") {
    try {
      const recovered = await recoverMessageAddress({
        message: params.message,
        signature: params.signatureHex as Hex,
      });
      return recovered.toLowerCase() === params.address.toLowerCase();
    } catch {
      return false;
    }
  }

  try {
    const sigBytes = hexToBytes(params.signatureHex as Hex);
    const msgBytes = new TextEncoder().encode(params.message);
    const pubkeyBytes = base58.decode(params.address);
    return ed25519.verify(sigBytes, msgBytes, pubkeyBytes);
  } catch {
    return false;
  }
}
