import { expect, test } from "vite-plus/test";
import { agreedBase, plan } from "../src/plan.ts";
import type { Listing } from "../src/store.ts";

/** A listing from path → content (the content stands for its hash). */
const list = (files: Record<string, string>): Listing =>
  Object.fromEntries(Object.entries(files).map(([p, h]) => [p, { size: h.length, mtime: 1, hash: h }]));

test("plan: the first sync only adds, and asks about files that differ", () => {
  const actions = plan(
    list({ "a.tex": "1", "same.bib": "s", "both.tex": "mine" }),
    list({ "b.tex": "2", "same.bib": "s", "both.tex": "theirs" }),
    {},
  );
  expect(actions).toEqual([
    { kind: "copy", path: "a.tex", from: "a", fresh: true },
    { kind: "copy", path: "b.tex", from: "b", fresh: true },
    { kind: "conflict", path: "both.tex" },
    { kind: "settle", path: "same.bib", hash: "s" },
  ]);
});

test("plan: a change on one side is copied to the other", () => {
  const base = { "ch1.tex": "v1", "ch2.tex": "v1" };
  const actions = plan(
    list({ "ch1.tex": "v2", "ch2.tex": "v1" }),
    list({ "ch1.tex": "v1", "ch2.tex": "v3" }),
    base,
  );
  expect(actions).toEqual([
    { kind: "copy", path: "ch1.tex", from: "a", fresh: false },
    { kind: "copy", path: "ch2.tex", from: "b", fresh: false },
  ]);
});

test("plan: a file deleted on one side and untouched on the other is deleted there", () => {
  const base = { "old.md": "x", "gone.md": "y" };
  expect(plan(list({ "gone.md": "y" }), list({ "old.md": "x" }), base)).toEqual([
    { kind: "delete", path: "gone.md", on: "a" },
    { kind: "delete", path: "old.md", on: "b" },
  ]);
});

test("plan: changed on both sides is a conflict, also when one side deleted it", () => {
  const base = { "ch.tex": "v1", "notes.md": "n1", "draft.md": "d1" };
  const actions = plan(
    list({ "ch.tex": "mine", "draft.md": "edited" }),
    list({ "ch.tex": "theirs", "notes.md": "edited" }),
    base,
  );
  expect(actions).toEqual([
    { kind: "conflict", path: "ch.tex" },
    { kind: "conflict", path: "draft.md", gone: "b" },
    { kind: "conflict", path: "notes.md", gone: "a" },
  ]);
});

test("plan: the same change made on both sides is no conflict, only a record to update", () => {
  const base = { "ch.tex": "v1", "bye.md": "x" };
  expect(plan(list({ "ch.tex": "v2" }), list({ "ch.tex": "v2" }), base)).toEqual([
    { kind: "settle", path: "bye.md", hash: null },
    { kind: "settle", path: "ch.tex", hash: "v2" },
  ]);
  expect(plan(list({ "ch.tex": "v2" }), list({ "ch.tex": "v2" }), { "ch.tex": "v2" })).toEqual([]);
});

test("plan: names that differ only by capitals are left alone, files and folders", () => {
  const actions = plan(
    list({ "Fig.pdf": "1", "fig.pdf": "2", "Img/a.png": "a", "ok.tex": "o" }),
    list({ "Fig.pdf": "1", "img/b.png": "b" }),
    {},
  );
  expect(actions).toEqual([
    { kind: "settle", path: "Fig.pdf", hash: "1" }, // the same on both sides: nothing to move
    { kind: "clash", path: "Img/a.png", with: ["img"] },
    { kind: "clash", path: "fig.pdf", with: ["Fig.pdf"] },
    { kind: "clash", path: "img/b.png", with: ["Img"] },
    { kind: "copy", path: "ok.tex", from: "a", fresh: true },
  ]);
});

test("plan: two computers' records agree only on what both remember alike", () => {
  expect(agreedBase({ a: "1", b: "2", c: "3" }, { a: "1", b: "other" })).toEqual({ a: "1" });
  expect(agreedBase({ a: "1" }, null)).toEqual({});
});
