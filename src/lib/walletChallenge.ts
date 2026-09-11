import "server-only";
import { cookies, headers } from "next/headers";
import { generateSiweNonce } from "viem/siwe";
import {
  buildChallengeMessage,
  normalizeAddress,
  verifyWalletSignature,
  type ChallengePurpose,
  type WalletChain,
} from "./walletAuth";

const COOKIE_NAME = "cp_wallet_challenge";
const CHALLENGE_TTL_MS = 5 * 60_000;

interface StoredChallenge {
  message: string;
  chain: WalletChain;
  address: string;
  purpose: ChallengePurpose;
  expiresAt: number;
}

/**
 * Issues a challenge message and stores it httpOnly — the client only ever
 * gets the message text to sign, never anything it could tamper with to
 * change what "completing" the challenge later proves. httpOnly blocks
 * client JS from forging the cookie; the nonce inside the message blocks
 * replaying an old signature against a new challenge. secure is dropped in
 * dev since localhost is plain http.
 */
export async function createChallenge(
  chain: WalletChain,
  rawAddress: string,
  purpose: ChallengePurpose,
  chainId?: number,
): Promise<string> {
  const address = normalizeAddress(chain, rawAddress);

  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const now = new Date();
  const expirationTime = new Date(now.getTime() + CHALLENGE_TTL_MS);

  const message = buildChallengeMessage({
    chain,
    address,
    nonce: generateSiweNonce(),
    domain: host,
    uri: `${isLocal ? "http" : "https"}://${host}`,
    purpose,
    issuedAt: now,
    expirationTime,
    chainId,
  });

  const stored: StoredChallenge = {
    message,
    chain,
    address,
    purpose,
    expiresAt: expirationTime.getTime(),
  };

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, JSON.stringify(stored), {
    httpOnly: true,
    sameSite: "lax",
    secure: !isLocal,
    maxAge: CHALLENGE_TTL_MS / 1000,
    path: "/",
  });

  return message;
}

export interface CompletedChallenge {
  chain: WalletChain;
  address: string;
  purpose: ChallengePurpose;
}

/** Reads back the challenge this session issued, verifies the signature
 * against the server's own copy of the message (the client never sends the
 * message itself — see walletAuth.ts's buildChallengeMessage doc comment),
 * and clears the cookie either way so a challenge is single-use. */
export async function completeChallenge(signatureHex: string): Promise<CompletedChallenge> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  cookieStore.delete(COOKIE_NAME);

  if (!raw) {
    throw new Error("No pending wallet request — try connecting again.");
  }

  let stored: StoredChallenge;
  try {
    stored = JSON.parse(raw) as StoredChallenge;
  } catch {
    throw new Error("No pending wallet request — try connecting again.");
  }

  if (Date.now() > stored.expiresAt) {
    throw new Error("That request expired — try connecting again.");
  }

  const verified = await verifyWalletSignature({
    chain: stored.chain,
    address: stored.address,
    message: stored.message,
    signatureHex,
  });
  if (!verified) {
    throw new Error("Signature verification failed.");
  }

  return { chain: stored.chain, address: stored.address, purpose: stored.purpose };
}
