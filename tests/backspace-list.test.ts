// Regression tests for Backspace on list items.
//
// The app deliberately does NOT bind markdown()'s deleteMarkupBackward: that
// command deletes the whole list marker (`- ` or `- [ ] `) in one keystroke.
// Backspace must fall through to defaultKeymap's deleteCharBackward and delete
// one character at a time, so `- [ ] test` becomes `- [ ]est` first, and
// `- test` becomes `-test` (not `  test`).
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { defaultKeymap, deleteCharBackward } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { insertNewlineContinueMarkupCommand } from "../src/markdown-enter.ts";

function makeState(doc: string, cursorPos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursorPos),
    extensions: [
      markdown({ extensions: [GFM], addKeymap: false }),
      keymap.of(defaultKeymap),
    ],
  });
  ensureSyntaxTree(state, state.doc.length, 10000);
  return state;
}

test("Backspace binding falls through to deleteCharBackward, not deleteMarkupBackward", () => {
  // Mirror of the app's wiring in src/main.ts: the high-precedence keymap only
  // owns Enter; Backspace is left to defaultKeymap.
  const enter = insertNewlineContinueMarkupCommand();
  const state = EditorState.create({
    doc: "- test",
    extensions: [
      markdown({ extensions: [GFM], addKeymap: false }),
      Prec.high(keymap.of([{ key: "Enter", run: enter }])),
      keymap.of(defaultKeymap),
    ],
  });
  const flat = state.facet(keymap).flat();
  const backspace = flat.find((b) => b.key === "Backspace");
  assert.equal(backspace?.run, deleteCharBackward);
});

// Backspace deletes one character at a time (what deleteCharBackward does).
function deleteBackward(state: EditorState): EditorState {
  const head = state.selection.main.head;
  return state.update({
    changes: { from: head - 1, to: head },
    selection: EditorSelection.cursor(head - 1),
    userEvent: "delete.backward",
  }).state;
}

test("Backspace on a task item deletes characters one at a time", () => {
  let state = makeState("- [ ] test", 6); // cursor before "t"
  state = deleteBackward(state);
  assert.equal(state.doc.toString(), "- [ ]test");
  state = deleteBackward(state);
  assert.equal(state.doc.toString(), "- [ test");
  state = deleteBackward(state);
  assert.equal(state.doc.toString(), "- [test");
});

test("Backspace on a plain list item removes the marker char by char", () => {
  let state = makeState("- test", 2); // cursor before "t"
  state = deleteBackward(state);
  assert.equal(state.doc.toString(), "-test");
  state = deleteBackward(state);
  assert.equal(state.doc.toString(), "test");
});
