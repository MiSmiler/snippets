// Give explicit markdown code (inline `code`, fenced and indented code
// blocks) the code font, leaving prose in the proportional reading font.
//
// The font stacks themselves live in style.css (--font-prose / --font-code);
// this extension only marks code regions with the `cm-code` class -- a span
// mark for inline code, a line class for block code. Code regions are
// identified through the markdown syntax tree, so anything written inside
// fenced/indented code is never re-parsed as markup: task markers, list
// prefixes etc. inside code stay plain text. Chinese characters inside code
// fall through the code stack to the same CJK font as prose (they are not
// monospaced), an accepted trade-off for zero-bundle system fonts.

import { EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";

/** One markdown code region. `block` means fenced/indented block code
 *  (spans whole lines); otherwise it is inline code within a line. */
export interface CodeRange {
  readonly from: number;
  readonly to: number;
  readonly block: boolean;
}

const BLOCK_CODE_NODES = new Set(["FencedCode", "CodeBlock"]);

/**
 * Collect every explicit markdown code region in the document. Runs the
 * parser to completion so the tree is never stale.
 */
export function collectCodeRanges(state: EditorState): CodeRange[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const ranges: CodeRange[] = [];
  if (!tree) return ranges;
  tree.iterate({
    enter(node) {
      if (node.name === "InlineCode") {
        ranges.push({ from: node.from, to: node.to, block: false });
      } else if (BLOCK_CODE_NODES.has(node.name)) {
        ranges.push({ from: node.from, to: node.to, block: true });
      }
    },
  });
  return ranges;
}

const inlineCodeMark = Decoration.mark({ class: "cm-code" });

function computeDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const decos: Range<Decoration>[] = [];
  for (const { from, to, block } of collectCodeRanges(view.state)) {
    if (!block) {
      decos.push(inlineCodeMark.range(from, to));
      continue;
    }
    // Block code: one line decoration per covered line (a mark cannot span
    // lines). The whole line is code (fence marks included), so a line class
    // is both simpler and cheaper than per-segment marks.
    const firstLine = doc.lineAt(from).number;
    const lastLine = doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = firstLine; n <= lastLine; n += 1) {
      const line = doc.line(n);
      decos.push(Decoration.line({ class: "cm-code" }).range(line.from, line.from));
    }
  }
  return Decoration.set(decos);
}

const codeFontPlugin = ViewPlugin.fromClass(
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

/** Extension that renders markdown code regions in the --font-code font. */
export function codeFontExtension() {
  return codeFontPlugin;
}
