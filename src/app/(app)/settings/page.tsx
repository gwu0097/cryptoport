import { getUser } from "@/lib/auth";
import { updateAccountPassword } from "./actions";
import { unlinkWallet } from "./walletActions";
import { getLinkedWallets } from "@/lib/queries";
import { isSyntheticEmail, truncateAddress, walletDisplayName } from "@/lib/walletDisplay";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ConfirmDeleteButton } from "@/components/ui/ConfirmDeleteButton";
import { Field, inputClass, selectClass } from "@/components/ui/Field";
import { LinkWalletModal } from "@/components/auth/LinkWalletModal";
import { SignInPrompt } from "@/components/SignInPrompt";

export default async function SettingsPage({
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
      <PageHeader title="Settings" />

      <div className="flex max-w-2xl flex-col gap-6">
        <Panel title="Appearance">
          <Field label="Theme" hint="Light theme coming soon.">
            <select disabled defaultValue="dark" className={selectClass}>
              <option value="dark">Dark</option>
            </select>
          </Field>
        </Panel>

        <Panel title="Preferences">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Language">
              <select disabled defaultValue="en" className={selectClass}>
                <option value="en">English</option>
              </select>
            </Field>
            <Field label="Currency">
              <select disabled defaultValue="usd" className={selectClass}>
                <option value="usd">USD</option>
              </select>
            </Field>
          </div>
          <p className="mt-3 text-xs text-fg-muted">
            More languages and currencies coming soon.
          </p>
        </Panel>

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
          </>
        )}
      </div>
    </>
  );
}
