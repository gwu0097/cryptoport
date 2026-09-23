// Read-only. Which assets changed rated status between two runs, with the
// gate_status before and after (i.e. which gate moved).
//
//   node scripts/diag/screener-rated-diff.mjs <older_run_id> <newer_run_id>
import { createClient } from "@supabase/supabase-js";
process.loadEnvFile(new URL("../../.env.local", import.meta.url).pathname);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "cryptoport" } });

const [A, B] = process.argv.slice(2);
if (!A || !B) throw new Error("usage: screener-rated-diff.mjs <older_run_id> <newer_run_id>");
const load = async (run) => {
  const { data, error } = await db.from("screener_asset_metrics").select("asset_id, rated, gate_status, screener_assets(gecko_id)").eq("run_id", run);
  if (error) throw error;
  return new Map(data.map((r) => [r.asset_id, r]));
};
const a = await load(A);
const b = await load(B);
for (const [id, rb] of b) {
  const ra = a.get(id);
  if (ra && ra.rated !== rb.rated) {
    const moved = Object.keys(rb.gate_status).filter((g) => ra.gate_status[g] !== rb.gate_status[g]);
    console.log(`${rb.screener_assets.gecko_id}: ${ra.rated} -> ${rb.rated}  (${moved.map((g) => `${g}: ${ra.gate_status[g]} -> ${rb.gate_status[g]}`).join(", ")})`);
  }
}
console.log(`rated: ${[...a.values()].filter((r) => r.rated).length} -> ${[...b.values()].filter((r) => r.rated).length}`);
