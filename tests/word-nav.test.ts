// Golden-behavior tests for the hybrid Chinese-aware word navigation.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Text } from "@codemirror/state";
import { charCategory, deleteTargetByWord, moveByWord } from "../src/word-nav.ts";

const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

function doc(text: string) {
  return Text.of(text.split("\n"));
}

const right = (text: string, pos: number) => moveByWord(doc(text), pos, true, segmenter);
const left = (text: string, pos: number) => moveByWord(doc(text), pos, false, segmenter);
const delBack = (text: string, pos: number) => deleteTargetByWord(doc(text), pos, false, segmenter);
const delFwd = (text: string, pos: number) => deleteTargetByWord(doc(text), pos, true, segmenter);

test("charCategory mirrors CodeMirror's default categorizer", () => {
  assert.equal(charCategory("你"), "Word");
  assert.equal(charCategory("々"), "Other"); // ideographic iteration mark: not in CM's word ranges
  assert.equal(charCategory("a"), "Word");
  assert.equal(charCategory("3"), "Word");
  assert.equal(charCategory("_"), "Word");
  assert.equal(charCategory(","), "Other");
  assert.equal(charCategory("，"), "Other");
  assert.equal(charCategory(" "), "Space");
  assert.equal(charCategory("\n"), "Space");
  assert.equal(charCategory("😀"), "Other");
});

test("pure Chinese text moves word by word", () => {
  const t = "你好世界";
  assert.equal(right(t, 0), 2);
  assert.equal(right(t, 2), 4);
  assert.equal(right(t, 1), 2); // inside 你好 -> end of 你好
  assert.equal(right(t, 3), 4); // inside 世界 -> end of 世界
  assert.equal(left(t, 4), 2);
  assert.equal(left(t, 2), 0);
  assert.equal(left(t, 3), 2); // inside 世界 -> start of 世界
  assert.equal(left(t, 1), 0);
});

test("Chinese with spaces: spaces are skipped like CodeMirror does", () => {
  const t = "你好 世界";
  assert.equal(right(t, 0), 2);
  assert.equal(right(t, 2), 5); // space skipped, lands at end of 世界
  assert.equal(right(t, 3), 5);
  assert.equal(right(t, 4), 5);
  assert.equal(left(t, 5), 3);
  assert.equal(left(t, 4), 3);
  assert.equal(left(t, 3), 0); // space skipped, lands at start of 你好
  assert.equal(left(t, 2), 0);
});

test("mixed Chinese/Latin text", () => {
  const t = "今天weather很好";
  assert.equal(right(t, 0), 2);
  assert.equal(right(t, 2), 9);
  assert.equal(right(t, 9), 11);
  assert.equal(right(t, 3), 9); // inside weather -> end of weather
  assert.equal(left(t, 11), 9);
  assert.equal(left(t, 9), 2);
  assert.equal(left(t, 2), 0);
  assert.equal(left(t, 8), 2); // inside weather -> start of weather (boundary is CJK-flanked)
});

test("segments inside a mixed run", () => {
  const t = "中文ABC中文";
  assert.equal(right(t, 0), 2);
  assert.equal(right(t, 2), 5);
  assert.equal(right(t, 5), 7);
  assert.equal(left(t, 7), 5);
  assert.equal(left(t, 5), 2);
  assert.equal(left(t, 2), 0);
});

test("Latin text keeps CodeMirror's exact behavior", () => {
  const t = "foo bar";
  assert.equal(right(t, 0), 3);
  assert.equal(right(t, 4), 7); // space skipped, lands at end of bar
  assert.equal(right(t, 2), 3);
  assert.equal(left(t, 7), 4);
  assert.equal(left(t, 5), 4);
  assert.equal(left(t, 4), 0);
  assert.equal(right("hello_world", 0), 11); // identifiers stay one jump
});

test("punctuation inside words: don't / 3.14 behave like CodeMirror", () => {
  assert.equal(right("don't", 0), 3);
  assert.equal(right("don't", 3), 4);
  assert.equal(right("don't", 4), 5);
  assert.equal(left("don't", 5), 4);
  assert.equal(right("3.14", 0), 1);
  assert.equal(right("3.14", 1), 2);
  assert.equal(right("3.14", 2), 4);
});

test("Chinese with CJK punctuation", () => {
  const t = "你好，世界";
  assert.equal(right(t, 0), 2);
  assert.equal(right(t, 2), 3);
  assert.equal(right(t, 3), 5);
  assert.equal(left(t, 5), 3);
  assert.equal(left(t, 3), 2);
  assert.equal(left(t, 2), 0);
});

test("kana gets segmented too", () => {
  const t = "こんにちは世界";
  assert.equal(right(t, 0), 5);
  assert.equal(right(t, 5), 7);
  assert.equal(left(t, 7), 5);
  assert.equal(left(t, 5), 0);
});

test("movement crosses line breaks (newline is a space)", () => {
  assert.equal(right("foo\nbar", 3), 7);
  assert.equal(right("你好\n世界", 2), 5);
  assert.equal(left("bar\nfoo", 7), 4);
  assert.equal(left("bar\nfoo", 3), 0);
  // no movement at document edges
  assert.equal(right("foo", 3), 3);
  assert.equal(left("foo", 0), 0);
});

test("delete backward deletes one Chinese word", () => {
  assert.equal(delBack("你好世界", 4), 2);
  assert.equal(delBack("你好世界", 2), 0);
  assert.equal(delBack("中文ABC中文", 7), 5);
  assert.equal(delBack("今天weather很好", 11), 9);
  assert.equal(delBack("你好，世界", 5), 3);
});

test("delete backward keeps CodeMirror's space rules", () => {
  assert.equal(delBack("foo bar", 7), 4);
  assert.equal(delBack("foo bar", 3), 0);
  assert.equal(delBack("foo bar", 4), 0); // single space at cursor is deleted with the word
  assert.equal(delBack("foo  bar", 5), 3); // two spaces: both deleted, word left alone
  assert.equal(delBack("你好 世界", 3), 0); // space + preceding word
  assert.equal(delBack("don't", 5), 4);
  assert.equal(delBack("foo", 0), 0); // nothing at document start
});

test("delete backward at line edges matches CodeMirror", () => {
  assert.equal(delBack("foo\nbar", 4), 3); // cursor at line start: crosses exactly one character (the newline)
  assert.equal(delBack("你好\n世界", 3), 2); // same for Chinese
  assert.equal(delBack("你好\n世界", 2), 0); // cursor at line end: deletes the whole line word
});

test("delete forward deletes one Chinese word", () => {
  assert.equal(delFwd("你好世界", 0), 2);
  assert.equal(delFwd("你好世界", 2), 4);
  assert.equal(delFwd("你好 世界", 0), 2); // space after the word is kept
});

test("delete forward keeps CodeMirror's behavior for Latin text", () => {
  assert.equal(delFwd("foo bar", 0), 3);
  assert.equal(delFwd("foo bar", 4), 7); // deletes "bar", not the space before
});
