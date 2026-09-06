// Horizontal-rule dividers (`---`) rendered as full-width rules, and
// block-scoped Ctrl+A selection.
//
// A divider is a GFM thematic-break line whose source text is exactly `---`
// (after trimming), located through the markdown syntax tree. Using the tree
// means content inside fenced/indented code is never a divider, and a `---`
// directly under a paragraph (a setext heading underline) isn't one either.
// Nested contexts are excluded too: `> ---` inside a blockquote and an
// indented `---` inside a list item are not document-level dividers.
//
// Every line belongs to exactly one *block*. A block is a maximal segment of
// non-divider lines plus the divider row that terminates it: a divider
// belongs to the block above its row. A divider with only dividers (or
// nothing) above it -- a leading `---` or one repeated after another -- owns
// no segment and stands alone as a one-row block, so consecutive dividers
// never merge. Each block decomposes into up to four parts, in order:
//
//     front whitespace | text | tail whitespace | divider
//
// `text` is the real content: from the first non-blank line through the last
// non-blank line, keeping blank lines in between. Blank lines before the
// text are front whitespace; blank lines after it (up to the divider or the
// end of the document) are tail whitespace. A block with no text at all
// stores its whitespace as tail whitespace -- never front -- so front
// whitespace can only exist alongside text.
//
// Ctrl+A is a stateless two-level selection. The first press targets the
// caret's block:
//   - a block with text: a caret anywhere except on the divider selects the
//     text alone (a caret parked in front/tail whitespace still selects the
//     text); a caret ON the block's divider selects the whole block (front
//     whitespace + text + tail whitespace + divider);
//   - a block without text (blank-only, or a lone divider row): the caret
//     always selects the whole block (its whitespace and divider, if any).
// The rule is stateless: the target is a pure function of the caret line,
// and every dispatch leaves the caret on a line that maps back to the same
// target, so "a second press selects everything" needs no remembered state.
//
// The rendering mirrors the task-checkbox extension: a widget replaces the
// `---` glyphs while the source text stays editable underneath; as soon as
// the line is no longer exactly `---` the decoration disappears.

