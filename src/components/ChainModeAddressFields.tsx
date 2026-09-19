"use client";

import { useId, useState } from "react";
import { Field, inputClass, selectClass } from "./ui/Field";
import { InfoTooltip } from "./ui/InfoTooltip";
import { isEvmChainId } from "@/lib/adapters/evmChains";
import { NON_EVM_CHAINS, findNonEvmChain } from "@/lib/adapters/nonEvmChains";

// Drawn from nonEvmChains.ts — the same list wallets/actions.ts's
// isAutoCapableChain checks server-side (the real, server-enforced source
// of truth). This copy only drives the UI (datalist suggestions, disabling
// the "auto" option), so it can safely import the plain-data half of that
// module (no adapters, no server-only) — being out of sync would just make
// the client-side hint wrong, never let an unsupported chain actually get
// saved as auto (the server checks again). The EVM half isn't in that
// list — isEvmChainId (imported directly from evmChains.ts, the same list
// evm.ts scans) recognizes any of the 32 configured EVM chains, so typing
// "RON" or "SEI" enables Auto mode exactly like "ETH" does, without
// needing every EVM chain cluttering the datalist below.
// "ETH" stands in for "any EVM chain" in the suggestion list — listing all
// 31 would be noisy for a text-autocomplete; typing another EVM chain id
// (RON, SEI, ARB, ...) still works via isEvmChainId below, just isn't
// suggested here.
const DATALIST_CHAINS = ["ETH", ...NON_EVM_CHAINS.map((c) => c.id)];

// Generated from the same list rather than a hand-written sentence — the
// old copy (a static string in this file) had already drifted once from
// the real NON_EVM_CHAINS list before that file existed to prevent it.
const AUTO_CHAINS_HINT = `Auto-sync exists for ${NON_EVM_CHAINS.map((c) => c.id).join(", ")}, and any EVM chain (ETH, RON, SEI, ARB, ...). Any other chain still works for manual tracking.`;

function isAutoCapableChain(chain: string): boolean {
  const upper = chain.trim().toUpperCase();
  return findNonEvmChain(upper) !== undefined || isEvmChainId(upper);
}

// Only BTC needs its own callout today — auto mode for every other chain
// just scans a plain address, nothing to explain. Keyed by the same
// uppercase id NON_EVM_CHAINS/wallets.chain use.
const CHAIN_ADDRESS_HINTS: Record<string, string> = {
  BTC: "An xpub/ypub/zpub scans the whole HD wallet account, not just one address — use that instead of a single receive address unless you're sure that one address is where funds actually sit.",
};

/**
 * Chain is free text with autocomplete (same pattern as the Tag field) —
 * any chain works for manual tracking, not just the ones this app has an
 * adapter for. Mode reacts to it: the "auto" option disables itself (and
 * the field snaps back to "manual" if it was selected) the moment the
 * typed chain isn't one this app can actually auto-sync. Address lives
 * here too (not in the parent form) specifically so its hint can react to
 * the same chain state — chain only exists as state inside this component,
 * and the parent pages are Server Components that can't hold it. All three
 * still submit as plain form fields (name="chain"/"mode"/"address") — this
 * only replaces the static markup with something that reacts to itself,
 * the surrounding form/server action is unchanged.
 *
 * Every hint here is deliberately conditional: a blank/unrecognized chain
 * shows no mode warning until the user has actually typed something, and
 * the long "which chains auto-sync" explanation lives in a hover tooltip
 * rather than sitting under the field permanently — showing guidance only
 * when it's relevant, not by default.
 */
export function ChainModeAddressFields({
  defaultChain = "",
  defaultMode = "",
  defaultAddress = "",
}: {
  defaultChain?: string;
  defaultMode?: string;
  defaultAddress?: string;
}) {
  const [chain, setChain] = useState(defaultChain);
  const [mode, setMode] = useState(defaultMode);
  const datalistId = useId();

  const trimmedChain = chain.trim();
  const isAutoCapable = isAutoCapableChain(trimmedChain);
  const addressHint = CHAIN_ADDRESS_HINTS[trimmedChain.toUpperCase()];

  return (
    <>
      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            Chain
            <InfoTooltip>{AUTO_CHAINS_HINT}</InfoTooltip>
          </span>
        }
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
        hint={
          trimmedChain !== "" && !isAutoCapable
            ? "Auto mode isn't available for this chain — manual entry only."
            : undefined
        }
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

      <Field
        label="Address"
        hint={addressHint ? `Optional for manual. ${addressHint}` : "Optional for manual tracking."}
      >
        <input name="address" type="text" defaultValue={defaultAddress} className={inputClass} />
      </Field>
    </>
  );
}
