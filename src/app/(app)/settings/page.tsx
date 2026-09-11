import { getUser } from "@/lib/auth";
import { updateAccountPassword } from "./actions";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field, inputClass, selectClass } from "@/components/ui/Field";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const { changed } = await searchParams;
  const user = await getUser();

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

        <Panel title="Account">
          <p className="mb-4 text-sm text-fg-muted">
            Signed in as <span className="text-fg">{user?.email}</span>
          </p>

          {changed && (
            <p className="mb-4 rounded-lg border border-positive/30 bg-positive/10 px-4 py-3 text-sm text-positive">
              Password updated.
            </p>
          )}

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
        </Panel>
      </div>
    </>
  );
}
