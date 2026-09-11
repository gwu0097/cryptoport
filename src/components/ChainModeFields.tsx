"use client";

import { useId, useState } from "react";
import { Field, inputClass, selectClass } from "./ui/Field";
import { isEvmChainId } from "@/lib/adapters/evmChains";

// Kept in sync by hand with the non-EVM half of AUTO_CAPABLE_CHAINS in
// wallets/actions.ts (the real, server-enforced source of truth) — this
// copy only drives the UI (datalist suggestions, disabling the "auto"
// option), so being out of sync would just make the client-side hint
// wrong, never let an unsupported chain actually get saved as auto (the
// server checks again). The EVM half isn't hand-copied — isEvmChainId
// (imported directly from evmChains.ts, the same list evm.ts scans)
// recognizes any of the 31 configured EVM chains, so typing "RON" or
// "SEI" enables Auto mode exactly like "ETH" does, without needing every
// EVM chain cluttering the datalist below.
const NON_EVM_AUTO_CAPABLE_CHAINS = [
  "BTC",
  "SOL",
  "ADA",
  "ATOM",
  "INJ",
  "NEAR",
  "SUI",
  "FIL",
  "BCH",
  "DOT",
  "TAO",
  "NEO",
  "XRP",
  "TON",
  "APT",
  "ICP",
];
// "ETH" stands in for "any EVM chain" in the suggestion list — listing all
// 31 would be noisy for a text-autocomplete; typing another EVM chain id
// (RON, SEI, ARB, ...) still works via isEvmChainId below, just isn't
// suggested here.
const DATALIST_CHAINS = ["ETH", ...NON_EVM_AUTO_CAPABLE_CHAINS];

function isAutoCapableChain(chain: string): boolean {
  const upper = chain.trim().toUpperCase();
  return NON_EVM_AUTO_CAPABLE_CHAINS.includes(upper) || isEvmChainId(upper);
}

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

  const isAutoCapable = isAutoCapableChain(chain);

  return (
    <>
      <Field
        label="Chain"
        hint="Any chain works for manual tracking — auto-sync exists for BTC, SOL, ADA, ATOM, INJ, NEAR, SUI, FIL, BCH, DOT, TAO, NEO, XRP, TON, APT, ICP, and any EVM chain (ETH, RON, SEI, ARB, ...)."
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
            if (mode === "auto" && !isAutoCapableChain(next)) {
              setMode("manual");
            }
          }}
          className={inputClass}
        />
        <datalist id={datalistId}>
          {DATALIST_CHAINS.map((c) => (
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
