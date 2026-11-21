import { scratch } from "./_env.ts";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { Db } from "../src/db.ts";

const e = (hash: string, size = 1) => ({ size, mtime: 1000, hash });

test("db: a change number goes up with each real change, and only then", () => {
  const s = new Db(":memory:").scope("folder");
  expect(s.seq).toBe(0);
  expect(s.put("a.tex", e("1"))).toBe(true);
  expect(s.put("a.tex", e("1"))).toBe(false); // the same: nothing to tell
  expect(s.put("b.tex", e("2"))).toBe(true);
  expect(s.remove("a.tex")).toBe(true);
  expect(s.remove("a.tex")).toBe(false);
  expect(s.seq).toBe(3);
  expect(Object.keys(s.view())).toEqual(["b.tex"]);
});

test("db: another computer gets only what changed since its number, deletions included, in pages", () => {
  const s = new Db(":memory:").scope("folder");
  s.put("a", e("1"));
  s.put("b", e("2"));
  const first = s.changesSince("", 0);
  expect(first.reset).toBe(true); // it knew nothing of this history
  expect(first.changes.map((c) => c[0])).toEqual(["a", "b"]);
  s.put("b", e("3"));
  s.remove("a");
  s.put("c", e("4"));
  const next = s.changesSince(first.epoch, first.seq);
  expect(next.reset).toBe(false);
  expect(next.changes).toEqual([
    ["b", e("3")],
    ["a", null],
    ["c", e("4")],
  ]);
  const p1 = s.changesSince(first.epoch, first.seq, 2);
  expect(p1.more).toBe(true);
  const p2 = s.changesSince(first.epoch, p1.seq, 2);
  expect([...p1.changes, ...p2.changes]).toEqual(next.changes);
  expect(p2.more).toBe(false);
});

test("db: a mirror follows another scope through its changes, and starts over on a new history", () => {
  const db = new Db(":memory:");
  const theirs = db.scope("folder");
  const mine = db.scope("peer:x");
  theirs.put("a", e("1"));
  theirs.put("b", e("2"));
  mine.mirror(theirs.changesSince(mine.epoch, mine.seq));
  expect(mine.hashes()).toEqual({ a: "1", b: "2" });
  theirs.remove("a");
  theirs.put("c", e("3"));
  mine.mirror(theirs.changesSince(mine.epoch, mine.seq));
  expect(mine.hashes()).toEqual({ b: "2", c: "3" });
  expect([mine.epoch, mine.seq]).toEqual([theirs.epoch, theirs.seq]);
  theirs.clear(); // its folder changed
  theirs.put("z", e("9"));
  const c = theirs.changesSince(mine.epoch, mine.seq);
  expect(c.reset).toBe(true);
  mine.mirror(c);
  expect(mine.hashes()).toEqual({ z: "9" });
});

test("db: long-gone rows are dropped once many, under a new history", () => {
  const s = new Db(":memory:").scope("folder");
  for (let i = 0; i < 6000; i++) s.put(`f${i}`, e(String(i)));
  for (let i = 0; i < 5900; i++) s.remove(`f${i}`);
  const epoch = s.epoch;
  expect(s.compact()).toBe(true);
  expect(s.epoch).not.toBe(epoch);
  const all = s.changesSince(epoch, 0, 100_000);
  expect(all.reset).toBe(true);
  expect(all.changes.length).toBe(100);
});

test("db: the lists are kept between runs, and a failed transaction leaves nothing behind", () => {
  const file = join(scratch("db-file"), "index.db");
  const db = new Db(file);
  db.scope("folder").put("a", e("1"));
  expect(() =>
    db.transaction(() => {
      db.scope("folder").put("b", e("2"));
      throw new Error("power cut");
    }),
  ).toThrow("power cut");
  db.close();
  const again = new Db(file).scope("folder");
  expect(again.hashes()).toEqual({ a: "1" });
  expect(again.seq).toBe(1);
});

test("db: file names like Object's own properties are names like any other", () => {
  const s = new Db(":memory:").scope("folder");
  s.put("__proto__", e("p"));
  s.put("constructor", e("c"));
  expect(s.get("toString")).toBeUndefined();
  expect(Object.keys(s.hashes()).sort()).toEqual(["__proto__", "constructor"]);
});
