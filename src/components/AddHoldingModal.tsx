"use client";

import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Field, inputClass } from "./ui/Field";
import { SubmitButton } from "./ui/SubmitButton";
import { buttonClass } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { CoinSearchInput } from "./CoinSearchInput";
import { searchCoinsAction } from "@/app/(app)/wallets/actions";
import type { CoinSearchResult } from "@/lib/adapters/coingecko";

/**
 * "+ Add holding" as a popup (see ui/Dialog.tsx) rather than two
 * always-visible panels at the bottom of the wallet page — keeps the page
 * itself to just the wallet's actual holdings. Both entry modes (by
 * quantity, priced live off the shared ticker table; by a fixed USD value,
 * bypassing pricing entirely) live in the same popup rather than two
 * separate buttons, matching how they were already presented side by side.
 *
 * Each form's Ticker field is a CoinSearchInput (the same picker Watchlist
 * uses) rather than a plain text input: typing still just types a ticker —
 * nothing about that path changes — but picking a result also stashes that
 * coin's coingecko_id/icon_url in hidden inputs, submitted alongside the
 * ticker. addHolding stores them on the holding, which is what lets
 * priceKey.ts resolve a manual holding to a real, collision-safe price
 * instead of a bare-ticker Coinbase/Jupiter lookup — a manual holding has
 * no chain to infer an identity from otherwise (fixes a real bug: a
 * manually-added "DOG" Bitcoin Rune was priced off Coinbase's own
 * unrelated "DOG"). Same insert gets a real icon instead of the ticker-
 * initial fallback badge, for free. Editing the ticker text after a pick
 * clears the stash (CoinSearchInput's own contract), so a stale identity
 * can never be submitted next to a ticker it no longer matches.
 */
export function AddHoldingModal({
  addHolding,
  defaultTicker,
}: {
  addHolding: (formData: FormData) => void | Promise<void>;
  defaultTicker?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [qtyCoin, setQtyCoin] = useState<CoinSearchResult | null>(null);
  const [usdCoin, setUsdCoin] = useState<CoinSearchResult | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className={buttonClass("secondary", "sm")}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add holding
      </button>

      <Dialog ref={dialogRef} title="Add holding">
        <div className="grid gap-4 sm:grid-cols-2">
          <form
            action={addHolding}
            onSubmit={() => dialogRef.current?.close()}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="kind" value="qty" />
            <input type="hidden" name="coingecko_id" value={qtyCoin?.id ?? ""} />
            <input type="hidden" name="icon_url" value={qtyCoin?.imageUrl ?? ""} />
            <Field label="Ticker">
              <CoinSearchInput
                search={searchCoinsAction}
                onSelect={setQtyCoin}
                name="ticker"
                defaultValue={defaultTicker}
                placeholder="e.g. BTC, ETH, PEPE…"
                required
              />
            </Field>
            <Field label="Quantity">
              <input name="qty" type="text" inputMode="decimal" required className={inputClass} />
            </Field>
            <SubmitButton className="self-start">Add by quantity</SubmitButton>
          </form>

          <form
            action={addHolding}
            onSubmit={() => dialogRef.current?.close()}
            className="flex flex-col gap-3"
          >
            <input type="hidden" name="kind" value="usd" />
            <input type="hidden" name="coingecko_id" value={usdCoin?.id ?? ""} />
            <input type="hidden" name="icon_url" value={usdCoin?.imageUrl ?? ""} />
            <Field label="Ticker">
              <CoinSearchInput
                search={searchCoinsAction}
                onSelect={setUsdCoin}
                name="ticker"
                placeholder="e.g. BTC, ETH, PEPE…"
                required
              />
            </Field>
            <Field label="Fixed USD value">
              <input name="usd_override" type="text" inputMode="decimal" required className={inputClass} />
            </Field>
            <SubmitButton className="self-start">Add fixed USD value</SubmitButton>
          </form>
        </div>
      </Dialog>
    </>
  );
}
