// Pure, no imports — the two password-changing rules this app enforces
// (minimum length, matches its confirmation) used to be independently
// reimplemented three times across two files (signUp and updatePassword in
// (auth)/actions.ts, updateAccountPassword in (app)/settings/actions.ts),
// with the length constant redeclared in two places and the check order
// and error wording already drifted between them. One rule set now.

export const MIN_PASSWORD_LENGTH = 8;

/** Returns an error message if the password is invalid, or null if it's
 * fine. Validate-only, never throws — each caller presents the result in
 * its own idiom (a {error} form-state object in one file, a thrown Error
 * in another). */
export function validatePassword(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmPassword) return "Passwords do not match.";
  return null;
}
