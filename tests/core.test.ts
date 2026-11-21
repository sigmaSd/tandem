import { put, scratch, tree } from "./_env.ts";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { Core, type Job } from "../src/core.ts";
import { Link, RemoteStore } from "../src/remote.ts";

const running: Core[] = [];
afterEach(() => {
  for (const c of running.splice(0)) c.stop();
});

/** A Tandem of its own: its files in a scratch folder, listening only on this computer, silent on the network. */
async function tandem(name: string, files: Record<string, string> = {}) {
  const core = new Core(scratch(`${name}-state`), { discovery: false, bind: "127.0.0.1", port: 0 });
  await core.init();
  core.config.device.name = name;
  const folder = scratch(`${name}-folder`);
  put(folder, files);
  await core.setFolder(folder);
  running.push(core);
  return { core, folder };
}

/** Wait for the sync to reach a phase. */
function reach<P extends Job["phase"]>(core: Core, ...phases: P[]): Promise<Extract<Job, { phase: P }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still ${core.job?.phase}`)), 15_000);
    const check = () => {
      const job = core.job;
      if (job?.phase === "error" && !phases.includes("error" as P)) {
        clearTimeout(timer);
        off();
        return reject(new Error(job.message));
      }
      if (!job || !phases.includes(job.phase as P)) return;
      clearTimeout(timer);
      off();
      resolve(job as Extract<Job, { phase: P }>);
    };
    const off = core.onChange(check);
    check();
  });
}

async function pair(a: Core, b: Core) {
  const code = await a.startPairing();
  await b.pair(`127.0.0.1:${a.port}`, code);
  return { onA: a.config.copies.at(-1)!.id, onB: b.config.copies.at(-1)!.id };
}

/** Compare, answer nothing, apply. */
async function syncNow(core: Core, copyId: string) {
  core.compare(copyId);
  const job = await reach(core, "review", "done");
  if (job.phase === "review") core.start();
  return (await reach(core, "done")).summary;
}

test("core: two computers pair with a code, then sync both ways over the network", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "\\chapter{One}", "figures/phase.pdf": "PDF" });
  const b = await tandem("Laptop", { "refs.bib": "@book{x}" });
  const ids = await pair(a.core, b.core);
  expect(a.core.pairing).toBeNull(); // the code is used up
  expect(a.core.config.copies.map((c) => c.name)).toEqual(["Laptop"]);
  expect(b.core.config.copies.map((c) => c.name)).toEqual(["Office PC"]);

  b.core.compare(ids.onB);
  const review = await reach(b.core, "review");
  expect(review.first).toBe(true);
  expect(review.counts).toMatchObject({ send: 1, receive: 2, conflict: 0 });
  expect(b.core.items().map((i) => [i.kind, i.path])).toEqual([
    ["receive", "figures/phase.pdf"],
    ["send", "refs.bib"],
    ["receive", "thesis.tex"],
  ]);
  b.core.start();
  const done = await reach(b.core, "done");
  expect(done.summary).toMatchObject({ sent: 1, received: 2, inSync: true, kept: 0 });
  expect(tree(a.folder)).toEqual(tree(b.folder));
  expect(Object.keys(tree(a.folder)).sort()).toEqual(["figures/phase.pdf", "refs.bib", "thesis.tex"]);
  expect(a.core.config.copies[0].lastSync).toBeGreaterThan(0); // the other side was told
  expect(a.core.state().guest).toBeNull(); // and its "Laptop is syncing with this computer" notice is gone

  // the other computer starts the next one: it knows what was synced, so a deletion is a deletion
  rmSync(join(b.folder, "refs.bib"));
  put(b.folder, { "thesis.tex": "\\chapter{One} and more" });
  const summary = await syncNow(a.core, ids.onA);
  expect(summary).toMatchObject({ received: 1, removed: 1, inSync: true, kept: 2 });
  expect(tree(a.folder)).toEqual({ "figures/phase.pdf": "PDF", "thesis.tex": "\\chapter{One} and more" });
  expect(tree(b.folder)).toEqual(tree(a.folder));
});

test("core: the notice that another computer is syncing here shows while it works, and goes when it stops", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  let told = 0;
  a.core.onChange(() => told++);
  b.core.compare(ids.onB);
  await reach(b.core, "review");
  expect(a.core.state().guest).toBe("Laptop"); // the review is open over there
  b.core.cancel(); // left without syncing: nothing says "done", so the notice goes by itself
  told = 0;
  await new Promise((r) => setTimeout(r, 4600));
  expect(a.core.state().guest).toBeNull();
  expect(told).toBeGreaterThan(0); // and the window was told, so it redraws without it
}, 10_000);

test("core: a conflict is shown, compared side by side, and settled by the answer", async () => {
  const a = await tandem("Office PC", { "ch2.tex": "Intro.\nWe prove X.\nEnd." });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  put(a.folder, { "ch2.tex": "Intro.\nWe prove X and Y.\nEnd." });
  put(b.folder, { "ch2.tex": "Intro.\nWe prove X.\nEnd.\nThanks." });

  b.core.compare(ids.onB);
  const review = await reach(b.core, "review");
  expect(review.counts.conflict).toBe(1);
  expect(review.open).toBe(1);
  const diff = await b.core.diff("ch2.tex");
  expect(diff.kind === "text" && diff.rows.map((r) => r.kind)).toEqual(["same", "change", "same", "del"]);
  b.core.choose(null, "both");
  expect((b.core.job as Extract<Job, { phase: "review" }>).open).toBe(0);
  b.core.start();
  const done = await reach(b.core, "done");
  expect(done.summary).toMatchObject({ bothKept: 1, inSync: true });
  const files = tree(b.folder);
  const other = Object.keys(files).find((f) => f.includes(".conflict-Office-PC-"))!;
  expect(files["ch2.tex"]).toContain("Thanks.");
  expect(files[other]).toContain("X and Y");
  expect(tree(a.folder)).toEqual(files);
});

test("core: an unanswered conflict leaves both files alone and the copies not in sync", async () => {
  const a = await tandem("Office PC", { "ch.tex": "v1", "ok.tex": "o" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  put(a.folder, { "ch.tex": "theirs" });
  put(b.folder, { "ch.tex": "mine", "ok.tex": "o2" });
  const summary = await syncNow(b.core, ids.onB);
  expect(summary).toMatchObject({ sent: 1, unanswered: 1, inSync: false });
  expect(tree(a.folder)).toEqual({ "ch.tex": "theirs", "ok.tex": "o2" });
  expect(tree(b.folder)["ch.tex"]).toBe("mine");
});

test("core: a computer removed on one side is refused, and a wrong code is burnt after five tries", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await a.core.removeCopy(ids.onA);
  b.core.compare(ids.onB);
  expect((await reach(b.core, "error")).message).toContain("no longer recognizes");
  expect(tree(b.folder)).toEqual({});

  const code = await a.core.startPairing();
  const wrong = code.endsWith("0") ? `${code.slice(0, -1)}1` : `${code.slice(0, -1)}0`;
  for (let i = 0; i < 5; i++)
    await expect(b.core.pair(`127.0.0.1:${a.core.port}`, wrong)).rejects.toThrow(/not the code|not showing/);
  expect(a.core.pairing).toBeNull();
  await expect(b.core.pair(`127.0.0.1:${a.core.port}`, code)).rejects.toThrow("not showing a code");
  await expect(b.core.pair("127.0.0.1:9", code)).rejects.toThrow("No Tandem answered");
  await expect(b.core.pair(`127.0.0.1:${b.core.port}`, code)).rejects.toThrow("this computer");
  await expect(b.core.pair("127.0.0.1", "482 916")).rejects.toThrow("12 letters");
});

test("core: a paired computer reaches the synced folder and nothing else", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  put(scratch("Office PC-state-neighbour"), { "private.txt": "p" });
  b.core.compare(ids.onB);
  await reach(b.core, "review");
  for (const path of ["../Office PC-state/config.json", "/etc/hostname", ".tandem/copy.json", "..\\x"]) {
    await expect(b.core.openVersion(path, "b")).rejects.toThrow();
    await expect(b.core.diff(path)).rejects.toThrow();
  }
});

test("core: a drive carries the folder between two computers that never meet", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "v1", "fig/a.pdf": "A" });
  const b = await tandem("Laptop");
  const usb = scratch("usb");
  put(usb, { "holiday.jpg": "not ours" });

  // the office computer starts a copy on the drive: in a folder of its own, the drive's files untouched
  await a.core.addDrive(usb, true);
  const onA = a.core.config.copies[0];
  expect(onA.kind === "drive" && onA.path).toBe(join(usb, "Office PC-folder"));
  expect(await syncNow(a.core, onA.id)).toMatchObject({ sent: 2, inSync: true });
  expect(tree(usb)["holiday.jpg"]).toBe("not ours");
  expect(tree(a.folder)).toEqual({ "thesis.tex": "v1", "fig/a.pdf": "A" });

  // the laptop finds that copy on the drive, and takes it
  const copyDir = join(usb, "Office PC-folder");
  await b.core.addDrive(copyDir);
  const onB = b.core.config.copies[0];
  expect(await syncNow(b.core, onB.id)).toMatchObject({ received: 2, inSync: true });
  put(b.folder, { "thesis.tex": "v2, written on the laptop" });
  expect(await syncNow(b.core, onB.id)).toMatchObject({ sent: 1, kept: 1 });

  // back at the office
  expect(await syncNow(a.core, onA.id)).toMatchObject({ received: 1, inSync: true });
  expect(tree(a.folder)).toEqual({ "thesis.tex": "v2, written on the laptop", "fig/a.pdf": "A" });
  expect((await a.core.oldVersions()).map((o) => o.path)).toEqual(["thesis.tex"]);

  // unplugged: said plainly, nothing touched; plugged back under another letter: found again
  renameSync(copyDir, join(usb, "elsewhere"));
  a.core.compare(onA.id);
  expect((await reach(a.core, "error")).message).toContain("not plugged in");
  expect(a.core.state().copies[0].available).toBe(false);
  renameSync(join(usb, "elsewhere"), copyDir);
  expect(await syncNow(a.core, onA.id)).toMatchObject({ inSync: true });
});

test("core: a folder found empty after it held files stops the sync instead of deleting everything", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1", "ch2.tex": "2" });
  const drive = scratch("emptied-drive");
  await a.core.addDrive(drive);
  const id = a.core.config.copies[0].id;
  await syncNow(a.core, id);
  rmSync(join(a.folder, "ch1.tex"));
  rmSync(join(a.folder, "ch2.tex")); // as when the folder's disk is not mounted
  a.core.compare(id);
  expect((await reach(a.core, "error")).message).toContain("is empty, and it held 2 files");
  expect(tree(drive)).toEqual({ "ch1.tex": "1", "ch2.tex": "2" });
});

test("core: old versions are filed under this computer's clock, whatever the other computer's says", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "the good text" });
  const b = await tandem("Old laptop");
  await pair(a.core, b.core);
  const onB = b.core.config.copies[0];
  if (onB.kind !== "device") throw new Error("not a device");
  // the laptop's clock is years behind: its requests carry an ancient time stamp
  const remote = new RemoteStore(
    new Link(
      `127.0.0.1:${a.core.port}`,
      { id: b.core.config.device.id, port: b.core.port },
      onB.deviceId,
      Buffer.from(onB.key, "base64"),
    ),
  );
  const { files } = await remote.scan("");
  const up = await remote.begin(
    "thesis.tex",
    { size: 3, hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", mtime: 1 },
    files["thesis.tex"],
  );
  await up.write(Buffer.from("abc"));
  await up.commit("20000101-000000");
  expect(tree(a.folder)).toEqual({ "thesis.tex": "abc" });
  const [old] = await a.core.oldVersions();
  expect(old.stamp.slice(0, 4)).toBe(String(new Date().getUTCFullYear()));
  // so a restart, which drops old versions past their time, keeps it
  a.core.stop();
  const again = new Core(a.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 });
  await again.init();
  running.push(again);
  expect((await again.oldVersions()).map((o) => o.path)).toEqual(["thesis.tex"]);
});

test("core: a drive pulled while the review is open is not written to, nor remembered as synced", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1" });
  const parent = scratch("pulled");
  const drive = join(parent, "stick");
  await a.core.addDrive(drive);
  const id = a.core.config.copies[0].id;
  await syncNow(a.core, id);
  put(a.folder, { "ch3.tex": "the new chapter" });
  a.core.compare(id);
  await reach(a.core, "review");
  renameSync(drive, join(parent, "stick-unplugged"));
  a.core.start();
  const done = await reach(a.core, "done");
  expect(done.summary).toMatchObject({ sent: 0, lost: "there", inSync: false });
  expect(existsSync(drive)).toBe(false); // not made again where the drive was
  renameSync(join(parent, "stick-unplugged"), drive);
  a.core.compare(id);
  await reach(a.core, "review");
  expect(a.core.items().map((i) => [i.kind, i.path])).toEqual([["send", "ch3.tex"]]); // still to send, not to delete
});

test("core: a folder changed on the other computer while the review is open receives nothing", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1", "ch2.tex": "2" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  put(b.folder, { "ch3.tex": "new" });
  rmSync(join(b.folder, "ch2.tex"));
  b.core.compare(ids.onB);
  await reach(b.core, "review");
  const other = scratch("other-project");
  put(other, { "todo.txt": "unrelated" });
  await a.core.setFolder(other);
  b.core.start();
  const done = await reach(b.core, "done");
  expect(done.summary.inSync).toBe(false);
  expect(done.summary.sent + done.summary.removed).toBe(0);
  expect(tree(other, true)).toEqual({ "todo.txt": "unrelated" });
  expect(tree(a.folder)).toEqual({ "ch1.tex": "1", "ch2.tex": "2" });
  // and the next comparison is a first sync with the new folder: it only adds
  b.core.compare(ids.onB);
  await reach(b.core, "review");
  expect(
    b.core
      .items()
      .map((i) => i.kind)
      .sort(),
  ).toEqual(["receive", "send", "send"]);
});

test("core: a review left open while the other computer synced must be made again", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  put(a.folder, { "a.tex": "from a" });
  a.core.compare(ids.onA);
  await reach(a.core, "review");
  put(b.folder, { "b.tex": "from b" });
  await syncNow(b.core, ids.onB);
  a.core.start();
  expect((await reach(a.core, "error")).message).toContain("since the comparison");
  expect(tree(a.folder)).toEqual(tree(b.folder));
});

test("core: files named like things every object has are files like any other", async () => {
  const a = await tandem("Office PC");
  for (const name of ["constructor", "__proto__", "toString", "sub/hasOwnProperty"])
    put(a.folder, { [name]: name });
  const drive = scratch("proto-drive");
  await a.core.addDrive(drive);
  const id = a.core.config.copies[0].id;
  expect(await syncNow(a.core, id)).toMatchObject({ sent: 4, inSync: true });
  expect(Object.keys(tree(drive)).sort()).toEqual([
    "__proto__",
    "constructor",
    "sub/hasOwnProperty",
    "toString",
  ]);
  rmSync(join(drive, "constructor"));
  put(drive, { toString: "t2" });
  expect(await syncNow(a.core, id)).toMatchObject({ received: 1, removed: 1, inSync: true });
  expect(Object.keys(tree(a.folder)).sort()).toEqual(["__proto__", "sub/hasOwnProperty", "toString"]);
});

test("core: the folder can't be its own copy, nor hold it", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  await expect(a.core.addDrive(a.folder)).rejects.toThrow("synced folder itself");
  await expect(a.core.addDrive(join(a.folder, "backup"))).rejects.toThrow("inside the other");
  await expect(a.core.addDrive(join(a.folder, ".."))).rejects.toThrow("inside the other");
  expect(existsSync(join(a.folder, "backup"))).toBe(false);
  expect(a.core.config.copies).toEqual([]);
});

test("core: an old version is put back from the window's list", async () => {
  const a = await tandem("Office PC", { "ch.tex": "first" });
  const drive = scratch("old-drive");
  await a.core.addDrive(drive);
  const id = a.core.config.copies[0].id;
  await syncNow(a.core, id);
  put(drive, { "ch.tex": "second, from elsewhere" });
  await syncNow(a.core, id);
  expect(tree(a.folder)).toEqual({ "ch.tex": "second, from elsewhere" });
  const [old] = await a.core.oldVersions();
  await a.core.restore(old.stamp, old.path);
  expect(tree(a.folder)).toEqual({ "ch.tex": "first" });
  expect((await a.core.oldVersions()).length).toBe(2);
});

test("core: what the window is told holds no key", async () => {
  const a = await tandem("Office PC");
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  const key = a.core.config.copies[0].kind === "device" ? a.core.config.copies[0].key : "";
  expect(key.length).toBeGreaterThan(20);
  expect(JSON.stringify(a.core.state())).not.toContain(key);
  expect(JSON.stringify(a.core.state())).not.toContain(a.core.config.device.id);
});
