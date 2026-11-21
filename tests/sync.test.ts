import { put, scratch, tree } from "./_env.ts";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { apply, type Choice } from "../src/apply.ts";
import { DEFAULT_IGNORE, ignorer } from "../src/ignore.ts";
import {
  cleanRel,
  conflictName,
  isTextName,
  localLabel,
  NameError,
  stampOf,
  windowsTrouble,
} from "../src/names.ts";
import { plan } from "../src/plan.ts";
import { ChangedError, LocalStore, type Store, transfer } from "../src/store.ts";

const STAMP = "20261120-160312";
/** The stamp as it shows in a file name: this computer's clock, to the minute. */
const WHEN = localLabel(STAMP);

/** One whole sync between two folders, as the app does it. */
async function sync(
  dirA: string,
  dirB: string,
  base: Record<string, string>,
  opts: { choices?: Record<string, Choice>; between?: () => void; a?: Store; b?: Store; stamp?: string } = {},
) {
  const a = opts.a ?? new LocalStore(dirA);
  const b = opts.b ?? new LocalStore(dirB);
  const scanA = await a.scan(DEFAULT_IGNORE);
  const scanB = await b.scan(DEFAULT_IGNORE);
  const listA = scanA.files;
  const listB = scanB.files;
  const actions = plan(listA, listB, base, [...scanA.unread, ...scanB.unread]);
  opts.between?.();
  const result = await apply({
    a,
    b,
    listA,
    listB,
    base,
    actions,
    choices: opts.choices ?? {},
    stamp: opts.stamp ?? STAMP,
    nameB: "Office PC",
  });
  return { actions, ...result };
}

const results = (r: { outcomes: { path: string; result: string }[] }) =>
  Object.fromEntries(r.outcomes.map((o) => [o.path, o.result]));

test("sync: the first sync gives both folders everything, and LaTeX's build files stay home", async () => {
  const A = scratch("first-a");
  const B = scratch("first-b");
  put(A, {
    "thesis.tex": "\\section{A}",
    "thesis.aux": "junk",
    "figures/phase.pdf": "PDF1",
    "~$notes.docx": "lock",
  });
  put(B, { "refs.bib": "@book{}", "figures/energy.pdf": "PDF2" });
  const base = {};
  await sync(A, B, base);
  const both = {
    "thesis.tex": "\\section{A}",
    "refs.bib": "@book{}",
    "figures/phase.pdf": "PDF1",
    "figures/energy.pdf": "PDF2",
  };
  expect(tree(B)).toEqual(both);
  expect(tree(A)).toEqual({ ...both, "thesis.aux": "junk", "~$notes.docx": "lock" });
  expect(Object.keys(base).sort()).toEqual(Object.keys(both).sort());
  expect((await sync(A, B, base)).actions).toEqual([]); // nothing left to do
});

test("sync: edits travel both ways, and each replaced file is kept as an old version", async () => {
  const A = scratch("edit-a");
  const B = scratch("edit-b");
  put(A, { "ch1.tex": "one", "ch2.tex": "two" });
  const base = {};
  await sync(A, B, base);
  put(A, { "ch1.tex": "one, edited here" });
  put(B, { "ch2.tex": "two, edited there" });
  const r = await sync(A, B, base);
  expect(results(r)).toEqual({ "ch1.tex": "sent", "ch2.tex": "received" });
  expect(tree(A)).toEqual({ "ch1.tex": "one, edited here", "ch2.tex": "two, edited there" });
  expect(tree(B)).toEqual(tree(A));
  expect(tree(A, true)[`.tandem/old/${STAMP}/ch2.tex`]).toBe("two");
  expect(tree(B, true)[`.tandem/old/${STAMP}/ch1.tex`]).toBe("one");
});

