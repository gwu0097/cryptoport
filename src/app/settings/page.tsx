import { getCredentials } from "@/lib/authCredentials";
import { changeCredentials } from "./actions";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Field, inputClass, selectClass } from "@/components/ui/Field";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const { changed } = await searchParams;
  const creds = await getCredentials();

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

        <Panel title="Login">
          {changed && (
            <p className="mb-4 rounded-lg border border-positive/30 bg-positive/10 px-4 py-3 text-sm text-positive">
              Login updated. Your browser will ask you to sign in again with the new credentials.
            </p>
          )}

          <form action={changeCredentials} className="flex flex-col gap-4">
            <Field label="Current password">
              <input
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
                className={inputClass}
              />
            </Field>

            <Field label="New username">
              <input
                name="newUsername"
                type="text"
                required
                defaultValue={creds?.username ?? ""}
                autoComplete="username"
                className={inputClass}
              />
            </Field>

            <Field label="New password">
              <input
                name="newPassword"
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

            <Button type="submit" className="self-start">
              Update login
            </Button>
          </form>
        </Panel>
      </div>
    </>
  );
}
