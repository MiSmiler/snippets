// Pure helpers for drag-to-reorder the tab strip. Kept free of DOM and Tauri
// dependencies so they can be unit-tested with `npm test`.
//
// The drop geometry model: the strip is a row of tabs in display order. A
// drop lands on a *slot*, a boundary counted 0..tabs.length where slot k
// means "insert before the tab currently at index k" (slot 0 = very front,
// slot length = very end). A slot is the only thing drag commits against.

export interface TabBounds {
  left: number;
  right: number;
}

/**
 * The slot under an x coordinate. Tabs are compared by their midpoint, so
 * the left half of a tab targets the slot before it and the right half the
 * slot after it. `x` is clamped to the strip's span.
 */
export function dropSlot(bounds: readonly TabBounds[], x: number): number {
  const n = bounds.length;
  if (n === 0) return 0;
  const first = bounds[0].left;
  const last = bounds[n - 1].right;
  const clamped = Math.min(Math.max(x, first), last);
  for (let i = 0; i < n; i += 1) {
    if (clamped <= (bounds[i].left + bounds[i].right) / 2) return i;
  }
  return n;
}

/**
 * Whether dropping at slot `slot` leaves the tab at `from` where it already
 * is. Slots `from` (insert before itself) and `from + 1` (insert right after
 * itself) are both no-ops.
 */
export function dropSlotIsNoOp(from: number, slot: number): boolean {
  return slot === from || slot === from + 1;
}

/**
 * Move the item at `from` to slot `slot` (see the module comment for slot
 * semantics), returning a new array with the same item references. Returns a
 * copy of `items` unchanged for the two no-op slots. `from` must be a valid
 * index; `slot` must be in 0..items.length.
 */
export function moveItem<T>(items: readonly T[], from: number, slot: number): T[] {
  if (dropSlotIsNoOp(from, slot)) return [...items];
  const out = [...items];
  const [item] = out.splice(from, 1);
  const insertAt = slot > from ? slot - 1 : slot;
  out.splice(insertAt, 0, item);
  return out;
}
