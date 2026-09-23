import { getUser } from "@/lib/auth";
import { updateAccountPassword } from "../settings/actions";
import { unlinkWallet } from "../settings/walletActions";
import { signOut } from "@/app/(auth)/actions";
import { getLinkedWallets } from "@/lib/queries";
import { isSyntheticEmail, truncateAddress, walletDisplayName } from "@/lib/walletDisplay";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { Field, inputClass } from "@/components/ui/Field";
import { LinkWalletModal } from "@/components/auth/LinkWalletModal";
import { SignInPrompt } from "@/components/SignInPrompt";

export const metadata = { title: "Profile · CryptoPort" };

/**
 * Profile = who you are and how you sign in (email, password, linked sign-in
 * wallets). App behaviour (theme, language & region incl. timezone) lives in
 * Settings — the common split (identity vs. configuration; e.g. Slack keeps
 * timezone under Preferences, not the profile). Opened from the profile menu
 * at the top right.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const { changed } = await searchParams;
  const user = await getUser();
  const linkedWallets = await getLinkedWallets();
  const walletOnly = user ? isSyntheticEmail(user.email ?? "") : false;

  return (
    <>
      <PageHeader title="Profile" />

      <div className="flex max-w-2xl flex-col gap-6">
        {!user ? (
          <SignInPrompt message="Sign up or log in to manage your account." />
        ) : (
          <>
            <Panel title="Account">
              <p className="mb-4 text-sm text-fg-muted">
                Signed in as{" "}
                <span className="text-fg">{walletDisplayName(user) ?? user.email}</span>
              </p>

              {changed && (
                <p className="mb-4 rounded-lg border border-positive/30 bg-positive/10 px-4 py-3 text-sm text-positive">
                  Password updated.
                </p>
              )}

              {walletOnly ? (
                <p className="text-xs text-fg-muted">
                  This account has no password — sign in with a linked wallet below instead.
                </p>
              ) : (
                <form action={updateAccountPassword} className="flex flex-col gap-4">
                  <Field label="New password" hint="At least 8 characters.">
                    <input
                      name="password"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </Field>

                  <Field label="Confirm new password">
                    <input
                      name="confirmPassword"
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </Field>

                  <SubmitButton className="self-start" pendingLabel="Updating…">
                    Update password
                  </SubmitButton>
                </form>
              )}
            </Panel>

            <Panel title="Linked wallets" description="Sign in with any of these instead of your email.">
              {linkedWallets.length > 0 && (
                <ul className="mb-4 flex flex-col gap-2">
                  {linkedWallets.map((wallet) => (
                    <li
                      key={wallet.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm"
                    >
                      <span>
                        <span className="text-fg-muted">{wallet.chain === "ETH" ? "Ethereum" : "Solana"}</span>{" "}
                        <span className="text-fg" title={wallet.address}>
                          {truncateAddress(wallet.address)}
                        </span>
                      </span>
                      <form action={unlinkWallet.bind(null, wallet.id)}>
                        <ConfirmDeleteButton confirmMessage={`Unlink ${truncateAddress(wallet.address)}?`}>
                          Unlink
                        </ConfirmDeleteButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              <LinkWalletModal />
            </Panel>
            <Panel title="Session">
              <form action={signOut}>
                <SubmitButton variant="secondary" pendingLabel="Signing out…">
                  Sign out
                </SubmitButton>
              </form>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
