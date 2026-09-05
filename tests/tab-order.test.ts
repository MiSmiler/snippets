// Unit tests for the pure drag-reorder helpers (src/tab-order.ts).
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dropSlot,
  dropSlotIsNoOp,
  moveItem,
  type TabBounds,
} from "../src/tab-order.ts";

const A = "a";
const B = "b";
const C = "c";
const D = "d";

// --- dropSlot ---

test("dropSlot targets the slot before a tab when x is in its left half", () => {
  const bounds: TabBounds[] = [
    { left: 0, right: 100 },
    { left: 100, right: 200 },
    { left: 200, right: 300 },
  ];
  assert.equal(dropSlot(bounds, 0), 0);
  assert.equal(dropSlot(bounds, 49), 0);
  assert.equal(dropSlot(bounds, 50), 0); // exact midpoint stays with the left slot
  assert.equal(dropSlot(bounds, 150), 1);
  assert.equal(dropSlot(bounds, 160), 2); // right of a midpoint targets the next slot
  assert.equal(dropSlot(bounds, 251), 3);
});

test("dropSlot clamps x outside the strip to the front/back slot", () => {
  const bounds: TabBounds[] = [{ left: 40, right: 140 }];
  assert.equal(dropSlot(bounds, -1000), 0);
  assert.equal(dropSlot(bounds, 1000), 1);
});

test("dropSlot of an empty strip is slot 0", () => {
  assert.equal(dropSlot([], 42), 0);
});

test("dropSlot handles ragged tab widths", () => {
  const bounds: TabBounds[] = [
    { left: 0, right: 180 }, // wide
    { left: 180, right: 210 }, // narrow
    { left: 210, right: 400 },
  ];
  assert.equal(dropSlot(bounds, 60), 0);
  assert.equal(dropSlot(bounds, 120), 1); // past the wide tab's midpoint (90)
  assert.equal(dropSlot(bounds, 200), 2); // past the narrow tab's midpoint (195)
  assert.equal(dropSlot(bounds, 350), 3);
});

// --- dropSlotIsNoOp / moveItem ---

test("dropping at the source slot or just after it is a no-op", () => {
  assert.equal(dropSlotIsNoOp(2, 2), true);
  assert.equal(dropSlotIsNoOp(2, 3), true);
  assert.equal(dropSlotIsNoOp(2, 1), false);
  assert.equal(dropSlotIsNoOp(0, 1), true);
  assert.equal(dropSlotIsNoOp(3, 4), true); // last tab to the very end
});

test("moveItem moves left across tabs", () => {
  assert.deepEqual(moveItem([A, B, C, D], 2, 0), [C, A, B, D]);
});

test("moveItem moves right across tabs", () => {
  assert.deepEqual(moveItem([A, B, C, D], 1, 3), [A, C, B, D]);
});

test("moveItem moves to the very end", () => {
  assert.deepEqual(moveItem([A, B, C, D], 0, 4), [B, C, D, A]);
});

test("moveItem keeps the array unchanged for no-op slots", () => {
  assert.deepEqual(moveItem([A, B, C], 0, 1), [A, B, C]);
  assert.deepEqual(moveItem([A, B, C], 2, 3), [A, B, C]);
});

test("moveItem preserves item references (state lives on the tab objects)", () => {
  const items = [A, B, C, D];
  const out = moveItem(items, 1, 4);
  assert.deepEqual(out, [A, C, D, B]);
  assert.equal(out[0], items[0]);
  assert.equal(out[1], items[2]);
  assert.equal(out[3], items[1]);
});
