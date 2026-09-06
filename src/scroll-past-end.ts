// Scroll-past-end ("overscroll") at the bottom of a note, matching how VS
// Code treats the end of a document:
//
// - The mouse wheel / trackpad / scrollbar can scroll into a deep blank
//   region below the text, so every line of the note can be brought to the
//   top of the viewport (deep slack = viewport height - one line). Notes
//   shorter than the viewport become scrollable too, as long as they hold
//   more than one line; a single empty line has no extra scroll range, so a
//   brand-new note stays put.
// - Caret-driven movement (typing at the end of the note, PageDown,
//   Ctrl+End) never enters that deep region on its own: when the editor
//   scrolls to reveal the caret it leaves a small cushion of blank lines
//   below the caret line instead of gluing it to the bottom edge.
//
// The two behaviors come from separate mechanisms that don't fight each
// other. The deep region is plain scrollable overflow: CodeMirror's
// built-in `scrollPastEnd()` grows `.cm-content`'s bottom padding to
// `editor height - one line - top padding`, and the browser's native wheel
// scrolling uses that range as-is. The cushion is applied through
// `EditorView.cursorScrollMargin`, a facet that CodeMirror only consults
// when it scrolls to *reveal the caret* (typing, key movement, commands);
// wheel / trackpad motion never goes through it.
//
// PageDown needs one extra guard. CodeMirror's own cursorPageDown returns
// false once the caret sits at the end of the note, and an unhandled
// PageDown then falls through to the browser: Chromium pages the focused
// contenteditable natively and scrolls the view straight into the deep
// region. And while the caret can still move, cursorPageDown keeps it at
// its previous screen offset instead of resting it on the cushion, so the
// press that reaches the end of the note with less than a page left parks
// the caret wherever it was -- with a large blank region below. The keymap
// below runs the default paging, then re-pins the caret to the cushion
// whenever it ends up at the end of a note that fills the window, so
// keyboard paging always stops at the cushion, never in the deep region.

import { Compartment, Prec } from "@codemirror/state";
import type { Extension, StateEffect } from "@codemirror/state";
import { cursorPageDown, selectPageDown } from "@codemirror/commands";
import { EditorView, keymap, scrollPastEnd } from "@codemirror/view";

/**
 * Line-box height in em for the prose text. Must mirror the
 * `".cm-scroller": { lineHeight: "1.65" }` theme in main.ts -- the cushion
 * is measured in em-derived pixels so it scales with the font size.
 */
const LINE_HEIGHT_EM = 1.65;

/** Blank lines kept below the caret line when it is revealed near the end. */
const CUSHION_LINES = 5;

const cushionCompartment = new Compartment();

/** The reveal cushion as pixels at the given font size. */
function cushionMarginPx(fontSizePx: number): number {
  return Math.round(CUSHION_LINES * fontSizePx * LINE_HEIGHT_EM);
}

function cushionExtension(fontSizePx: number): Extension {
  return EditorView.cursorScrollMargin.of({ x: 0, y: cushionMarginPx(fontSizePx) });
}

/**
 * The reveal cushion in pixels, derived from the measured line height so it
 * stays in sync with the `cursorScrollMargin` facet above.
 */
function cushionPx(view: EditorView): number {
  const lineHeight = view.defaultLineHeight;
  return Math.round(CUSHION_LINES * (lineHeight > 0 ? lineHeight : LINE_HEIGHT_EM));
}

/**
 * True when the note's text (ignoring the overscroll padding) fills or
 * overflows the viewport. Only then does the caret have a bottom edge to
 * rest on; shorter notes stay top-aligned and must not be scrolled.
 */
function documentFillsViewport(view: EditorView): boolean {
  // scrollPastEnd sets its padding as an inline style on .cm-content; strip
  // it so the comparison measures the real text, not the overscroll region.
  const slackPad = parseFloat(view.contentDOM.style.paddingBottom) || 0;
  // Allow a couple of pixels of slack so a note that *exactly* fills the
  // window still counts as filling it.
  return view.scrollDOM.scrollHeight - slackPad >= view.scrollDOM.clientHeight - 2;
}

/**
 * Scroll the caret line so its bottom sits one cushion above the viewport
 * bottom (y: "end" aligns the caret to the bottom edge, yMargin adds the
 * cushion). A no-op when the caret is already resting there.
 */
function pinToCushion(view: EditorView): void {
  const head = view.state.selection.main.head;
  view.dispatch({
    effects: EditorView.scrollIntoView(head, { y: "end", yMargin: cushionPx(view) }),
  });
}

/**
 * PageDown / Shift+PageDown when the caret or selection head sits at the
 * end of the note. Consume the key so the browser's native paging can never
 * scroll into the deep region, and pin the caret to the cushion when the
 * note fills the window (a no-op while it is already resting there).
 */
function pageDownAtEnd(view: EditorView): boolean {
  if (documentFillsViewport(view)) pinToCushion(view);
  return true;
}

const pageGuard = keymap.of([
  {
    key: "PageDown",
    // Run the default page movement; when the caret ends up at the end of a
    // note that fills the window (the press couldn't complete a full page),
    // re-pin it to the cushion instead of leaving it at its old offset.
    run: (view) => {
      if (cursorPageDown(view)) {
        const head = view.state.selection.main.head;
        if (head >= view.state.doc.length && documentFillsViewport(view)) pinToCushion(view);
        return true;
      }
      return pageDownAtEnd(view);
    },
    shift: (view) => {
      if (selectPageDown(view)) {
        const head = view.state.selection.main.head;
        if (head >= view.state.doc.length && documentFillsViewport(view)) pinToCushion(view);
        return true;
      }
      return pageDownAtEnd(view);
    },
  },
]);

/**
 * Enable bottom overscroll: deep wheel/trackpad slack via `scrollPastEnd()`,
 * a caret reveal cushion sized for the current font size, and the PageDown
 * guard that keeps keyboard paging out of the deep region.
 */
export function scrollPastEndExtension(fontSizePx: number): Extension {
  return [
    scrollPastEnd(),
    cushionCompartment.of(cushionExtension(fontSizePx)),
    // High precedence so it shadows defaultKeymap's PageDown binding; it
    // re-runs the default behavior itself, so nothing is lost.
    Prec.high(pageGuard),
  ];
}

/**
 * Reconfigure the reveal cushion for a new font size. Call this alongside
 * the font-size reconfigure when the user changes the font, so the cushion
 * stays at a constant number of *lines* rather than a constant pixel count.
 */
export function reconfigureScrollCushion(fontSizePx: number): StateEffect<unknown> {
  return cushionCompartment.reconfigure(cushionExtension(fontSizePx));
}
