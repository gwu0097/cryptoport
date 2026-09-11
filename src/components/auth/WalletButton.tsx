"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createStore, type EIP6963ProviderDetail } from "mipd";
import type { EIP1193Provider, Hex } from "viem";
import { Wallet as WalletIcon } from "lucide-react";
import { requestWalletSignIn, completeWalletSignIn } from "@/app/(auth)/walletActions";
import { requestWalletLink, completeWalletLink } from "@/app/(app)/settings/walletActions";
import type { WalletChain } from "@/lib/walletAuth";

// Row styling for the picker list inside WalletPickerDialog — left-aligned,
// full-width rows (icon + name), not the centered pill buttons ui/Button.tsx
// makes; this component is only ever rendered inside that dialog's left
// pane now; see WalletPickerDialog.tsx.
const ROW_CLASS =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-fg transition hover:bg-surface-raised disabled:opacity-50 disabled:pointer-events-none";

function RowIconWrap({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-raised text-fg-muted">
      {children}
    </span>
  );
}

// This project's first browser-wallet integration — no wagmi/ethers/
// RainbowKit dependency, just mipd (the standard EIP-6963 "Multi Injected
// Provider Discovery" store — see https://eips.ethereum.org/EIPS/eip-6963,
// the fix for every EVM wallet extension fighting over the single
// window.ethereum slot) plus the raw EIP-1193 and Phantom-style
// (window.solana) provider APIs for the actual connect/sign calls, which is
// all a sign-message flow needs. Only a type import from walletAuth.ts
// (erased at build time) — the module's actual code (viem, @noble/curves)
// stays server-only and out of this client bundle.
interface SolanaProvider {
  connect: () => Promise<{ publicKey: { toString(): string } }>;
  signMessage: (message: Uint8Array, display?: "utf8" | "hex") => Promise<{ signature: Uint8Array }>;
}
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
    solana?: SolanaProvider;
  }
}

