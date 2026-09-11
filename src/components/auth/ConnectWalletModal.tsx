"use client";

import { Wallet } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { buttonClass } from "../ui/Button";
import { useLazyDialog } from "../ui/useLazyDialog";
import { ConnectAndLinkWallet } from "./ConnectAndLinkWallet";

/**
 * wallets/new's "connect a wallet" option as a popup trigger instead of the
 * full wallet picker sitting inline on the page, competing for space with
 * the manual "Create wallet" form above it — same reasoning as
 * VerifyWalletModal. ConnectAndLinkWallet's own onLinked navigates away
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

      <Dialog ref={dialogRef} title="Connect a wallet">
        <p className="mb-3 text-xs text-fg-muted">
          Sign a message to verify you own it and add it to your portfolio in one step — you can rename
          it afterwards.
        </p>
        {open && <ConnectAndLinkWallet />}
      </Dialog>
    </>
  );
}
