"use client";

import { Wallet } from "lucide-react";
import { buttonClass } from "../ui/Button";
import { useLazyDialog } from "../ui/useLazyDialog";
import { WalletPickerDialog } from "./WalletPickerDialog";
import { ConnectAndLinkWallet } from "./ConnectAndLinkWallet";

/**
 * wallets/new's "connect a wallet" option — opens the shared
 * WalletPickerDialog (see its comment) instead of showing the full wallet
 * list inline, competing for space with the manual "Create wallet" form
 * above it. ConnectAndLinkWallet's own onLinked navigates away
 * (router.push to the new wallet's page) on success, so unlike
 * VerifyWalletModal there's no explicit close-the-dialog step needed here.
 */
export function ConnectWalletModal() {
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
        description="Sign a message to verify you own it and add it to your portfolio in one step — you can rename it afterwards."
      >
        {open && <ConnectAndLinkWallet />}
      </WalletPickerDialog>
    </>
  );
}
