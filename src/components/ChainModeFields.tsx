"use client";

import { useId, useState } from "react";
import { Field, inputClass, selectClass } from "./ui/Field";

// Kept in sync by hand with AUTO_CAPABLE_CHAINS in wallets/actions.ts (the
// real, server-enforced source of truth) — this copy only drives the UI
// (datalist suggestions, disabling the "auto" option), so being out of
// sync would just make the client-side hint wrong, never let an
// unsupported chain actually get saved as auto (the server checks again).
const AUTO_CAPABLE_CHAINS = ["BTC", "ETH", "SOL", "ADA", "ATOM", "INJ", "NEAR", "SUI", "FIL", "BCH"];

/**
 * Chain is free text with autocomplete (same pattern as the Tag field) —
 * any chain works for manual tracking, not just the ones this app has an
 * adapter for. Mode reacts to it: the "auto" option disables itself (and
 * the field snaps back to "manual" if it was selected) the moment the
 * typed chain isn't one this app can actually auto-sync. Both fields still
 * submit as plain form fields (name="chain"/"mode") — this only replaces
 * the static markup with something that reacts to itself, the surrounding
 * form/server action is unchanged.
 */
export function ChainModeFields({
  defaultChain = "",
  defaultMode = "",
}: {
  defaultChain?: string;
  defaultMode?: string;
}) {
  const [chain, setChain] = useState(defaultChain);
  const [mode, setMode] = useState(defaultMode);
  const datalistId = useId();

  const isAutoCapable = AUTO_CAPABLE_CHAINS.includes(chain.trim().toUpperCase());

  return (
    <>
      <Field
        label="Chain"
        hint="Any chain works for manual tracking — auto-sync only exists for BTC, ETH, SOL, ADA, ATOM, INJ, NEAR, SUI, FIL, and BCH."
      >
        <input
          name="chain"
          type="text"
          required
          list={datalistId}
          value={chain}
          onChange={(e) => {
            const next = e.target.value;
            setChain(next);
            if (mode === "auto" && !AUTO_CAPABLE_CHAINS.includes(next.trim().toUpperCase())) {
              setMode("manual");
            }
          }}
          className={inputClass}
        />
        <datalist id={datalistId}>
          {AUTO_CAPABLE_CHAINS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Field>

      <Field
        label="Mode"
        hint={!isAutoCapable ? "Auto mode isn't available for this chain — manual entry only." : undefined}
      >
        <select
          name="mode"
          required
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className={selectClass}
        >
          <option value="" disabled>
            Select a mode
          </option>
          <option value="manual">manual — enter holdings by hand</option>
          <option value="auto" disabled={!isAutoCapable}>
            auto — adapter fetches holdings
          </option>
        </select>
      </Field>
    </>
  );
}
