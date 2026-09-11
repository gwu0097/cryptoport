"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { buttonClass } from "./ui/Button";
import { WalletButton, type PinnedWalletTarget } from "./auth/WalletButton";

/**
 * "Verify" as a small trigger (icon-only next to the edit pencil in
 * WalletsTable, or a labeled button next to the name on the wallet detail
 * page) rather than a full-width "Ethereum wallet" button and an
 * always-visible explanatory paragraph — the popup itself (see ui/Dialog.tsx,
 * same shell as EditWalletModal/AddHoldingModal) is where the actual wallet
 * picker (WalletButton, which can list several installed EVM wallets via
 * EIP-6963) lives, so the trigger stays compact regardless of how many
 * wallets are found. The `title` on the trigger carries the explanation
 * instead of a permanent paragraph.
 *
 * WalletButton itself is only mounted while the dialog is open — a native
 * <dialog>'s content stays in the DOM while closed, and this component
 * shows up once per row in WalletsTable, so an always-mounted WalletButton
 * would mean one EIP-6963 discovery listener (plus every provider's icon
 * <img>) per unverified wallet on the page instead of only the one(s)
 * actually being used.
 *
 * onLinked (not the default router.refresh()) is passed explicitly so the
 * dialog closes itself on success — WalletButton skips its own
 * router.refresh() whenever onLinked is supplied, so this does both.
 */
export function VerifyWalletModal({
  pinnedTarget,
  variant = "button",
}: {
  pinnedTarget: PinnedWalletTarget;
  variant?: "button" | "icon";
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Fires on every close path (Escape, the X button, our own
    // backdrop-click handler in Dialog.tsx, or dialogRef.close() below) —
    // one listener covers all of them instead of threading a callback
    // through each.
    const handleClose = () => setOpen(false);
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, []);

  function openDialog() {
    setOpen(true);
    dialogRef.current?.showModal();
  }

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={openDialog}
          title="Verify you own this address — lets you sign in with it in the future."
          aria-label="Verify wallet"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-muted transition hover:bg-surface-raised hover:text-fg"
        >
          <ShieldCheck className="size-3.5" aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={openDialog}
          title="Verifying this wallet lets you log in with it in the future."
          className={`${buttonClass("secondary", "sm")} gap-1.5`}
        >
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          Verify
        </button>
      )}

      <Dialog ref={dialogRef} title="Verify this wallet">
        <p className="mb-3 text-xs text-fg-muted">
          Sign a message to prove you own this address — this lets you log in with it directly in the
          future.
        </p>
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
      </Dialog>
    </>
  );
}