test("sync: a deletion is repeated on the other side, the file kept as an old version there", async () => {
  const A = scratch("del-a");
  const B = scratch("del-b");
  put(A, { "keep.tex": "k", "notes/old.md": "old notes" });
  const base = {};
  await sync(A, B, base);
  rmSync(join(B, "notes/old.md"));
  const r = await sync(A, B, base);
  expect(results(r)).toEqual({ "notes/old.md": "removed-here" });
  expect(tree(A)).toEqual({ "keep.tex": "k" });
  expect(existsSync(join(A, "notes"))).toBe(false); // the folder left empty went too
  expect(tree(A, true)[`.tandem/old/${STAMP}/notes/old.md`]).toBe("old notes");
  expect(base).toEqual({ "keep.tex": expect.any(String) });
});

test("sync: a conflict waits for an answer, and nothing is touched until then", async () => {
  const A = scratch("conf-a");
  const B = scratch("conf-b");
  put(A, { "ch2.tex": "v1", "other.tex": "o" });
  const base = {};
  await sync(A, B, base);
  put(A, { "ch2.tex": "mine", "other.tex": "o2" });
  put(B, { "ch2.tex": "theirs" });
  const r = await sync(A, B, base);
  expect(results(r)).toEqual({ "ch2.tex": "unanswered", "other.tex": "sent" });
  expect(tree(A)["ch2.tex"]).toBe("mine");
  expect(tree(B)["ch2.tex"]).toBe("theirs");
  expect((await sync(A, B, base)).actions).toEqual([{ kind: "conflict", path: "ch2.tex" }]); // still asked
});

test("sync: a conflict's three answers", async () => {
  for (const choice of ["a", "b", "both"] as const) {
    const A = scratch(`ans-${choice}-a`);
    const B = scratch(`ans-${choice}-b`);
    put(A, { "ch2.tex": "v1" });
    const base = {};
    await sync(A, B, base);
    put(A, { "ch2.tex": "mine" });
    put(B, { "ch2.tex": "theirs!" });
    const r = await sync(A, B, base, { choices: { "ch2.tex": choice } });
    if (choice === "a") {
      expect(tree(A)).toEqual({ "ch2.tex": "mine" });
      expect(tree(B, true)[`.tandem/old/${STAMP}/ch2.tex`]).toBe("theirs!"); // the loser is kept
    } else if (choice === "b") {
      expect(tree(A)).toEqual({ "ch2.tex": "theirs!" });
      expect(tree(A, true)[`.tandem/old/${STAMP}/ch2.tex`]).toBe("mine");
    } else {
      const name = `ch2.conflict-Office-PC-${WHEN}.tex`;
      expect(r.outcomes).toEqual([{ path: "ch2.tex", result: "both-kept", detail: name }]);
      expect(tree(A)).toEqual({ "ch2.tex": "mine", [name]: "theirs!" });
    }
    expect(tree(B)).toEqual(tree(A));
    expect((await sync(A, B, base)).actions).toEqual([]);
  }
});

test("sync: deleted on one side and edited on the other: the edit is kept, or the deletion", async () => {
  for (const choice of ["a", "b"] as const) {
    const A = scratch(`gone-${choice}-a`);
    const B = scratch(`gone-${choice}-b`);
    put(A, { "draft.md": "v1" });
    const base = {};
    await sync(A, B, base);
    put(A, { "draft.md": "worked on" });
    rmSync(join(B, "draft.md"));
    expect((await sync(A, B, base)).actions).toEqual([{ kind: "conflict", path: "draft.md", gone: "b" }]);
    await sync(A, B, base, { choices: { "draft.md": choice } });
    if (choice === "a") expect(tree(B)).toEqual({ "draft.md": "worked on" });
    else {
      expect(tree(A)).toEqual({});
      expect(tree(A, true)[`.tandem/old/${STAMP}/draft.md`]).toBe("worked on");
    }
    expect(tree(B)).toEqual(tree(A));
  }
});

test("sync: a file edited after it was compared is left alone, on either side", async () => {
  const A = scratch("race-a");
  const B = scratch("race-b");
  put(A, { "ch1.tex": "v1", "ch2.tex": "v1" });
  const base = {};
  await sync(A, B, base);
  put(A, { "ch1.tex": "to send" });
  put(B, { "ch2.tex": "to receive" });
  const r = await sync(A, B, base, {
    between() {
      put(B, { "ch1.tex": "typed meanwhile on B" }); // the destination changed
      put(B, { "ch2.tex": "to receive, and more" }); // the source changed
    },
  });
  expect(results(r)).toEqual({ "ch1.tex": "changed", "ch2.tex": "changed" });
  expect(tree(B)).toEqual({ "ch1.tex": "typed meanwhile on B", "ch2.tex": "to receive, and more" });
  expect(tree(A)).toEqual({ "ch1.tex": "to send", "ch2.tex": "v1" });
  expect(tree(B, true)[".tandem/old"]).toBeUndefined();
});

