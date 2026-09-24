import "server-only";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { seiStakingHoldings, type SeiStakeHolding, type SeiStakingData } from "../seiStaking";

// Sei native staking for a wallet saved as either address form (pure
// mapping + the why: ../seiStaking.ts).
// - 0x → sei1 via Sei's Addr precompile (0x…1004, getSeiAddr) over plain
//   eth_call. Not the sei_getSeiAddress RPC: Sei's own node answers that one
//   with "deprecated, scheduled for removal" (live, 2026-09-24).
// - Staking reads use the Cosmos REST API, Sei's own endpoint first, then
//   PublicNode. Sei is going EVM-only during 2026; if these endpoints are
//   ever removed, this degrades to a warning, never a failed sync.

const EVM_RPCS = ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"];
const LCDS = ["https://rest.sei-apis.com", "https://sei-rest.publicnode.com"];
const ADDR_PRECOMPILE = "0x0000000000000000000000000000000000001004";
const ADDR_ABI = parseAbi(["function getSeiAddr(address addr) view returns (string)"]);
const TIMEOUT_MS = 10_000;

async function firstOk<T>(urls: readonly string[], get: (base: string) => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (const u of urls) {
    try {
      return await get(u);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function toSeiAddress(address: string): Promise<string | null> {
  if (address.startsWith("sei1")) return address;
  return firstOk(EVM_RPCS, async (rpc) => {
    const r = await fetch(rpc, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: ADDR_PRECOMPILE, data: encodeFunctionData({ abi: ADDR_ABI, functionName: "getSeiAddr", args: [address as `0x${string}`] }) }, "latest"],
      }),
    });
    const j = (await r.json()) as { result?: `0x${string}`; error?: { message: string } };
    // A reverted call means this 0x address was never associated with a sei1
    // account (it has never signed a Sei transaction): no Cosmos-side stake.
    if (j.error) {
      if (/revert|not associated|no associated/i.test(j.error.message)) return null;
      throw new Error(j.error.message);
    }
    const sei = decodeFunctionResult({ abi: ADDR_ABI, functionName: "getSeiAddr", data: j.result! }) as string;
    return sei || null;
  });
}

const lcdJson = <T>(path: string) =>
  firstOk(LCDS, async (base) => {
    const r = await fetch(`${base}${path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`Sei REST ${path.split("/").slice(0, 5).join("/")} failed: HTTP ${r.status}`);
    return (await r.json()) as T;
  });

export async function fetchSeiStakingHoldings(address: string, unitUsd: number | null, icon: string | null): Promise<SeiStakeHolding[]> {
  const sei = await toSeiAddress(address);
  if (!sei) return [];
  const [d, rw, ub] = await Promise.all([
    lcdJson<{ delegation_responses?: { delegation: { validator_address: string }; balance: { amount: string } }[] }>(`/cosmos/staking/v1beta1/delegations/${sei}`),
    lcdJson<{ rewards?: { validator_address: string; reward: { denom: string; amount: string }[] }[] }>(`/cosmos/distribution/v1beta1/delegators/${sei}/rewards`),
    lcdJson<{ unbonding_responses?: { validator_address: string; entries: { balance: string; completion_time: string }[] }[] }>(
      `/cosmos/staking/v1beta1/delegators/${sei}/unbonding_delegations`,
    ),
  ]);
  const data: SeiStakingData = {
    delegations: (d.delegation_responses ?? []).map((x) => ({ validator: x.delegation.validator_address, amountUsei: x.balance.amount })),
    rewards: (rw.rewards ?? []).map((x) => ({ validator: x.validator_address, amountUsei: x.reward.find((c) => c.denom === "usei")?.amount ?? "0" })),
    unbonding: (ub.unbonding_responses ?? []).flatMap((x) =>
      x.entries.map((e) => ({ validator: x.validator_address, amountUsei: e.balance, completionTime: e.completion_time })),
    ),
  };
  const validators = [...new Set([...data.delegations, ...data.rewards, ...data.unbonding].map((x) => x.validator))];
  const monikers = new Map<string, string>();
  await Promise.all(
    validators.map(async (v) => {
      const info = await lcdJson<{ validator?: { description?: { moniker?: string } } }>(`/cosmos/staking/v1beta1/validators/${v}`).catch(() => null);
      const m = info?.validator?.description?.moniker?.trim();
      if (m) monikers.set(v, m);
    }),
  );
  return seiStakingHoldings(data, monikers, unitUsd, icon);
}

const EVM_ADDR_ABI = parseAbi(["function getEvmAddr(string addr) view returns (address)"]);

/** Whether a sei1… account is linked to an EVM address (Addr precompile
 * getEvmAddr). false = the call reverts: never linked, so after SIP-3 it
 * can't transact. null = couldn't be checked (callers must not guess). */
export async function seiAccountIsLinked(seiAddress: string): Promise<boolean | null> {
  try {
    return await firstOk(EVM_RPCS, async (rpc) => {
      const r = await fetch(rpc, {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: ADDR_PRECOMPILE, data: encodeFunctionData({ abi: EVM_ADDR_ABI, functionName: "getEvmAddr", args: [seiAddress] }) }, "latest"],
        }),
      });
      const j = (await r.json()) as { result?: `0x${string}`; error?: { message: string } };
      if (j.error) {
        if (/revert/i.test(j.error.message)) return false;
        throw new Error(j.error.message);
      }
      return /^0x0{40}$/i.test(j.result ?? "") ? false : true;
    });
  } catch {
    return null;
  }
}
