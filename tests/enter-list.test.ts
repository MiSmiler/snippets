// Regression tests for the Enter-in-list behavior of the vendored
// insertNewlineContinueMarkupCommand (src/markdown-enter.ts).
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  insertNewlineContinueMarkup,
  markdown,
} from "@codemirror/lang-markdown";
import { insertNewlineContinueMarkupCommand } from "../src/markdown-enter.ts";
import { GFM } from "@lezer/markdown";

// Enter on an empty list item always removes the marker (exits the list),
// regardless of which item it is. Upstream's default keeps the marker when the
// empty item is the second item of a tight list and inserts a blank line above
// it instead (the behavior this project opts out of by vendoring the command).
const enter = insertNewlineContinueMarkupCommand();

function makeState(doc: string, cursorPos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursorPos),
    extensions: [markdown()],
  });
  // The command consults the syntax tree; without a view the parse is lazy,
  // so force it before the first Enter.
  ensureSyntaxTree(state, state.doc.length, 10000);
  return state;
}

function pressEnter(state: EditorState): EditorState {
  let next = state;
  const handled = enter({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  assert.equal(handled, true, "Enter should be handled as list markup continuation");
  return next;
}

test("our configured Enter binding wins over markdown()'s built-in keymap", () => {
  // markdown() registers its own Prec.high markdownKeymap (Enter -> the
  // unconfigured insertNewlineContinueMarkup) before any keymap the app
  // adds; at equal precedence the earlier registration shadows later ones.
  // The app disables it (addKeymap: false) and owns the bindings explicitly,
  // so the first Enter binding in the keymap facet must be the configured
  // command. Mirror of the app's wiring in src/main.ts.
  const enter = insertNewlineContinueMarkupCommand();
  const state = EditorState.create({
    doc: "- test1\n- test2\n- test3",
    extensions: [
      markdown({ extensions: [GFM], addKeymap: false }),
      Prec.high(keymap.of([{ key: "Enter", run: enter }])),
      keymap.of(defaultKeymap),
    ],
  });
  const flat = state.facet(keymap).flat();
  assert.equal(flat.find((b) => b.key === "Enter")?.run, enter);
});

test("without addKeymap: false, the unconfigured built-in Enter binding would win", () => {
  // Guards the premise of the fix: with the built-in keymap left enabled,
  // markdown()'s unconfigured Enter binding shadows the app's configured one.
  const enter = insertNewlineContinueMarkupCommand();
  const state = EditorState.create({
    doc: "- test1\n- test2\n- test3",
    extensions: [
      markdown({ extensions: [GFM] }),
      Prec.high(keymap.of([{ key: "Enter", run: enter }])),
      keymap.of(defaultKeymap),
    ],
  });
  const flat = state.facet(keymap).flat();
  const winner = flat.find((b) => b.key === "Enter")!;
  assert.notEqual(winner.run, enter);
  assert.equal(winner.run, insertNewlineContinueMarkup);
});

test("Enter after the first item, then Enter again, exits the list", () => {
  // Regression: with upstream defaults, the second Enter on the empty second
  // item inserted a blank line above it and kept the "- " marker, yielding
  // "- test1\n\n- \n- test2\n- test3". The empty second item must behave
  // like any other empty item: remove the marker and leave a blank line.
  let state = makeState("- test1\n- test2\n- test3", 7); // end of "- test1"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n- \n- test2\n- test3");
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n\n- test2\n- test3");
});

test("Enter on an empty third item also exits the list (unchanged behavior)", () => {
  let state = makeState("- test1\n- test2\n- test3", 15); // end of "- test2"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n- test2\n- \n- test3");
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n- test2\n\n- test3");
});

test("Enter on an empty second item of a two-item list exits the list", () => {
  let state = makeState("- test1\n- test2", 7); // end of "- test1"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n- \n- test2");
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n\n- test2");
});

// --- Issue #2: in a loose (blank-line-separated) list, Enter inserts the new
// item on the very next line, never after a blank line. ---

test("Enter at the end of a loose middle item inserts tightly", () => {
  let state = makeState("- test1\n\n- test2", 7); // end of "- test1"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n- \n\n- test2");
});

test("Enter at the end of a loose last item inserts tightly", () => {
  let state = makeState("- test1\n\n- test2", 16); // end of "- test2"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- test1\n\n- test2\n- ");
});

test("Enter mid-line in a loose item inserts tightly (no blank line)", () => {
  let state = makeState("- test1\n\n- test2", 4); // after "- te"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- te\n- st1\n\n- test2");
});

test("Enter in a nested loose list inserts tightly", () => {
  let state = makeState("- parent\n  - child\n\n  - child2", 18); // end of "child"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- parent\n  - child\n  - \n\n  - child2");
});

test("Enter in a loose ordered list inserts tightly and renumbers", () => {
  let state = makeState("1. test1\n\n2. test2", 8); // end of "test1"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "1. test1\n2. \n\n3. test2");
});

test("Enter in a loose task list inserts tightly and keeps the checkbox", () => {
  let state = makeState("- [ ] a\n\n- [x] b", 7); // end of "a"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "- [ ] a\n- [ ] \n\n- [x] b");
});

test("Enter in a loose list inside a blockquote inserts tightly", () => {
  let state = makeState("> - a\n>\n> - b", 5); // end of "a"
  state = pressEnter(state);
  assert.equal(state.doc.toString(), "> - a\n> - \n>\n> - b");
});
