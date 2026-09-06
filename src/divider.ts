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
// Dividers partition the document into *blocks* (maximal runs of lines that
// are not divider rows; consecutive dividers merge into one boundary). They
// exist purely for selection: a divider row belongs to no block. A block's
// text ends at the last character of its final line -- the line break that
// would otherwise sit between that line and the divider below is not part of
// the block, so copying a block never carries a trailing newline (or blank
// line) along. Ctrl+A is redefined as a stateless two-level selection:
//   - first press selects the block containing the caret;
//   - a second press (or any state where the current block is already fully
//     selected) selects the whole document, which stays selected on further
//     presses.
// Exceptions: a caret on a divider row, in a block with no visible content
// (blank-only), or in a document with no dividers selects the whole document
// on the first press -- so Ctrl+A never selects nothing.
//
// The rendering mirrors the task-checkbox extension: a widget replaces the
// `---` glyphs while the source text stays editable underneath; as soon as
// the line is no longer exactly `---` the decoration disappears.

import { EditorSelection, type EditorState, type Range } from "@codemirror/state";
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

/** A content block: an offset range plus whether it holds no visible text. */
export interface BlockSpan {
  readonly from: number;
  readonly to: number;
  /** True when the block has no non-whitespace content (blank-only). */
  readonly blank: boolean;
}

function isDividerLine(dividers: DividerInfo[], line: number): boolean {
  return dividers.some((d) => d.line === line);
}

/**
 * The block containing `pos` (as an offset range covering the block's text
 * through the end of its last line), or null when `pos` sits on a divider
 * row and therefore belongs to no block. A document without dividers is one
 * block spanning everything.
 */
export function blockAt(state: EditorState, pos: number): BlockSpan | null {
  const doc = state.doc;
  const dividers = collectDividerRanges(state);
  const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
  if (isDividerLine(dividers, line.number)) return null;

  let start = line.number;
  while (start > 1 && !isDividerLine(dividers, start - 1)) start -= 1;
  let end = line.number;
  while (end < doc.lines && !isDividerLine(dividers, end + 1)) end += 1;

  const from = doc.line(start).from;
  // End at the last character of the block's final line. The line break that
  // would separate that line from the divider below is left out, so copying
  // a block (or retyping over it) never drags the divider's adjacent newline
  // along. A block that runs to the document end still reaches doc.length.
  const to = doc.line(end).to;
  return { from, to, blank: doc.sliceString(from, to).trim().length === 0 };
}

/**
 * The selection the next Ctrl+A should make (pure, for tests): the block the
 * caret is in, or the whole document when the block is already fully selected
 * (second press), when everything is already selected, when the caret is on a
 * divider row, or when the current block has no content to select.
 */
export function nextSelectionTarget(state: EditorState): { from: number; to: number } {
  const doc = state.doc;
  const sel = state.selection.main;
  const len = doc.length;
  const wholeSelected = sel.from === 0 && sel.to === len;
  const block = blockAt(state, sel.head);
  if (
    !block ||
    block.blank ||
    wholeSelected ||
    (!sel.empty && sel.from === block.from && sel.to === block.to)
  ) {
    return { from: 0, to: len };
  }
  return { from: block.from, to: block.to };
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
