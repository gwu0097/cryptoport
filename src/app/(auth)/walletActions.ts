"use server";

import { serviceDb, serviceAuth, userAuth } from "@/lib/supabase";
import { createChallenge, completeChallenge } from "@/lib/walletChallenge";
import { generateSyntheticEmail, type WalletChain } from "@/lib/walletDisplay";
import { ensureTrackedWallet } from "@/lib/trackedWallet";

// Called directly from WalletButton.tsx's click handlers, not through a
// <form action>, so these take plain arguments rather than the
// (prevState, formData) shape ../actions.ts's useActionState forms use —
// there's no form here, just an imperative "prompt the wallet, then tell
// the server what happened" flow. Same {error} convention as ../actions.ts
// otherwise: never throws, so the component can render a message without a
// try/catch around every call.
//
// completeWalletSignIn deliberately does NOT call next/navigation's
// redirect() itself and returns a target path instead — Next's own docs
// (node_modules/next/dist/docs/.../functions/redirect.md) show redirect()
// working from a Server Action only via a <form action>-bound submission;
// an event-handler-triggered flow like this one is documented to use
// useRouter() instead, which is what WalletButton.tsx does with this
// redirectTo value.
export type WalletChallengeResult = { ok: true; message: string } | { ok: false; error: string };
export type WalletSignInResult = { ok: true; redirectTo: string } | { ok: false; error: string };

export async function requestWalletSignIn(
  chain: WalletChain,
  address: string,
  chainId?: number,
): Promise<WalletChallengeResult> {
  try {
    const message = await createChallenge(chain, address, "signin", chainId);
    return { ok: true, message };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Same generateLink + verifyOtp mechanism /auth/confirm/route.ts already
// uses in production for email links — generateLink doesn't send mail, so
// this can't hit Supabase's send-rate limit. serviceAuth() (admin API) has
// to mint the link since there's no session yet to do this any other way;
// verifyOtp then runs through userAuth() so its setAll writes the session
// cookie onto this request's response.
async function mintSession(email: string): Promise<void> {
  const { data, error } = await serviceAuth().generateLink({ type: "magiclink", email });
  if (error) throw new Error(`Failed to sign in: ${error.message}`);

  const supabase = await userAuth();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: data.properties.hashed_token,
  });
  if (verifyError) throw new Error(`Failed to sign in: ${verifyError.message}`);
}

// Runs under service_role with no session (see completeWalletSignIn below)
// — userId is passed explicitly into ensureTrackedWallet, never left to the
// wallets.user_id column's `default auth.uid()`, which only fires under a
// real session (the link flow in (app)/settings/walletActions.ts is the one
// that can rely on it). See trackedWallet.ts's own doc comment for the
// dedupe/lookup reasoning shared with that flow.
async function autoAddWallet(userId: string, chain: WalletChain, address: string): Promise<string | null> {
  try {
    return await ensureTrackedWallet(serviceDb(), chain, address, userId);
  } catch {
    // A failed portfolio-tracking insert shouldn't block sign-in — it just
    // means the address won't show up automatically this time.
    return null;
  }
}

export async function completeWalletSignIn(signatureHex: string): Promise<WalletSignInResult> {
  let completed;
  try {
    completed = await completeChallenge(signatureHex);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (completed.purpose !== "signin") {
    return { ok: false, error: "That request wasn't a sign-in request." };
  }
  const { chain, address } = completed;

  // No session exists yet at this point in the flow — auth.uid() is null,
  // so this is the one place service_role is required (see db/schema.sql's
  // linked_wallets comment and src/lib/supabase.ts's serviceDb() doc
  // comment, which otherwise forbids service-role for owned tables). This
  // read only ever touches the identity mapping, never wallets/holdings.
  const db = serviceDb();
  const { data: linked, error: lookupError } = await db
    .from("linked_wallets")
    .select("user_id")
    .eq("chain", chain)
    .eq("address", address)
    .maybeSingle();
  if (lookupError) return { ok: false, error: `Failed to sign in: ${lookupError.message}` };

  let userId: string;
  let email: string;

  if (linked) {
    userId = linked.user_id;
    const { data: userData, error: userError } = await serviceAuth().getUserById(userId);
    if (userError || !userData.user) {
      return { ok: false, error: "That account could not be found." };
    }
    email = userData.user.email!;
  } else {
    email = generateSyntheticEmail();
    const { data: created, error: createError } = await serviceAuth().createUser({
      email,
      email_confirm: true,
      user_metadata: { wallet_chain: chain, wallet_address: address },
    });
    if (createError || !created.user) {
      return { ok: false, error: `Failed to create account: ${createError?.message ?? "unknown error"}` };
    }
    userId = created.user.id;

    const { error: insertError } = await db.from("linked_wallets").insert({ user_id: userId, chain, address });

    if (insertError) {
      if (insertError.code === "23505") {
        // Lost a race with another sign-in for the same address — sign into
        // whichever account actually won, and clean up the orphaned user we
        // just created for nothing.
        const { data: winner } = await db
          .from("linked_wallets")
          .select("user_id")
          .eq("chain", chain)
          .eq("address", address)
          .single();
        await serviceAuth().deleteUser(userId);
        if (!winner) return { ok: false, error: "Failed to sign in — try again." };

        const { data: winnerUser, error: winnerError } = await serviceAuth().getUserById(winner.user_id);
        if (winnerError || !winnerUser.user) return { ok: false, error: "Failed to sign in — try again." };
        userId = winner.user_id;
        email = winnerUser.user.email!;
      } else {
        await serviceAuth().deleteUser(userId);
        return { ok: false, error: `Failed to create account: ${insertError.message}` };
      }
    }
  }

  const walletId = await autoAddWallet(userId, chain, address);
  try {
    await mintSession(email);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, redirectTo: walletId ? `/wallets/${walletId}?autosync=1` : "/wallets" };
}
