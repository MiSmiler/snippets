// Undo history configuration for the editor.
//
// CodeMirror's default history merges adjacent document changes that
// happen within newGroupDelay (500ms), and its "joinable userEvent"
// rule treats both "input.type*" and "delete*" as joinable. As a
// result, deleting a character right after typing it merges the
// deletion into the typing event -- the merged event can even have
// empty net changes, which makes Ctrl+Z a no-op and leaves the
// deleted character unrestorable.
//
// This configuration vetoes such merges when the incoming transaction
// is a deletion, so every deletion becomes its own undo step. Typing
// is still grouped into events exactly as before.

import { Transaction } from "@codemirror/state";

export function joinToEvent(tr: Transaction, isAdjacent: boolean): boolean {
  if (!isAdjacent) return false;
  const userEvent = tr.annotation(Transaction.userEvent);
  return !userEvent || !/^delete/.test(userEvent);
}
