// Tests for the horizontal-rule divider feature (src/divider.ts): rendering
// triggers are the syntax-aware divider rows; Ctrl+A block selection follows
// the four-part block model (front whitespace | text | tail whitespace |
// divider). A divider belongs to the block above its row; a caret on the
// divider selects the whole block, a caret in a content block selects just
// the text, and a second press selects the whole document.
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
  collectBlocks,
  collectDividerRanges,
  nextSelectionTarget,
  type Block,
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

/** Render one block as its field slices (null = absent). */
function shapeOf(doc: string, block: Block) {
  const part = (r: { from: number; to: number } | null) =>
    r === null ? null : doc.slice(r.from, r.to);
  return {
    span: doc.slice(block.from, block.to),
    leadWhite: part(block.leadWhite),
    text: part(block.text),
    tailWhite: part(block.tailWhite),
    divider: part(block.divider),
  };
}

function shapes(doc: string) {
  return collectBlocks(makeState(doc)).map((b) => shapeOf(doc, b));
}

// ---- Divider recognition ------------------------------------------------

test("a lone --- line surrounded by blank lines is one divider", () => {
  assert.deepEqual(dividerLines("alpha\n\n---\n\nbeta\ngamma"), [3]);
});

test("two real dividers split the document into three regions", () => {
  assert.deepEqual(dividerLines("one\n\n---\ntwo\n\n---\nthree"), [3, 6]);
});

test("adjacent divider lines are both dividers", () => {
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

// ---- Block partition -----------------------------------------------------

// CDOC = alpha / blank / --- (divider, line 3) / beta / gamma.
// Block 1 owns the divider: {text "alpha", tail "\n\n", divider "---"}.
const CDOC = "alpha\n\n---\nbeta\ngamma";

test("a content block above a divider: text, tail whitespace, divider", () => {
  assert.deepEqual(shapes(CDOC), [
    { span: "alpha\n\n---", leadWhite: null, text: "alpha", tailWhite: "\n\n", divider: "---" },
    { span: "beta\ngamma", leadWhite: null, text: "beta\ngamma", tailWhite: null, divider: null },
  ]);
});

test("blocks tile every line of the document", () => {
  for (const doc of [
    CDOC,
    "a\n\n---\n\n---\nb",
    "---\ncontent",
    "a\n\n---\n---\nb",
    "\n\n---\na",
    "\n\nA\n\n",
    "one\n\n\ntwo\n\n---\nthree",
  ]) {
    const state = makeState(doc);
    const blocks = collectBlocks(state);
    assert.equal(blocks[0].fromLine, 1);
    assert.equal(blocks[blocks.length - 1].toLine, state.doc.lines);
    for (let i = 1; i < blocks.length; i += 1) {
      assert.equal(blocks[i].fromLine, blocks[i - 1].toLine + 1);
    }
  }
});

test("a document without dividers is a single block (front/tail margins split off)", () => {
  assert.deepEqual(shapes("\n\nA\n\n"), [
    { span: "\n\nA\n\n", leadWhite: "\n\n", text: "A", tailWhite: "\n\n", divider: null },
  ]);
});

test("a blank-only region between two dividers owns the divider below it", () => {
  // line 4 (blank) between divider 3 and divider 5 forms {tail "\n", divider}.
  assert.deepEqual(shapes("a\n\n---\n\n---\nb"), [
    { span: "a\n\n---", leadWhite: null, text: "a", tailWhite: "\n\n", divider: "---" },
    { span: "\n---", leadWhite: null, text: null, tailWhite: "\n", divider: "---" },
    { span: "b", leadWhite: null, text: "b", tailWhite: null, divider: null },
  ]);
});

test("blank lines above the first divider form a blank-only block owning it", () => {
  assert.deepEqual(shapes("\n\n---\na"), [
    { span: "\n\n---", leadWhite: null, text: null, tailWhite: "\n\n", divider: "---" },
    { span: "a", leadWhite: null, text: "a", tailWhite: null, divider: null },
  ]);
});

test("consecutive dividers never merge: each later row is its own block", () => {
  // Line 3 belongs to block 1; line 4 stands alone as a one-row block.
  assert.deepEqual(shapes("a\n\n---\n---\nb"), [
    { span: "a\n\n---", leadWhite: null, text: "a", tailWhite: "\n\n", divider: "---" },
    { span: "---", leadWhite: null, text: null, tailWhite: null, divider: "---" },
    { span: "b", leadWhite: null, text: "b", tailWhite: null, divider: null },
  ]);
});

test("a leading divider owns nothing and stands alone", () => {
  assert.deepEqual(shapes("---\ncontent"), [
    { span: "---", leadWhite: null, text: null, tailWhite: null, divider: "---" },
    { span: "content", leadWhite: null, text: "content", tailWhite: null, divider: null },
  ]);
});

test("a document made only of dividers is one row-block per divider", () => {
  assert.deepEqual(shapes("---\n---"), [
    { span: "---", leadWhite: null, text: null, tailWhite: null, divider: "---" },
    { span: "---", leadWhite: null, text: null, tailWhite: null, divider: "---" },
  ]);
});

test("front whitespace only exists alongside text", () => {
  const doc = "---\n\nA\n\n---\nB";
  const blocks = collectBlocks(makeState(doc));
  // block 2 = front "\n" / text "A" / tail "\n\n" / divider "---".
  assert.deepEqual(shapeOf(doc, blocks[1]), {
    span: "\nA\n\n---",
    leadWhite: "\n",
    text: "A",
    tailWhite: "\n\n",
    divider: "---",
  });
});

test("blank lines inside the text are kept; only the margins split off", () => {
  assert.deepEqual(shapes("one\n\n\ntwo\n\n---\nthree"), [
    { span: "one\n\n\ntwo\n\n---", leadWhite: null, text: "one\n\n\ntwo", tailWhite: "\n\n", divider: "---" },
    { span: "three", leadWhite: null, text: "three", tailWhite: null, divider: null },
  ]);
});

test("a trailing divider ends its block; nothing follows", () => {
  assert.deepEqual(shapes("content\n\n---"), [
    { span: "content\n\n---", leadWhite: null, text: "content", tailWhite: "\n\n", divider: "---" },
  ]);
});

test("a phantom empty final line after ---\\n is a zero-width blank block", () => {
  const doc = "a\n\n---\n";
  const blocks = collectBlocks(makeState(doc));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].from, doc.length);
  assert.equal(blocks[1].to, doc.length);
  assert.equal(blocks[1].text, null);
  assert.equal(blocks[1].tailWhite, null);
});

