// Preview-suppression gate shared by the replace-widget preview extensions
// (task checkboxes in task-checkbox.ts, divider rules in divider.ts).
//
// A replace widget swaps a source span (`[ ]` / `[x]`, `---`) for a graphic,
// leaving the raw text underneath editable but hidden from view. While the
// caret sits on or inside the replaced span -- or while a selection so much
// as touches it -- the widget hides exactly the text being edited or
// selected, so the preview is temporarily lifted and the span renders as its
// plain source text until the caret or selection moves away.
//
// The rule is endpoint-inclusive: a collapsed caret at either edge of the
// span, and a selection whose boundary rests exactly on an edge, both
// suppress the widget, because the source text at those positions is
// reachable by the caret (or covered by the selection boundary) and must
// stay visible. Selection direction is irrelevant; only the extent matters.
//
// The gate is a pure function of the main selection extent and the focus
// state. Each view plugin collects its own spans and applies the gate only
// while its editor has focus: an unfocused editor always shows the normal
// preview, since nothing is being edited or selected interactively.

/** A half-open document range; the shape of every preview span. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** The extent of a (main) selection, normalized so from <= to; a collapsed
 *  selection is the caret position. */
export interface SelectionExtent {
  readonly from: number;
  readonly to: number;
}

/**
 * True when the selection extent touches the half-open span [from, to):
 * overlapping it, or meeting it at an edge. A collapsed selection (caret at
 * p) touches exactly when from <= p <= to.
 */
export function selectionTouches(
  selection: SelectionExtent,
  from: number,
  to: number,
): boolean {
  return selection.to >= from && selection.from <= to;
}

/**
 * Per-item suppression flags: an item is suppressed when the editor has
 * focus and the main selection touches its span (see selectionTouches).
 * Without focus no item is ever suppressed.
 */
export function suppressionMask<T extends Span>(
  items: readonly T[],
  selection: SelectionExtent,
  focused: boolean,
): boolean[] {
  if (!focused) return items.map(() => false);
  return items.map((item) => selectionTouches(selection, item.from, item.to));
}

/** Element-wise comparison of two suppression masks. */
export function sameMask(a: boolean[], b: boolean[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
