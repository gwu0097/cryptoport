"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { requestWalletSignIn, completeWalletSignIn } from "@/app/(auth)/walletActions";
import { requestWalletLink, completeWalletLink } from "@/app/(app)/settings/walletActions";
import { Button } from "@/components/ui/Button";
import type { WalletChain } from "@/lib/walletAuth";

// This project's first browser-wallet integration — no wagmi/ethers/
// RainbowKit dependency, just the raw EIP-1193 (window.ethereum) and
// Phantom-style (window.solana) provider APIs, which is all a single
// sign-message flow needs. Only a type import from walletAuth.ts (erased at
// build time) — the module's actual code (viem, @noble/curves) stays
// server-only and out of this client bundle. truncate() below duplicates
// walletAuth.ts's truncateAddress rather than importing it, for the same
// reason — a runtime import would pull that module's heavy dependencies in
// just for a few lines of string slicing.
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
 * Two independent triggers, not one auto-detecting button — anyone running
 * both an EVM wallet (Rabby) and a Solana wallet (Phantom) at once needs to
 * pick which to use, and guessing would be wrong for exactly that setup.
 * `mode` decides which pair of Server Actions this talks to:
 * (auth)/walletActions.ts (sign in, possibly creating a new account) or
 * (app)/settings/walletActions.ts (link to the already signed-in account).
 *
 * `pinnedTarget` narrows a mode="link" button to one already-known address
 * (the wallet detail page's "Link this wallet") — only that chain's button
 * renders, and the account the extension returns is compared against it
 * *before* a challenge is even requested, so connecting the wrong account
 * in the extension fails fast with a clear message instead of silently
 * linking whatever's active. This check is a UX convenience only, not the
 * security boundary — the server independently verifies the signature
 * against whatever address the client claims either way.
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
  const [pending, setPending] = useState<WalletChain | null>(null);
  // null until the post-mount check runs, so a fresh SSR paint shows
  // nothing instead of flashing "No wallet detected" for a moment.
  const [providers, setProviders] = useState<{ eth: boolean; sol: boolean } | null>(null);

  // Reads window.ethereum/window.solana after mount — neither exists during
  // server rendering, same "can't know yet" trade-off as WalletsTable.tsx's
  // localStorage read. Synchronizing with an external system, not deriving
  // state that could just be computed during render, so the lint rule is
  // disabled narrowly here rather than restructured around.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProviders({ eth: !!window.ethereum, sol: !!window.solana });
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

  async function requestChallenge(chain: WalletChain, address: string, chainId?: number): Promise<string> {
    if (mode === "signin") {
      const result = await requestWalletSignIn(chain, address, chainId);
      if (!result.ok) throw new Error(result.error);
      return result.message;
    }
    return requestWalletLink(chain, address, chainId);
  }

  async function completeChallenge(signatureHex: string): Promise<void> {
    if (mode === "signin") {
      const result = await completeWalletSignIn(signatureHex);
      if (!result.ok) throw new Error(result.error);
      router.push(result.redirectTo);
    } else {
      const { walletId } = await completeWalletLink(signatureHex);
      if (onLinked) onLinked(walletId);
      else router.refresh();
    }
  }

  async function connectEthereum() {
    setError(null);
    setPending("ETH");
    try {
      const provider = window.ethereum;
      if (!provider) throw new Error("No Ethereum wallet detected.");

      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const address = accounts[0];
      if (!address) throw new Error("No account returned by the wallet.");
      checkPinnedMatch("ETH", address);
      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;

      const message = await requestChallenge("ETH", address, parseInt(chainIdHex, 16));
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

  const showEth = !!providers?.eth && (!pinnedTarget || pinnedTarget.chain === "ETH");
  const showSol = !!providers?.sol && (!pinnedTarget || pinnedTarget.chain === "SOL");

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {showEth && (
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            disabled={pending !== null}
            onClick={connectEthereum}
          >
            {pending === "ETH" ? "Confirm in wallet…" : "Ethereum wallet"}
          </Button>
        )}
        {showSol && (
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
        {providers && !showEth && !showSol && (
          <p className="text-xs text-fg-muted">
            {pinnedTarget
              ? `Install ${pinnedTarget.chain === "ETH" ? "Rabby or MetaMask" : "Phantom"} to link this wallet.`
              : "No wallet detected — install Rabby, MetaMask, or Phantom."}
          </p>
        )}
      </div>
    </div>
  );
}
