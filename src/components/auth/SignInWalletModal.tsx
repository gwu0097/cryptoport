"use client";

import { Wallet } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { buttonClass } from "../ui/Button";
import { useLazyDialog } from "../ui/useLazyDialog";
import { WalletButton } from "./WalletButton";

/**
 * Login/signup's "or sign in with a wallet" option as a popup trigger
 * instead of the row of wallet buttons sitting directly on the page — the
 * exact thing this app had originally (a single "Ethereum wallet" button
 * that popped a picker), lost when that button briefly became an
 * always-visible inline row during this session's EIP-6963 work, and
 * restored here now that every wallet-picker entry point in the app
 * (Verify, wallets/new's connect option, this) opens the same way. See
 * VerifyWalletModal's comment for why WalletButton is only mounted while
 * open. completeWalletSignIn's own router.push (see WalletButton.tsx)
 * navigates away on success, so there's no explicit close-the-dialog step
 * needed here.
 */
export function SignInWalletModal() {
  const { dialogRef, open, openDialog } = useLazyDialog();

  return (
    <>
      <button type="button" onClick={openDialog} className={`${buttonClass("secondary", "md")} w-full gap-1.5`}>
        <Wallet className="size-4" aria-hidden="true" />
        Log in with wallet
      </button>

      <Dialog ref={dialogRef} title="Log in with a wallet">
        <p className="mb-3 text-xs text-fg-muted">
          Sign a message to prove you own it — no password needed. If it isn&rsquo;t linked to an account
          yet, one is created for it.
        </p>
        {open && <WalletButton mode="signin" />}
      </Dialog>
    </>
  );
}
