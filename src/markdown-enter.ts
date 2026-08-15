// Vendored from @codemirror/lang-markdown@6.5.2 (dist/index.js).
//
// Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin>
// and others, under the MIT License (see node_modules/@codemirror/lang-markdown/LICENSE).
//
// The upstream `insertNewlineContinueMarkupCommand` is copied here with two
// deliberate behavior changes for this project:
//
//   1. Enter at the end of a list item always inserts the new item on the
//      very next line (tight). Upstream's `nonTightList` branch, which
//      prepended a blank line to "continue" a non-tight (loose) list, is
//      removed (fixes issue #2).
//   2. Enter on an empty list item always removes the marker and exits the
//      list (upstream's `nonTightLists: false`), now hardcoded. The upstream
//      "move second item down" branch, the `nonTightLists` config parameter,
//      and the now-unused `nonTightList`/`blankLine` helpers are dropped.
//
// Everything else (blockquote continuation, ordered-list renumbering,
// nesting/dedent, task markers, trailing-whitespace trimming) is unchanged.
// `deleteMarkupBackward` and `markdown()` are still imported from upstream;
// only this Enter command is vendored. When bumping @codemirror/lang-markdown,
// re-sync this file against upstream's `insertNewlineContinueMarkupCommand`.

import { EditorSelection, EditorState, countColumn } from "@codemirror/state";
import type {
  ChangeSpec,
  SelectionRange,
  StateCommand,
  Text,
} from "@codemirror/state";
import { indentUnit, syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";

class Context {
  readonly node: SyntaxNode;
  readonly from: number;
  readonly to: number;
  readonly spaceBefore: string;
  readonly spaceAfter: string;
  readonly type: string;
  readonly item: SyntaxNode | null;

  constructor(
    node: SyntaxNode,
    from: number,
    to: number,
    spaceBefore: string,
    spaceAfter: string,
    type: string,
    item: SyntaxNode | null,
  ) {
    this.node = node;
    this.from = from;
    this.to = to;
    this.spaceBefore = spaceBefore;
    this.spaceAfter = spaceAfter;
    this.type = type;
    this.item = item;
  }

  blank(maxWidth: number | null, trailing = true): string {
    let result = this.spaceBefore + (this.node.name == "Blockquote" ? ">" : "");
    if (maxWidth != null) {
      while (result.length < maxWidth) result += " ";
      return result;
    } else {
      for (
        let i = this.to - this.from - result.length - this.spaceAfter.length;
        i > 0;
        i--
      )
        result += " ";
      return result + (trailing ? this.spaceAfter : "");
    }
  }

  marker(doc: Text, add: number): string {
    let number =
      this.node.name == "OrderedList"
        ? String(+itemNumber(this.item!, doc)[2] + add)
        : "";
    return this.spaceBefore + number + this.type + this.spaceAfter;
  }
}

function getContext(node: SyntaxNode, doc: Text): Context[] {
  let nodes: SyntaxNode[] = [],
    context: Context[] = [];
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    if (cur.name == "FencedCode") return context;
    if (cur.name == "ListItem" || cur.name == "Blockquote") nodes.push(cur);
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    let node = nodes[i],
      match: RegExpExecArray | null;
    let line = doc.lineAt(node.from),
      startPos = node.from - line.from;
    if (
      node.name == "Blockquote" &&
      (match = /^ *>( ?)/.exec(line.text.slice(startPos)))
    ) {
      context.push(
        new Context(
          node,
          startPos,
          startPos + match[0].length,
          "",
          match[1],
          ">",
          null,
        ),
      );
    } else if (
      node.name == "ListItem" &&
      node.parent!.name == "OrderedList" &&
      (match = /^( *)\d+([.)])( *)/.exec(line.text.slice(startPos)))
    ) {
      let after = match[3],
        len = match[0].length;
      if (after.length >= 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      context.push(
        new Context(
          node.parent!,
          startPos,
          startPos + len,
          match[1],
          after,
          match[2],
          node,
        ),
      );
    } else if (
      node.name == "ListItem" &&
      node.parent!.name == "BulletList" &&
      (match = /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/.exec(
        line.text.slice(startPos),
      ))
    ) {
      let after = match[4],
        len = match[0].length;
      if (after.length > 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      let type = match[2];
      if (match[3]) type += match[3].replace(/[xX]/, " ");
      context.push(
        new Context(
          node.parent!,
          startPos,
          startPos + len,
          match[1],
          after,
          type,
          node,
        ),
      );
    }
  }
  return context;
}

function itemNumber(item: SyntaxNode, doc: Text): RegExpExecArray {
  return /^(\s*)(\d+)(?=[.)])/.exec(doc.sliceString(item.from, item.from + 10))!;
}

