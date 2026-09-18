import "server-only";
import { getProgramAccounts } from "./solanaRpc";
import { fetchTokenInfo } from "./jupiter";
import type { AdapterHolding } from "./types";

const SKR_PROGRAM = "SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ";
const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
const SKR_DECIMALS = 6;
// The stake-position account's exact size, confirmed live via
// getAccountInfo. Passed as a dataSize filter alongside the memcmp below
// — reported directly that this holding was missing in production while
// the structurally-identical native-staking query succeeded reliably;
// the difference is that Stake11111...'s accounts are Solana's own core
// state (RPC nodes keep it cheap/indexed to serve), while an unconstrained
// getProgramAccounts scan over an arbitrary third-party program's full
// account set is a genuinely expensive operation many public RPC
// providers throttle or reject more readily — narrowing with dataSize
// first (standard practice for this exact class of call) cuts that cost
// sharply instead of relying on the memcmp filter alone.
const STAKE_POSITION_SIZE = 169;

/**
 * Solana Mobile's SKR staking (delegating SKR to a "Guardian" node,
 * stake.solanamobile.com) — a program that launched January 2026 with no
 * public IDL, docs, or open-source repo (checked: nothing under
 * github.com/solana-mobile). Reads the on-chain stake-position account
 * directly, the same getProgramAccounts+memcmp technique as
 * wormholeStaking.ts/jupiterDaoStaking.ts/solanaStaking.ts — but unlike
 * those, the byte layout below had to be reverse-engineered rather than
 * read from a spec, so it was cross-checked two independent ways against
 * a real wallet before shipping (see commit message for the exact
 * numbers): (1) the decoded per-user amount sits alone, isolated from
 * pubkey-byte noise, at a single offset scanned across the whole account;
 * (2) the program's own global-pool account (same technique, found via
 * the same wallet's transaction history) has a `total_staked` field that
 * matches its real SPL token vault balance to within 0.00001% of 5
 * billion tokens — a coincidence that precise would not happen from a
 * wrong offset.
 *
 * Layout (bincode, 169 bytes), byte-for-byte verified:
 *   0-7    discriminator (8 bytes, unidentified format — not confirmed
 *          Anchor's standard sha256("account:Name") scheme, so not
 *          computed the way wormholeStaking.ts's is; not needed for
 *          correctness here since the offset-41 memcmp filter below
 *          already isolates the right account type)
 *   41-72  owner/staker authority (pubkey) — filtered on this
 *   105-112 staked amount (u64 LE, 6 decimals)
 *
 * Exactly one stake-position account per wallet (verified live — unlike
 * native SOL staking, which can have many), so this can never return more
 * than one holding.
 */
export async function fetchSkrStaking(address: string): Promise<AdapterHolding[]> {
  const accounts = await getProgramAccounts(
    SKR_PROGRAM,
    [{ dataSize: STAKE_POSITION_SIZE }, { memcmp: { offset: 41, bytes: address } }],
    "SKR stake position lookup",
  );
  if (accounts.length === 0) return []; // never staked SKR — a real $0, not an error

  const buf = Buffer.from(accounts[0].account.data[0], "base64");
  const raw = buf.readBigUInt64LE(105);
  const qty = Number(raw) / 10 ** SKR_DECIMALS;
  if (qty <= 0) return [];

  const tokenInfo = await fetchTokenInfo([SKR_MINT]).catch(() => new Map()); // icon is cosmetic — never fail over it
  const icon = tokenInfo.get(SKR_MINT)?.icon ?? null;

  return [
    {
      ticker: "SKR",
      qty,
      usd_override: null,
      // contract+chain (not a bare "SKR" ticker) routes this through the
      // safe CoinGecko contract-keyed price path — NON_EVM_PLATFORM_IDS
      // maps "solana-defi" to CoinGecko's "solana" platform (priceKey.ts)
      // — rather than a risky bare-ticker Coinbase/Jupiter lookup. Same
      // fix-class this session already shipped once for a real bug (a
      // manually-added "DOG" mispriced off Coinbase's own unrelated
      // "DOG" — see coinbase.ts/priceKey.ts's coingecko_id branch).
      contract: SKR_MINT,
      category: "defi",
      chain: "solana-defi",
      icon_url: icon,
      // Only one Guardian (Solana Mobile itself, 0% commission) is live
      // as of this writing — Helius/Jito/Anza/Triton/DoubleZero are
      // announced but not yet on-chain, and there's no Stakewiz-equivalent
      // API to resolve a Guardian's name from its pubkey if that changes.
      // Revisit this label once multiple Guardians actually exist.
      protocol: "SKR Staking: Solana Mobile",
      protocol_url: "https://stake.solanamobile.com/",
    },
  ];
}
