import Link from "next/link";
import { getWalletsWithTotals } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { refreshPricesAction } from "./actions";

// Without this, Next prerenders "/" once at build time (it has no runtime
// APIs or cookies to force dynamic rendering the old way) and Vercel would
// serve that frozen snapshot until the next deploy — wrong for a page whose
// entire job is showing current wallet values.
export const dynamic = "force-dynamic";

export default async function Home() {
  const { wallets, grand } = await getWalletsWithTotals();

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>CryptoPort</h1>

      <section style={{ margin: "16px 0" }}>
        <p style={{ fontSize: 24, fontWeight: 600 }}>{formatUsd(grand.total)}</p>
        {grand.unpricedCount > 0 && (
          <p style={{ color: "#a15c00" }}>
            {grand.unpricedCount} holding{grand.unpricedCount === 1 ? "" : "s"} unpriced and
            excluded from the total ({grand.unpricedTickers.join(", ")})
          </p>
        )}
      </section>

      <p style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <Link href="/wallets/new">+ Add wallet</Link>
        <form action={refreshPricesAction}>
          <button type="submit">Refresh prices</button>
        </form>
        <Link href="/settings">Change login</Link>
      </p>

      {wallets.length === 0 ? (
        <p>No wallets yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid currentColor" }}>
              <th style={{ padding: "8px 4px" }}>Name</th>
              <th style={{ padding: "8px 4px" }}>Chain</th>
              <th style={{ padding: "8px 4px" }}>Account</th>
              <th style={{ padding: "8px 4px" }}>Mode</th>
              <th style={{ padding: "8px 4px" }}>Value</th>
              <th style={{ padding: "8px 4px" }}>Refreshed</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((wallet) => (
              <tr key={wallet.id} style={{ borderBottom: "1px solid #4443" }}>
                <td style={{ padding: "8px 4px" }}>
                  <Link href={`/wallets/${wallet.id}`}>{wallet.name}</Link>
                </td>
                <td style={{ padding: "8px 4px" }}>{wallet.chain}</td>
                <td style={{ padding: "8px 4px" }}>{wallet.account}</td>
                <td style={{ padding: "8px 4px" }}>{wallet.mode}</td>
                <td style={{ padding: "8px 4px" }}>
                  {wallet.total > 0 ? formatUsd(wallet.total) : null}
                  {wallet.unpricedCount > 0 && (
                    <span style={{ color: "#a15c00" }}>
                      {" "}
                      ({wallet.unpricedCount} unpriced)
                    </span>
                  )}
                  {wallet.total === 0 && wallet.unpricedCount === 0 && "—"}
                </td>
                <td style={{ padding: "8px 4px" }}>{formatStaleness(wallet.last_refresh_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
