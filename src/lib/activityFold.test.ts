import test from "node:test";
import assert from "node:assert/strict";
import { foldSoldOut, soldOut } from "./activityFold.ts";

const coin = (influencerId: string, name: string, lastAt: string, holdingQty: number, sells = 1, nowUsd: number | null = 1) => ({ influencerId, name, lastAt, holdingQty, sells, nowUsd });
const shape = (items: ReturnType<typeof foldSoldOut<ReturnType<typeof coin>>>) => items.map((i) => (i.kind === "coin" ? i.c.name : `[${i.coins.map((c) => c.name).join(",")}]`));

test("the same rule for every trader: every sold-out coin folds, the newest too (Hash's 3 coins)", () => {
  const hash = [coin("hash", "NIBS", "14:39", 0), coin("hash", "SATOSHI", "11:36", 0), coin("hash", "DUKE", "11:09", 0)];
  assert.deepEqual(shape(foldSoldOut(hash)), ["[NIBS,SATOSHI,DUKE]"]);
});

test("open positions keep their rows; only sold-out ones fold (Risk)", () => {
  const risk = [coin("risk", "X7", "15:28", 469_400, 0), coin("risk", "WATCH", "15:28", 32_000_000), coin("risk", "CLONES", "13:11", 0), coin("risk", "GATHR", "13:11", 0), coin("risk", "OPG", "13:11", 5, 1, 0.0000033)];
  assert.deepEqual(shape(foldSoldOut(risk)), ["X7", "WATCH", "[CLONES,GATHR,OPG]"]);
});

test("traders never mix; a lone sold-out coin keeps its row", () => {
  const rows = [coin("a", "A1", "10:00", 0), coin("a", "A2", "09:00", 0), coin("b", "B1", "08:00", 0), coin("b", "B2", "07:00", 0), coin("b", "B3", "06:00", 0)];
  assert.deepEqual(shape(foldSoldOut(rows)), ["[A1,A2]", "[B1,B2,B3]"]);
  assert.deepEqual(shape(foldSoldOut([coin("c", "C1", "10:00", 0), coin("c", "OPEN", "11:00", 5)])), ["C1", "OPEN"]);
  assert.equal(soldOut(coin("x", "X", "1", 5, 0)), false); // bought, never sold: open
});
