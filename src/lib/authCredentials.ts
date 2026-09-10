import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { portfolioDb } from "./supabase";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

type Credentials = { username: string; passwordHash: string };

export async function getCredentials(): Promise<Credentials | null> {
  const { data, error } = await portfolioDb()
    .from("app_credentials")
    .select("username, password_hash")
    .eq("id", 1)
    .single();
  if (error || !data) return null;
  return { username: data.username, passwordHash: data.password_hash };
}

// Used by the /settings form to re-check the caller's current password
// before letting them set a new one.
export async function verifyCurrentPassword(password: string): Promise<boolean> {
  const creds = await getCredentials();
  if (!creds) return false;
  return verifyPasswordHash(password, creds.passwordHash);
}

// Used by proxy.ts to gate every request. Fails closed (returns false) on
// any mismatch or lookup failure — never falls open.
export async function verifyLogin(username: string, password: string): Promise<boolean> {
  const creds = await getCredentials();
  if (!creds || username !== creds.username) return false;
  return verifyPasswordHash(password, creds.passwordHash);
}
