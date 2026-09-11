"use client";

import { useRouter } from "next/navigation";
import { Wallet } from "lucide-react";
import { buttonClass } from "../ui/Button";
import { useLazyDialog } from "../ui/useLazyDialog";
import { WalletPickerDialog } from "./WalletPickerDialog";
import { WalletButton } from "./WalletButton";

/**
 * Settings' "add another linked wallet" option — same WalletPickerDialog as
 * VerifyWalletModal/ConnectWalletModal/SignInWalletModal. Unlike those,
 * there's no pinnedTarget (any wallet can be linked here) and no
 * navigation on success, just a refresh of the linked-wallets list in
 * place, so onLinked is passed explicitly (closing the dialog) same as
 * VerifyWalletModal.
 */
export function LinkWalletModal() {
  const { dialogRef, open, openDialog } = useLazyDialog();
  const router = useRouter();

  return (
    <>
      <button type="button" onClick={openDialog} className={`${buttonClass("secondary", "sm")} gap-1.5`}>
        <Wallet className="size-3.5" aria-hidden="true" />
        Link a wallet
      </button>

      <WalletPickerDialog
        ref={dialogRef}
        heading="Link a wallet"
        description="Sign a message to link this wallet to your account so you can sign in with it directly."
      >
        {open && (
          <WalletButton
            mode="link"
            onLinked={() => {
              dialogRef.current?.close();
              router.refresh();
            }}
          />
        )}
      </WalletPickerDialog>
    </>
  );
}
