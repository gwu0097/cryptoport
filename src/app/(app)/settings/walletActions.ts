"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { userDb } from "@/lib/supabase";
import { createChallenge, completeChallenge } from "@/lib/walletChallenge";
import { truncateAddress, isSyntheticEmail, type WalletChain } from "@/lib/walletAuth";

// {ok, error} return values, NOT throw-on-error — unlike settings/actions.ts
// (which is form-bound), these two are called directly from
// WalletButton.tsx's click handlers, same as ../(auth)/walletActions.ts's
// matching pair. That distinction matters: Next redacts a thrown Server
// Action error's message to a generic "Minified React error #441" in
// production when there's no error.tsx boundary to catch it (this app has
// none) — real bug hit live: an invalid-address/challenge failure here
// surfaced as that opaque message instead of anything useful. Next's own
// docs are explicit about this ("expected errors... avoid throw, model
// them as return values") — this is exactly that case, corrected to match
// the pattern (auth)/walletActions.ts already used correctly.
export type WalletLinkChallengeResult = { ok: true; message: string } | { ok: false; error: string };
export type WalletLinkResult = { ok: true; walletId: string } | { ok: false; error: string };

export async function requestWalletLink(
  chain: WalletChain,
  address: string,
  chainId?: number,
): Promise<WalletLinkChallengeResult> {
  // requireUser() redirects via a thrown NEXT_REDIRECT control-flow error
  // when there's no session — that has to escape this function, not get
  // swallowed into an {ok:false} result, so it stays outside the try block
  // (same "redirect outside try/catch" rule Next's own docs give for
  // redirect() generally).
  await requireUser();
  try {
    const message = await createChallenge(chain, address, "link", chainId);
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Same "don't filter EVM by chain label" reasoning as
// (auth)/walletActions.ts's version — see its comment. Scoped by RLS
// (userDb() only ever sees this user's rows), no explicit user_id filter
// needed. .limit(1) not .maybeSingle() for the same more-than-one-match
// reason as that file too.
async function findExistingTrackedWallet(chain: WalletChain, address: string): Promise<string | null> {
  const db = await userDb();
  const base = db.from("wallets").select("id");
  const query = chain === "ETH" ? base.ilike("address", address) : base.eq("chain", chain).eq("address", address);
  const { data } = await query.limit(1);
  return data?.[0]?.id ?? null;
}

async function ensureTrackedWallet(chain: WalletChain, address: string): Promise<string> {
  const existing = await findExistingTrackedWallet(chain, address);
  if (existing) return existing;

  const db = await userDb();
  const { data, error } = await db
    .from("wallets")
    .insert({ chain, address, mode: "auto", name: truncateAddress(address) })
    .select("id")
    .single();
  if (error) throw new Error(`Wallet linked, but failed to add it to your portfolio: ${error.message}`);
  return data.id;
}

// Returns the tracked wallet's id (existing or freshly created) so callers
// outside Settings — the wallet detail page's "Link this wallet" and
// wallets/new's "Connect & link" — can navigate to it. Settings itself
// ignores the walletId and just refreshes in place.
export async function completeWalletLink(signatureHex: string): Promise<WalletLinkResult> {
  await requireUser(); // outside the try block — see requestWalletLink's comment
  try {
    const completed = await completeChallenge(signatureHex);
    if (completed.purpose !== "link") {
      throw new Error("That request wasn't a link request.");
    }
    const { chain, address } = completed;

    // Checked before inserting so re-linking a wallet you've already linked
    // (Settings, then later "connect & link" on wallets/new with the same
    // one) is a harmless no-op instead of hitting the unique violation below
    // and being told it belongs to "another account" — RLS means a hit here
    // can only ever be a row this user owns, never someone else's.
    const db = await userDb();
    const already = await db.from("linked_wallets").select("id").eq("chain", chain).eq("address", address).limit(1);

    if (!already.data?.length) {
      // user_id isn't set explicitly — this runs under a real session, so
      // the column's default auth.uid() applies, same as createWallet/
      // resolveTagId elsewhere in this app. RLS's own with check
      // (user_id = auth.uid()) structurally prevents this from ever
      // writing a row for anyone else.
      const { error } = await db.from("linked_wallets").insert({ chain, address });
      if (error) {
        if (error.code === "23505") {
          // The pre-check above already ruled out "it's mine" — a unique
          // violation here can only mean it's someone else's. Deliberately
          // doesn't say whose — that would leak whether a given address
          // has an account here at all.
          throw new Error("That wallet is already linked to another account.");
        }
        throw new Error(`Failed to link wallet: ${error.message}`);
      }
    }

    const walletId = await ensureTrackedWallet(chain, address);

    revalidatePath("/settings");
    revalidatePath("/wallets");
    revalidatePath(`/wallets/${walletId}`);
    return { ok: true, walletId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function unlinkWallet(linkedWalletId: string): Promise<void> {
  const user = await requireUser();
  const db = await userDb();

  // Refuse to remove someone's only way back in: their last linked wallet,
  // on an account with no password to fall back on (a synthetic email
  // means signInWithPassword can never work for this account).
  const { count, error: countError } = await db
    .from("linked_wallets")
    .select("id", { count: "exact", head: true });
  if (countError) throw new Error(`Failed to unlink wallet: ${countError.message}`);

  if ((count ?? 0) <= 1 && isSyntheticEmail(user.email ?? "")) {
    // No password form exists for a wallet-only account (see settings/
    // page.tsx's walletOnly branch) and a synthetic email can't receive a
    // reset link either — linking another wallet first is the only way
    // back in, not "set a password."
    throw new Error("This is your only way to sign in — link another wallet before unlinking it.");
  }

  const { error } = await db.from("linked_wallets").delete().eq("id", linkedWalletId);
  if (error) throw new Error(`Failed to unlink wallet: ${error.message}`);

  revalidatePath("/settings");
}
