// Tests for the preview-suppression gate (src/preview-gate.ts): the shared
// rule behind temporarily un-rendering replace widgets (task checkboxes,
// divider rules) while the caret/selection touches their source span. The
// rule is endpoint-inclusive -- a collapsed caret at either edge of the span
// and a selection whose boundary rests exactly on an edge both count as
// touching -- and applies only while the editor is focused.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { sameMask, selectionTouches, suppressionMask } from "../src/preview-gate.ts";

// ---- selectionTouches ----------------------------------------------------

test("a collapsed caret at the span's from edge touches", () => {
  assert.equal(selectionTouches({ from: 2, to: 2 }, 2, 5), true);
});

test("a collapsed caret at the span's to edge touches", () => {
  assert.equal(selectionTouches({ from: 5, to: 5 }, 2, 5), true);
});

test("a collapsed caret inside the span touches", () => {
  assert.equal(selectionTouches({ from: 3, to: 3 }, 2, 5), true);
});

test("a collapsed caret outside the span does not touch", () => {
  assert.equal(selectionTouches({ from: 1, to: 1 }, 2, 5), false);
  assert.equal(selectionTouches({ from: 6, to: 6 }, 2, 5), false);
});

test("a selection overlapping the span touches", () => {
  assert.equal(selectionTouches({ from: 4, to: 7 }, 2, 5), true); // starts inside
  assert.equal(selectionTouches({ from: 0, to: 3 }, 2, 5), true); // ends inside
  assert.equal(selectionTouches({ from: 0, to: 9 }, 2, 5), true); // contains it
});

test("a selection meeting the span at an edge touches", () => {
  assert.equal(selectionTouches({ from: 0, to: 2 }, 2, 5), true); // ends at from
  assert.equal(selectionTouches({ from: 5, to: 9 }, 2, 5), true); // starts at to
});

test("a selection neither overlapping nor meeting the span does not touch", () => {
  assert.equal(selectionTouches({ from: 0, to: 1 }, 2, 5), false);
  assert.equal(selectionTouches({ from: 6, to: 9 }, 2, 5), false);
});

// ---- suppressionMask ------------------------------------------------------

test("an unfocused editor keeps every item visible", () => {
  const items = [
    { from: 2, to: 5 },
    { from: 10, to: 13 },
  ];
  assert.deepEqual(suppressionMask(items, { from: 3, to: 3 }, false), [false, false]);
  assert.deepEqual(suppressionMask(items, { from: 0, to: 20 }, false), [false, false]);
});

test("while focused, only touched items are suppressed", () => {
  const items = [
    { from: 2, to: 5 },
    { from: 10, to: 13 },
  ];
  assert.deepEqual(suppressionMask(items, { from: 3, to: 3 }, true), [true, false]);
  assert.deepEqual(suppressionMask(items, { from: 0, to: 11 }, true), [true, true]);
  assert.deepEqual(suppressionMask(items, { from: 7, to: 9 }, true), [false, false]);
});

// ---- sameMask -------------------------------------------------------------

test("sameMask compares element-wise", () => {
  assert.equal(sameMask([], []), true);
  assert.equal(sameMask([true, false], [true, false]), true);
  assert.equal(sameMask([true, false], [false, false]), false);
  assert.equal(sameMask([true], [true, false]), false);
});
