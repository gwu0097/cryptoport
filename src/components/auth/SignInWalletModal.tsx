"use client";

import { Wallet } from "lucide-react";
import { buttonClass } from "../ui/Button";
import { useLazyDialog } from "../ui/useLazyDialog";
import { WalletPickerDialog } from "./WalletPickerDialog";
import { WalletButton } from "./WalletButton";

/**
 * Login/signup's "or sign in with a wallet" option — opens the shared
 * WalletPickerDialog (modeled on DeBank's own "Connect your wallet" modal
 * at the user's request, see its comment) instead of a row of wallet
 * buttons sitting directly on the page. completeWalletSignIn's own
 * router.push (see WalletButton.tsx) navigates away on success, so there's
 * no explicit close-the-dialog step needed here.
 */
export function SignInWalletModal() {
  const { dialogRef, open, openDialog } = useLazyDialog();

  return (
    <>
      <button type="button" onClick={openDialog} className={`${buttonClass("secondary", "md")} w-full gap-1.5`}>
        <Wallet className="size-4" aria-hidden="true" />
        Log in with wallet
      </button>

      <WalletPickerDialog
        ref={dialogRef}
        heading="Connect your wallet with CryptoPort"
        description='Connecting your wallet is like "logging in" to Web3. Select your wallet from the options to get started.'
      >
        {open && <WalletButton mode="signin" />}
      </WalletPickerDialog>
    </>
  );
}
