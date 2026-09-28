// The services this app depends on that could need an upgrade as users
// grow — shown on Owner's console → API list (/admin/apis). Pure data.
//
// Owner decision 2026-09-28: list only what has a plan, a quota or a rate
// limit a paid tier would lift; free services that scale (a chain's own
// public node, an explorer link, each user's own exchange key) are named
// in UNLISTED_HOSTS instead, with why. apiRegistry.test.ts fails when code
// calls an https host that is in neither — so a new API gets a decision the
// day it's added. Keep limits and plans true when they change.

export type ApiTier = "free-no-signup" | "free-signup" | "paid";

export const TIER_LABEL: Record<ApiTier, string> = {
  "free-no-signup": "Free, no sign-up",
  "free-signup": "Free with sign-up",
  paid: "Paid",
};

export interface ApiService {
  name: string;
  category: "Infrastructure" | "Prices & market data" | "Blockchain data" | "Research & AI";
  tier: ApiTier;
  /** The plan in use today. */
  plan: string;
  /** Its limits, as measured or documented. */
  limits: string;
  usedFor: string;
  /** What breaks first as users grow, and what to upgrade to. */
  scaling: string;
  env: string[];
  /** Hosts it's called on: exact, or "*.suffix". */
  hosts: string[];
  /** Where the calls are made. */
  code: string;
  /** Not confirmed with the owner / the provider's dashboard yet. */
  unconfirmed?: string;
}

