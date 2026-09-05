// Tests for the Shift+Mod+Enter insert-line-above command
// (src/insert-line.ts): inserts a blank line above the current line and moves
// the cursor onto it, never splitting the anchor line.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { insertLineAboveCommand } from "../src/insert-line.ts";

const insertAbove = insertLineAboveCommand();

function makeState(doc: string, cursorPos: number | number[]): EditorState {
  const selection = Array.isArray(cursorPos)
    ? EditorSelection.create(cursorPos.map((pos) => EditorSelection.cursor(pos)))
    : EditorSelection.cursor(cursorPos);
  return EditorState.create({
    doc,
    selection,
    extensions: [markdown({ extensions: [GFM] })],
  });
}

function pressAbove(state: EditorState): EditorState {
  let next = state;
  const handled = insertAbove({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  assert.equal(handled, true, "Shift+Mod+Enter should always be handled");
  return next;
}

function cursorPositions(state: EditorState): number[] {
  return state.selection.ranges.map((r) => r.from).sort((a, b) => a - b);
}

test("mid-line cursor inserts a blank line above without splitting the line", () => {
  // "alpha\nbeta\ngamma", cursor inside "beta" (after "be").
  let state = makeState("alpha\nbeta\ngamma", 8);
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "alpha\n\nbeta\ngamma");
  assert.deepEqual(cursorPositions(state), [6]);
});

test("cursor at the start of a line inserts directly above it", () => {
  let state = makeState("alpha\nbeta", 6); // start of "beta"
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "alpha\n\nbeta");
  assert.deepEqual(cursorPositions(state), [6]);
});

test("cursor on the first line inserts a blank line at the very top", () => {
  let state = makeState("alpha\nbeta", 2); // mid "alpha"
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "\nalpha\nbeta");
  assert.deepEqual(cursorPositions(state), [0]);
});

test("cursor on the last line inserts above it (no trailing newline needed)", () => {
  let state = makeState("alpha\nbeta\ngamma", 14); // mid "gamma"
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "alpha\nbeta\n\ngamma");
  assert.deepEqual(cursorPositions(state), [11]);
});

test("new blank line carries the anchor line's indentation", () => {
  let state = makeState("alpha\n  beta\ngamma", 8); // mid the 2-space-indented line
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "alpha\n  \n  beta\ngamma");
  assert.deepEqual(cursorPositions(state), [8]);
});

test("multiple cursors each get a blank line above their own line", () => {
  // In-app single selection is the norm (the app never enables
  // allowMultipleSelections), but the command is per-range: when multi-cursor
  // IS enabled every cursor still gets its own blank line above.
  const state = EditorState.create({
    doc: "alpha\nbeta\ngamma",
    selection: EditorSelection.create([
      EditorSelection.cursor(2),
      EditorSelection.cursor(13),
    ]),
    extensions: [
      markdown({ extensions: [GFM] }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  const after = pressAbove(state);
  assert.equal(after.doc.toString(), "\nalpha\nbeta\n\ngamma");
  assert.deepEqual(cursorPositions(after), [0, 12]);
});

test("a multi-line selection anchors the blank line above its first line", () => {
  // Selection spanning "beta\ngamm" (from start of beta into gamma).
  let state = EditorState.create({
    doc: "alpha\nbeta\ngamma",
    selection: EditorSelection.create([EditorSelection.range(6, 14)]),
    extensions: [markdown({ extensions: [GFM] })],
  });
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "alpha\n\nbeta\ngamma");
  assert.deepEqual(cursorPositions(state), [6]);
  assert.equal(state.selection.main.empty, true);
});

test("an already-blank line still gets a blank line above it", () => {
  let state = makeState("a\n\nb", 2); // on the empty middle line
  state = pressAbove(state);
  assert.equal(state.doc.toString(), "a\n\n\nb");
  assert.deepEqual(cursorPositions(state), [2]);
});

test("read-only documents are left untouched", () => {
  const state = EditorState.create({
    doc: "alpha\nbeta",
    selection: EditorSelection.cursor(3),
    extensions: [
      markdown({ extensions: [GFM] }),
      EditorState.readOnly.of(true),
    ],
  });
  const handled = insertAbove({
    state,
    dispatch: () => {
      assert.fail("readOnly documents must not dispatch a transaction");
    },
  });
  assert.equal(handled, false);
  assert.equal(state.doc.toString(), "alpha\nbeta");
});

test("inserting above is a single input event, undoable in one step", () => {
  const run = (state: EditorState): EditorState => {
    let next = state;
    insertAbove({
      state,
      dispatch: (tr) => {
        assert.equal(tr.annotation(Transaction.userEvent), "input");
        next = tr.state;
      },
    });
    return next;
  };
  let state = EditorState.create({
    doc: "alpha\nbeta\ngamma",
    selection: EditorSelection.cursor(8),
    extensions: [markdown({ extensions: [GFM] }), history()],
  });
  state = run(state);
  assert.equal(state.doc.toString(), "alpha\n\nbeta\ngamma");
  // One Ctrl+Z restores the original document (and the original cursor).
  let undone = state;
  undo({
    state: undone,
    dispatch: (t) => {
      undone = t.state;
    },
  });
  assert.equal(undone.doc.toString(), "alpha\nbeta\ngamma");
  assert.deepEqual(cursorPositions(undone), [8]);
});
