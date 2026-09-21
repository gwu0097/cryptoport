// Split out of adminAuth.ts: this is genuinely pure (a string comparison)
// and doesn't need next/navigation or ./auth's own next/headers-touching
// dependency chain — kept separate so it's directly `node --test`-able,
// same reasoning as walletDisplay.ts's own split from walletAuth.ts.

/** Pure comparison — the single most security-critical check in the admin
 * feature (src/app/(app)/admin/) deserves direct unit-test coverage, not
 * just an eyeball read of requireAdmin (adminAuth.ts). Case-insensitive
 * (email addresses are, in practice, regardless of RFC technicalities) and
 * null/undefined-safe on both sides: a signed-out visitor (`email` null)
 * and an unset ADMIN_EMAIL (feature disabled) both correctly fail closed
 * rather than throwing. */
export function isAdminEmail(email: string | null | undefined, adminEmail: string | undefined): boolean {
  return !!email && !!adminEmail && email.toLowerCase() === adminEmail.toLowerCase();
}
