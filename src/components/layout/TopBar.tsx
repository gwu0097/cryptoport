import Link from "next/link";
import { Plug, Search, LogOut } from "lucide-react";
import { signOut } from "@/app/(auth)/actions";

export function TopBar({ userEmail }: { userEmail: string | null }) {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
      <div className="flex shrink-0 items-center gap-4">
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
      </div>

      {/* Plain GET form to /lookup — a read-only address search that never
          touches the portfolio (see lib/lookup.ts). A real navigation (not
          client-side routing), so the browser switches immediately; the
          slow on-chain fetch shows lookup/loading.tsx while it streams in. */}
      <form action="/lookup" className="flex flex-1 justify-center">
        <div className="relative w-full max-w-sm">
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

      <form action={signOut} className="flex shrink-0 items-center gap-2">
        {userEmail && <span className="hidden text-sm text-fg-muted sm:inline">{userEmail}</span>}
        <button
          type="submit"
          aria-label="Log out"
          title="Log out"
          className="grid size-9 place-items-center rounded-lg border border-border text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          <LogOut className="size-4" aria-hidden="true" />
        </button>
      </form>
    </header>
  );
}
