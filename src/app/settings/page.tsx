import Link from "next/link";
import { getCredentials } from "@/lib/authCredentials";
import { changeCredentials } from "./actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const { changed } = await searchParams;
  const creds = await getCredentials();

  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <p>
        <Link href="/">← Wallets</Link>
      </p>
      <h1>Change login</h1>

      {changed && (
        <p style={{ color: "#1a7f37" }}>
          Login updated. Your browser will ask you to sign in again with the new credentials.
        </p>
      )}

      <form
        action={changeCredentials}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            required
            autoComplete="current-password"
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <label>
          New username
          <input
            name="newUsername"
            type="text"
            required
            defaultValue={creds?.username ?? ""}
            autoComplete="username"
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <label>
          New password
          <input
            name="newPassword"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <label>
          Confirm new password
          <input
            name="confirmPassword"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <button type="submit" style={{ alignSelf: "start" }}>
          Update login
        </button>
      </form>
    </main>
  );
}
