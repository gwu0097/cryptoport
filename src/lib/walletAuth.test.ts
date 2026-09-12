import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { buildChallengeMessage, normalizeAddress, verifyWalletSignature } from "./walletAuth.ts";

function issuedWindow() {
  const issuedAt = new Date();
  return { issuedAt, expirationTime: new Date(issuedAt.getTime() + 5 * 60_000) };
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function evmChallenge(purpose: "signin" | "link" = "signin") {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = normalizeAddress("ETH", account.address);
  const message = buildChallengeMessage({
    chain: "ETH",
    address,
    nonce: "abcdef1234567890",
    domain: "cryptoport-phi.vercel.app",
    uri: "https://cryptoport-phi.vercel.app/login",
    purpose,
    ...issuedWindow(),
  });
  const signatureHex = await account.signMessage({ message });
  return { address, message, signatureHex };
}

function solanaChallenge(purpose: "signin" | "link" = "signin") {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  const address = base58.encode(pub);
  const message = buildChallengeMessage({
    chain: "SOL",
    address,
    nonce: "abcdef1234567890",
    domain: "cryptoport-phi.vercel.app",
    uri: "https://cryptoport-phi.vercel.app/login",
    purpose,
    ...issuedWindow(),
  });
  const signatureHex = bytesToHex(ed25519.sign(new TextEncoder().encode(message), priv));
  return { address, message, signatureHex };
}

test("buildChallengeMessage: a NaN chainId doesn't crash — falls back to 1", () => {
  // Regression: a malformed eth_chainId response from a wallet extension
  // (or just untrusted client input) parsed to NaN, which viem's
  // createSiweMessage rejects outright (NaN !== Math.floor(NaN) is always
  // true) — that threw inside a Server Action with no error.tsx boundary
  // to catch it, surfacing to the user as an opaque "Minified React error
  // #441" instead of anything useful. Server-side chainId handling in
  // walletAuth.ts now guards this explicitly rather than relying on the
  // client (WalletButton.tsx) to always send a clean value.
  const message = buildChallengeMessage({
    chain: "ETH",
    address: "0x3afd68ecac6581cde82318d0781a50006eaa41e9",
    nonce: "abcdef1234567890",
    domain: "cryptoport-phi.vercel.app",
    uri: "https://cryptoport-phi.vercel.app/login",
    purpose: "signin",
    chainId: NaN,
    ...issuedWindow(),
  });
  assert.match(message, /Chain ID: 1\n/);
});

test("EVM: a valid signature over the exact message verifies", async () => {
  const { address, message, signatureHex } = await evmChallenge();
  const ok = await verifyWalletSignature({ chain: "ETH", address, message, signatureHex });
  assert.equal(ok, true);
});

test("EVM: a tampered message fails verification", async () => {
  const { address, message, signatureHex } = await evmChallenge();
  const tampered = message.replace("Nonce: abcdef1234567890", "Nonce: 0000000000000000");
  const ok = await verifyWalletSignature({ chain: "ETH", address, message: tampered, signatureHex });
  assert.equal(ok, false);
});

test("EVM: a signature from a different address fails verification", async () => {
  const { message, signatureHex } = await evmChallenge();
  const otherAddress = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const ok = await verifyWalletSignature({ chain: "ETH", address: otherAddress, message, signatureHex });
  assert.equal(ok, false);
});

test("EVM: a garbage signature fails verification instead of throwing", async () => {
  const { address, message } = await evmChallenge();
  const ok = await verifyWalletSignature({ chain: "ETH", address, message, signatureHex: "0xnotasignature" });
  assert.equal(ok, false);
});

test("Solana: a valid signature over the exact message verifies", async () => {
  const { address, message, signatureHex } = solanaChallenge();
  const ok = await verifyWalletSignature({ chain: "SOL", address, message, signatureHex });
  assert.equal(ok, true);
});

test("Solana: a tampered message fails verification", async () => {
  const { address, message, signatureHex } = solanaChallenge();
  const tampered = message.replace("Nonce: abcdef1234567890", "Nonce: 0000000000000000");
  const ok = await verifyWalletSignature({ chain: "SOL", address, message: tampered, signatureHex });
  assert.equal(ok, false);
});

test("Solana: a signature from a different key fails verification", async () => {
  const { message, signatureHex } = solanaChallenge();
  const otherPub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const ok = await verifyWalletSignature({
    chain: "SOL",
    address: base58.encode(otherPub),
    message,
    signatureHex,
  });
  assert.equal(ok, false);
});

test("normalizeAddress lowercases a checksummed EVM address", () => {
  const mixed = "0x3aFd68ECaC6581cDE82318D0781a50006EAa41e9";
  assert.equal(normalizeAddress("ETH", mixed), mixed.toLowerCase());
});

test("normalizeAddress accepts an all-lowercase EVM address (no checksum to check)", () => {
  const lower = "0x3afd68ecac6581cde82318d0781a50006eaa41e9";
  assert.equal(normalizeAddress("ETH", lower), lower);
});

test("normalizeAddress rejects an EVM address with a corrupted checksum", () => {
  // Same address as the mixed-case one above with one character's case
  // flipped — no longer matches its own checksum.
  const corrupted = "0x3AFD68ECaC6581cDE82318D0781a50006EAa41e9";
  assert.throws(() => normalizeAddress("ETH", corrupted));
});

test("normalizeAddress rejects a malformed EVM address", () => {
  assert.throws(() => normalizeAddress("ETH", "0xnotanaddress"));
});

test("normalizeAddress round-trips a valid Solana address unchanged", () => {
  const pub = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
  const address = base58.encode(pub);
  assert.equal(normalizeAddress("SOL", address), address);
});

test("normalizeAddress rejects invalid base58 for Solana", () => {
  assert.throws(() => normalizeAddress("SOL", "not-valid-base58!!!"));
});

test("normalizeAddress rejects a Solana address that decodes to the wrong length", () => {
  // Valid base58, but not 32 raw bytes (an ed25519 public key).
  assert.throws(() => normalizeAddress("SOL", base58.encode(new Uint8Array(16))));
});