function renumberList(
  after: SyntaxNode,
  doc: Text,
  changes: ChangeSpec[],
  offset = 0,
) {
  for (let prev = -1, node: SyntaxNode = after; ; ) {
    if (node.name == "ListItem") {
      let m = itemNumber(node, doc);
      let number = +m[2];
      if (prev >= 0) {
        if (number != prev + 1) return;
        changes.push({
          from: node.from + m[1].length,
          to: node.from + m[0].length,
          insert: String(prev + 2 + offset),
        });
      }
      prev = number;
    }
    let next = node.nextSibling;
    if (!next) break;
    node = next;
  }
}

function normalizeIndent(content: string, state: EditorState): string {
  let blank = /^[ \t]*/.exec(content)![0].length;
  if (!blank || state.facet(indentUnit) != "\t") return content;
  let col = countColumn(content, 4, blank);
  let space = "";
  for (let i = col; i > 0; ) {
    if (i >= 4) {
      space += "\t";
      i -= 4;
    } else {
      space += " ";
      i--;
    }
  }
  return space + content.slice(blank);
}

/**
A command that, when invoked in Markdown context with cursor selection(s),
creates a new line with the markup for blockquotes and lists that were active
on the old line. Unlike upstream, it never inserts a blank line to continue a
loose list, and it always exits the list on Enter in an empty item.
*/
export const insertNewlineContinueMarkupCommand = (): StateCommand => ({
  state,
  dispatch,
}) => {
  let tree = syntaxTree(state),
    { doc } = state;
  let dont: { range: SelectionRange } | null = null;
  let changes = state.changeByRange((range) => {
    if (
      !range.empty ||
      (!markdownLanguage.isActiveAt(state, range.from, -1) &&
        !markdownLanguage.isActiveAt(state, range.from, 1))
    )
      return (dont = { range });
    let pos = range.from,
      line = doc.lineAt(pos);
    let context = getContext(tree.resolveInner(pos, -1), doc);
    while (context.length && context[context.length - 1].from > pos - line.from)
      context.pop();
    if (!context.length) return (dont = { range });
    const inner = context[context.length - 1];
    if (inner.to - inner.spaceAfter.length > pos - line.from)
      return (dont = { range });
    let emptyLine =
      pos >= inner.to - inner.spaceAfter.length &&
      !/\S/.test(line.text.slice(inner.to));
    // Empty line in list: always remove a level of markup and exit the list.
    if (inner.item && emptyLine) {
      if (
        inner.item.from < line.from &&
        !/^[\s>]*$/.test(line.text.slice(0, inner.to))
      )
        return (dont = { range });
      let next = context.length > 1 ? context[context.length - 2] : null;
      let delTo: number,
        insert = "";
      if (next && next.item) {
        // Re-add marker for the list at the next level.
        delTo = line.from + next.from;
        insert = next.marker(doc, 1);
      } else {
        delTo = line.from + (next ? next.to : 0);
      }
      let changes: ChangeSpec[] = [{ from: delTo, to: pos, insert }];
      if (inner.node.name == "OrderedList")
        renumberList(inner.item, doc, changes, -2);
      if (next && next.node.name == "OrderedList")
        renumberList(next.item!, doc, changes);
      return { range: EditorSelection.cursor(delTo + insert.length), changes };
    }
    if (inner.node.name == "Blockquote" && emptyLine && line.from) {
      let prevLine = doc.lineAt(line.from - 1),
        quoted = />\s*$/.exec(prevLine.text);
      // Two aligned empty quoted lines in a row.
      if (quoted && quoted.index == inner.from) {
        let changes = state.changes([
          { from: prevLine.from + quoted.index, to: prevLine.to },
          { from: line.from + inner.from, to: line.to },
        ]);
        return { range: range.map(changes), changes };
      }
    }
    let changes: ChangeSpec[] = [];
    if (inner.node.name == "OrderedList")
      renumberList(inner.item!, doc, changes);
    let continued = inner.item && inner.item.from < line.from;
    let insert = "";
    // If not dedented.
    if (
      !continued ||
      /^[\s\d.)\-+*>]*/.exec(line.text)![0].length >= inner.to
    ) {
      for (let i = 0, e = context.length - 1; i <= e; i++) {
        insert +=
          i == e && !continued
            ? context[i].marker(doc, 1)
            : context[i].blank(
                i < e
                  ? countColumn(line.text, 4, context[i + 1].from) -
                      insert.length
                  : null,
              );
      }
    }
    let from = pos;
    while (from > line.from && /\s/.test(line.text.charAt(from - line.from - 1)))
      from--;
    insert = normalizeIndent(insert, state);
    // Upstream prepended a blank line here for non-tight lists; removed.
    changes.push({ from, to: pos, insert: state.lineBreak + insert });
    return { range: EditorSelection.cursor(from + insert.length + 1), changes };
  });
  if (dont) return false;
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};
