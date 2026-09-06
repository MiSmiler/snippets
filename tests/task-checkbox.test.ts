// Tests for the interactive task-checkbox rendering (src/task-checkbox.ts).
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { collectTaskMarkers, toggleChange, visibleTaskMarkers } from "../src/task-checkbox.ts";

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
}

function collect(doc: string) {
  return collectTaskMarkers(makeState(doc)).map((m) => ({
    from: m.from,
    to: m.to,
    checked: m.checked,
  }));
}

test("recognizes checked and unchecked markers", () => {
  assert.deepEqual(collect("- [x] done\n- [ ] todo"), [
    { from: 2, to: 5, checked: true },
    { from: 13, to: 16, checked: false },
  ]);
});

test("recognizes [X] as checked", () => {
  assert.deepEqual(collect("* [X] star"), [{ from: 2, to: 5, checked: true }]);
});

test("recognizes nested and blockquote task items", () => {
  assert.deepEqual(collect("- a\n  - [ ] b\n> - [x] q"), [
    { from: 8, to: 11, checked: false },
    { from: 18, to: 21, checked: true },
  ]);
});

test("skips ordered-list tasks", () => {
  assert.deepEqual(collect("1. [ ] ordered"), []);
});

test("ignores task markers inside fenced code", () => {
  assert.deepEqual(collect("```\n- [ ] not a task\n```"), []);
});

test("renders an empty task item with a trailing space", () => {
  // The Enter continuation inserts "- [ ] " (trailing space), which the GFM
  // parser does recognize as a TaskMarker.
  assert.deepEqual(collect("- [ ] \n"), [{ from: 2, to: 5, checked: false }]);
});

test("skips a bare marker without trailing space (GFM leaf requires one)", () => {
  assert.deepEqual(collect("- [ ]\n"), []);
});

test("toggleChange flips unchecked to checked and back, always lowercase", () => {
  const unchecked = collectTaskMarkers(makeState("- [ ] todo"))[0];
  assert.deepEqual(toggleChange(unchecked), { from: 2, to: 5, insert: "[x]" });
  const checked = collectTaskMarkers(makeState("- [x] done"))[0];
  assert.deepEqual(toggleChange(checked), { from: 2, to: 5, insert: "[ ]" });
  // [X] is read as checked but toggles back to the lowercase form.
  const upper = collectTaskMarkers(makeState("- [X] done"))[0];
  assert.deepEqual(toggleChange(upper), { from: 2, to: 5, insert: "[ ]" });
});

test("applying the toggle change updates the source text", () => {
  const state = makeState("- [ ] todo");
  const next = state.update({
    changes: toggleChange(collectTaskMarkers(state)[0]),
    userEvent: "task.toggle",
  });
  assert.equal(next.state.doc.toString(), "- [x] todo");
});

// ---- Preview suppression -------------------------------------------------
// Marker spans in "- [x] done\n- [ ] todo": [2,5) checked and [13,16) unchecked.
// The gate is endpoint-inclusive: caret/selection touching a span's edges
// suppresses it; an unfocused editor keeps every checkbox rendered.

function visible(doc: string, from: number, to = from, focused = true) {
  return visibleTaskMarkers(makeState(doc), { from, to }, focused).map((m) => ({
    from: m.from,
    to: m.to,
    checked: m.checked,
  }));
}

const BOTH = [
  { from: 2, to: 5, checked: true },
  { from: 13, to: 16, checked: false },
];

function one(marker: { from: number; to: number; checked: boolean }) {
  return [marker];
}

const FIRST = { from: 2, to: 5, checked: true };
const SECOND = { from: 13, to: 16, checked: false };

test("an unfocused editor renders every checkbox", () => {
  assert.deepEqual(visible("- [x] done\n- [ ] todo", 3, 3, false), BOTH);
  assert.deepEqual(visible("- [x] done\n- [ ] todo", 14, 15, false), BOTH);
});

test("a caret inside or at either edge of a marker span suppresses it", () => {
  const doc = "- [x] done\n- [ ] todo";
  // Inside / at the edges of the first marker [2,5).
  assert.deepEqual(visible(doc, 2), one(SECOND)); // at from
  assert.deepEqual(visible(doc, 3), one(SECOND));
  assert.deepEqual(visible(doc, 4), one(SECOND));
  assert.deepEqual(visible(doc, 5), one(SECOND)); // at to
  // Inside / at the edges of the second marker [13,16).
  assert.deepEqual(visible(doc, 13), one(FIRST)); // at from
  assert.deepEqual(visible(doc, 14), one(FIRST));
  assert.deepEqual(visible(doc, 15), one(FIRST));
  assert.deepEqual(visible(doc, 16), one(FIRST)); // at to
});

test("a caret on visible text or the - prefix keeps every checkbox", () => {
  const doc = "- [x] done\n- [ ] todo";
  assert.deepEqual(visible(doc, 0), BOTH); // on "-"
  assert.deepEqual(visible(doc, 1), BOTH); // on the space before "["
  assert.deepEqual(visible(doc, 6), BOTH); // start of "done"
  assert.deepEqual(visible(doc, 10), BOTH); // end of the first line
  assert.deepEqual(visible(doc, 17), BOTH); // start of "todo"
});

test("a selection covering, overlapping, or edge-touching a marker suppresses it", () => {
  const doc = "- [x] done\n- [ ] todo";
  assert.deepEqual(visible(doc, 0, 5), one(SECOND)); // contains the whole marker [2,5)
  assert.deepEqual(visible(doc, 0, 2), one(SECOND)); // ends exactly at from (touch)
  assert.deepEqual(visible(doc, 4, 7), one(SECOND)); // overlaps the marker's tail
  assert.deepEqual(visible(doc, 5, 9), one(SECOND)); // starts exactly at to (touch)
  // Touching only the second marker's edges suppresses just it.
  assert.deepEqual(visible(doc, 10, 13), one(FIRST)); // ends exactly at 13
  assert.deepEqual(visible(doc, 16, 21), one(FIRST)); // starts exactly at 16
});

test("a selection away from every marker keeps every checkbox", () => {
  const doc = "- [x] done\n- [ ] todo";
  assert.deepEqual(visible(doc, 6, 10), BOTH); // "done"
  assert.deepEqual(visible(doc, 17, 21), BOTH); // "todo"
});

test("a selection spanning both markers suppresses both", () => {
  assert.deepEqual(visible("- [x] done\n- [ ] todo", 2, 16), []);
});
