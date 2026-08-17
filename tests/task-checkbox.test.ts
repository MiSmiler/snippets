// Tests for the interactive task-checkbox rendering (src/task-checkbox.ts).
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { collectTaskMarkers, toggleChange } from "../src/task-checkbox.ts";

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
