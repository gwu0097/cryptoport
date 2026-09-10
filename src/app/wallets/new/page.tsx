import Link from "next/link";
import { createWallet } from "../actions";

export default function NewWalletPage() {
  return (
    <main style={{ padding: 24, maxWidth: 480, margin: "0 auto" }}>
      <p>
        <Link href="/">← Wallets</Link>
      </p>
      <h1>Add wallet</h1>

      <form action={createWallet} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Name
          <input name="name" type="text" required style={{ display: "block", width: "100%" }} />
        </label>

        <label>
          Chain
          <select name="chain" required defaultValue="" style={{ display: "block", width: "100%" }}>
            <option value="" disabled>
              Select a chain
            </option>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
            <option value="SOL">SOL</option>
          </select>
        </label>

        <label>
          Mode
          <select name="mode" required defaultValue="" style={{ display: "block", width: "100%" }}>
            <option value="" disabled>
              Select a mode
            </option>
            <option value="manual">manual — enter holdings by hand</option>
            <option value="auto">auto — adapter fetches holdings</option>
          </select>
        </label>

        <label>
          Account
          <select name="account" defaultValue="personal" style={{ display: "block", width: "100%" }}>
            <option value="personal">personal</option>
            <option value="biz">biz</option>
          </select>
        </label>

        <label>
          Address <span style={{ opacity: 0.7 }}>(optional for manual)</span>
          <input name="address" type="text" style={{ display: "block", width: "100%" }} />
        </label>

        <button type="submit" style={{ alignSelf: "start" }}>
          Create wallet
        </button>
      </form>
    </main>
  );
}
