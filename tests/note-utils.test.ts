// Unit tests for the pure multi-note helpers (src/note-utils.ts).
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_MD,
  freeUntitledName,
  isMarkdownName,
  planStartup,
  stripMarkdownExt,
  untitledName,
} from "../src/note-utils.ts";

// --- isMarkdownName ---

test("isMarkdownName accepts *.md names case-insensitively", () => {
  assert.equal(isMarkdownName("data.md"), true);
  assert.equal(isMarkdownName("note.MD"), true);
  assert.equal(isMarkdownName("a.md"), true);
  assert.equal(isMarkdownName("x.md.md"), true);
});

test("isMarkdownName rejects non-md, hidden, and extensionless names", () => {
  assert.equal(isMarkdownName(""), false);
  assert.equal(isMarkdownName("md"), false);
  assert.equal(isMarkdownName("data.txt"), false);
  assert.equal(isMarkdownName("data.md.tmp"), false);
  assert.equal(isMarkdownName(".hidden.md"), false);
  assert.equal(isMarkdownName(".md"), false);
  assert.equal(isMarkdownName("a/b.md"), true); // no path awareness: callers filter
});

// --- stripMarkdownExt ---

test("stripMarkdownExt drops only a trailing .md", () => {
  assert.equal(stripMarkdownExt("note.md"), "note");
  assert.equal(stripMarkdownExt("note.MD"), "note");
  assert.equal(stripMarkdownExt("a.md.md"), "a.md");
  assert.equal(stripMarkdownExt("noext"), "noext");
});

// --- untitled naming ---

test("untitled names start at Untitled.md then add counters", () => {
  assert.equal(untitledName(0), "Untitled.md");
  assert.equal(untitledName(1), "Untitled-1.md");
  assert.equal(untitledName(2), "Untitled-2.md");
});

test("freeUntitledName skips occupied names, including gaps", () => {
  assert.equal(freeUntitledName(new Set(["note.md"])), "Untitled.md");
  assert.equal(freeUntitledName(new Set(["Untitled.md"])), "Untitled-1.md");
  assert.equal(
    freeUntitledName(new Set(["Untitled.md", "Untitled-2.md"])),
    "Untitled-1.md",
  );
  assert.equal(
    freeUntitledName(new Set(["Untitled.md", "Untitled-1.md", "Untitled-3.md"])),
    "Untitled-2.md",
  );
});

// --- planStartup ---

test("no session + data.md present opens data.md (legacy fallback)", () => {
  assert.deepEqual(planStartup(null, null, [DATA_MD, "other.md"]), {
    kind: "open",
    names: [DATA_MD],
    active: 0,
  });
});

test("no session + empty folder creates data.md (first run)", () => {
  assert.deepEqual(planStartup(null, null, []), { kind: "create-data" });
});

test("no session + notes but no data.md starts empty", () => {
  assert.deepEqual(planStartup(null, null, ["a.md", "b.md"]), { kind: "empty" });
});

test("recorded empty session starts empty even when notes exist", () => {
  assert.deepEqual(planStartup([], null, ["a.md", "b.md"]), { kind: "empty" });
});

test("recorded session restores survivors in order", () => {
  assert.deepEqual(planStartup(["a.md", "b.md", "c.md"], "c.md", ["a.md", "c.md"]), {
    kind: "open",
    names: ["a.md", "c.md"],
    active: 1,
  });
});

test("vanished active file falls back to the first survivor", () => {
  assert.deepEqual(planStartup(["a.md", "b.md"], "a.md", ["b.md"]), {
    kind: "open",
    names: ["b.md"],
    active: 0,
  });
});

test("all session files vanished starts empty", () => {
  assert.deepEqual(planStartup(["a.md", "b.md"], "a.md", []), { kind: "empty" });
});
