"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { requestWalletSignIn, completeWalletSignIn } from "@/app/(auth)/walletActions";
import { requestWalletLink, completeWalletLink } from "@/app/(app)/settings/walletActions";
import { Button } from "@/components/ui/Button";
import type { WalletChain } from "@/lib/walletAuth";

// This project's first browser-wallet integration — no wagmi/ethers/
// RainbowKit dependency, just the raw EIP-1193 (window.ethereum), EIP-6963
// (multi-wallet discovery), and Phantom-style (window.solana) provider
// APIs, which is all a sign-message flow needs. Only a type import from
// walletAuth.ts (erased at build time) — the module's actual code (viem,
// @noble/curves) stays server-only and out of this client bundle.
// truncate() below duplicates walletAuth.ts's truncateAddress rather than
// importing it, for the same reason.
interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}
interface SolanaProvider {
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signMessage: (message: Uint8Array, display?: "utf8" | "hex") => Promise<{ signature: Uint8Array }>;
}
declare global {
  interface Window {
    ethereum?: EthereumProvider;
    solana?: SolanaProvider;
  }
}

// EIP-6963 ("Multi Injected Provider Discovery") — the standard fix for the
// single-slot window.ethereum problem: every EVM wallet extension fights
// over that one global, so only whichever one "wins" it is ever reachable.
// A 6963-aware wallet instead announces itself via a CustomEvent, letting a
// page discover every installed wallet and offer a real choice rather than
// being at the mercy of browser extension load order. A page asks for
// announcements by dispatching "eip6963:requestProvider"; a wallet extension
// announces via "eip6963:announceProvider" (both on load, and again on
// request) with a stable per-session uuid, a display name, and an icon.
interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: EthereumProvider;
}

function truncate(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Some wallets reject a raw UTF-8 string passed to personal_sign — hex is
// the safe wire format both directions in this component.
function messageToHex(message: string): string {
  return bytesToHex(new TextEncoder().encode(message));
}

function walletErrorMessage(e: unknown): string {
  // EIP-1193's standard "user rejected the request" code.
  if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === 4001) {
    return "Request rejected in wallet.";
  }
  return e instanceof Error ? e.message : "Something went wrong connecting the wallet.";
}

export interface PinnedWalletTarget {
  chain: WalletChain;
  address: string;
}

/**
 * One button per installed EVM wallet (via EIP-6963 discovery) plus one for
 * Solana, rather than a single "Ethereum wallet" button hostage to whichever
 * extension happens to hold window.ethereum — that's what made this always
 * seem to mean "Rabby specifically" before. A wallet that hasn't adopted
 * EIP-6963 yet still works via a generic "Ethereum wallet" fallback button
 * using window.ethereum directly, shown only when no 6963 wallet announced
 * itself at all (a page never sees BOTH for the same wallet, since a 6963
 * wallet still also sets window.ethereum).
 *
 * `mode` decides which pair of Server Actions this talks to:
 * (auth)/walletActions.ts (sign in, possibly creating a new account) or
 * (app)/settings/walletActions.ts (link to the already signed-in account).
 *
 * `pinnedTarget` narrows a mode="link" button set to one already-known
 * address (the wallet detail page's "Link this wallet") — only that
 * chain's buttons render, and the account the extension returns is
 * compared against it *before* a challenge is even requested, so
 * connecting the wrong account fails fast with a clear message instead of
 * silently linking whatever's active. This check is a UX convenience only,
 * not the security boundary — the server independently verifies the
 * signature against whatever address the client claims either way.
 *
 * `onLinked` lets a caller react to a successful link beyond the default
 * router.refresh() (wallets/new redirects to the new wallet's page instead,
 * since refreshing an empty "add wallet" form would be a dead end).
 */
