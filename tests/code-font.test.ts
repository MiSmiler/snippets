// Tests for markdown code-range detection (src/code-font.ts), which decides
// which regions get the --font-code stack. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { collectCodeRanges } from "../src/code-font.ts";

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
}

function collect(doc: string) {
  return collectCodeRanges(makeState(doc)).map((r) => ({
    from: r.from,
    to: r.to,
    block: r.block,
  }));
}

test("plain prose has no code ranges", () => {
  assert.deepEqual(collect("hello world\n\n- [ ] a task\n# heading\n"), []);
});

test("detects inline code (marks included)", () => {
  assert.deepEqual(collect("run `npm install` now"), [
    { from: 4, to: 17, block: false },
  ]);
});

test("detects inline code inside other markup", () => {
  assert.deepEqual(collect("- [x] see `docs`"), [
    { from: 10, to: 16, block: false },
  ]);
});

test("detects fenced code blocks as whole-line ranges", () => {
  const doc = "```\n- [ ] not a task\n```";
  assert.deepEqual(collect(doc), [{ from: 0, to: doc.length, block: true }]);
});

test("detects fenced code with info string and tildes", () => {
  const doc = "~~~js\nconst x = 1\n~~~";
  assert.deepEqual(collect(doc), [{ from: 0, to: doc.length, block: true }]);
});

test("detects indented code blocks", () => {
  // The CodeBlock node spans the code text (indent spaces are outside it);
  // rendering still decorates the whole line via doc.lineAt().
  assert.deepEqual(collect("para\n\n    indented\n"), [
    { from: 10, to: 18, block: true },
  ]);
});

test("code ranges ignore nested markup inside code", () => {
  // Everything inside the fence is one block range -- no separate inline
  // ranges, even though the content looks like backticked text.
  const doc = "```\n`fake inline`\n```";
  assert.deepEqual(collect(doc), [{ from: 0, to: doc.length, block: true }]);
});

test("empty document has no ranges", () => {
  assert.deepEqual(collect(""), []);
});
