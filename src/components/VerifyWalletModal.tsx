"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "./ui/Dialog";
import { WalletButton, type PinnedWalletTarget } from "./auth/WalletButton";

/**
 * "Verify" as a small trigger next to the wallet name (same spot as
 * EditWalletModal's pencil icon) rather than a full-width "Ethereum wallet"
 * button and an always-visible explanatory paragraph sitting under the
 * address line — the popup itself (see ui/Dialog.tsx, same shell as
 * EditWalletModal/AddHoldingModal) is where the actual wallet picker
 * (WalletButton, which can list several installed EVM wallets via EIP-6963)
 * lives, so the header stays compact regardless of how many wallets are
 * found. The `title` on the trigger carries the explanation instead.
 *
 * onLinked (not the default router.refresh()) is passed explicitly so the
 * dialog closes itself on success — WalletButton skips its own
 * router.refresh() whenever onLinked is supplied, so this does both.
 */
export function VerifyWalletModal({ pinnedTarget }: { pinnedTarget: PinnedWalletTarget }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        title="Verifying this wallet lets you log in with it in the future."
        className="rounded-md px-1.5 py-0.5 text-xs font-medium text-accent transition hover:bg-surface-raised"
      >
        Verify
      </button>

      <Dialog ref={dialogRef} title="Verify this wallet">
        <p className="mb-3 text-xs text-fg-muted">
          Sign a message to prove you own this address — this lets you log in with it directly in the
          future.
        </p>
        <WalletButton
          mode="link"
          pinnedTarget={pinnedTarget}
          onLinked={() => {
            dialogRef.current?.close();
            router.refresh();
          }}
        />
      </Dialog>
    </>
  );
}