import { EditorSelection, type EditorState, type Range, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  type Command,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

/** One divider row: the exact source range of its `---` and its line number. */
export interface DividerInfo {
  readonly from: number;
  readonly to: number;
  readonly line: number;
}

/**
 * Collect every document-level `---` divider. Runs the parser to completion so
 * the tree is never stale. Nested thematic breaks (blockquotes, list items)
 * and other thematic-break spellings (`***`, `___`, `- - -`) are skipped.
 */
export function collectDividerRanges(state: EditorState): DividerInfo[] {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  const dividers: DividerInfo[] = [];
  if (!tree) return dividers;
  tree.iterate({
    enter(node) {
      if (node.name !== "HorizontalRule") return;
      if (doc.sliceString(node.from, node.to).trim() !== "---") return;
      let cur: SyntaxNode | null = node.node.parent;
      let nested = false;
      while (cur) {
        if (cur.name === "Blockquote" || cur.name === "ListItem") {
          nested = true;
          break;
        }
        cur = cur.parent;
      }
      if (nested) return;
      dividers.push({
        from: node.from,
        to: node.to,
        line: doc.lineAt(node.from).number,
      });
    },
  });
  return dividers;
}

/** A contiguous range inside the document (inclusive of its end). */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

/**
 * One block: the front-whitespace / text / tail-whitespace / divider
 * decomposition of a line segment (see the module comment). `from`/`to`
 * cover the whole block from the first row's start to the last row's last
 * character; `fromLine`/`toLine` are its 1-based row numbers. Only `text`
 * may span multiple rows; every other part is a run of blank rows or a
 * single divider row, so a part's characters are its rows' line breaks.
 */
export interface Block {
  readonly from: number;
  readonly to: number;
  readonly fromLine: number;
  readonly toLine: number;
  /** Blank rows before the text (only ever present alongside `text`). */
  readonly leadWhite: LineRange | null;
  /** The real content, front/tail blank margins trimmed, inner blanks kept. */
  readonly text: LineRange | null;
  /** Blank rows after the text; the whole whitespace of a blank-only block. */
  readonly tailWhite: LineRange | null;
  /** The divider row this block owns, or null when the block ends elsewhere. */
  readonly divider: DividerInfo | null;
}

function isBlankLine(doc: Text, lineNo: number): boolean {
  return doc.line(lineNo).text.trim().length === 0;
}

/**
 * Build the block for the non-divider rows `lo..hi` (inclusive, empty when
 * `lo > hi`) plus the divider that terminates them, or for `lo..hi` alone
 * when `divider` is null (the final segment after the last divider).
 */
function buildSegment(
  doc: Text,
  lo: number,
  hi: number,
  divider: DividerInfo | null,
): Block {
  if (lo > hi) {
    // No rows above the divider (leading divider or one repeated after
    // another): the block is just that divider row.
    const row = doc.line(divider!.line);
    return {
      from: row.from,
      to: row.to,
      fromLine: divider!.line,
      toLine: divider!.line,
      leadWhite: null,
      text: null,
      tailWhite: null,
      divider,
    };
  }

  let firstTextLine = -1;
  let lastTextLine = -1;
  for (let n = lo; n <= hi; n += 1) {
    if (!isBlankLine(doc, n)) {
      if (firstTextLine < 0) firstTextLine = n;
      lastTextLine = n;
    }
  }

  const firstLine = doc.line(lo);
  const segmentEnd = divider ? divider.from : doc.length;

  if (firstTextLine < 0) {
    // Blank-only: the whitespace is tail whitespace, running to the divider
    // (or the document end); with a divider the block ends on that row.
    const from = firstLine.from;
    return {
      from,
      to: divider ? divider.to : doc.length,
      fromLine: lo,
      toLine: divider ? divider.line : hi,
      leadWhite: null,
      text: null,
      tailWhite: from < segmentEnd ? { from, to: segmentEnd } : null,
      divider,
    };
  }

  const textFrom = doc.line(firstTextLine).from;
  const textTo = doc.line(lastTextLine).to;
  return {
    from: firstLine.from,
    to: divider ? divider.to : doc.length,
    fromLine: lo,
    toLine: divider ? divider.line : hi,
    leadWhite: firstLine.from < textFrom ? { from: firstLine.from, to: textFrom } : null,
    text: { from: textFrom, to: textTo },
    tailWhite: textTo < segmentEnd ? { from: textTo, to: segmentEnd } : null,
    divider,
  };
}

/**
 * Partition the document into blocks, top to bottom. Every row -- including
 * every divider row -- belongs to exactly one block. A document without
 * dividers is a single block covering everything.
 */
export function collectBlocks(state: EditorState): Block[] {
  const doc = state.doc;
  const blocks: Block[] = [];
  let previousDividerLine = 0;
  for (const divider of collectDividerRanges(state)) {
    blocks.push(buildSegment(doc, previousDividerLine + 1, divider.line - 1, divider));
    previousDividerLine = divider.line;
  }
  if (previousDividerLine < doc.lines) {
    blocks.push(buildSegment(doc, previousDividerLine + 1, doc.lines, null));
  }
  return blocks;
}

/**
 * The block owning the line at `pos`. Every clamped position sits on a row
 * that belongs to exactly one block, so this never returns null.
 */
export function blockAt(state: EditorState, pos: number): Block {
  const doc = state.doc;
  const lineNo = doc.lineAt(Math.max(0, Math.min(pos, doc.length))).number;
  const blocks = collectBlocks(state);
  return blocks.find((b) => b.fromLine <= lineNo && lineNo <= b.toLine)!;
}

/** The first-press Ctrl+A target for a caret parked on `caretLine`. */
function firstPressTarget(block: Block, caretLine: number): { from: number; to: number } {
  const onDivider = block.divider !== null && block.divider.line === caretLine;
  if (block.text !== null && !onDivider) {
    // Caret in a block with content (its front whitespace, its text, or its
    // tail whitespace): select just the text.
    return { from: block.text.from, to: block.text.to };
  }
  // Caret on the block's divider, or in a content-less block: select the
  // whole block (front whitespace + text + tail whitespace + divider, or
  // the block's whitespace and/or divider alone).
  return { from: block.from, to: block.to };
}

/**
 * The selection the next Ctrl+A should make (pure, for tests). First press:
 * see `firstPressTarget`. The whole document when everything is already
 * selected, or when the current selection already equals what a first press
 * would make from the caret (a second press) -- which stays selected on
 * further presses.
 */
export function nextSelectionTarget(state: EditorState): { from: number; to: number } {
  const doc = state.doc;
  const sel = state.selection.main;
  const len = doc.length;
  if (sel.from === 0 && sel.to === len) return { from: 0, to: len };
  const caretLine = doc.lineAt(Math.max(0, Math.min(sel.head, len))).number;
  const block = blockAt(state, sel.head);
  const target = firstPressTarget(block, caretLine);
  if (!sel.empty && sel.from === target.from && sel.to === target.to) {
    return { from: 0, to: len };
  }
  return target;
}

/** Keymap command: select the caret's block, or the whole document (see
 *  nextSelectionTarget). Always reports the key as handled so the default
 *  select-all can't also run. */
export function selectBlockOrAllCommand(): Command {
  return (view) => {
    const { from, to } = nextSelectionTarget(view.state);
    const sel = view.state.selection.main;
    if (sel.from === from && sel.to === to) return true; // already the target
    view.dispatch({
      selection: EditorSelection.single(from, to),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

class DividerWidget extends WidgetType {
  eq(other: DividerWidget): boolean {
    return other instanceof DividerWidget;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement("div");
    rule.className = "cm-divider";
    rule.setAttribute("aria-hidden", "true");
    return rule;
  }
}

function computeDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const divider of collectDividerRanges(view.state)) {
    decos.push(
      Decoration.replace({
        widget: new DividerWidget(),
      }).range(divider.from, divider.to),
    );
  }
  return Decoration.set(decos);
}

const dividerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.decorations = computeDecorations(update.view);
      }
    }
  },
  { decorations: (view) => view.decorations },
);

/** Extension that renders `---` divider rows as full-width rules. */
export function dividerExtension() {
  return dividerPlugin;
}
