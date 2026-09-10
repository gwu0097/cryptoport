import Link from "next/link";
import { Plug, Search } from "lucide-react";

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

      {/* Plain GET form to /lookup — a read-only address search that never
          touches the portfolio (see lib/lookup.ts). No client JS needed. */}
      <form action="/lookup" className="ml-auto w-full max-w-sm">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <input
            type="text"
            name="address"
            placeholder="Search any wallet address…"
            className="h-9 w-full rounded-lg border border-border bg-surface-raised pl-9 pr-3 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
        </div>
      </form>
    </header>
  );
}
