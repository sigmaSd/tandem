import { expect, test } from "vite-plus/test";
import { missedBy } from "../src/core.ts";
import { skipper } from "../src/ignore.ts";
import type { Listing } from "../src/listing.ts";
import { copyStatus, type SideView } from "../src/status.ts";

const list = (files: Record<string, string>): Listing =>
  Object.fromEntries(Object.entries(files).map(([p, h]) => [p, { size: 1, mtime: 1, hash: h }]));
const known = (files: Record<string, string>): SideView => ({ known: true, files: list(files), unread: [] });
const none = () => false;

test("status: both sides known: what a sync would do", () => {
  const base = { "a.tex": "1", "b.tex": "1", "c.tex": "1" };
  const s = copyStatus(
    known({ "a.tex": "2", "b.tex": "1", "c.tex": "2", "new.tex": "n" }),
    known({ "a.tex": "1", "c.tex": "3" }),
    base,
    none,
  );
  expect(s.both).toEqual({ send: 2, receive: 1, conflict: 1, other: 0 }); // a and new; b deleted there; c
  expect(s.here).toEqual({ known: true, changed: 3 });
  expect(s.there).toEqual({ known: true, changed: 2 });
  expect(s.synced).toBe(true);
});

test("status: in sync is only said with both sides known", () => {
  const base = { "a.tex": "1" };
  expect(copyStatus(known({ "a.tex": "1" }), known({ "a.tex": "1" }), base, none).both).toEqual({
    send: 0,
    receive: 0,
    conflict: 0,
    other: 0,
  });
  const off = copyStatus(known({ "a.tex": "1" }), { known: false, why: "off" }, base, none);
  expect(off.both).toBeUndefined();
  expect(off.here).toEqual({ known: true, changed: 0 }); // "nothing changed here", not "in sync"
  expect(off.there).toEqual({ known: false, why: "off" });
});

test("status: a side that can't be told about says why, and the other half still counts", () => {
  const s = copyStatus({ known: false, why: "network" }, known({ "a.tex": "2" }), { "a.tex": "1" }, none);
  expect(s.here).toEqual({ known: false, why: "network" });
  expect(s.there).toEqual({ known: true, changed: 1 });
  expect(s.both).toBeUndefined();
});

test("status: files left out on either side count nowhere", () => {
  const skip = skipper("*.aux", "build/");
  const s = copyStatus(known({ "a.aux": "x", "build/out.pdf": "o" }), known({}), {}, skip);
  expect(s.both).toEqual({ send: 0, receive: 0, conflict: 0, other: 0 });
  expect(s.here).toEqual({ known: true, changed: 0 });
});

test("status: what a sync finds that the watcher should have told", () => {
  const now = 1_000_000;
  const entries: Record<string, { size: number; mtime: number; hash: string }> = {
    old: { size: 1, mtime: now - 60_000, hash: "x" },
    fresh: { size: 1, mtime: now - 1000, hash: "y" },
  };
  expect(missedBy(["old", "fresh", "gone"], (p) => entries[p], now)).toEqual(["old", "gone"]);
});

test("ignore: a whole path is left out by any folder on its way, in any of the lists", () => {
  const skip = skipper("build/", "*.aux\n/top/");
  expect(skip("build/out.pdf")).toBe(true);
  expect(skip("ch/build/x/y.tex")).toBe(true);
  expect(skip("top/a.tex")).toBe(true);
  expect(skip("sub/top/a.tex")).toBe(false);
  expect(skip("thesis.aux")).toBe(true);
  expect(skip("thesis.tex")).toBe(false);
});
