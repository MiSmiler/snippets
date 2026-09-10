// Open http(s) links in the default browser with Ctrl/Cmd+Click.
//
// Scope: only destinations whose text literally starts with a lowercase
// `http://` or `https://` are recognized -- no case folding, no `www.`
// completion, no `<...>` unwrapping, no `mailto:`. Bare autolinks
// (`https://example.com`), autolinks in angle brackets (`<https://x>`) and
// explicit links (`[t](https://x)`) all qualify; anything else is left
// alone, including reference links (`[t][r]` carries no destination of its
// own) and images (`![alt](https://x)`, which is not a hyperlink).
//
// Visual affordance: markdown's stock highlight styles permanently underline
// every `Link`/`Image` node -- both the light default and oneDark do. The
// link extension draws that underline itself, as a hover-only decoration:
// hovering a recognized link underlines it, and while the platform modifier
// (Ctrl on Windows/Linux, Cmd on macOS) is held the cursor also turns into a
// pointer. Everything else stays ununderlined, so both theme variants
// register `withoutLinkUnderline(...)` instead of the stock style (see
// main.ts).
//
// Interaction: opening requires the modifier, so a plain click remains a
// plain click. The `mousedown` handler calls `preventDefault` and returns
// `true`, which stops CodeMirror's own mouse-selection handler before it
// runs, so opening a link never moves the caret or disturbs the selection.
// The destination is checked here in the frontend and again by the opener
// plugin's capability scope on the Rust side.

import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { ensureSyntaxTree, HighlightStyle } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";

/** A recognized link: the span that reacts to the pointer, and its URL. */
export interface LinkTarget {
  /** Start of the clickable/hoverable span (half-open). */
  readonly from: number;
  /** End of the span: a click at exactly this offset is outside the link. */
  readonly to: number;
  /** The literal destination text, known to start with `http(s)://`. */
  readonly url: string;
}

/** Injected collaborators: the module itself knows nothing about Tauri. */
export interface LinkOpenOptions {
  /** Whether the platform's "open link" modifier is held for this event. */
  readonly modOf: (event: MouseEvent | KeyboardEvent) => boolean;
  /** Hand a recognized URL to the system default application. */
  readonly open: (url: string) => Promise<void>;
  /** Called when `open` rejects; the URL is included for the message. */
  readonly onError: (url: string, error: unknown) => void;
}

/**
 * A copy of a highlight style with the markdown `Link`/`Image` underline
 * removed; every other spec is kept verbatim.
 *
 * Both theme variants need this: the stock light style and oneDark each
 * underline `tags.link`. The matching specs are copied with `textDecoration`
 * dropped rather than shadowed by an appended spec, because a tag maps to
 * exactly one class -- appending would also drop oneDark's link color.
 * Register the result *instead of* the original: a non-fallback highlighter
 * suppresses fallback ones entirely, so the two cannot be layered.
 */
export function withoutLinkUnderline(style: HighlightStyle): HighlightStyle {
  return HighlightStyle.define(
    style.specs.map((spec) => {
      if (!spec.textDecoration || !selectsLink(spec.tag)) return spec;
      const copy = { ...spec };
      delete copy.textDecoration;
      return copy;
    }),
  );
}

/** Whether a highlight spec's tag selector covers `tags.link` itself. */
function selectsLink(tag: unknown): boolean {
  const list: readonly Tag[] = Array.isArray(tag) ? tag : [tag as Tag];
  // A tag's `set` starts with the tag itself, so this catches `tags.link`
  // directly as well as any selector that lists it.
  return list.some((entry) => entry.set.includes(tags.link));
}

/** True for the destinations this feature is allowed to hand to the OS. */
export function isOpenableUrl(text: string): boolean {
  return text.startsWith("http://") || text.startsWith("https://");
}

/**
 * The recognized link at `pos`, or null. `pos` is a half-open offset: a
 * position at the link's end offset is outside it.
 */
export function findLinkTarget(state: EditorState, pos: number): LinkTarget | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree) return null;

  // Side 1 resolves a boundary position to the node starting there, which is
  // the node under a click's own offset.
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL") {
      const url = state.doc.sliceString(node.from, node.to);
      if (!isOpenableUrl(url)) return null;
      const container = enclosingLink(node);
      // An image's destination is not a hyperlink.
      if (container?.name === "Image") return null;
      // Underline the link as written; for a bare autolink or a reference
      // definition there is no enclosing link, so the URL is the span.
      const span = container && container.name !== "LinkReference" ? container : node;
      return { from: span.from, to: span.to, url };
    }
    if (node.name === "Link" || node.name === "Autolink") {
      // The click landed on a label or bracket rather than the destination.
      const urlNode = node.getChild("URL");
      if (!urlNode) return null; // Reference links carry no destination.
      const url = state.doc.sliceString(urlNode.from, urlNode.to);
      return isOpenableUrl(url) ? { from: node.from, to: node.to, url } : null;
    }
    if (node.name === "Image" || node.name === "LinkReference") return null;
    node = node.parent;
  }
  return null;
}

