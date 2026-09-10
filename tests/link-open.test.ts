// Tests for http(s) link recognition (src/link-open.ts): which markdown
// spans count as openable links, and the exact span that hover/click act on.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { defaultHighlightStyle } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { tags } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { findLinkTarget, isOpenableUrl, withoutLinkUnderline } from "../src/link-open.ts";

function makeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] });
}

/** The target at `pos`, or null, as a plain comparable object. */
function targetAt(doc: string, pos: number) {
  const target = findLinkTarget(makeState(doc), pos);
  return target && { from: target.from, to: target.to, url: target.url };
}

/** Every offset in the document, mapped to its target. Useful to assert that
 *  a whole span is live or dead. */
function targetsAcross(doc: string) {
  const state = makeState(doc);
  return Array.from({ length: doc.length + 1 }, (_, pos) => {
    const target = findLinkTarget(state, pos);
    return target ? target.url : null;
  });
}

// ---- withoutLinkUnderline ------------------------------------------------

test("withoutLinkUnderline strips the link underline and nothing else", () => {
  const rewritten = withoutLinkUnderline(defaultHighlightStyle);
  // No spec is added or dropped: the matching one is rewritten in place.
  assert.equal(rewritten.specs.length, defaultHighlightStyle.specs.length);
  const link = rewritten.specs.find((spec) => spec.tag === tags.link);
  assert.ok(link);
  assert.equal(link.textDecoration, undefined);
  // Unrelated decorations survive.
  const strike = rewritten.specs.find((spec) => spec.tag === tags.strikethrough);
  assert.equal(strike?.textDecoration, "line-through");
});

test("withoutLinkUnderline keeps oneDark's link color", () => {
  const before = oneDarkHighlightStyle.specs.find((spec) => spec.tag === tags.link);
  const after = withoutLinkUnderline(oneDarkHighlightStyle).specs.find(
    (spec) => spec.tag === tags.link,
  );
  assert.ok(before && after);
  assert.equal(after.textDecoration, undefined);
  assert.equal(after.color, before.color);
});

// ---- isOpenableUrl -------------------------------------------------------

test("accepts only the two literal lowercase schemes", () => {
  assert.equal(isOpenableUrl("http://example.com"), true);
  assert.equal(isOpenableUrl("https://example.com"), true);
  assert.equal(isOpenableUrl("HTTP://example.com"), false);
  assert.equal(isOpenableUrl("HTTPS://example.com"), false);
  assert.equal(isOpenableUrl("Https://example.com"), false);
  assert.equal(isOpenableUrl(" www.example.com"), false);
  assert.equal(isOpenableUrl("www.example.com"), false);
  assert.equal(isOpenableUrl("mailto:a@b.com"), false);
  assert.equal(isOpenableUrl("#anchor"), false);
  assert.equal(isOpenableUrl("notes/other.md"), false);
  assert.equal(isOpenableUrl(""), false);
});

// ---- explicit links ------------------------------------------------------

test("the whole [t](url) span is live, and only that span", () => {
  const doc = "[t](https://example.com)";
  const whole = { from: 0, to: doc.length, url: "https://example.com" };
  for (const pos of [0, 1, 2, 5, doc.length - 1]) {
    assert.deepEqual(targetAt(doc, pos), whole, `offset ${pos}`);
  }
  // Half-open: the offset at the end of the link is outside it.
  assert.equal(targetAt(doc, doc.length), null);
});

test("http is accepted and the scheme check is case-sensitive", () => {
  assert.deepEqual(targetAt("[t](http://example.com)", 5)?.url, "http://example.com");
  assert.equal(targetAt("[t](HTTPS://example.com)", 5), null);
  assert.equal(targetAt("[t](HtTp://example.com)", 5), null);
  assert.equal(targetAt("[t](HTTP://example.com)", 0), null);
});

test("a link title stays out of the destination", () => {
  const doc = '[t](https://example.com "title")';
  assert.deepEqual(targetAt(doc, 0), {
    from: 0,
    to: doc.length,
    url: "https://example.com",
  });
});

test("non-http destinations are inert everywhere", () => {
  for (const doc of [
    "[t](mailto:a@b.com)",
    "[t](notes/other.md)",
    "[t](#anchor)",
    "[t]()",
    "[t](<https://example.com/a b>)",
    "[t](www.example.com)",
  ]) {
    assert.deepEqual(
      targetsAcross(doc).filter((url) => url !== null),
      [],
      `${doc} should have no live offsets`,
    );
  }
});

test("reference links have no destination of their own", () => {
  const doc = "[t][r]\n\n[r]: https://ref.example.com";
  // The label is dead...
  assert.equal(targetAt(doc, 0), null);
  assert.equal(targetAt(doc, 3), null);
  // ...but the definition's URL is a plain http(s) URL and stays live.
  const urlStart = doc.indexOf("https://");
  assert.deepEqual(targetAt(doc, urlStart), {
    from: urlStart,
    to: urlStart + "https://ref.example.com".length,
    url: "https://ref.example.com",
  });
});

// ---- autolinks -----------------------------------------------------------

test("a bare https URL is live over exactly its own text", () => {
  const doc = "see https://example.com here";
  assert.deepEqual(targetAt(doc, 4), { from: 4, to: 23, url: "https://example.com" });
  assert.deepEqual(targetAt(doc, 22), { from: 4, to: 23, url: "https://example.com" });
  assert.equal(targetAt(doc, 23), null);
  assert.equal(targetAt(doc, 3), null);
});

test("an angle-bracket autolink underlines the brackets too", () => {
  const doc = "<https://example.com>";
  assert.deepEqual(targetAt(doc, 0), { from: 0, to: 21, url: "https://example.com" });
  assert.deepEqual(targetAt(doc, 20), { from: 0, to: 21, url: "https://example.com" });
});

test("a bare www host is not a link", () => {
  assert.deepEqual(targetsAcross("see www.example.com here").filter(Boolean), []);
});

test("uppercase bare schemes are not autolinks at all", () => {
  assert.deepEqual(targetsAcross("HTTPS://EXAMPLE.COM").filter(Boolean), []);
});

test("trailing punctuation the parser trims stays outside the link", () => {
  const doc = "see https://example.com/a. ok";
  assert.deepEqual(targetAt(doc, 4), { from: 4, to: 25, url: "https://example.com/a" });
});

// ---- exclusions ----------------------------------------------------------

test("images are not links", () => {
  for (const doc of ["![alt](https://example.com/i.png)", "![alt](http://example.com)"]) {
    assert.deepEqual(
      targetsAcross(doc).filter((url) => url !== null),
      [],
      `${doc} should have no live offsets`,
    );
  }
});

test("links inside code are inert", () => {
  assert.deepEqual(targetsAcross("`[t](https://example.com)`").filter(Boolean), []);
  const fenced = "```\n[t](https://example.com)\n```";
  assert.deepEqual(targetsAcross(fenced).filter(Boolean), []);
});

// ---- neighbors and bounds ------------------------------------------------

test("adjacent links resolve independently", () => {
  const doc = "[a](https://one.example) [b](https://two.example)";
  const secondStart = doc.indexOf("[b]");
  assert.equal(targetAt(doc, 0)?.url, "https://one.example");
  assert.equal(targetAt(doc, secondStart)?.url, "https://two.example");
  assert.equal(targetAt(doc, secondStart - 1), null); // the separating space
});

test("positions outside the document are inert", () => {
  const doc = "[t](https://example.com)";
  assert.equal(targetAt(doc, -1), null);
  assert.equal(targetAt(doc, doc.length + 1), null);
});
