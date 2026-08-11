// Regression tests for Ctrl+Z after backspace deletions.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { joinToEvent } from "../src/undo-history.ts";

function makeState(doc = "") {
  return EditorState.create({
    doc,
    extensions: [history({ joinToEvent })],
  });
}

type Step = (state: EditorState) => EditorState;

// Simulate typing a character (what the editor dispatches with
// userEvent "input.type").
const type = (text: string): Step => (state) => {
  const head = state.selection.main.head;
  return state.update({
    changes: { from: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: "input.type",
  }).state;
};

// Simulate a Backspace (userEvent "delete.backward", like CodeMirror's
// deleteCharBackward command).
const backspace: Step = (state) => {
  const head = state.selection.main.head;
  return state.update({
    changes: { from: head - 1, to: head },
    selection: { anchor: head - 1 },
    userEvent: "delete.backward",
  }).state;
};

// Apply a step and return the resulting state.
const apply = (state: EditorState, step: Step): EditorState => step(state);

// Run the undo command and return the resulting state.
function undoOnce(state: EditorState): EditorState {
  let next = state;
  undo({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  return next;
}

test("undo restores a character deleted right after typing it", () => {
  // Regression: before joinToEvent, the deletion merged into the typing
  // event (net-empty changes), making undo a no-op.
  let state = apply(apply(makeState(), type("好")), backspace);
  assert.equal(state.doc.toString(), "");
  state = undoOnce(state);
  assert.equal(state.doc.toString(), "好");
});

test("undo after type-delete-type restores the deleted character and removes the replacement", () => {
  let state = makeState();
  state = apply(state, type("好"));
  state = apply(state, backspace);
  state = apply(state, type("很"));
  assert.equal(state.doc.toString(), "很");
  state = undoOnce(state);
  assert.equal(state.doc.toString(), "好");
});

test("consecutive backspaces each get their own undo step", () => {
  let state = makeState();
  state = apply(state, type("abc"));
  state = apply(state, backspace);
  state = apply(state, backspace);
  assert.equal(state.doc.toString(), "a");
  state = undoOnce(state);
  assert.equal(state.doc.toString(), "ab");
  state = undoOnce(state);
  assert.equal(state.doc.toString(), "abc");
});

test("rapid typing still merges into a single undo step", () => {
  let state = makeState();
  for (const ch of "abcde") state = apply(state, type(ch));
  assert.equal(state.doc.toString(), "abcde");
  state = undoOnce(state);
  assert.equal(state.doc.toString(), "");
});

test("deletion in a different location does not join with recent typing", () => {
  // Type at the end, then delete a character somewhere else: the delete
  // must undo independently even though it happened within the group
  // delay window.
  let state = makeState("你好世界");
  // Move the cursor to the end of the document first.
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  state = apply(state, type("!"));
  assert.equal(state.doc.toString(), "你好世界!");
  state = state.update({
    changes: { from: 2, to: 3 },
    selection: { anchor: 2 },
    userEvent: "delete.backward",
  }).state;
  assert.equal(state.doc.toString(), "你好界!");
  state = undoOnce(state);
  assert.equal(state.doc.toString(), "你好世界!");
});

test("deletions with a custom non-delete userEvent still join like before", () => {
  // The veto only applies to userEvents matching /^delete/; other
  // joinable events (e.g. plain "input.type") keep default behavior.
  const state = EditorState.create({
    doc: "",
    extensions: [history({ joinToEvent })],
  });
  const t1 = state.update({
    changes: { from: 0, insert: "a" },
    selection: { anchor: 1 },
    userEvent: "input.type",
    annotations: Transaction.time.of(1000),
  }).state;
  const t2 = t1.update({
    changes: { from: 1, insert: "b" },
    selection: { anchor: 2 },
    userEvent: "input.type",
    annotations: Transaction.time.of(1300),
  }).state;
  assert.equal(t2.doc.toString(), "ab");
  const undone = undoOnce(t2);
  assert.equal(undone.doc.toString(), "");
});