test("sync: cut short, the next sync finishes the job and loses nothing", async () => {
  const A = scratch("cut-a");
  const B = scratch("cut-b");
  put(A, { "a.tex": "1", "b.tex": "2", "c.tex": "3" });
  const base: Record<string, string> = {};
  const b = new LocalStore(B);
  let writes = 0;
  // the drive is pulled while the second file is being written
  const flaky: Store = {
    scan: (i, p) => b.scan(i, p),
    read: (p, o, l) => b.read(p, o, l),
    retire: (p, e, s) => b.retire(p, e, s),
    async begin(path, meta, expect) {
      const up = await b.begin(path, meta, expect);
      if (++writes < 2) return up;
      return { ...up, commit: () => Promise.reject(new Error("EIO: drive gone")) };
    },
  };
  const r = await sync(A, B, base, { b: flaky });
  expect(Object.values(results(r))).toEqual(["sent", "failed", "failed"]);
  expect(tree(B)).toEqual({ "a.tex": "1" }); // no half-written file
  expect(Object.keys(base)).toEqual(["a.tex"]);
  const again = await sync(A, B, base);
  expect(results(again)).toEqual({ "b.tex": "sent", "c.tex": "sent" });
  expect(tree(B)).toEqual(tree(A));
});

test("sync: when the other copy goes away, the sync stops instead of failing every file", async () => {
  const A = scratch("lost-a");
  const B = scratch("lost-b");
  put(A, { "a.tex": "1", "b.tex": "2", "c.tex": "3" });
  const a = new LocalStore(A);
  const b = new LocalStore(B);
  const listA = (await a.scan("")).files;
  const dead: Store = {
    scan: b.scan.bind(b),
    read: b.read.bind(b),
    retire: b.retire.bind(b),
    begin: () => Promise.reject(new Error("unplugged")),
  };
  const r = await apply({
    a,
    b: dead,
    listA,
    listB: {},
    base: {},
    actions: plan(listA, {}, {}),
    choices: {},
    stamp: STAMP,
    nameB: "USB",
    alive: (side) => Promise.resolve(side === "a"),
  });
  expect(r.lost).toBe("b");
  expect(r.outcomes.map((o) => o.result)).toEqual(["failed", "stopped", "stopped"]);
});

test("sync: a folder or file that can't be read is unknown, not deleted: both sides are left alone", async () => {
  const A = scratch("unread-a");
  const B = scratch("unread-b");
  put(A, { "ch.tex": "v1", "private/notes.md": "n", "private/more.md": "m", "locked.docx": "doc" });
  const base = {};
  await sync(A, B, base);
  const { chmodSync } = await import("node:fs");
  chmodSync(join(A, "private"), 0o000); // the folder can't be opened
  chmodSync(join(A, "locked.docx"), 0o000); // the file can't be read (as when Word holds it)
  put(B, { "private/notes.md": "edited on B" });
  try {
    const r = await sync(A, B, base);
    expect(r.actions).toEqual([
      { kind: "unread", path: "locked.docx" },
      { kind: "unread", path: "private/more.md" },
      { kind: "unread", path: "private/notes.md" },
    ]);
    expect(new Set(Object.values(results(r)))).toEqual(new Set(["unread"]));
    expect(tree(B)).toEqual({
      "ch.tex": "v1",
      "private/notes.md": "edited on B",
      "private/more.md": "m",
      "locked.docx": "doc",
    });
    expect(tree(B, true)[".tandem/old"]).toBeUndefined();
  } finally {
    chmodSync(join(A, "private"), 0o755);
    chmodSync(join(A, "locked.docx"), 0o644);
  }
  // readable again: the edit made meanwhile arrives
  expect(results(await sync(A, B, base))).toEqual({ "private/notes.md": "received" });

  // the folder lists its files but none can be looked at (permissions changed by a careless command)
  chmodSync(A, 0o644);
  try {
    const scan = await new LocalStore(A).scan(DEFAULT_IGNORE);
    expect(scan.files).toEqual({});
    expect(scan.unread.sort()).toEqual(["ch.tex", "locked.docx", "private/"]);
    const actions = plan(scan.files, (await new LocalStore(B).scan(DEFAULT_IGNORE)).files, base, scan.unread);
    expect(new Set(actions.map((x) => x.kind))).toEqual(new Set(["unread"])); // nothing deleted on B
  } finally {
    chmodSync(A, 0o755);
  }
});