export const API_SERVICES: ApiService[] = [
  {
    name: "Vercel",
    category: "Infrastructure",
    tier: "free-signup",
    plan: "Hobby (free)",
    limits: "Non-commercial use only; function time up to 300 s; cron jobs once a day each (4 used).",
    usedFor: "Hosting, server functions, the daily crons (snapshot, screener, token registry, Wallet Watch).",
    scaling: "Hobby's terms don't allow a commercial product — Pro ($20/user/month) before charging anyone. More frequent crons also need Pro.",
    env: ["CRON_SECRET", "NEXT_PUBLIC_SITE_URL"],
    hosts: ["*.vercel.app"],
    code: "vercel.json, src/app/api/cron/*",
    unconfirmed: "The plan (Hobby assumed from the setup) — check the Vercel dashboard.",
  },
  {
    name: "Supabase",
    category: "Infrastructure",
    tier: "free-signup",
    plan: "Free (organization shared with csp-screener and Trace Two)",
    limits: "500 MB database; 1 GB of logs a month for the whole organization (~11,000 requests a day; keep cryptoport under ~5,000); 5 GB egress; 50,000 monthly active users; pauses after a week idle.",
    usedFor: "The database (every table), sign-in, row-level security.",
    scaling: "Logs and database size go first. Pro ($25/month + compute) — and move cryptoport to its own organization so other projects don't share its quota.",
    env: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    hosts: ["*.supabase.co"],
    code: "src/lib/supabase.ts, src/lib/auth.ts",
  },
  {
    name: "CoinGecko",
    category: "Prices & market data",
    tier: "free-signup",
    plan: "Demo, two keys (primary + backup)",
    limits: "10,000 calls a month per key; 30 calls a minute. The primary hit the monthly cap on 2026-09-22.",
    usedFor: "Prices and 24h/7d/30d changes (250 coins a call), market data, the contract → coin list, exchange ticker maps, price history, the screener.",
    scaling: "Monthly calls go first (price refreshes grow with users' distinct coins). Analyst plan (~$129/month, 500,000 calls) or Basic.",
    env: ["COINGECKO_API_KEY", "COINGECKO_API_KEY_BACKUP"],
    hosts: ["api.coingecko.com", "coin-images.coingecko.com"],
    code: "src/lib/adapters/coingeckoFetch.ts (every call)",
  },
  {
    name: "Alchemy",
    category: "Blockchain data",
    tier: "free-signup",
    plan: "Free",
    limits: "30 million compute units a month; per-second throughput cap.",
    usedFor: "Which tokens an EVM wallet holds (20 chains), transaction history, Wallet Watch's activity check.",
    scaling: "Compute units grow with wallets × chains × syncs. Pay-as-you-go.",
    env: ["ALCHEMY_API_KEY"],
    hosts: ["*.g.alchemy.com"],
    code: "src/lib/adapters/alchemy.ts, alchemyDiscovery.ts, watchActivitySources.ts",
  },
  {
    name: "Helius",
    category: "Blockchain data",
    tier: "free-signup",
    plan: "Free",
    limits: "1,000,000 credits a month (4,285 used on 2026-09-28, 20 days left); ~10 requests a second. Parsed transactions cost 100 credits a call.",
    usedFor: "Solana RPC (balances, staking, DeFi accounts), Wallet Watch's activity check.",
    scaling: "Credits go first once many users run activity checks on busy Solana wallets. Developer plan ($49/month).",
    env: ["HELIUS_API_KEY"],
    hosts: ["mainnet.helius-rpc.com", "api-mainnet.helius-rpc.com"],
    code: "src/lib/adapters/solanaRpc.ts, watchActivitySources.ts",
  },
  {
    name: "Etherscan (API v2)",
    category: "Blockchain data",
    tier: "free-signup",
    plan: "Free",
    limits: "3 calls a second and a daily quota, app-wide; Base, Optimism, Avalanche, BNB and Gnosis aren't on the free tier.",
    usedFor: "Token discovery on 6 chains (Taiko, Mantle, opBNB, Fraxtal, Sonic, Sei), transaction history fallback.",
    scaling: "3/second is shared by every user — a wallet that would wait over 5 s already skips it. Standard plan for more calls and the missing chains.",
    env: ["ETHERSCAN_API_KEY"],
    hosts: ["api.etherscan.io"],
    code: "src/lib/adapters/etherscanFetch.ts (paces every call)",
  },
  {
    name: "Zerion",
    category: "Blockchain data",
    tier: "free-signup",
    plan: "Free (developer)",
    limits: "300 calls a day; 1 call a second, app-wide.",
    usedFor: "EVM DeFi positions no native adapter covers — one call per EVM wallet sync.",
    scaling: "The first to break: 300 syncs a day across all users. A paid Zerion API plan.",
    env: ["ZERION_API_KEY"],
    hosts: ["api.zerion.io"],
    code: "src/lib/adapters/zerionDefi.ts",
  },
  {
    name: "Jupiter",
    category: "Prices & market data",
    tier: "free-signup",
    plan: "Free API key",
    limits: "10 requests per ~10 seconds, shared app-wide (paced in jupiterFetch.ts).",
    usedFor: "Prices for Solana tokens CoinGecko doesn't list, token info, the Jupiter portfolio (positions), Perps and Prediction positions.",
    scaling: "1 request a second for everyone. A paid Jupiter API tier.",
    env: ["JUPITER_API_KEY"],
    hosts: ["api.jup.ag", "perps-api.jup.ag", "vote.jup.ag"],
    code: "src/lib/adapters/jupiterFetch.ts (every api.jup.ag call)",
  },
  {
    name: "Perplexity",
    category: "Research & AI",
    tier: "paid",
    plan: "Pay per use (Agent API)",
    limits: "Billed per request; results are stored and only re-run when someone asks.",
    usedFor: "Token analysis and trend explanations (Encyclopedia, Trend Finder).",
    scaling: "Cost grows with how often users ask for a fresh analysis — stays capped by the stored results.",
    env: ["PERPLEXITY_API_KEY"],
    hosts: ["api.perplexity.ai"],
    code: "src/lib/adapters/perplexity.ts",
    unconfirmed: "Current spend — check the Perplexity billing page.",
  },
  {
    name: "DefiLlama",
    category: "Prices & market data",
    tier: "free-no-signup",
    plan: "Free public API",
    limits: "No key; rate-limited per IP.",
    usedFor: "The screener (Fundamentals): protocol TVL, fees, stablecoins and its price cross-checks.",
    scaling: "Fine until heavy use; Pro API if it starts rate-limiting.",
    env: [],
    hosts: ["coins.llama.fi", "api.llama.fi", "stablecoins.llama.fi"],
    code: "src/lib/screener/adapters/defillama.ts, defillamaPrices.ts",
  },
  {
    name: "Public RPC providers (PublicNode, dRPC, BlockPI)",
    category: "Blockchain data",
    tier: "free-no-signup",
    plan: "Free public endpoints",
    limits: "No key; rate-limited per IP.",
    usedFor: "Balance reads on most EVM chains, Cosmos, Injective, Sei, Polkadot; a Solana fallback.",
    scaling: "Many users syncing at once from one server IP can be throttled. Their paid plans (or Alchemy/QuickNode) for the busiest chains.",
    env: [],
    hosts: ["*.publicnode.com", "*.drpc.org", "*.blockpi.network"],
    code: "src/lib/adapters/evmChains.ts, cosmos.ts, seiStaking.ts, injectiveTx.ts, substrate.ts, solanaRpc.ts",
  },
  {
    name: "Blockstream / mempool.space",
    category: "Blockchain data",
    tier: "free-no-signup",
    plan: "Free public Esplora APIs",
    limits: "No key; rate-limited per IP.",
    usedFor: "Bitcoin balances and transactions (and Wallet Watch's Bitcoin check).",
    scaling: "Fine at current use; Blockstream's paid Explorer API if throttled.",
    env: [],
    hosts: ["blockstream.info", "mempool.space"],
    code: "src/lib/adapters/bitcoin*.ts",
  },
  {
    name: "toncenter",
    category: "Blockchain data",
    tier: "free-no-signup",
    plan: "Anonymous (no key)",
    limits: "About 1 request a second without a key.",
    usedFor: "TON balances.",
    scaling: "A free toncenter key raises it to 10 a second — take one before TON users grow.",
    env: [],
    hosts: ["toncenter.com"],
    code: "src/lib/adapters/ton.ts",
  },
];