export function WalletButton({
  mode,
  pinnedTarget,
  onLinked,
}: {
  mode: "signin" | "link";
  pinnedTarget?: PinnedWalletTarget;
  onLinked?: (walletId: string) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Identifies which specific button is mid-flow — an EIP-6963 provider's
  // uuid, "legacy-eth" for the window.ethereum fallback, or "SOL" — so only
  // the clicked button shows "Confirm in wallet…" while the rest just
  // disable, rather than one shared per-chain flag that can't distinguish
  // which of several EVM wallets was actually clicked.
  const [pending, setPending] = useState<string | null>(null);
  const [evmProviders, setEvmProviders] = useState<Eip6963ProviderDetail[]>([]);
  // null until the post-mount discovery settles, so a fresh SSR paint shows
  // nothing instead of flashing "no wallet found" before extensions have
  // had a chance to respond.
  const [ready, setReady] = useState<{ legacyEth: boolean; sol: boolean } | null>(null);

  useEffect(() => {
    const found = new Map<string, Eip6963ProviderDetail>();

    function onAnnounce(event: Event) {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      found.set(detail.info.uuid, detail);
      setEvmProviders([...found.values()]);
    }

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    // Asks every already-loaded 6963-aware extension to (re-)announce right
    // now — needed because an extension's own on-load announcement can fire
    // before this listener is attached.
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // A brief settle window before treating "nothing announced yet" as
    // "nothing installed" — real extensions respond to the request event
    // near-instantly, this just avoids a one-frame flash of "not found".
    const settleTimer = setTimeout(() => {
      setReady({ legacyEth: !!window.ethereum, sol: !!window.solana });
    }, 150);

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(settleTimer);
    };
  }, []);

  function checkPinnedMatch(chain: WalletChain, address: string): void {
    if (!pinnedTarget) return;
    const matches =
      chain === "ETH"
        ? address.toLowerCase() === pinnedTarget.address.toLowerCase()
        : address === pinnedTarget.address;
    if (!matches) {
      throw new Error(
        `Your wallet is connected as ${truncate(address)}, but this wallet is ${truncate(pinnedTarget.address)} — switch accounts and try again.`,
      );
    }
  }

  // Both requestWalletSignIn/requestWalletLink and completeWalletSignIn/
  // completeWalletLink return {ok, ...} rather than throwing (see
  // settings/walletActions.ts's comment on why) — converted to a plain
  // throw right here, at the client/server boundary, rather than one
  // component-wide try/catch further down swallowing the distinction
  // between "the server said no" and "something else broke".
  async function requestChallenge(chain: WalletChain, address: string, chainId?: number): Promise<string> {
    const result =
      mode === "signin"
        ? await requestWalletSignIn(chain, address, chainId)
        : await requestWalletLink(chain, address, chainId);
    if (!result.ok) throw new Error(result.error);
    return result.message;
  }

  async function completeChallenge(signatureHex: string): Promise<void> {
    if (mode === "signin") {
      const result = await completeWalletSignIn(signatureHex);
      if (!result.ok) throw new Error(result.error);
      router.push(result.redirectTo);
    } else {
      const result = await completeWalletLink(signatureHex);
      if (!result.ok) throw new Error(result.error);
      if (onLinked) onLinked(result.walletId);
      else router.refresh();
    }
  }

  async function connectEthereum(provider: EthereumProvider, pendingKey: string) {
    setError(null);
    setPending(pendingKey);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("No account returned by the wallet.");
      checkPinnedMatch("ETH", address);
      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
      // A malformed/unexpected eth_chainId response (some wallet quirk)
      // shouldn't block signing in over a cosmetic SIWE field — parseInt
      // can yield NaN, which viem's createSiweMessage server-side rejects
      // outright (NaN !== Math.floor(NaN) is always true), so undefined
      // (→ walletAuth.ts's own chainId ?? 1 default) is the safe fallback.
      const parsedChainId = parseInt(chainIdHex, 16);
      const chainId = Number.isFinite(parsedChainId) ? parsedChainId : undefined;

      const message = await requestChallenge("ETH", address, chainId);
      const signature = (await provider.request({
        method: "personal_sign",
        params: [messageToHex(message), address],
      })) as string;

      await completeChallenge(signature);
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setPending(null);
    }
  }

  async function connectSolana() {
    setError(null);
    setPending("SOL");
    try {
      const provider = window.solana;
      if (!provider) throw new Error("No Solana wallet detected.");

      const { publicKey } = await provider.connect();
      const address = publicKey.toString();
      checkPinnedMatch("SOL", address);

      const message = await requestChallenge("SOL", address);
      const { signature } = await provider.signMessage(new TextEncoder().encode(message), "utf8");

      await completeChallenge(bytesToHex(signature));
    } catch (e) {
      setError(walletErrorMessage(e));
    } finally {
      setPending(null);
    }
  }

  const showEvm = !pinnedTarget || pinnedTarget.chain === "ETH";
  const showSol = !pinnedTarget || pinnedTarget.chain === "SOL";
  // A 6963-aware wallet still also sets window.ethereum, so the legacy
  // fallback only makes sense once discovery has settled with nothing
  // found via the newer standard — otherwise a single wallet would show up
  // as two buttons.
  const showLegacyEth = showEvm && evmProviders.length === 0 && !!ready?.legacyEth;
  const noEthFound = showEvm && evmProviders.length === 0 && ready && !ready.legacyEth;
  const noSolFound = showSol && ready && !ready.sol;

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {showEvm &&
          evmProviders.map((detail) => (
            <Button
              key={detail.info.uuid}
              type="button"
              variant="secondary"
              className="flex-1 items-center gap-2"
              disabled={pending !== null}
              onClick={() => connectEthereum(detail.provider, detail.info.uuid)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a wallet-supplied data: URI, not an optimizable asset */}
              <img src={detail.info.icon} alt="" className="size-4 shrink-0" aria-hidden="true" />
              {pending === detail.info.uuid ? "Confirm in wallet…" : detail.info.name}
            </Button>
          ))}

        {showLegacyEth && (
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            disabled={pending !== null}
            onClick={() => connectEthereum(window.ethereum!, "legacy-eth")}
          >
            {pending === "legacy-eth" ? "Confirm in wallet…" : "Ethereum wallet"}
          </Button>
        )}

        {showSol && !!ready?.sol && (
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            disabled={pending !== null}
            onClick={connectSolana}
          >
            {pending === "SOL" ? "Confirm in wallet…" : "Solana wallet"}
          </Button>
        )}

        {noEthFound && (
          <p className="text-xs text-fg-muted">
            No Ethereum wallet found — install Rabby, MetaMask, or another wallet.
          </p>
        )}
        {noSolFound && (
          <p className="text-xs text-fg-muted">
            No Solana wallet found — install Phantom, Solflare, or Backpack.
          </p>
        )}
      </div>
    </div>
  );
}
