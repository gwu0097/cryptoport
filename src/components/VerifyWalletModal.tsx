"use client";

import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { buttonClass } from "./ui/Button";
import { useLazyDialog } from "./ui/useLazyDialog";
import { WalletPickerDialog } from "./auth/WalletPickerDialog";
import { WalletButton, type PinnedWalletTarget } from "./auth/WalletButton";

/**
 * "Verify" as a small labeled trigger (next to the name on the wallet
 * detail page, or next to the Chain badge in WalletsTable) — opens the
 * shared WalletPickerDialog (see its comment) with the actual picker.
 * Always labeled "Verify" with the ShieldCheck icon, never icon-only — a
 * bare shield glyph with no text next to it reads as decoration, not a
 * button. The `title` on the trigger carries the explanation in addition
 * to the label.
 *
 * onLinked (not the default router.refresh()) is passed explicitly so the
 * dialog closes itself on success — WalletButton skips its own
 * router.refresh() whenever onLinked is supplied, so this does both.
 */
export function VerifyWalletModal({ pinnedTarget }: { pinnedTarget: PinnedWalletTarget }) {
  const { dialogRef, open, openDialog } = useLazyDialog();
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title="Verifying this wallet lets you log in with it in the future."
        className={`${buttonClass("secondary", "sm")} gap-1.5`}
      >
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        Verify
      </button>

      <WalletPickerDialog
        ref={dialogRef}
        heading="Verify your wallet"
        description="Sign a message to prove you own this address — this lets you log in with it directly in the future."
      >
        {open && (
          <WalletButton
            mode="link"
            pinnedTarget={pinnedTarget}
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
