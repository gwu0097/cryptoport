import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// This app has never stored a per-user secret before today — every prior
// "credential" was an app-wide env var (HELIUS_API_KEY, ZERION_API_KEY, ...)
// or the now-dropped app_credentials singleton row (see schema.sql). A
// connected exchange's API key is the first genuinely per-user secret this
// app persists (exchange_connections.encrypted_secret), so it goes through
// real application-level encryption rather than trusting Supabase's disk
// encryption alone — the DB is queryable by anyone with service_role
// access; the plaintext key should never be one `select` away.
//
// AES-256-GCM via Node's built-in crypto — no new dependency, and GCM's
// built-in auth tag means a tampered/corrupted ciphertext fails to decrypt
// loudly instead of silently returning garbage.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size

function getKey(): Buffer {
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) throw new Error("SECRETS_ENCRYPTION_KEY is not set.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}) — generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** iv, authTag, and ciphertext are stored together (base64, colon-joined) —
 * a fresh random iv every call, per GCM's own requirement that an (iv, key)
 * pair is never reused. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string): string {
  const [ivB64, authTagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted secret (expected iv:authTag:ciphertext).");
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
