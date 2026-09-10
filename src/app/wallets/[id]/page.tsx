import Link from "next/link";
import { notFound } from "next/navigation";
import { getWalletDetail, type HoldingWithValuation } from "@/lib/queries";
import { formatStaleness, formatUsd } from "@/lib/format";
import { addHolding, deleteHolding, updateHolding } from "../actions";

function ValueCell({ holding }: { holding: HoldingWithValuation }) {
  if (holding.valuation.kind === "unpriced") {
    return <span style={{ color: "#a15c00" }}>unpriced</span>;
  }
  return <>{formatUsd(holding.valuation.usd)}</>;
}

function EditForm({ holding, walletId }: { holding: HoldingWithValuation; walletId: string }) {
  const update = updateHolding.bind(null, holding.id, walletId);
  return (
    <form action={update} style={{ display: "flex", gap: 4 }}>
      {holding.source === "manual_usd" ? (
        <input
          name="usd_override"
          type="text"
          inputMode="decimal"
          defaultValue={holding.usd_override ?? ""}
          style={{ width: 120 }}
        />
      ) : (
        <input
          name="qty"
          type="text"
          inputMode="decimal"
          defaultValue={holding.qty ?? ""}
          style={{ width: 120 }}
        />
      )}
      <button type="submit">Save</button>
    </form>
  );
}

export default async function WalletDetailPage(props: PageProps<"/wallets/[id]">) {
  const { id } = await props.params;
  const detail = await getWalletDetail(id);
  if (!detail) notFound();

  const { wallet, holdings, total, unpricedCount } = detail;
  const addHoldingForWallet = addHolding.bind(null, wallet.id);

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <p>
        <Link href="/">← Wallets</Link>
      </p>
      <h1>{wallet.name}</h1>
      <p>
        {wallet.chain} · {wallet.account} · {wallet.mode}
        {wallet.address && <> · {wallet.address}</>}
      </p>
      <p>Refreshed: {formatStaleness(wallet.last_refresh_at)}</p>

      <section style={{ margin: "16px 0" }}>
        <p style={{ fontSize: 24, fontWeight: 600 }}>{formatUsd(total)}</p>
        {unpricedCount > 0 && (
          <p style={{ color: "#a15c00" }}>
            {unpricedCount} holding{unpricedCount === 1 ? "" : "s"} unpriced and excluded from
            the total
          </p>
        )}
      </section>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid currentColor" }}>
            <th style={{ padding: "8px 4px" }}>Ticker</th>
            <th style={{ padding: "8px 4px" }}>Qty</th>
            <th style={{ padding: "8px 4px" }}>Price</th>
            <th style={{ padding: "8px 4px" }}>Value</th>
            <th style={{ padding: "8px 4px" }}>Source</th>
            <th style={{ padding: "8px 4px" }}></th>
          </tr>
        </thead>
        <tbody>
          {holdings.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: "8px 4px", opacity: 0.7 }}>
                No holdings yet.
              </td>
            </tr>
          )}
          {holdings.map((holding) => (
            <tr key={holding.id} style={{ borderBottom: "1px solid #4443" }}>
              <td style={{ padding: "8px 4px" }}>{holding.ticker}</td>
              <td style={{ padding: "8px 4px" }}>{holding.qty ?? "—"}</td>
              <td style={{ padding: "8px 4px" }}>
                {holding.source === "manual_usd" ? "—" : (holding.price ?? "unpriced")}
              </td>
              <td style={{ padding: "8px 4px" }}>
                <ValueCell holding={holding} />
              </td>
              <td style={{ padding: "8px 4px" }}>{holding.source}</td>
              <td style={{ padding: "8px 4px" }}>
                {holding.source === "auto" ? null : (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <EditForm holding={holding} walletId={wallet.id} />
                    <form action={deleteHolding.bind(null, holding.id, wallet.id)}>
                      <button type="submit">Delete</button>
                    </form>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Add holding</h2>
      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <form
          action={addHoldingForWallet}
          style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 220 }}
        >
          <input type="hidden" name="kind" value="qty" />
          <label>
            Ticker
            <input
              name="ticker"
              type="text"
              required
              defaultValue={wallet.chain}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Quantity
            <input
              name="qty"
              type="text"
              inputMode="decimal"
              required
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <button type="submit" style={{ alignSelf: "start" }}>
            Add by quantity
          </button>
        </form>

        <form
          action={addHoldingForWallet}
          style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 220 }}
        >
          <input type="hidden" name="kind" value="usd" />
          <label>
            Ticker
            <input name="ticker" type="text" required style={{ display: "block", width: "100%" }} />
          </label>
          <label>
            Fixed USD value
            <input
              name="usd_override"
              type="text"
              inputMode="decimal"
              required
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <button type="submit" style={{ alignSelf: "start" }}>
            Add fixed USD value
          </button>
        </form>
      </div>
    </main>
  );
}
