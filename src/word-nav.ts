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
  type Extension,
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
// (incl. extension A and B), kana, and Hangul. Astral-plane code points
// (extension B and beyond) need the \u{...} form: \u20000 would parse as
// \u2000 followed by a literal "0", turning the class into the range
// U+0030-U+2FA1 and making every ASCII letter or digit "CJK".
const CJK_RE =
  /[\u2E80-\u2EFF\u3040-\u30FF\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/u;

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

// ---- Double-click word selection ----

// True for a grapheme cluster that can be part of a Latin identifier: a
// CodeMirror Word cluster (letter, digit, "_", or a non-ASCII case-pair
// letter) that is not CJK, or the separator "-" between two such clusters.
function isIdentifierCluster(cluster: string): boolean {
  return cluster == "-" || (charCategory(cluster) == "Word" && !hasCJK(cluster));
}

// The identifier around `probe`: a maximal run of identifier clusters with
// leading/trailing "-" trimmed off ("foo-" yields "foo", "---" yields
// nothing). Null when `probe` itself sits on a trimmed separator, or when
// only separators are left.
function identifierAt(lineText: string, probe: number): { from: number; to: number } | null {
  const isIdent = (from: number, to: number) => isIdentifierCluster(lineText.slice(from, to));
  let end = findClusterBreak(lineText, probe, true);
  if (!isIdent(probe, end)) return null;
  let start = probe;
  while (start > 0) {
    const prev = findClusterBreak(lineText, start, false);
    if (!isIdent(prev, start)) break;
    start = prev;
  }
  while (end < lineText.length) {
    const next = findClusterBreak(lineText, end, true);
    if (!isIdent(end, next)) break;
    end = next;
  }
  while (start < end && lineText[start] == "-") start++;
  while (end > start && lineText[end - 1] == "-") end--;
  if (start >= end || probe < start || probe >= end) return null;
  return { from: start, to: end };
}

// Selection range for a double click at `pos`, in three steps:
//
//   1. An identifier at the click: "foo_bar", "foo-bar", "café-bar" and
//      "2024-01-01" come out whole. CodeMirror's charCategorizer splits at
//      "-", and jieba splits at "_"; technical notes are full of both.
//   2. Otherwise CodeMirror's own groupAt() run around the clicked cluster
//      (punctuation, spaces, emoji), which is also the fallback below.
//   3. Inside a Word run, the segmentation engine's word at the click. That
//      is what makes double clicking a word inside 中文 select that word
//      instead of the whole CJK run; a position the engine has no word for
//      keeps the run, which is also what an unavailable engine
//      (createNoopProvider) produces.
//
// groupAt() is reproduced here because @codemirror/view does not export it;
// keep this in sync with its groupAt() (dist/index.js).
export function wordRangeAt(
  doc: Text,
  pos: number,
  bias: number,
  provider: SegmentProvider,
): { from: number; to: number } {
  const line = doc.lineAt(pos);
  const linePos = pos - line.from;
  if (line.length == 0) return { from: pos, to: pos };
  // CodeMirror biases away from the line edges.
  if (linePos == 0) bias = 1;
  else if (linePos == line.length) bias = -1;

  // The cluster the click picked: left of the cursor when bias < 0.
  let from = linePos;
  let to = linePos;
  if (bias < 0) from = findClusterBreak(line.text, linePos, false);
  else to = findClusterBreak(line.text, linePos, true);
  const probe = from; // start of that cluster, before any run is expanded

  const ident = identifierAt(line.text, probe);
  if (ident) return { from: line.from + ident.from, to: line.from + ident.to };

  const cat = charCategory(line.text.slice(from, to));
  while (from > 0) {
    const prev = findClusterBreak(line.text, from, false);
    if (charCategory(line.text.slice(prev, from)) != cat) break;
    from = prev;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to, true);
    if (charCategory(line.text.slice(to, next)) != cat) break;
    to = next;
  }

  if (cat == "Word") {
    const seg = segmentAt(provider.segment(line.text), probe);
    if (seg) return { from: line.from + seg.start, to: line.from + seg.end };
  }
  return { from: line.from + from, to: line.from + to };
}

// Mouse selection style that makes a double click select a segmented word
// (see wordRangeAt). Only double clicks are taken over: plain clicks, triple
// clicks, Shift+click and start-of-drag selections return null here and keep
// CodeMirror's basicMouseSelection untouched. Dragging after the double
// click still runs through the style below, so the two ends of the drag are
// merged word-wise (same shape as basicMouseSelection, which is not
// exported either).
export function wordSelectionStyle(getProvider: () => SegmentProvider): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button != 0 || event.detail != 2) return null;
    // The click that started this gesture, in document coordinates.
    const start = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
    let startSel = view.state.selection;
    const rangeAt = (pos: number, assoc: number) => {
      const range = wordRangeAt(view.state.doc, pos, assoc, getProvider());
      return EditorSelection.undirectionalRange(range.from, range.to);
    };
    return {
      update(update) {
        // Keep the anchor meaningful if the document changes mid-drag, like
        // basicMouseSelection does.
        if (update.docChanged) {
          start.pos = update.changes.mapPos(start.pos);
          startSel = startSel.map(update.changes);
        }
        return false;
      },
      get(curEvent, extend, multiple) {
        const cur = view.posAndSideAtCoords({ x: curEvent.clientX, y: curEvent.clientY }, false);
        // The pointer moved away from where the gesture started: span from
        // the word under the start point to the word under the pointer.
        let range = rangeAt(cur.pos, cur.assoc);
        if (start.pos != cur.pos && !extend) {
          const startRange = rangeAt(start.pos, start.assoc);
          const from = Math.min(startRange.from, range.from);
          const to = Math.max(startRange.to, range.to);
          // Copied verbatim from basicMouseSelection: its third argument
          // lands in goalColumn, which is irrelevant for a horizontal drag.
          range =
            from < range.from
              ? EditorSelection.range(from, to, range.assoc)
              : EditorSelection.range(to, from, range.assoc);
        }
        if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to, range.assoc));
        // allowMultipleSelections is not enabled in this app, so the
        // `multiple` branch of basicMouseSelection is unreachable.
        void multiple;
        return EditorSelection.create([range]);
      },
    };
  });
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
