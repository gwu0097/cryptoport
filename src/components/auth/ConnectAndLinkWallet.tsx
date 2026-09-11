"use client";

import { useRouter } from "next/navigation";
import { WalletButton } from "./WalletButton";

/**
 * wallets/new's "connect & link" option — wraps WalletButton with the
 * navigate-to-the-new-wallet behavior that page needs instead of
 * WalletButton's default router.refresh() (refreshing an empty "add
 * wallet" form after a successful connect would be a dead end). Its own
 * component because a Server Component can't pass a plain callback like
 * this to a Client Component prop — only a Server Action crosses that
 * boundary as a function, and router.push isn't one.
 */
export function ConnectAndLinkWallet() {
  const router = useRouter();
  return <WalletButton mode="link" onLinked={(walletId) => router.push(`/wallets/${walletId}?autosync=1`)} />;
}
