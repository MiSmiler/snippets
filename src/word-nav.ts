// Chinese-aware word navigation for CodeMirror.
//
// CodeMirror's default group movement (Ctrl+ArrowLeft/Right, the Shift
// selection variants, Ctrl+Backspace, Ctrl+Delete) buckets every CJK
// character into a single "Word" run, so one press skips over a whole
// stretch of Chinese text instead of stopping between words.
//
// These commands keep CodeMirror's exact walking semantics (run categories,
// space skipping, line crossing on move, single-space rule and line-local
// walk on delete) but additionally stop at Intl.Segmenter word boundaries
// when either adjacent segment contains CJK ideographs, kana or Hangul.
// Pure Latin/number/punctuation text behaves exactly as before.
//
// Known deviation: movement is logical (LTR) rather than visual, so bidi
// text (Arabic/Hebrew) may move differently from CodeMirror's defaults.
// The app has no atomic ranges, so skipAtomic is omitted from the delete
// command.

import {
  EditorSelection,
  findClusterBreak,
  type EditorState,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import {
  cursorGroupLeft,
  cursorGroupRight,
  deleteGroupBackward,
  deleteGroupForward,
  selectGroupLeft,
  selectGroupRight,
} from "@codemirror/commands";
import { EditorView, type Command } from "@codemirror/view";

// Mirrors CodeMirror's default char categorizer (makeCategorizer with no
// "wordChars" language data), which is what state.charCategorizer() returns
// for this app. Categories are assigned to whole grapheme clusters.
const NON_ASCII_SINGLE_CASE_WORD_CHAR =
  /[\u00df\u0587\u0590-\u05f4\u0600-\u06ff\u3040-\u309f\u30a0-\u30ff\u3400-\u4db5\u4e00-\u9fcc\uac00-\ud7af]/;

export type Category = "Word" | "Space" | "Other";

export function charCategory(cluster: string): Category {
  if (!/\S/.test(cluster)) return "Space";
  for (let i = 0; i < cluster.length; i++) {
    const ch = cluster[i];
    if (
      /\w/.test(ch) ||
      (ch > "\x80" && (ch.toUpperCase() != ch.toLowerCase() || NON_ASCII_SINGLE_CASE_WORD_CHAR.test(ch)))
    ) {
      return "Word";
    }
  }
  return "Other";
}

// Character classes that get Intl.Segmenter word boundaries: CJK ideographs
// (incl. extension A and B), kana, and Hangul. The u flag is required for
// the astral-plane escape \u20000-\u2FA1F to be parsed as a range.
const CJK_RE =
  /[\u2E80-\u2EFF\u3040-\u30FF\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\uAC00-\uD7AF\u20000-\u2FA1F]/u;

export interface WordSegment {
  start: number;
  end: number;
  hasCJK: boolean;
}

// Word-like segments of a line, with a flag for whether the segment contains
// CJK/kana/Hangul characters (only such segments create segmentation stops).
export interface WordSegment {
  start: number;
  end: number;
  hasCJK: boolean;
}

// A source of word-like segments for one editor line. The walk logic below
// only depends on this seam, so engines are interchangeable (Intl.Segmenter
// in-process, jieba over IPC) and switching engines in settings takes effect
// on the next keystroke in every open tab.
export interface SegmentProvider {
  segment(lineText: string): WordSegment[];
}

function hasCJK(text: string): boolean {
  return CJK_RE.test(text);
}

// Word-like segments of a line from an Intl.Segmenter.
export function segmentLine(segmenter: Intl.Segmenter, lineText: string): WordSegment[] {
  const out: WordSegment[] = [];
  for (const s of segmenter.segment(lineText)) {
    if (s.isWordLike) {
      out.push({ start: s.index, end: s.index + s.segment.length, hasCJK: hasCJK(s.segment) });
    }
  }
  return out;
}

// The "system" engine: the WebView's built-in Intl.Segmenter (pre-existing
// behavior). Requires Intl.Segmenter support in the runtime.
export function createSystemProvider(): SegmentProvider {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return { segment: (lineText) => segmentLine(segmenter, lineText) };
}

// No word stops at all: a CJK run behaves like CodeMirror's native whole-run
// jump. Used as a last-resort fallback when no engine is available.
export function createNoopProvider(): SegmentProvider {
  return { segment: () => [] };
}

// One word-like span of a line, as UTF-16 offsets (matches WordSegment minus
// the derived hasCJK flag).
export interface SegRange {
  start: number;
  end: number;
}

// The jieba engine over IPC, with a per-line-text cache. `request` must
// resolve to UTF-16 spans for the line, or null/reject while the engine is
// warming up or unavailable. Cache misses are served by `fallback` (usually
// the system provider) while the request is in flight, so a keystroke right
// after an edit never blocks: it behaves like the old engine once, then the
// cache takes over. The line text is the key, so edits invalidate entries
// automatically; entries accumulate only for lines the cursor actually
// walked (a few thousand rows at most per long session).
export function createJiebaProvider(
  mode: "standard" | "fine",
  fallback: SegmentProvider,
  request: (lineText: string, mode: "standard" | "fine") => Promise<SegRange[] | null>,
): SegmentProvider {
  const cache = new Map<string, WordSegment[]>();
  const pending = new Set<string>();
  return {
    segment(lineText) {
      const cached = cache.get(lineText);
      if (cached) return cached;
      if (!pending.has(lineText)) {
        pending.add(lineText);
        // Both callbacks run directly on the request promise (before any
        // awaiter of that same promise resumes), so the pending marker is
        // cleared in time for the next keystroke to issue a fresh request.
        void request(lineText, mode).then(
          (ranges) => {
            if (ranges) {
              cache.set(
                lineText,
                ranges.map((r) => ({
                  start: r.start,
                  end: r.end,
                  hasCJK: hasCJK(lineText.slice(r.start, r.end)),
                })),
              );
            }
            pending.delete(lineText);
          },
          () => {
            // Engine unavailable: keep serving the fallback, allow a retry.
            pending.delete(lineText);
          },
        );
      }
      return fallback.segment(lineText);
    },
  };
}

function segmentAt(segments: WordSegment[], pos: number): WordSegment | null {
  for (const s of segments) {
    if (pos >= s.start && pos < s.end) return s;
  }
  return null;
}

function isWordStart(segments: WordSegment[], pos: number): boolean {
  for (const s of segments) {
    if (s.start == pos) return true;
  }
  return false;
}

// True when `pos` is a segmenter word boundary (start of a word-like
// segment) and either adjacent segment contains CJK/kana/Hangul.
function boundaryHasCJK(segments: WordSegment[], pos: number): boolean {
  const left = segmentAt(segments, pos - 1);
  const right = segmentAt(segments, pos);
  return (left != null && left.hasCJK) || (right != null && right.hasCJK);
}

// Move the cursor one word/group in the given direction, honoring
// Intl.Segmenter word boundaries inside CJK Word runs. Replicates
// EditorView.moveByChar with the cursorGroup "byGroup" predicate:
//   - land at the end of the current/next run moving right, at the start of
//     the run moving left (space runs are skipped);
//   - line breaks are space characters, so one press can cross a line;
//   - at a segmenter word boundary flanked by a CJK segment, stop: moving
//     right that is the end of the current word, moving left the start.
export function moveByWord(doc: Text, pos: number, forward: boolean, provider: SegmentProvider): number {
  let line = doc.lineAt(pos);
  let cat: Category | null = null;
  let segments: WordSegment[] = [];
  let cur = pos;
  let first = true;

  for (;;) {
    const off = cur - line.from;
    let next: number;
    let char: string;
    if (forward) {
      if (off == line.length) {
        if (line.number == doc.lines) return cur;
        char = "\n";
        line = doc.line(line.number + 1);
        next = line.from;
      } else {
        next = findClusterBreak(line.text, off, true) + line.from;
        char = line.text.slice(off, next - line.from);
      }
    } else {
      if (off == 0) {
        if (line.number == 1) return cur;
        char = "\n";
        line = doc.line(line.number - 1);
        next = line.to;
      } else {
        next = findClusterBreak(line.text, off, false) + line.from;
        char = line.text.slice(next - line.from, off);
      }
    }

    if (!first) {
      if (cat == "Space") {
        // space runs are skipped (category adoption below)
      } else if (charCategory(char) != cat) {
        return cur;
      } else if (cat == "Word" && forward && isWordStart(segments, off) && boundaryHasCJK(segments, off)) {
        return cur;
      }
    }

    if (cat == null || cat == "Space") {
      cat = charCategory(char);
      if (cat == "Word") {
        segments = provider.segment(line.text);
      }
    }

    cur = next;
    first = false;

    if (
      !first &&
      cat == "Word" &&
      !forward &&
      isWordStart(segments, cur - line.from) &&
      boundaryHasCJK(segments, cur - line.from)
    ) {
      return cur;
    }
  }
}

// Deletion target for Ctrl+Backspace / Ctrl+Delete. Replicates CodeMirror's
// deleteByGroup walk (line-local, single space at the cursor is skipped
// without adopting its category, at a line edge exactly one character
// crosses into the adjacent line) plus segmenter word boundaries inside CJK
// Word runs. Returns an absolute document position.
export function deleteTargetByWord(doc: Text, pos: number, forward: boolean, provider: SegmentProvider): number {
  const line = doc.lineAt(pos);
  const lineText = line.text;
  const head = pos - line.from;
  let p = head;
  let cat: Category | null = null;
  let segments: WordSegment[] = [];
  let segInfoSet = false;

  for (;;) {
    if (p == (forward ? line.length : 0)) {
      if (p == head && (forward ? line.number != doc.lines : line.number != 1)) {
        return line.from + p + (forward ? 1 : -1);
      }
      break;
    }
    const next = findClusterBreak(lineText, p, forward);
    const nextChar = lineText.slice(Math.min(p, next), Math.max(p, next));
    const nextCat = charCategory(nextChar);
    if (cat != null && nextCat != cat) break;
    if (
      cat == "Word" &&
      isWordStart(segments, forward ? p : next) &&
      boundaryHasCJK(segments, forward ? p : next)
    ) {
      return line.from + (forward ? p : next);
    }
    if (nextChar != " " || p != head) {
      cat = nextCat;
      if (cat == "Word" && !segInfoSet) {
        segInfoSet = true;
        segments = provider.segment(lineText);
      }
    }
    p = next;
  }
  return line.from + p;
}

// ---- CodeMirror command wrappers (ports of moveSel / extendSel / deleteBy) ----

function updateSel(sel: EditorSelection, by: (range: SelectionRange) => SelectionRange): EditorSelection {
  return EditorSelection.create(sel.ranges.map(by), sel.mainIndex);
}

function setSel(state: EditorState, selection: EditorSelection) {
  return state.update({ selection, scrollIntoView: true, userEvent: "select" });
}

function moveSel(view: EditorView, how: (range: SelectionRange) => SelectionRange): boolean {
  const selection = updateSel(view.state.selection, how);
  if (selection.eq(view.state.selection, true)) return false;
  view.dispatch(setSel(view.state, selection));
  return true;
}

function extendSel(target: EditorView, forward: boolean, how: (range: SelectionRange) => SelectionRange): boolean {
  const selection = updateSel(target.state.selection, (range) => {
    if (range.undirectional && (range.head >= range.anchor) != forward) {
      range = EditorSelection.range(range.head, range.anchor);
    }
    const head = how(range);
    return EditorSelection.range(range.anchor, head.head);
  });
  if (selection.eq(target.state.selection)) return false;
  target.dispatch(setSel(target.state, selection));
  return true;
}

function cursorByWord(view: EditorView, forward: boolean, provider: SegmentProvider): boolean {
  const doc = view.state.doc;
  return moveSel(view, (range) =>
    range.empty
      ? EditorSelection.cursor(moveByWord(doc, range.head, forward, provider))
      : EditorSelection.cursor(forward ? range.to : range.from),
  );
}

function selectByWord(view: EditorView, forward: boolean, provider: SegmentProvider): boolean {
  const doc = view.state.doc;
  return extendSel(view, forward, (range) => EditorSelection.cursor(moveByWord(doc, range.head, forward, provider)));
}

function deleteByWord(view: EditorView, forward: boolean, provider: SegmentProvider): boolean {
  if (view.state.readOnly) return false;
  let event = "delete.selection";
  const { state } = view;
  const changes = state.changeByRange((range) => {
    let { from, to } = range;
    if (from == to) {
      const towards = deleteTargetByWord(state.doc, from, forward, provider);
      if (towards < from) {
        event = "delete.backward";
      } else if (towards > from) {
        event = "delete.forward";
      }
      from = Math.min(from, towards);
      to = Math.max(to, towards);
    }
    return from == to ? { range } : { changes: { from, to }, range: EditorSelection.cursor(from, from < range.head ? -1 : 1) };
  });
  if (changes.changes.empty) return false;
  view.dispatch(
    state.update(changes, {
      scrollIntoView: true,
      userEvent: event,
      effects: event == "delete.selection" ? EditorView.announce.of(state.phrase("Selection deleted")) : undefined,
    }),
  );
  return true;
}

export interface WordNavCommands {
  cursorLeft: Command;
  cursorRight: Command;
  selectLeft: Command;
  selectRight: Command;
  deleteBackward: Command;
  deleteForward: Command;
}

// Returns the hybrid commands, or CodeMirror's originals when Intl.Segmenter
// is unavailable (ancient WebView2 runtimes). `getProvider` is consulted on
// every keystroke so changing the engine in settings takes effect on the next
// keypress, in every open tab.
export function wordNavCommands(getProvider: () => SegmentProvider): WordNavCommands {
  if (typeof Intl.Segmenter != "function") {
    return {
      cursorLeft: cursorGroupLeft,
      cursorRight: cursorGroupRight,
      selectLeft: selectGroupLeft,
      selectRight: selectGroupRight,
      deleteBackward: deleteGroupBackward,
      deleteForward: deleteGroupForward,
    };
  }
  return {
    cursorLeft: (view) => cursorByWord(view, false, getProvider()),
    cursorRight: (view) => cursorByWord(view, true, getProvider()),
    selectLeft: (view) => selectByWord(view, false, getProvider()),
    selectRight: (view) => selectByWord(view, true, getProvider()),
    deleteBackward: (view) => deleteByWord(view, false, getProvider()),
    deleteForward: (view) => deleteByWord(view, true, getProvider()),
  };
}
