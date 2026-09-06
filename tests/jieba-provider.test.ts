// Unit tests for the jieba IPC segment provider: fallback while the request
// is in flight, caching after it resolves, null responses not being cached,
// and in-flight requests being deduplicated.
// Run with: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJiebaProvider,
  createSystemProvider,
  type SegRange,
} from "../src/word-nav.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

/** A fake IPC boundary that records calls and lets tests settle them. */
function fakeRequest() {
  const calls: Array<{ lineText: string; mode: "standard" | "fine" }> = [];
  const pending: Array<{
    promise: Promise<SegRange[] | null>;
    resolve: (v: SegRange[] | null) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  const request = (lineText: string, mode: "standard" | "fine"): Promise<SegRange[] | null> => {
    calls.push({ lineText, mode });
    const d = deferred<SegRange[] | null>();
    pending.push(d);
    return d.promise;
  };
  return { calls, pending, request };
}

const system = createSystemProvider();

const LINE = "研究生命科学";
const JIEBA_SEGS: SegRange[] = [
  { start: 0, end: 2 },
  { start: 2, end: 6 },
];

test("miss serves fallback and dedups in-flight requests", async () => {
  const { calls, pending, request } = fakeRequest();
  const provider = createJiebaProvider("standard", system, request);

  const first = provider.segment(LINE);
  assert.deepEqual(first, system.segment(LINE)); // fallback while in flight
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "standard");

  // Repeated keystrokes while the request is in flight: no second request.
  assert.deepEqual(provider.segment(LINE), first);
  assert.equal(calls.length, 1);

  pending[0].resolve(JIEBA_SEGS);
  await pending[0].promise;

  // Once the response lands, the cache serves jieba segments directly.
  assert.equal(calls.length, 1);
  assert.deepEqual(
    provider.segment(LINE).map((s) => [s.start, s.end]),
    [
      [0, 2],
      [2, 6],
    ],
  );
});

test("resolved segments are cached and used afterwards", async () => {
  const { pending, request } = fakeRequest();
  const provider = createJiebaProvider("standard", system, request);

  provider.segment(LINE);
  pending[0].resolve(JIEBA_SEGS);
  await pending[0].promise;

  const segs = provider.segment(LINE);
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map((s) => [s.start, s.end]),
    [
      [0, 2],
      [2, 6],
    ],
  );
  // hasCJK is derived from each segment's text (here: pure Chinese).
  assert.ok(segs.every((s) => s.hasCJK));
});

test("null response (engine warming up) is not cached, next miss retries", async () => {
  const { calls, pending, request } = fakeRequest();
  const provider = createJiebaProvider("fine", system, request);

  provider.segment(LINE);
  assert.equal(calls[0].mode, "fine"); // mode is forwarded to the backend
  pending[0].resolve(null); // not ready yet
  await pending[0].promise;

  provider.segment(LINE);
  assert.equal(calls.length, 2); // retried, since nothing was cached

  pending[1].resolve(JIEBA_SEGS);
  await pending[1].promise;
  assert.deepEqual(provider.segment(LINE).map((s) => [s.start, s.end]), [
    [0, 2],
    [2, 6],
  ]);
});

test("rejected request keeps fallback and allows a later retry", async () => {
  const { calls, pending, request } = fakeRequest();
  const provider = createJiebaProvider("standard", system, request);

  provider.segment(LINE);
  assert.equal(calls.length, 1);
  pending[0].reject(new Error("ipc down"));
  await pending[0].promise.catch(() => undefined);

  // Fallback was served; nothing cached, so the next miss retries.
  assert.deepEqual(provider.segment(LINE), system.segment(LINE));
  assert.equal(calls.length, 2);
});
