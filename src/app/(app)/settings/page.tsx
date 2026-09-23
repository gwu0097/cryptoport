import { saveTimeZone } from "./actions";
import { getUser } from "@/lib/auth";
import { getEffectiveTimeZone } from "@/lib/preferences";
import { listTimeZones, timeZoneLabel } from "@/lib/timezone";
import { PageHeader } from "@/components/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Field, selectClass } from "@/components/ui/Field";

export const metadata = { title: "Settings · CryptoPort" };

/**
 * Settings = how the app behaves for you (theme, language & region). Account
 * and sign-in details moved to Profile (the profile menu, top right).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const { saved } = await searchParams;
  const [user, zone] = await Promise.all([getUser(), getEffectiveTimeZone()]);
  const zones = listTimeZones();

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

        <Panel
          title="Language & region"
          description="Every time on the site is shown in this timezone. Data is still stored and computed in UTC (daily snapshots, the Fundamentals run, signal blocks) — only how times are displayed changes."
        >
          {saved === "timezone" && (
            <p className="mb-4 rounded-lg border border-positive/30 bg-positive/10 px-4 py-3 text-sm text-positive">
              Time zone saved.
            </p>
          )}
          {user ? (
            <form action={saveTimeZone} className="mb-4 flex flex-wrap items-end gap-3">
              <Field
                label="Time zone"
                hint={
                  zone.saved
                    ? `Currently showing ${timeZoneLabel(zone.tz)}.`
                    : zone.detected
                      ? `Automatic: your browser is on ${timeZoneLabel(zone.detected)}.`
                      : "Automatic: detecting your browser's timezone…"
                }
              >
                <select name="timezone" defaultValue={zone.saved ?? "auto"} className={selectClass}>
                  <option value="auto">Automatic (detect from browser){zone.detected ? ` — ${zone.detected}` : ""}</option>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </form>
          ) : (
            <p className="mb-4 text-sm text-fg-muted">
              Showing times in {timeZoneLabel(zone.tz)} (detected from your browser). Log in to choose a different one.
            </p>
          )}
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
          <p className="mt-3 text-xs text-fg-muted">More languages and currencies coming soon.</p>
        </Panel>
      </div>
    </>
  );
}
