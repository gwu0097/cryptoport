// The list "Add Exchange" renders from — built as a registry, not
// hand-written markup, specifically so the next exchange is "add an entry
// here + an adapter file", not a UI rewrite. Pure/no server deps, so this
// can be imported from a client component too.
export interface ExchangeProvider {
  id: string; // matches wallets.provider / exchange_connections.provider
  name: string;
  portalUrl: string;
  /** Short, ordered setup steps shown in the connect modal — specific to
   * each provider's own portal, since "generate a key" looks different
   * everywhere. */
  steps: string[];
  /** Field labels/hints also differ enough per provider (Coinbase's "key
   * name" is a full resource path; Kraken/Gemini's is a plain string) that
   * hand-writing generic text for both wouldn't actually fit either well —
   * cheaper to let each provider supply its own two-field copy than to
   * find a lowest-common-denominator wording. */
  keyLabel: string;
  keyHint: string;
  secretLabel: string;
  secretHint: string;
}

export const EXCHANGE_PROVIDERS: ExchangeProvider[] = [
  {
    id: "coinbase",
    name: "Coinbase",
    portalUrl: "https://portal.cdp.coinbase.com/api-keys/secret",
    steps: [
      "Go to portal.cdp.coinbase.com → API Keys → Secret API Keys → Create API key.",
      "Permissions: View only.",
      "Copy the key name (organizations/.../apiKeys/...) and the private key below — Ed25519 or ECDSA both work, paste it exactly as shown.",
    ],
    keyLabel: "Key name",
    keyHint: "organizations/.../apiKeys/...",
    secretLabel: "Private key",
    secretHint: "Paste it exactly as Coinbase shows it — a PEM block (with BEGIN/END lines) or a plain base64 string, both work.",
  },
  {
    id: "kraken",
    name: "Kraken",
    portalUrl: "https://www.kraken.com/u/security/api",
    steps: [
      "Go to Settings → API on Kraken → Add key.",
      "Key permissions: check \"Query Funds\" only — no trading or withdrawal access needed.",
      "Copy the API key and the Private Key (secret) below — the secret is shown only once.",
    ],
    keyLabel: "API Key",
    keyHint: "The public key shown on your API key's settings page.",
    secretLabel: "Private Key",
    secretHint: "The base64-encoded secret Kraken shows only once, when you create the key.",
  },
  {
    id: "gemini",
    name: "Gemini",
    portalUrl: "https://exchange.gemini.com/settings/api",
    steps: [
      "Go to Settings → API on Gemini → Create a new API key.",
      "Role: Auditor (read-only) — can't be combined with Trader/Fund Manager, and it's all this needs.",
      "Copy the API Key and API Secret below — the secret is shown only once.",
    ],
    keyLabel: "API Key",
    keyHint: "Starts with account- or master-.",
    secretLabel: "API Secret",
    secretHint: "Shown only once, when you create the key — copy it immediately.",
  },
];
