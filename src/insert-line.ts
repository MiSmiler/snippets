// Command for Shift+Mod+Enter (Ctrl+Shift+Enter on Windows/Linux,
// Cmd+Shift+Enter on macOS): insert a blank line above the current line and
// move the cursor into it.
//
// CodeMirror ships insertBlankLine (bound to Mod+Enter in defaultKeymap --
// the app's existing "blank line below" insert) but has no upstream
// insert-above. This command is a mirror of upstream's newlineAndIndent(true)
// with the insertion anchored at the *start* of the anchor line instead of at
// its end:
//
//   - Like insertBlankLine it never splits the anchor line: the whole line
//     stays put and a new blank line is inserted above it, cursor included.
//   - The new line carries the indentation upstream would compute for the
//     line below: the language indent strategy at the insertion point, falling
//     back to the anchor line's own leading whitespace (which is what
//     markdown resolves to, so a top-level line gets a column-0 blank line and
//     an indented line gets a blank line with the same indent).
//   - Multi-line selections anchor on their first line, so the blank line
//     goes above the whole selection (insertBlankLine anchors below the last
//     selected line).
//   - Unlike insertBlankLine, a whitespace-only anchor line is never consumed
//     (upstream collapses it into the new line below); inserting above never
//     deletes text.
//   - Like insertBlankLine it handles every selection range (multi-cursor
//     aware), bails out on readOnly documents, and dispatches with
//     userEvent "input" so the insert joins normal undo grouping.

import { EditorSelection, Text, countColumn } from "@codemirror/state";
import type { StateCommand } from "@codemirror/state";
import {
  IndentContext,
  getIndentation,
  indentString,
} from "@codemirror/language";

export const insertLineAboveCommand = (): StateCommand => ({
  state,
  dispatch,
}) => {
  if (state.readOnly) return false;
  let changes = state.changeByRange((range) => {
    let line = state.doc.lineAt(range.from);
    // Indentation for the new line, mirroring insertBlankLine: ask the
    // language for the indent of a line starting right before the anchor
    // line. Markdown's only indent strategy (Document) returns null, so the
    // fallback -- the anchor line's own leading whitespace -- applies.
    let cx = new IndentContext(state, { simulateBreak: line.from });
    let indent = getIndentation(cx, line.from);
    if (indent == null)
      indent = countColumn(/^\s*/.exec(line.text)?.[0] ?? "", state.tabSize);
    let space = indentString(state, indent);
    // Insert `space` + "\n" right at the anchor line's start. The inserted
    // `space` becomes the new (blank) line and the anchor line follows after
    // the "\n", so the cursor lands at the end of the inserted indentation.
    return {
      changes: { from: line.from, to: line.from, insert: Text.of([space, ""]) },
      range: EditorSelection.cursor(line.from + space.length),
    };
  });
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
};
