// Interactive task-list checkboxes.
//
// Renders GFM task markers (`- [ ]` / `- [x]`) as clickable checkbox widgets.
// Clicking toggles the source text between `[ ]` and `[x]` (always written
// lowercase; `[X]` is only recognized as checked when reading). Clicking never
// moves the cursor or disturbs an existing selection, and every toggle is its
// own undo step.
//
// The keyboard deliberately does not interact with the checkbox: it is a
// non-focusable span, so Space/Tab/Enter always type into the document. Task
// markers are located through the GFM syntax tree (TaskMarker nodes), which
// naturally excludes fenced code. Ordered-list tasks (`1. [ ]`) are skipped.
// Empty items written by the Enter continuation (`- [ ] ` with a trailing
// space) parse as TaskMarker and render like any other item.

import { EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

export interface TaskMarkerInfo {
  /** Start offset of the `[ ]` / `[x]` marker (also the start of the Task node). */
  readonly from: number;
  /** End offset of the marker (from + 3). */
  readonly to: number;
  /** End offset of the Task node (marker plus the first line's content). */
  readonly taskTo: number;
  readonly checked: boolean;
}

/**
 * Collect every GFM task marker in the document, skipping ordered-list tasks
 * (`1. [ ]`). Runs the parser to completion so the tree is never stale.
 */
export function collectTaskMarkers(state: EditorState): TaskMarkerInfo[] {
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  const markers: TaskMarkerInfo[] = [];
  if (!tree) return markers;
  tree.iterate({
    enter(node) {
      if (node.name !== "TaskMarker") return;
      // Only bullet-list tasks are interactive; ordered-list tasks are out of
      // scope. Walk up to the list ancestor to tell them apart.
      let cur: SyntaxNode | null = node.node.parent;
      while (cur) {
        if (cur.name === "OrderedList") return;
        if (cur.name === "BulletList") break;
        cur = cur.parent;
      }
      if (!cur) return;
      const text = doc.sliceString(node.from, node.to);
      markers.push({
        from: node.from,
        to: node.to,
        taskTo: node.node.parent!.to,
        checked: text.length === 3 && text[1] !== " ",
      });
    },
  });
  return markers;
}

/** The source-text change that toggles a marker, ready to dispatch. */
export function toggleChange(
  marker: { from: number; to: number; checked: boolean },
): { from: number; to: number; insert: string } {
  return { from: marker.from, to: marker.to, insert: marker.checked ? "[ ]" : "[x]" };
}

class TaskCheckboxWidget extends WidgetType {
  private readonly from: number;
  private readonly to: number;
  private readonly checked: boolean;

  constructor(from: number, to: number, checked: boolean) {
    super();
    this.from = from;
    this.to = to;
    this.checked = checked;
  }

  eq(other: TaskCheckboxWidget): boolean {
    return (
      other.from === this.from && other.to === this.to && other.checked === this.checked
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // A native checkbox: crisp rendering in every theme via `accent-color`,
    // with built-in accessibility semantics. Clicking toggles the source text.
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-task-checkbox";
    input.title = this.checked ? "Mark as not done" : "Mark as done";
    // preventDefault on mousedown keeps the input from taking focus, so the
    // checkbox never intercepts keyboard input (Tab/Space keep typing into the
    // document) and clicking it does not move the cursor.
    input.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("click", () => {
      view.dispatch({
        changes: toggleChange({ from: this.from, to: this.to, checked: this.checked }),
        userEvent: "task.toggle",
      });
      view.focus();
    });
    return input;
  }

  // The editor should ignore mousedown on the checkbox (no cursor move, no
  // selection start). Keyboard events never reach it because the input never
  // takes focus.
  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown";
  }
}

const taskDoneMark = Decoration.mark({ class: "cm-task-done" });

function computeDecorations(view: EditorView): DecorationSet {
  const markers = collectTaskMarkers(view.state);
  const decos: Range<Decoration>[] = [];
  for (const marker of markers) {
    decos.push(
      // Decoration.replace, not widget: it swaps the marker text for the
      // checkbox DOM instead of inserting alongside it.
      Decoration.replace({
        widget: new TaskCheckboxWidget(marker.from, marker.to, marker.checked),
      }).range(marker.from, marker.to),
    );
    if (marker.checked) {
      // Dim the whole task line's text (checkbox keeps its own color; the
      // marker span is hidden behind the widget anyway).
      decos.push(taskDoneMark.range(marker.from, marker.taskTo));
    }
  }
  return Decoration.set(decos);
}

const taskCheckboxPlugin = ViewPlugin.fromClass(
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

/** Extension that renders `- [ ]` / `- [x]` as interactive checkboxes. */
export function taskCheckboxExtension() {
  return taskCheckboxPlugin;
}