function truncate(address: string): string {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Some wallets reject a raw UTF-8 string passed to personal_sign — hex is
// the safe wire format both directions in this component.
function messageToHex(message: string): Hex {
  return bytesToHex(new TextEncoder().encode(message));
}

// EIP-6963 announcing a provider means it claims EIP-1193/EVM compatibility
// — that's the whole point of the standard, so the picker itself doesn't
// second-guess a wallet's name or icon (a multi-chain wallet whose primary
// brand is e.g. Tron or Cosmos can still legitimately sign for Ethereum
// too). What it can't guarantee is that the address it actually returns is
// well-formed — this is the "any wallet can log in, as long as the address
// fits the right chain" check, applied at connect time instead of the
// picker filtering wallets out by guesswork.
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function walletErrorMessage(e: unknown): string {
  // EIP-1193's standard "user rejected the request" code.
  if (e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === 4001) {
    return "Request rejected in wallet.";
  }
  return e instanceof Error ? e.message : "Something went wrong connecting the wallet.";
}

// Remembers which wallet was used last (by EIP-6963 rdns — the uuid mipd
// assigns is per-session/per-tab and can't be compared across visits) so
// the picker can put it first, the same "last used at the top" UX every
// major wallet-connect picker (RainbowKit, Web3Modal, ...) already has.
// Solana has only ever one button, so it's just a kind flag with no id.
const LAST_WALLET_KEY = "cryptoport:lastWallet";
type LastWallet = { kind: "evm"; rdns: string } | { kind: "solana" };

function readLastWallet(): LastWallet | null {
  try {
    const raw = localStorage.getItem(LAST_WALLET_KEY);
    return raw ? (JSON.parse(raw) as LastWallet) : null;
  } catch {
    return null;
  }
}

function writeLastWallet(wallet: LastWallet): void {
  try {
    localStorage.setItem(LAST_WALLET_KEY, JSON.stringify(wallet));
  } catch {
    // best-effort — nothing to fall back to, ordering just stays default
  }
}

export interface PinnedWalletTarget {
  chain: WalletChain;
  address: string;
}

/**
 * One button per installed EVM wallet (via mipd's EIP-6963 store) plus one
 * for Solana, rather than a single "Ethereum wallet" button hostage to
 * whichever extension happens to hold window.ethereum — that's what made
 * this always seem to mean "Rabby specifically" before. A wallet that
 * hasn't adopted EIP-6963 yet still works via a generic "Ethereum wallet"
 * fallback button using window.ethereum directly, shown only when no 6963
 * wallet announced itself at all (a page never sees BOTH for the same
 * wallet, since a 6963 wallet still also sets window.ethereum). Whichever
 * wallet last completed a sign-in/link successfully sorts first, tagged
 * "Last used".
 *
 * `mode` decides which pair of Server Actions this talks to:
 * (auth)/walletActions.ts (sign in, possibly creating a new account) or
 * (app)/settings/walletActions.ts (link to the already signed-in account).
 *
 * `pinnedTarget` narrows a mode="link" button set to one already-known
 * address (the wallet detail page's "Verify" popup) — only that chain's
 * buttons render, and the account the extension returns is compared
 * against it *before* a challenge is even requested, so connecting the
 * wrong account fails fast with a clear message instead of silently
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
  // Identifies which specific button is mid-flow — an EIP-6963 provider's
  // uuid, "legacy-eth" for the window.ethereum fallback, or "SOL" — so only
  // the clicked button shows "Confirm in wallet…" while the rest just
  // disable, rather than one shared per-chain flag that can't distinguish
  // which of several EVM wallets was actually clicked.
  const [pending, setPending] = useState<string | null>(null);
  const [evmProviders, setEvmProviders] = useState<readonly EIP6963ProviderDetail[]>([]);
  // null until the post-mount discovery settles, so a fresh SSR paint shows
  // nothing instead of flashing "no wallet found" before extensions have
  // had a chance to respond. mipd's store itself has no such "done loading"
  // concept (an extension can announce at any time), so this stays a
  // component-local settle timer around it.
  const [ready, setReady] = useState<{ legacyEth: boolean; sol: boolean } | null>(null);
  const [lastWallet, setLastWallet] = useState<LastWallet | null>(null);

  useEffect(() => {
    // Reads localStorage after mount (unavailable during server rendering)
    // — synchronizing with an external system, not derivable state, same
    // "not the anti-pattern this rule targets" reasoning as WalletsTable's
    // matching read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLastWallet(readLastWallet());

    const store = createStore();
    const unsubscribe = store.subscribe((providers) => setEvmProviders(providers), { emitImmediately: true });

    // A brief settle window before treating "nothing announced yet" as
    // "nothing installed" — real extensions respond to mipd's own
    // requestProvider dispatch near-instantly, this just avoids a
    // one-frame flash of "not found".
    const settleTimer = setTimeout(() => {
      setReady({ legacyEth: !!window.ethereum, sol: !!window.solana });
    }, 150);

    return () => {
      unsubscribe();
      store.destroy();
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

  async function connectEthereum(provider: EIP1193Provider, pendingKey: string, rdns?: string) {
    setError(null);
    setPending(pendingKey);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const address = accounts[0];
      if (!address) throw new Error("No account returned by the wallet.");
      if (!EVM_ADDRESS_RE.test(address)) {
        throw new Error("This wallet returned a non-Ethereum address — it may not support Ethereum.");
      }
      checkPinnedMatch("ETH", address);
      const chainIdHex = await provider.request({ method: "eth_chainId" });
      // A malformed/unexpected eth_chainId response (some wallet quirk)
      // shouldn't block signing in over a cosmetic SIWE field — parseInt
      // can yield NaN, which viem's createSiweMessage server-side rejects
      // outright (NaN !== Math.floor(NaN) is always true), so undefined
      // (→ walletAuth.ts's own chainId ?? 1 default) is the safe fallback.
      const parsedChainId = parseInt(chainIdHex, 16);
      const chainId = Number.isFinite(parsedChainId) ? parsedChainId : undefined;

      const message = await requestChallenge("ETH", address, chainId);
      const signature = await provider.request({
        method: "personal_sign",
        params: [messageToHex(message), address],
      });

      await completeChallenge(signature);
      if (rdns) writeLastWallet({ kind: "evm", rdns });
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
      if (!SOLANA_ADDRESS_RE.test(address)) {
        throw new Error("This wallet returned an address that doesn't look like Solana.");
      }
      checkPinnedMatch("SOL", address);

      const message = await requestChallenge("SOL", address);
      const { signature } = await provider.signMessage(new TextEncoder().encode(message), "utf8");

      await completeChallenge(bytesToHex(signature));
      writeLastWallet({ kind: "solana" });
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

  const sortedEvmProviders =
    lastWallet?.kind === "evm"
      ? [...evmProviders].sort((a, b) => {
          if (a.info.rdns === lastWallet.rdns) return -1;
          if (b.info.rdns === lastWallet.rdns) return 1;
          return 0;
        })
      : evmProviders;

  return (
    <div className="flex flex-col gap-1">
      {error && (
        <p className="mb-1 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
          {error}
        </p>
      )}

      {showEvm &&
        sortedEvmProviders.map((detail) => {
          const isLastUsed = lastWallet?.kind === "evm" && lastWallet.rdns === detail.info.rdns;
          return (
            <button
              key={detail.info.uuid}
              type="button"
              disabled={pending !== null}
              onClick={() => connectEthereum(detail.provider, detail.info.uuid, detail.info.rdns)}
              className={ROW_CLASS}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a wallet-supplied data: URI, not an optimizable asset */}
              <img src={detail.info.icon} alt="" className="size-6 shrink-0 rounded-md" aria-hidden="true" />
              <span className="flex-1 truncate">
                {pending === detail.info.uuid ? "Confirm in wallet…" : detail.info.name}
                {isLastUsed && pending !== detail.info.uuid && (
                  <span className="block text-xs font-normal text-fg-muted">Last used</span>
                )}
              </span>
            </button>
          );
        })}

      {showLegacyEth && (
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => connectEthereum(window.ethereum!, "legacy-eth")}
          className={ROW_CLASS}
        >
          <RowIconWrap>
            <WalletIcon className="size-3.5" aria-hidden="true" />
          </RowIconWrap>
          {pending === "legacy-eth" ? "Confirm in wallet…" : "Ethereum wallet"}
        </button>
      )}

      {showSol && !!ready?.sol && (
        <button type="button" disabled={pending !== null} onClick={connectSolana} className={ROW_CLASS}>
          <RowIconWrap>
            <WalletIcon className="size-3.5" aria-hidden="true" />
          </RowIconWrap>
          {pending === "SOL" ? "Confirm in wallet…" : "Solana wallet"}
        </button>
      )}

      {noEthFound && (
        <p className="px-3 py-2 text-xs text-fg-muted">
          No Ethereum wallet found — install Rabby, MetaMask, or another wallet.
        </p>
      )}
      {noSolFound && (
        <p className="px-3 py-2 text-xs text-fg-muted">
          No Solana wallet found — install Phantom, Solflare, or Backpack.
        </p>
      )}
    </div>
  );
}
