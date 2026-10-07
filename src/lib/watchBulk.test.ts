import { test } from "node:test";
import assert from "node:assert/strict";
import { BULK_MAX, parseBulk } from "./watchBulk.ts";

const SOL = "4a7NWcurNg4ynBk2U8ujhHW2evCjp3LmEkeEHsiPDCTs";
const EVM = "0x0748e296e5a350ec36c8487a1cea406e1b57d4b2";

test("name then address, as pasted from a list with wide spacing", () => {
  const { lines, problems } = parseBulk(`Swing 4a7N   ${SOL}\n\nSwing E27C\tE27C5KJeCE2YTV2SJVKe14KD3grw2Ji38K8aKATLaNY8\n`);
  assert.deepEqual(problems, []);
  assert.deepEqual(lines, [
    { line: 1, name: "Swing 4a7N", address: SOL },
    { line: 3, name: "Swing E27C", address: "E27C5KJeCE2YTV2SJVKe14KD3grw2Ji38K8aKATLaNY8" },
  ]);
});

test("address first, commas, or no name at all", () => {
  const { lines } = parseBulk(`${EVM}, Ansem\n${SOL}`);
  assert.deepEqual(lines, [
    { line: 1, name: "Ansem", address: EVM },
    { line: 2, name: null, address: SOL },
  ]);
});

test("lines that can't be added are named, not dropped", () => {
  const { lines, problems } = parseBulk(`just a name\n${SOL} ${EVM}\nA ${EVM.toUpperCase().replace("0X", "0x")}\nB ${EVM}`);
  assert.equal(lines.length, 1);
  assert.deepEqual(
    problems.map((p) => [p.line, p.error]),
    [
      [1, "No address on this line"],
      [2, "More than one address on this line"],
      [4, "Same address as line 3"],
    ],
  );
});

test(`at most ${BULK_MAX} wallets a batch; the rest are listed`, () => {
  const text = Array.from({ length: BULK_MAX + 2 }, (_, i) => `W${i} 0x${String(i).padStart(40, "0")}`).join("\n");
  const { lines, problems } = parseBulk(text);
  assert.equal(lines.length, BULK_MAX);
  assert.equal(problems.length, 2);
});
