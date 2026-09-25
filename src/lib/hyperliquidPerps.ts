// How a Hyperliquid perps account's value is split into rows, so the rows add
// up to the account's value exactly once. The account's value (accountValue)
// is withdrawable cash plus the margin held in open positions; each position
// row carries its own margin, so the "Perps Available" row is only what is
// left over — never the whole non-withdrawable part, which counted every
// position's margin twice (+$4,677 on one wallet vs DeBank, 2026-09-25). Pure.

/** Account value not already shown as withdrawable cash or position margin
 * (usually ~0); null when there's nothing meaningful left (under a cent, or
 * negative from rounding). */
export function perpsUnallocatedUsd(accountValue: number, withdrawable: number, positionMargins: readonly number[]): number | null {
  if (!Number.isFinite(accountValue)) return null;
  const allocated = (Number.isFinite(withdrawable) ? withdrawable : 0) + positionMargins.filter(Number.isFinite).reduce((s, m) => s + m, 0);
  const rest = accountValue - allocated;
  return rest >= 0.01 ? rest : null;
}