test("store: nothing can be written or read outside the folder", async () => {
  const dir = scratch("jail");
  const outside = scratch("jail-outside");
  put(dir, { "in.txt": "x" });
  put(outside, { "secret.txt": "s" });
  symlinkSync(outside, join(dir, "link"));
  const store = new LocalStore(dir);
  expect(Object.keys((await store.scan("")).files)).toEqual(["in.txt"]); // the link is not followed
  const meta = { size: 1, hash: "x", mtime: 0 };
  for (const bad of ["../x", "/etc/passwd", "a/../../x", ".tandem/old/x", "a\\b", "", "a//b", ".TANDEM/x"]) {
    await expect(store.begin(bad, meta, null)).rejects.toThrow(NameError);
    await expect(store.read(bad, 0, 10)).rejects.toThrow(NameError);
  }
  await expect(store.begin("link/planted.txt", meta, null)).rejects.toThrow(NameError);
  expect(tree(outside)).toEqual({ "secret.txt": "s" });
  // nor read through a link, to a folder or to a file
  symlinkSync(join(outside, "secret.txt"), join(dir, "key.txt"));
  await expect(store.read("link/secret.txt", 0, 10)).rejects.toThrow(NameError);
  await expect(store.read("key.txt", 0, 10)).rejects.toThrow(NameError);
  expect(Buffer.from(await store.read("in.txt", 0, 10)).toString()).toBe("x");
});

test("store: a file that arrives damaged never replaces the good one", async () => {
  const dir = scratch("damaged");
  put(dir, { "ch.tex": "good" });
  const store = new LocalStore(dir);
  const list = (await store.scan("")).files;
  const up = await store.begin("ch.tex", { size: 3, hash: "0".repeat(64), mtime: 0 }, list["ch.tex"]);
  await up.write(Buffer.from("bad"));
  await expect(up.commit(STAMP)).rejects.toThrow(ChangedError);
  expect(tree(dir, true)).toEqual({ "ch.tex": "good" }); // and no temporary file left
});

test("store: an old version can be put back, and what it replaces is kept in turn", async () => {
  const A = scratch("old-a");
  const B = scratch("old-b");
  put(A, { "ch.tex": "first draft" });
  const base = {};
  await sync(A, B, base);
  put(A, { "ch.tex": "second draft" });
  await sync(A, B, base);
  const b = new LocalStore(B);
  expect(await b.listOld()).toEqual([{ stamp: STAMP, path: "ch.tex", size: 11 }]);
  await b.restoreOld(STAMP, "ch.tex", "20261121-090000");
  expect(tree(B)).toEqual({ "ch.tex": "first draft" });
  expect((await b.listOld()).map((o) => o.stamp)).toEqual(["20261121-090000", STAMP]);
  expect(await b.pruneOld(30, Date.UTC(2026, 11, 25))).toBe(2);
  expect(await b.listOld()).toEqual([]);
});

