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
}

export const EXCHANGE_PROVIDERS: ExchangeProvider[] = [
  {
    id: "coinbase",
    name: "Coinbase",
    portalUrl: "https://portal.cdp.coinbase.com/api-keys/secret",
    steps: [
      "Go to portal.cdp.coinbase.com → API Keys → Secret API Keys → Create API key.",
      "Signature algorithm: choose ECDSA — not the portal's recommended Ed25519, which won't work here.",
      "Permissions: View only.",
      "Copy the key name (organizations/.../apiKeys/...) and the private key (the PEM block) below.",
    ],
  },
];
