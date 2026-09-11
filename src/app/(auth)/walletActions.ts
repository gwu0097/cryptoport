"use server";

import { serviceDb, serviceAuth, userAuth } from "@/lib/supabase";
import { createChallenge, completeChallenge } from "@/lib/walletChallenge";
import { generateSyntheticEmail, truncateAddress, type WalletChain } from "@/lib/walletAuth";

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

// EVM dedupe deliberately does NOT filter on chain: a wallet tracked under
// any of the 31 EVM chain labels (RON, SEI, ARB, ...) holds the exact same
// address as one labeled plain ETH — the label is just which chain the
// wallet is "focused" on for display, not which chains its 0x address
// actually gets scanned across (see AUTO_CAPABLE_CHAINS' comment in
// (app)/wallets/actions.ts). Filtering by chain='ETH' here would miss those
// and create a duplicate, double-counted wallet with identical holdings —
// a 0x-format address is unambiguous, no other chain's address format
// overlaps with it, so matching on address alone is safe. Solana's 'SOL' is
// the one literal chain value this app ever uses for that chain (per
// types.ts), so an exact chain filter there is correct, not a guess.
// wallets.address is stored exactly as typed elsewhere (see
// (app)/wallets/actions.ts's optionalString), so EVM's match is
// case-insensitive; Solana's base58 is case-sensitive, exact match.
// .limit(1) instead of .maybeSingle() — .maybeSingle() errors on more than
// one match, which a user who already tracks the same address under two
// different EVM labels (or created a duplicate by hand) would trigger.
// .eq("active", true) + a deterministic order — same reasoning as the
// matching function in (app)/settings/walletActions.ts: without them, a
// soft-deleted duplicate (deleteWallet sets active=false, never removes
// the row) could be the one returned instead of the real tracked wallet.
async function findExistingTrackedWallet(
  userId: string,
  chain: WalletChain,
  address: string,
): Promise<string | null> {
  const base = serviceDb()
    .from("wallets")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true)
    .order("created_at", { ascending: true });
  const query = chain === "ETH" ? base.ilike("address", address) : base.eq("chain", chain).eq("address", address);
  const { data } = await query.limit(1);
  return data?.[0]?.id ?? null;
}

// Runs under service_role with no session (see completeWalletSignIn below)
// — user_id is passed explicitly on every write here, never left to the
// column's `default auth.uid()`, which only fires under a real session
// (the link flow in (app)/settings/walletActions.ts is the one that can
// rely on it).
async function autoAddWallet(userId: string, chain: WalletChain, address: string): Promise<string | null> {
  const existing = await findExistingTrackedWallet(userId, chain, address);
  if (existing) return existing;

  const { data, error } = await serviceDb()
    .from("wallets")
    .insert({ user_id: userId, chain, address, mode: "auto", name: truncateAddress(address) })
    .select("id")
    .single();
  // A failed portfolio-tracking insert shouldn't block sign-in — it just
  // means the address won't show up automatically this time.
  if (error) return null;
  return data.id;
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
