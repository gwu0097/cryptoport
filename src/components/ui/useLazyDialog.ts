"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shared open/close plumbing for every "trigger button opens a native
 * <dialog>" popup in this app (VerifyWalletModal, ConnectWalletModal,
 * SignInWalletModal, LinkWalletModal — all wrapping WalletButton, which
 * only gets mounted while `open` is true; see VerifyWalletModal's comment
 * for why that matters). Factored out once a fourth near-identical copy of
 * this exact effect/state pair was about to get written.
 *
 * `open` tracks mount state separately from the dialog's own native
 * open/closed state — a <dialog>'s content stays in the DOM while closed,
 * so callers use `open` to decide whether to render their (potentially
 * expensive) children at all, not just whether the dialog looks open.
 */
export function useLazyDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Fires on every close path (Escape, the X button, Dialog.tsx's own
    // backdrop-click handler, or an explicit dialogRef.close() call) — one
    // listener covers all of them instead of threading a callback through
    // each.
    const handleClose = () => setOpen(false);
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, []);

  function openDialog() {
    setOpen(true);
    dialogRef.current?.showModal();
  }

  return { dialogRef, open, openDialog };
}