test("a setext underline never creates a block boundary", () => {
  assert.deepEqual(shapes("alpha\n---\nbeta\ngamma"), [
    { span: "alpha\n---\nbeta\ngamma", leadWhite: null, text: "alpha\n---\nbeta\ngamma", tailWhite: null, divider: null },
  ]);
});

// ---- Ctrl+A first press --------------------------------------------------

test("caret in the text of a content block selects just the text", () => {
  assert.equal(targetText(CDOC, 2), "alpha");
  assert.equal(targetText(CDOC, 13), "beta\ngamma");
  assert.equal(targetText(CDOC, 20), "beta\ngamma");
});

test("caret parked in a block's front or tail whitespace still selects the text", () => {
  assert.equal(targetText(CDOC, 6), "alpha"); // tail blank row above the divider
  assert.equal(targetText("\n\nA\n\n", 1), "A"); // front blank rows
  assert.equal(targetText("\n\nA\n\n", 4), "A"); // tail blank rows at EOF
  assert.equal(targetText("one\n\n\ntwo\n\n---\nthree", 4), "one\n\n\ntwo"); // inner blanks kept
});

test("caret on a content block's divider selects the whole block", () => {
  assert.equal(targetText(CDOC, 8), "alpha\n\n---");
  // Front whitespace is included too when it exists.
  assert.equal(targetText("---\n\nA\n\n---\nB", 9), "\nA\n\n---");
});

test("caret on a leading divider selects the divider row alone", () => {
  assert.equal(targetText("---\ncontent", 1), "---");
});

