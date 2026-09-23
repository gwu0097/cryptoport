import { Panel } from "@/components/ui/Panel";
import type { RegimeRule } from "@/lib/screener/queries";

const INPUT_LABEL: Record<string, { label: string; format: (v: number) => string }> = {
  btcDominancePct: { label: "BTC dominance", format: (v) => `${v.toFixed(2)}%` },
  btcDominance4wChangePts: { label: "BTC dominance, 4-week change", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} pts` },
  ethBtc4wChangePct: { label: "ETH/BTC, 4-week change", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%` },
  stablecoinSupply30dChangePct: { label: "Stablecoin supply, 30-day change", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%` },
  fundingPercentile: { label: "Funding vs stored history (percentile)", format: (v) => `${(v * 100).toFixed(0)}th` },
  btcOi4wChangePct: { label: "BTC open interest, 4-week change", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%` },
  btcPrice4wChangePct: { label: "BTC price, 4-week change", format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%` },
};

function Outcome({ fired }: { fired: boolean | null }) {
  if (fired === null) return <span className="text-fg-muted">not evaluable</span>;
  return fired ? <span className="font-medium text-warning">fired</span> : <span className="text-fg">no</span>;
}

/** The market-regime label with every rule's outcome and every input next to
 * it — never a bare label (SPEC: "always show the inputs"). A rule with a
 * missing input is "not evaluable" and can't set the label, so NEUTRAL with
 * few evaluable rules means "not enough history yet", not a market read. */
export function RegimePanel({ label, rules }: { label: string; rules: RegimeRule[] }) {
  const evaluable = rules.filter((r) => r.fired !== null).length;
  const inputs = new Map<string, number | null>();
  for (const r of rules) for (const [k, v] of Object.entries(r.inputs)) inputs.set(k, v);
  const missing = [...inputs.values()].filter((v) => v === null).length;

  return (
    <Panel
      title={
        <span>
          Market regime: <span className="font-semibold">{label}</span>
        </span>
      }
      description={`${evaluable} of ${rules.length} rules evaluable · ${inputs.size - missing} of ${inputs.size} inputs available. Thresholds are unvalidated starting values.${
        evaluable < rules.length
          ? " Rules with missing inputs can't fire, so this label reflects missing history as much as the market. Dominance and open-interest history builds from our own daily rows (full from ~2026-10-20)."
          : ""
      } Score B's regime modifiers are all 0, so the label doesn't change any score yet.`}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <ul className="space-y-1 text-sm">
          {rules.map((r) => (
            <li key={r.rule} className="flex justify-between gap-4">
              <span className="text-fg-muted">{r.rule}</span>
              <Outcome fired={r.fired} />
            </li>
          ))}
        </ul>
        <ul className="space-y-1 text-sm">
          {[...inputs.entries()].map(([k, v]) => (
            <li key={k} className="flex justify-between gap-4">
              <span className="text-fg-muted">{INPUT_LABEL[k]?.label ?? k}</span>
              <span className="tabular-nums">{v === null ? "—" : (INPUT_LABEL[k]?.format(v) ?? String(v))}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
