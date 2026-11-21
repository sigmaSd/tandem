import { put, scratch } from "./_env.ts";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { LocalStore } from "../src/store.ts";
import { onNetwork, Watcher } from "../src/watch.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A folder followed as Tandem does: one scan, then the watcher's paths read again. */
async function followed(name: string, files: Record<string, string>) {
  const dir = scratch(name);
  put(dir, files);
  const store = new LocalStore(dir);
  await store.scan("*.aux");
  const troubles: string[] = [];
  const watcher = new Watcher(dir, {
    paths: (paths) => void store.refresh(paths),
    lost: () => void store.scan("*.aux"),
    trouble: (why) => troubles.push(why),
  });
  expect(await watcher.start()).toBe(true);
  stops.push(() => watcher.stop());
  return { dir, store, troubles };
}

/** Wait until the list says what `want` says (the watcher waits for the folder to be quiet first). */
async function until(store: LocalStore, want: string[]) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const have = Object.keys(store.scope.view()).sort();
    if (JSON.stringify(have) === JSON.stringify(want)) return;
    if (Date.now() > deadline) expect(have).toEqual(want);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("watch: new, changed, renamed and deleted files and folders reach the list without a scan", async () => {
  const { dir, store, troubles } = await followed("watch-a", { "ch1.tex": "1", "old/notes.md": "n" });
  const seq = store.scope.seq;
  writeFileSync(join(dir, "ch2.tex"), "2");
  mkdirSync(join(dir, "figures/deep"), { recursive: true });
  writeFileSync(join(dir, "figures/deep/a.pdf"), "pdf");
  writeFileSync(join(dir, "thesis.aux"), "left out");
  await until(store, ["ch1.tex", "ch2.tex", "figures/deep/a.pdf", "old/notes.md"]);
  writeFileSync(join(dir, "ch1.tex"), "1, longer now");
  renameSync(join(dir, "old"), join(dir, "archive"));
  await until(store, ["archive/notes.md", "ch1.tex", "ch2.tex", "figures/deep/a.pdf"]);
  rmSync(join(dir, "figures"), { recursive: true });
  await until(store, ["archive/notes.md", "ch1.tex", "ch2.tex"]);
  expect(store.scope.get("ch1.tex")?.size).toBe(13);
  expect(store.scope.seq).toBeGreaterThan(seq);
  expect(troubles).toEqual([]);
});

test("watch: Tandem's own writes in .tandem are not news", async () => {
  const { dir, store } = await followed("watch-own", { "a.tex": "a" });
  const seq = store.scope.seq;
  put(dir, { ".tandem/old/20261120-160312/a.tex": "old" });
  await new Promise((r) => setTimeout(r, 1500));
  expect(store.scope.seq).toBe(seq);
});

test("watch: a local folder is not a network folder", async () => {
  expect(await onNetwork(scratch("watch-local"))).toBe(false);
});
