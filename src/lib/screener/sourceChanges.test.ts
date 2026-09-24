import test from "node:test";
import assert from "node:assert/strict";
import { sourceChanges } from "./sourceChanges.ts";

test("flags the day FLOW's sources lost FlowSwap, and only that day", () => {
  const days: [string, string[] | null][] = [
    ["2026-09-23", ["flowswap-v3", "flow"]],
    ["2026-09-24", ["flowswap-v3", "flow"]],
    ["2026-09-25", ["flow"]],
    ["2026-09-26", ["flow"]],
  ];
  assert.deepEqual(sourceChanges(days), [{ date: "2026-09-25", added: [], removed: ["flowswap-v3"] }]);
});

test("added sources are flagged, including across a day with no list; order changes are not", () => {
  assert.deepEqual(
    sourceChanges([
      ["2026-01-01", ["aave-v3", "aave-v2"]],
      ["2026-01-02", ["aave-v2", "aave-v3"]],
      ["2026-01-03", null],
      ["2026-01-04", ["aave-v2", "aave-v3", "aave-v4"]],
      ["2026-01-05", ["aave-v2", "aave-v3", "aave-v4"]],
      ["2026-01-06", ["aave-v4", "aave-v3", "aave-v2", "aave-v1"]],
    ]),
    [
      { date: "2026-01-04", added: ["aave-v4"], removed: [] },
      { date: "2026-01-06", added: ["aave-v1"], removed: [] },
    ],
  );
});
