// Read-only: runs the daily job's own grouping + sector logic on TODAY's
// DefiLlama responses under the OLD rules (no slug exclusions; sector =
// /protocols category) and the CURRENT ones (config slugExclusions; sector
// follows the fee data, aggregate.ts sectorCategoryFor), and prints every
// asset whose sector, scope bucket or revenue sources differ, plus the
// mixed chain/app groups the job would flag. DefiLlama only (free); no
// CoinGecko, no DB. See SPEC "Attribution audit (2026-09-24)".
//
//   NODE_OPTIONS="--conditions=react-server" <tsx> scripts/diag/screener-attribution-check.ts
async function main() {
  const { fetchProtocols, fetchFeesOverview, fetchParentProtocols } = await import("../../src/lib/screener/adapters/defillama");
  const { resolveGroups, dominantCategory, sectorCategoryFor, mixedChainAppGroups } = await import("../../src/lib/screener/aggregate");
  const { SCREENER_CONFIG, sectorBucketFor } = await import("../../src/lib/screener/config");

  const [protocols, fees, revenue, parents] = await Promise.all([
    fetchProtocols(),
    fetchFeesOverview("dailyFees"),
    fetchFeesOverview("dailyRevenue"),
    fetchParentProtocols(),
  ]);
  const withFees = protocols.filter((p) => fees.has(p.slug));
  const excluded = SCREENER_CONFIG.slugExclusions as Record<string, unknown>;
  const scope = SCREENER_CONFIG.scopeOverrides as Record<string, { bucket: string }>;

  const run = (current: boolean) => {
    const candidates = current ? withFees.filter((p) => !Object.hasOwn(excluded, p.slug)) : withFees;
    const { groups } = resolveGroups(candidates, parents);
    const cat = new Map(candidates.map((p) => [p.slug, current ? sectorCategoryFor(p.category, fees.get(p.slug)) : p.category]));
    const out = new Map<string, { sector: string | null; bucket: string; slugs: string[]; fees30d: number }>();
    for (const g of groups.values()) {
      const sector = dominantCategory(g.contributingSlugs, cat, (s) => revenue.get(s)?.total30d, (s) => fees.get(s)?.total30d);
      const bucket = scope[g.geckoId]?.bucket ?? sectorBucketFor(sector);
      const fees30d = g.contributingSlugs.reduce((a, s) => a + (fees.get(s)?.total30d ?? 0), 0);
      out.set(g.geckoId, { sector, bucket, slugs: g.contributingSlugs, fees30d });
    }
    return { out, mixed: mixedChainAppGroups(groups, new Map(candidates.map((p) => [p.slug, p]))) };
  };
  const before = run(false);
  const after = run(true);
  console.log(`groups: ${before.out.size} before, ${after.out.size} after`);
  const ids = [...new Set([...before.out.keys(), ...after.out.keys()])].sort();
  let changed = 0;
  for (const id of ids) {
    const b = before.out.get(id);
    const a = after.out.get(id);
    if (b?.sector === a?.sector && b?.bucket === a?.bucket && b?.slugs.join() === a?.slugs.join()) continue;
    changed++;
    const fmt = (x?: { sector: string | null; bucket: string; slugs: string[]; fees30d: number }) =>
      x ? `${x.sector} [${x.bucket}] slugs=${x.slugs.join(",")} fees30d=$${Math.round(x.fees30d).toLocaleString()}` : "(absent)";
    console.log(`  ${id}\n    before: ${fmt(b)}\n    after:  ${fmt(a)}`);
  }
  console.log(`${changed} asset(s) changed.`);
  console.log(`mixed chain/app groups flagged — before: ${JSON.stringify(before.mixed)} | after: ${JSON.stringify(after.mixed)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
