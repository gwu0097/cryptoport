import Link from "next/link";
import { Search } from "lucide-react";
import { searchWallet } from "@/app/(app)/wallet-watch/actions";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { SearchedWallet } from "@/lib/watchQuery";

/**
 * Wallet search (owner 2026-09-30): any address opens on the influencer
 * page as if watched — read now, trading record a click away — without a
 * name or group. Naming it there saves it; the unsaved ones are listed here
 * and removed after 10 days.
 */
export function WalletSearch({ searched, error }: { searched: SearchedWallet[]; error?: string }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <form action={searchWallet} className="flex w-full items-center gap-2 sm:w-auto">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <input
            type="text"
            name="address"
            required
            placeholder="Search any wallet address…"
            className="h-9 w-full rounded-lg border border-border bg-surface-raised pl-9 pr-3 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
        </div>
        <SubmitButton variant="secondary" size="sm" pendingLabel="Opening…">
          Wallet search
        </SubmitButton>
      </form>
      {error && <p className="text-xs text-negative">{error}</p>}
      {searched.length > 0 && (
        <p className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-fg-muted">
          <span title="Not saved — name one on its page to keep it. Unsaved searches are removed after 10 days.">Recent searches:</span>
          {searched.map((s) => (
            <Link key={s.id} href={`/wallet-watch/${s.id}`} className="font-mono text-fg hover:text-accent" title={s.addresses.join(", ")}>
              {s.name}
            </Link>
          ))}
        </p>
      )}
    </div>
  );
}