test("store: unchanged files are not hashed twice, changed ones are", async () => {
  const dir = scratch("cache");
  const cache = join(scratch("cache-state"), "hashes.json");
  put(dir, { "big.pdf": "x".repeat(1000), "ch.tex": "v1" });
  const old = new Date(Date.now() - 60_000);
  const { utimesSync } = await import("node:fs");
  utimesSync(join(dir, "big.pdf"), old, old);
  utimesSync(join(dir, "ch.tex"), old, old);
  const first = (await new LocalStore(dir, cache).scan("")).files;
  // the cache is trusted: a wrong hash planted in it comes back for the untouched file
  const planted = { ...first, "big.pdf": { ...first["big.pdf"], hash: "planted" } };
  writeFileSync(cache, JSON.stringify(planted));
  writeFileSync(join(dir, "ch.tex"), "v2 longer");
  const second = (await new LocalStore(dir, cache).scan("")).files;
  expect(second["big.pdf"].hash).toBe("planted");
  expect(second["ch.tex"].hash).not.toBe(first["ch.tex"].hash);
});

test("store: a copy keeps the document's date", async () => {
  const A = scratch("date-a");
  const B = scratch("date-b");
  put(A, { "ch.tex": "text" });
  const a = new LocalStore(A);
  const list = (await a.scan("")).files;
  const landed = await transfer(a, new LocalStore(B), "ch.tex", list["ch.tex"], null, STAMP);
  expect(Math.abs(landed.mtime - list["ch.tex"].mtime)).toBeLessThan(2000);
});

test("ignore: names anywhere, folders, paths from the top, and Tandem's own folder", () => {
  const skip = ignorer("*.aux\nbuild/\nnotes/draft.*\n/top.txt\n# a comment\n~$*");
  expect(skip("thesis.aux", false)).toBe(true);
  expect(skip("ch/Deep.AUX", false)).toBe(true);
  expect(skip("thesis.tex", false)).toBe(false);
  expect(skip("build", true)).toBe(true);
  expect(skip("build", false)).toBe(false); // a file named build
  expect(skip("a/build", true)).toBe(true);
  expect(skip("notes/draft.md", false)).toBe(true);
  expect(skip("old/notes/draft.md", false)).toBe(false);
  expect(skip("top.txt", false)).toBe(true);
  expect(skip("sub/top.txt", false)).toBe(false);
  expect(skip("~$thesis.docx", false)).toBe(true);
  expect(skip(".tandem", true)).toBe(true);
  const usual = ignorer(DEFAULT_IGNORE);
  expect(["a.synctex.gz", "x.fdb_latexmk", ".DS_Store", "a.log"].every((f) => usual(f, false))).toBe(true);
  expect(usual(".git", true)).toBe(true);
  expect(["thesis.pdf", "refs.bib", "fig.png", "thesis.bbl"].some((f) => usual(f, false))).toBe(false);
});

test("names: what is refused, what Windows can't hold, and the name of a file kept twice", () => {
  expect(cleanRel("a/b.tex")).toBe("a/b.tex");
  expect(cleanRel("café.tex")).toBe("café.tex"); // one spelling of é on every system
  expect(windowsTrouble("notes/what?.md")).toBe("what?.md");
  expect(windowsTrouble("aux.tex")).toBe("aux.tex");
  expect(windowsTrouble("trailing./x")).toBe("trailing.");
  expect(windowsTrouble("fine/name (1).tex")).toBeNull();
  const taken = new Set([`a/ch.conflict-Bureau-2-${WHEN}.tex`]);
  expect(conflictName("a/ch.tex", "Bureau n°2", "20261120-160312", (p) => taken.has(p))).toBe(
    `a/ch.conflict-Bureau-n-2-${WHEN}.tex`,
  );
  taken.add(`a/ch.conflict-Bureau-n-2-${WHEN}.tex`);
  expect(conflictName("a/ch.tex", "Bureau n°2", "20261120-160312", (p) => taken.has(p))).toBe(
    `a/ch.conflict-Bureau-n-2-${WHEN}-2.tex`,
  );
  expect(conflictName("Makefile", "", "20261120-160312", () => false)).toBe(
    `Makefile.conflict-other-${WHEN}`,
  );
  expect(stampOf(new Date(Date.UTC(2026, 10, 20, 16, 3, 12)))).toBe("20261120-160312");
  expect(isTextName("ch/intro.TEX")).toBe(true);
  expect(isTextName("fig.pdf")).toBe(false);
  mkdirSync(scratch("names"), { recursive: true });
});