test("caret in a blank-only block always selects whitespace plus its divider", () => {
  const doc = "a\n\n---\n\n---\nb";
  assert.equal(targetText(doc, 7), "\n---"); // on the blank row
  assert.equal(targetText(doc, 9), "\n---"); // on the divider row
});

test("caret in a blank-only block above the first divider selects whitespace + divider", () => {
  const doc = "\n\n---\na";
  assert.equal(targetText(doc, 1), "\n\n---");
  assert.equal(targetText(doc, 4), "\n\n---"); // on the divider itself
});

test("caret on either of two adjacent dividers selects its own row", () => {
  const doc = "a\n\n---\n---\nb";
  const first = targetText(doc, 4); // line 3 (block 1's divider)
  const second = targetText(doc, 8); // line 4 (the lone divider block)
  assert.equal(first, "a\n\n---");
  assert.equal(second, "---");
});

test("caret at the very end on a trailing divider selects the block above it", () => {
  const doc = "content\n\n---";
  assert.equal(targetText(doc, doc.length), "content\n\n---");
  assert.equal(targetText(doc, 2), "content");
});

test("a document without dividers follows the same rules (text only, then whole)", () => {
  const doc = "\n\nA\n\n";
  assert.equal(targetText(doc, 2), "A");
});

test("a setext underline never splits: first press already covers everything", () => {
  assert.equal(targetText("alpha\n---\nbeta\ngamma", 2), "alpha\n---\nbeta\ngamma");
});

test("a phantom empty line at EOF selects nothing (block stays bounded)", () => {
  const doc = "a\n\n---\n";
  assert.deepEqual(target(doc, doc.length), { from: doc.length, to: doc.length });
});

test("an empty document selects the (empty) whole document", () => {
  assert.deepEqual(target("", 0), { from: 0, to: 0 });
});

// ---- Ctrl+A second press (escalation) -----------------------------------

test("a second press after a text selection expands to the whole document", () => {
  // Selection [0,5) "alpha" with the head back inside the text.
  assert.deepEqual(target(CDOC, 0, 5), { from: 0, to: CDOC.length });
});

test("a second press after a whole-block selection (from the divider) expands", () => {
  // Whole block 1 [0,10) "alpha\n\n---", head parked on the divider row.
  assert.deepEqual(target(CDOC, 0, 10), { from: 0, to: CDOC.length });
});

test("a second press after a blank-only selection expands", () => {
  const doc = "a\n\n---\n\n---\nb";
  // Whole blank block [7,11) "\n---", head on its divider.
  assert.deepEqual(target(doc, 7, 11), { from: 0, to: doc.length });
});

test("a second press after a front-whitespace-inclusive selection expands", () => {
  const doc = "---\n\nA\n\n---\nB";
  // Whole block 2 [4,11) "\nA\n\n---", head on its divider.
  assert.deepEqual(target(doc, 4, 11), { from: 0, to: doc.length });
});

test("a second press in a divider-less document expands to everything", () => {
  const doc = "\n\nA\n\n";
  assert.deepEqual(target(doc, 2, 3), { from: 0, to: doc.length });
});

test("the whole document selected stays selected", () => {
  assert.deepEqual(target(CDOC, 0, CDOC.length), { from: 0, to: CDOC.length });
});

test("a selection spanning a divider collapses to the caret's target", () => {
  // Head at 13 lives in block 2's text; the block's text replaces the span.
  assert.deepEqual(target(CDOC, 0, 13), { from: 11, to: 21 });
});

test("after moving the caret away, the next press re-enters block selection", () => {
  // Stateless: a fresh empty caret inside a block selects the block again.
  assert.equal(targetText(CDOC, 2), "alpha");
});

// ---- Block lookup ---------------------------------------------------------

test("blockAt always returns the block owning the caret's line", () => {
  const state = makeState(CDOC);
  const onDivider = blockAt(state, 8);
  assert.equal(onDivider.divider!.line, 3);
  assert.equal(CDOC.slice(onDivider.from, onDivider.to), "alpha\n\n---");
  const inBeta = blockAt(state, 13);
  assert.equal(CDOC.slice(inBeta.text!.from, inBeta.text!.to), "beta\ngamma");
});
