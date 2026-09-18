// Split out of walletAuth.ts: these functions are genuinely pure (string
// checks, lookups) and don't need viem/siwe/@scure/base/@noble/curves —
// but they used to live in the same file as walletAuth.ts's signature-
// verification code, which does. Since queries.ts (imported by every
// data-heavy read page — Portfolio, Dashboard, Assets, DeFi) and (app)/
// layout.tsx (wrapping literally every page in the app) both only needed
// pinnedWalletChain/walletDisplayName, every single page load was pulling
// in the full signing-library dependency graph just to compute a display
// string — real, avoidable weight on the hottest code path in the app.
// walletAuth.ts re-exports WalletChain from here (type-only, free) so its
// own signature-verification code (which genuinely needs the pieces that
// stayed there) doesn't need touching.
import "server-only";
import { isEvmChainId } from "./adapters/evmChains.ts";

export type WalletChain = "ETH" | "SOL";

/**
 * Which wallet-auth chain (if any) a tracked wallet's own `chain` label maps
 * to — every EVM chain this app tracks (RON, SEI, ARB, ... all resolve to
 * 'ETH', one secp256k1 signature covers all of them) and 'SOL' maps to
 * itself; everything else (BTC, ADA, ...) has no wallet-auth signature
 * scheme implemented, so there's nothing to verify/link. Shared by the
 * wallet detail page and the wallets list table so "does this wallet get a
 * Verify affordance at all" is answered identically in both places — see
 * evmChains.ts's isEvmChainId for why this file can safely import it (no
 * server-only marker on either side).
 */
export function pinnedWalletChain(chain: string): WalletChain | null {
  if (isEvmChainId(chain)) return "ETH";
  if (chain === "SOL") return "SOL";
  return null;
}

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

/** Deliberately separate from pinnedWalletChain: that function answers "can
 * this chain sign a wallet-auth challenge" (BTC can't — no scheme
 * implemented — so it returns null for BTC), which is a different question
 * from "is there a free external viewer for this address." Live-verified:
 * debank.com/profile/<address> (200, real profile — DeBank aggregates
 * across every EVM chain for one 0x address, no chain-specific path
 * needed), jup.ag/portfolio/<address> (200 for a real address, 404 for a
 * nonsense route — confirming it's a real per-address page, not just
 * always-200; the old portfolio.jup.ag/portfolio/<address> now redirects
 * away from the address entirely, so that host is stale), and
 * unisat.io/address/<address> (200, and its own header text confirms it
 * covers "Ordinals, Runes, Alkanes" for a Bitcoin address — this is a
 * client-rendered SPA so curl/WebFetch can't diff real-vs-fake addresses
 * the way DeBank/Jupiter could, but UniSat is the same product behind the
 * Open API researched for native Runes-balance support, so it's a known-
 * real service, not a guess).
 *
 * Shared by the wallet detail page and the public Wallet Lookup page (moved
 * here — pure, no DB/network — once the second consumer needed the
 * identical logic, per this codebase's own "two is the threshold to
 * extract" rule). The caller is responsible for excluding a BTC xpub/ypub/
 * zpub first (see both call sites) — that's a key deriving many addresses,
 * not a spendable address itself, so UniSat's address page has no
 * meaningful equivalent to link to for one. */
export function externalPortfolioViewer(chain: string, address: string): { url: string; label: string } | null {
  if (isEvmChainId(chain)) return { url: `https://debank.com/profile/${address}`, label: "DeBank" };
  if (chain === "SOL") return { url: `https://jup.ag/portfolio/${address}`, label: "Jupiter Portfolio" };
  if (chain === "BTC") return { url: `https://unisat.io/address/${address}`, label: "UniSat" };
  return null;
}
