"use client";

import { useRouter } from "next/navigation";
import { inputClass } from "./ui/Field";

/**
 * A plain `<select>` needs an onChange handler to navigate — unlike
 * CheckboxLink's pointer-events-none trick (a checkbox can be a disguised
 * link), there's no way to make a native select itself a link. Kept as
 * small as that one requirement: server component still owns the actual
 * data fetch (getTransactions(walletId)) based on the ?wallet= this sets,
 * same searchParams-driven pattern as every other filter in this app —
 * this just supplies the one bit of client JS a `<select>` can't avoid.
 */
export function TransactionsWalletFilter({
  wallets,
  selected,
}: {
  wallets: { id: string; name: string }[];
  selected: string | undefined;
}) {
  const router = useRouter();

  return (
    <select
      value={selected ?? "all"}
      onChange={(e) => {
        const value = e.target.value;
        router.push(value === "all" ? "/transactions" : `/transactions?wallet=${value}`);
      }}
      className={`${inputClass} max-w-xs`}
    >
      <option value="all">All wallets</option>
      {wallets.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
}