/** Hosts the code calls or links to that aren't a scaling concern, and why.
 * Every https host in the code must be here or in API_SERVICES. */
export const UNLISTED_HOSTS: { reason: string; hosts: string[] }[] = [
  {
    reason: "A chain's or protocol's own free public API (no key, no plan to outgrow)",
    hosts: [
      "api.hyperliquid.xyz", "mainnet.zklighter.elliot.ai", "fapi.asterdex.com", "tapi.asterdex.com", "gamma-api.polymarket.com", "data-api.polymarket.com",
      "api.kamino.finance", "api.lulo.fi", "*.datapi.meteora.ag", "api.stakewiz.com", "kobe.mainnet.jito.network", "api.roninchain.com",
      "api.mainnet-beta.solana.com", "api.koios.rest", "rest.cosmos.directory", "chains.cosmos.directory", "status.cosmos.directory", "rest-lb.neutron.org",
      "sentry.exchange.grpc-web.injective.network", "rest.sei-apis.com", "evm-rpc.sei-apis.com", "xrplcluster.com", "s1.ripple.com", "rpc.mainnet.near.org",
      "rpc.polkadot.io", "polkadot.api.onfinality.io", "rosetta-api.internetcomputer.org", "fullnode.mainnet.aptoslabs.com", "graphql.mainnet.sui.io",
      "sui-mainnet-endpoint.blockvision.org", "mainnet1.neo.coz.io", "filfox.info", "arweave.net", "lite.chain.opentensor.ai", "entrypoint-finney.opentensor.ai",
      "arb1.arbitrum.io", "mainnet.era.zksync.io", "rpc.soniclabs.com", "rpc.zora.energy", "mainnet.mode.network", "mainnet.aurora.dev", "rpc.merlinchain.io",
      "rpc.mainnet.dbkchain.io", "rpc.mainnet.chain.robinhood.com", "zkevm-rpc.com", "rpcapi.fantom.network", "*.calderachain.xyz", "eth.rpc.blxrbdn.com",
      "*.blockscout.com", "raw.githubusercontent.com", "wallet.keplr.app", "data-api.binance.vision",
    ],
  },
  {
    reason: "Each user's own exchange account and key (no cost or quota of ours)",
    hosts: ["api.coinbase.com", "api.exchange.coinbase.com", "api.kraken.com", "api.gemini.com", "api.mexc.com"],
  },
  {
    reason: "A free embed shown in the browser",
    hosts: ["s3.tradingview.com", "coin360.com"],
  },
  {
    reason: "A link shown to the user (explorers, apps, docs, news) — never called",
    hosts: [
      "www.coingecko.com", "www.mintscan.io", "jup.ag", "x.com", "governance.aave.com", "dashboard.sei.io", "crypto.news", "coinalertnews.com", "cryptoticker.io",
      "ethdaily.io", "www.mexc.com", "www.kraken.com", "www.jito.network", "www.asterdex.com", "w.wormhole.com", "uniscan.xyz", "unisat.io", "taikoscan.io",
      "suiscan.xyz", "staking.superverse.co", "stake.solanamobile.com", "stake.axieinfinity.com", "sonicscan.org", "solscan.io", "snowscan.xyz", "slush.app",
      "seiscan.io", "portal.cdp.coinbase.com", "polymarket.com", "polygonscan.com", "optimistic.etherscan.io", "opbnb.bscscan.com", "mantlescan.xyz",
      "lineascan.build", "lido.fi", "help.phantom.com", "help.p2p.org", "help.keplr.app", "gnosisscan.io", "fraxscan.com", "explorer.zora.energy",
      "explorer.injective.network", "explorer.cronos.com", "exchange.gemini.com", "etherscan.io", "eips.ethereum.org", "docs.sei.io", "defillama.com",
      "debank.com", "chiliscan.com", "celoscan.io", "cardanoscan.io", "bscscan.com", "blastscan.io", "berascan.com", "basescan.org", "arbiscan.io",
      "app.parcl.co", "app.naviprotocol.io", "app.meteora.ag", "app.marinade.finance", "app.lulo.fi", "app.lighter.xyz", "app.kamino.finance",
      "app.init.capital", "app.hyperliquid.xyz",
    ],
  },
];

/** Whether a host is covered by a pattern ("*.suffix" matches subdomains). */
export function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}
