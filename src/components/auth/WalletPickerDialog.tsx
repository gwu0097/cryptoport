"use client";

import { forwardRef, type ReactNode } from "react";
import { X, Wallet } from "lucide-react";

/**
 * Two-pane wallet-connect modal shared by every wallet-picker entry point
 * (SignInWalletModal, LinkWalletModal, ConnectWalletModal,
 * VerifyWalletModal) — a scrollable list of wallets on the left
 * (`children`, rendered by WalletButton), a branded explanation panel on
 * the right. Modeled directly on DeBank's own "Connect your wallet" modal
 * (itself built on RabbyKit) at the user's request, with CryptoPort's own
 * mark instead of DeBank's logo and no RabbyKit ToS/attribution footer.
 *
 * A separate shell from ui/Dialog.tsx (used for ordinary forms — edit
 * wallet, add holding) rather than a variant of it — the two-pane layout,
 * corner-only close button, and lack of a bordered title bar make this a
 * different shape entirely, not a themed option on the same component.
 */
export const WalletPickerDialog = forwardRef<
  HTMLDialogElement,
  { heading: string; description: string; children: ReactNode }
>(function WalletPickerDialog({ heading, description, children }, ref) {
  return (
    <dialog
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="fixed inset-0 m-auto w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-black/60"
    >
      <button
        type="button"
        onClick={(e) => e.currentTarget.closest("dialog")?.close()}
        aria-label="Close"
        className="absolute right-3 top-3 z-10 rounded-md p-1 text-fg-muted transition hover:bg-surface-raised hover:text-fg"
      >
        <X className="size-4" aria-hidden="true" />
      </button>

      <div className="flex flex-col sm:flex-row">
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto border-b border-border p-3 sm:max-h-[26rem] sm:w-56 sm:shrink-0 sm:border-b-0 sm:border-r">
          {children}
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
          <div className="grid size-16 place-items-center rounded-2xl bg-accent text-accent-fg">
            <Wallet className="size-8" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-fg">{heading}</h2>
            <p className="mt-2 max-w-xs text-sm text-fg-muted">{description}</p>
          </div>
        </div>
      </div>
    </dialog>
  );
});
