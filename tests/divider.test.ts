// Tests for the horizontal-rule divider feature (src/divider.ts): rendering
// triggers are the syntax-aware divider rows; Ctrl+A block selection picks
// the block around the caret, then the whole document on a second press.
//
// Note on fixtures: per GFM, a `---` directly under a paragraph line (no
// blank line in between) is a setext heading underline, NOT a divider. Docs
// below therefore keep a blank line above every intended `---`.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  blockAt,
  collectDividerRanges,
  nextSelectionTarget,
} from "../src/divider.ts";

function makeState(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(anchor, head),
    extensions: [markdown({ extensions: [GFM] })],
  });
}

function dividerLines(doc: string): number[] {
  return collectDividerRanges(makeState(doc)).map((d) => d.line);
}

function target(doc: string, anchor = 0, head = anchor): { from: number; to: number } {
  return nextSelectionTarget(makeState(doc, anchor, head));
}

function targetText(doc: string, anchor = 0, head = anchor): string {
  const { from, to } = target(doc, anchor, head);
  return doc.slice(from, to);
}

// ---- Divider recognition ------------------------------------------------

test("a lone --- line surrounded by blank lines is one divider", () => {
  assert.deepEqual(dividerLines("alpha\n\n---\n\nbeta\ngamma"), [3]);
});

test("two real dividers split the document into three regions", () => {
  assert.deepEqual(dividerLines("one\n\n---\ntwo\n\n---\nthree"), [3, 6]);
});

test("adjacent divider lines are both dividers and merge into one boundary", () => {
  assert.deepEqual(dividerLines("---\n---"), [1, 2]);
});

test("a divider is recognized at the very start of a document", () => {
  assert.deepEqual(dividerLines("---\ncontent"), [1]);
});

test("a divider is recognized as the last line (no trailing newline)", () => {
  assert.deepEqual(dividerLines("content\n\n---"), [3]);
  const doc = "content\n\n---";
  const last = collectDividerRanges(makeState(doc))[0];
  assert.equal(last.to, doc.length);
});

test("--- inside fenced code is not a divider", () => {
  assert.deepEqual(dividerLines("```\n---\n```"), []);
});

test("--- as a setext heading underline is not a divider", () => {
  assert.deepEqual(dividerLines("title\n---"), []);
  assert.deepEqual(dividerLines("title\n---\nbody"), []);
  assert.deepEqual(dividerLines("alpha\n---\nbeta\ngamma"), []);
});

test("other thematic-break spellings are not dividers", () => {
  assert.deepEqual(dividerLines("***\n\n___\n\n- - -"), []);
});

test("thematic breaks inside blockquotes are not dividers", () => {
  assert.deepEqual(dividerLines("> ---\n> text"), []);
  assert.deepEqual(dividerLines("> ---\n\nbody"), []);
});

test("an indented --- inside a list item is not a divider", () => {
  assert.deepEqual(dividerLines("- item\n\n  ---"), []);
});

test("an indented --- at the document level still is a divider", () => {
  assert.deepEqual(dividerLines("   ---"), [1]);
});

test("a divider line with trailing whitespace is recognized", () => {
  assert.deepEqual(dividerLines("alpha\n\n--- \n\nbeta"), [3]);
});

// ---- Block partitioning ---------------------------------------------------

test("one divider: the block above ends at its last character, not the divider", () => {
  // CDOC below: alpha, blank, --- (line 3), beta, gamma. The block above is
  // "alpha" (line 1): the blank line in front of the divider and the divider
  // row itself are trailing margins, not block text -- so a copy is exactly
  // "alpha", with no blank line and no trailing newline.
  const block = blockAt(makeState("alpha\n\n---\nbeta\ngamma"), 2)!;
  assert.deepEqual({ from: block.from, to: block.to }, { from: 0, to: 5 });
  assert.equal(block.blank, false);
});

test("one divider: the block below runs to the end of the document", () => {
  const block = blockAt(makeState("alpha\n\n---\nbeta\ngamma"), 13)!;
  assert.deepEqual({ from: block.from, to: block.to }, { from: 11, to: 21 });
  assert.equal(block.blank, false);
});

test("a caret on the divider row belongs to no block", () => {
  assert.equal(blockAt(makeState("alpha\n\n---\nbeta\ngamma"), 8), null);
});

test("two dividers yield three blocks (margins and trailing newlines trimmed)", () => {
  const doc = "one\n\n---\ntwo\n\n---\nthree";
  const state = makeState(doc);
  assert.equal(doc.slice(blockAt(state, 1)!.from, blockAt(state, 1)!.to), "one");
  assert.equal(doc.slice(blockAt(state, 10)!.from, blockAt(state, 10)!.to), "two");
  assert.equal(doc.slice(blockAt(state, 20)!.from, blockAt(state, 20)!.to), "three");
});

