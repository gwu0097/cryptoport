import Link from "next/link";
import { Plug } from "lucide-react";

export function TopBar() {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
      <Link
        href="/wallets/new"
        aria-label="Connect wallet"
        title="Connect wallet"
        className="grid size-9 place-items-center rounded-lg border border-border text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <Plug className="size-5" aria-hidden="true" />
      </Link>

      <Link href="/wallets" className="text-lg font-semibold tracking-tight text-fg">
        Crypto<span className="text-accent">Port</span>
      </Link>

      <div className="ml-auto" />
    </header>
  );
}