/** Nearest Link/Autolink/Image/LinkReference ancestor of a URL node. */
function enclosingLink(urlNode: SyntaxNode): SyntaxNode | null {
  let node = urlNode.parent;
  while (node) {
    if (
      node.name === "Link" ||
      node.name === "Autolink" ||
      node.name === "Image" ||
      node.name === "LinkReference"
    ) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/** The link currently under the pointer, with the modifier's state. */
interface LinkHover {
  readonly from: number;
  readonly to: number;
  readonly modifier: boolean;
}

const setLinkHover = StateEffect.define<LinkHover | null>();

const linkHoverField = StateField.define<LinkHover | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLinkHover)) return effect.value;
    }
    // A document change can invalidate the stored offsets; the next pointer
    // event re-establishes them.
    return tr.docChanged ? null : value;
  },
});

const linkHoverDecorations = EditorView.decorations.compute([linkHoverField], (state) => {
  const hover = state.field(linkHoverField, false);
  if (!hover || hover.to > state.doc.length) return Decoration.none;
  const decoration = Decoration.mark({
    class: hover.modifier ? "cm-link-hover cm-link-mod" : "cm-link-hover",
  });
  return Decoration.set([decoration.range(hover.from, hover.to)]);
});

/** Extension that adds Ctrl/Cmd+Click link opening to the editor. */
export function linkOpenExtension(options: LinkOpenOptions): Extension {
  // Last pointer position, so a scroll or a modifier press can re-resolve the
  // hover without waiting for the mouse to move.
  let pointer: { x: number; y: number } | null = null;

  function applyHover(view: EditorView, target: LinkTarget | null, modifier: boolean): void {
    const current = view.state.field(linkHoverField, false);
    const next = target ? { from: target.from, to: target.to, modifier } : null;
    if (!current && !next) return;
    if (
      current &&
      next &&
      current.from === next.from &&
      current.to === next.to &&
      current.modifier === next.modifier
    ) {
      return;
    }
    view.dispatch({ effects: setLinkHover.of(next) });
  }

  function hoverAt(view: EditorView, event: MouseEvent | null): void {
    if (!pointer) return;
    const pos = view.posAtCoords(pointer);
    const modifier = event
      ? options.modOf(event)
      : (view.state.field(linkHoverField, false)?.modifier ?? false);
    applyHover(view, pos === null ? null : findLinkTarget(view.state, pos), modifier);
  }

  // The modifier can be pressed or released while the pointer already rests
  // on a link, so its state is tracked on the window rather than relying on
  // the next mousemove.
  const modifierTracker = ViewPlugin.fromClass(
    class {
      private readonly onKey: (event: KeyboardEvent) => void;
      private win: Window | null = null;

      constructor(view: EditorView) {
        this.onKey = (event) => {
          const hover = view.state.field(linkHoverField, false);
          if (!hover) return;
          const modifier = options.modOf(event);
          if (modifier === hover.modifier) return;
          view.dispatch({ effects: setLinkHover.of({ ...hover, modifier }) });
        };
        // `EditorView` has no window accessor; the document's view is it.
        const win = view.dom.ownerDocument.defaultView;
        if (!win) return;
        this.win = win;
        win.addEventListener("keydown", this.onKey);
        win.addEventListener("keyup", this.onKey);
      }

      destroy(): void {
        this.win?.removeEventListener("keydown", this.onKey);
        this.win?.removeEventListener("keyup", this.onKey);
      }
    },
  );

  const handlers = EditorView.domEventHandlers({
    mousemove(event, view) {
      // A held button means a drag-selection: the underline is a hover hint,
      // not a selection hint, so leave it to mousedown/mouseup to re-arm.
      if (event.buttons !== 0) return;
      pointer = { x: event.clientX, y: event.clientY };
      hoverAt(view, event);
    },
    mouseleave(_event, view) {
      pointer = null;
      applyHover(view, null, false);
    },
    // Scrolling moves the links under a stationary pointer.
    scroll(_event, view) {
      hoverAt(view, null);
    },
    mousedown(event, view) {
      let target: LinkTarget | null = null;
      if (event.button === 0 && options.modOf(event)) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        target = pos === null ? null : findLinkTarget(view.state, pos);
      }
      if (!target) {
        // A plain press drops the hint; the drag that may follow must not
        // leave a link looking hovered.
        applyHover(view, null, false);
        return false;
      }
      // Returning true (and preventing the default) keeps CodeMirror's mouse
      // selection from starting: no caret move, no selection change.
      event.preventDefault();
      options.open(target.url).catch((error) => options.onError(target.url, error));
      return true;
    },
  });

  return [linkHoverField, linkHoverDecorations, modifierTracker, handlers];
}
