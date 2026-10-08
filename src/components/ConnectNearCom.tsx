"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createStore, type EIP6963ProviderDetail } from "mipd";
import type { EIP1193Provider } from "viem";
import { connectNearCom, nearComChallengeAction, reconnectNearCom } from "@/app/(app)/wallets/actions";
import { REFRESH_TOKEN_DAYS } from "@/lib/nearIntents";
import { Dialog } from "./ui/Dialog";
import { Field, inputClass } from "./ui/Field";
import { buttonClass } from "./ui/Button";

/**
 * near.com (Confidential Intents, owner 2026-10-08; nearIntents.ts): your
 * wallet signs one EMPTY intent — proof the address is yours, nothing moves —
 * and near.com returns a read-only token the app stores encrypted, like an
 * exchange key. It lasts 30 days; `walletId` makes this the Reconnect for an
 * existing near.com wallet. Wallets found the same way as sign-in (EIP-6963,
 * window.ethereum as the fallback).
 */
export function ConnectNearCom({ walletId, signedAt, nowMs }: { walletId?: string; signedAt?: string | null; nowMs?: number }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("near.com");
  const [providers, setProviders] = useState<readonly EIP6963ProviderDetail[]>([]);
  const [legacy, setLegacy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const store = createStore();
    const unsubscribe = store.subscribe((p) => setProviders(p), { emitImmediately: true });
    const t = setTimeout(() => setLegacy(!!(window as { ethereum?: unknown }).ethereum), 150);
    return () => {
      unsubscribe();
      store.destroy();
      clearTimeout(t);
    };
  }, []);

  async function sign(provider: EIP1193Provider, key: string) {
    setError(null);
    setPending(key);
    try {
      const [address] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!address) throw new Error("No account returned by the wallet.");
      const challenge = await nearComChallengeAction(address);
      if (!challenge.ok) throw new Error(challenge.error);
      const hex = `0x${Array.from(new TextEncoder().encode(challenge.payload), (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      const signature = (await provider.request({ method: "personal_sign", params: [hex, address as `0x${string}`] })) as string;
      if (walletId) {
        const r = await reconnectNearCom(walletId, challenge.payload, signature);
        if (!r.ok) throw new Error(r.error);
        dialogRef.current?.close();
        router.refresh();
      } else {
        const r = await connectNearCom({ name, payload: challenge.payload, signature });
        if ("error" in r) throw new Error(r.error);
        router.push(`/wallets/${r.walletId}`);
      }
    } catch (e) {
      const rejected = e && typeof e === "object" && "code" in e && (e as { code: unknown }).code === 4001;
      setError(rejected ? "Request rejected in wallet." : e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setPending(null);
    }
  }

  const wallets: { key: string; label: string; icon?: string; provider: EIP1193Provider }[] = providers.length
    ? providers.map((p) => ({ key: p.info.uuid, label: p.info.name, icon: p.info.icon, provider: p.provider as EIP1193Provider }))
    : legacy
      ? [{ key: "injected", label: "Browser wallet", provider: (window as unknown as { ethereum: EIP1193Provider }).ethereum }]
      : [];

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className={walletId ? buttonClass("secondary", "sm") : `${buttonClass("secondary", "md")} w-full justify-start gap-2`}
      >
        {walletId ? "Reconnect near.com" : "Connect near.com"}
      </button>
      {walletId && signedAt && nowMs && <ReconnectBy signedAt={signedAt} nowMs={nowMs} />}
      <Dialog ref={dialogRef} title={walletId ? "Reconnect near.com" : "Connect near.com"}>
        <div className="flex flex-col gap-4">
          {error && <p className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">{error}</p>}
          <ul className="list-disc space-y-1 pl-4 text-xs text-fg-muted">
            <li>Sign once with the wallet you use on near.com. The message is an empty intent: it proves the address is yours and can&apos;t move funds.</li>
            <li>near.com returns a read-only token, stored encrypted. It lasts 30 days — then click Reconnect and sign again.</li>
          </ul>
          {!walletId && (
            <Field label="Name" hint="What to call this wallet in your list.">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={inputClass} />
            </Field>
          )}
          {wallets.length === 0 ? (
            <p className="text-sm text-fg-muted">No Ethereum wallet found in this browser — install or unlock MetaMask (or another) and reopen this.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {wallets.map((w) => (
                <button key={w.key} type="button" disabled={pending !== null} onClick={() => sign(w.provider, w.key)} className={`${buttonClass("primary", "md")} justify-center gap-2`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {w.icon && <img src={w.icon} alt="" className="size-4" />}
                  {pending === w.key ? "Waiting for your signature…" : `Sign with ${w.label}`}
                </button>
              ))}
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}

/** "Reconnect by Nov 7" — the token's 30 days, amber in the last 5 (the
 * request's clock, CLAUDE.md §6). */
function ReconnectBy({ signedAt, nowMs: now }: { signedAt: string; nowMs: number }) {
  const due = Date.parse(signedAt) + REFRESH_TOKEN_DAYS * 86_400_000;
  const days = Math.ceil((due - now) / 86_400_000);
  const date = new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return <p className={`text-xs ${days <= 5 ? "text-warning" : "text-fg-muted"}`}>{days > 0 ? `Reconnect by ${date} (${days} day${days === 1 ? "" : "s"})` : "Expired — reconnect to sync"}</p>;
}