test("several trailing blank lines above a divider are all trimmed", () => {
  const doc = "one\n\n\n---\ntwo";
  const block = blockAt(makeState(doc), 2)!;
  assert.equal(doc.slice(block.from, block.to), "one");
});

test("blank lines inside a block are kept", () => {
  // A blank line sandwiched between two content lines is real body text and
  // survives; only the blank tail above the divider is dropped.
  const doc = "one\n\n\ntwo\n\n---\nthree";
  const block = blockAt(makeState(doc), 2)!;
  assert.equal(doc.slice(block.from, block.to), "one\n\n\ntwo");
});

test("a document without dividers is a single whole-document block", () => {
  const block = blockAt(makeState("alpha\nbeta"), 2)!;
  assert.deepEqual({ from: block.from, to: block.to }, { from: 0, to: 10 });
});

test("a blank-only trailing region after a divider is flagged blank", () => {
  const block = blockAt(makeState("a\n\n---\n"), 7)!;
  assert.deepEqual({ from: block.from, to: block.to }, { from: 7, to: 7 });
  assert.equal(block.blank, true);
});

test("a document made only of dividers has no blocks", () => {
  assert.equal(blockAt(makeState("---\n---"), 0), null);
  assert.equal(blockAt(makeState("---\n---"), 7), null);
});

// ---- Ctrl+A state machine ------------------------------------------------

// CDOC = alpha, blank line, --- (divider, line 3), beta, gamma.
// Block 1 is [0, 5) "alpha" (the blank row in front of the divider is not
// part of the block); block 2 is [11, 21) "beta\ngamma".
const CDOC = "alpha\n\n---\nbeta\ngamma";

test("first press inside a block selects that block (no trailing newline or blank)", () => {
  assert.equal(targetText(CDOC, 2), "alpha");
  assert.equal(targetText(CDOC, 13), "beta\ngamma");
});

test("pressing again after the block is selected expands to the whole document", () => {
  // Block 1 fully selected (head back inside it at position 0).
  assert.deepEqual(target(CDOC, 5, 0), { from: 0, to: CDOC.length });
});

test("a block selected by dragging also expands on the next press", () => {
  // Block 2 fully selected (head at the end of the document).
  assert.deepEqual(target(CDOC, 11, CDOC.length), { from: 0, to: CDOC.length });
});

test("the whole document selected stays selected", () => {
  assert.deepEqual(target(CDOC, 0, CDOC.length), { from: 0, to: CDOC.length });
});

test("a caret on a divider row selects the whole document on the first press", () => {
  assert.deepEqual(target(CDOC, 8), { from: 0, to: CDOC.length });
});

test("a blank-only block falls back to the whole document", () => {
  assert.deepEqual(target("a\n\n---\n", 7), { from: 0, to: 7 });
});

test("a selection spanning a divider collapses to the caret's block", () => {
  // Head at 13 lives in block 2; the block's extent replaces the selection.
  assert.deepEqual(target(CDOC, 0, 13), { from: 11, to: 21 });
});

test("after moving the caret away, the next press selects the block again", () => {
  // Any cursor motion cancels a selection; a fresh Ctrl+A then re-enters
  // block-level selection (stateless: no memory of the previous press).
  assert.equal(targetText(CDOC, 2), "alpha");
});

test("no dividers: Ctrl+A always selects the whole document", () => {
  assert.equal(targetText("alpha\nbeta", 2), "alpha\nbeta");
});

test("a divider as the first line leaves only the content below selectable", () => {
  assert.deepEqual(target("---\ncontent", 5), { from: 4, to: "---\ncontent".length });
  // Caret on the leading divider: straight to the whole document.
  assert.deepEqual(target("---\ncontent", 1), { from: 0, to: "---\ncontent".length });
});

test("a divider as the last line: content above, whole document from the divider", () => {
  assert.equal(targetText("content\n\n---", 2), "content");
  assert.deepEqual(target("content\n\n---", 10), { from: 0, to: "content\n\n---".length });
});

test("adjacent dividers are one boundary: no empty block between them", () => {
  assert.deepEqual(targetText("a\n\n---\n---\nb", 12), "b");
});

test("a setext underline never splits: first press already selects everything", () => {
  assert.equal(targetText("alpha\n---\nbeta\ngamma", 2), "alpha\n---\nbeta\ngamma");
});

test("a document made only of dividers selects the whole document", () => {
  assert.deepEqual(target("---\n---", 2), { from: 0, to: 7 });
});

test("an empty document selects the (empty) whole document", () => {
  assert.deepEqual(target("", 0), { from: 0, to: 0 });
});
