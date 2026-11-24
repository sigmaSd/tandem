import { put, scratch, tree } from "./_env.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { Core, type Job } from "../src/core.ts";
import { copies, pair, reach, running, stopAll, syncNow, tandem } from "./_tandem.ts";
import { Db } from "../src/db.ts";
import { Link, RemoteStore } from "../src/remote.ts";

afterEach(stopAll);

test("core: two computers pair with a code, then sync both ways over the network", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "\\chapter{One}", "figures/phase.pdf": "PDF" });
  const b = await tandem("Laptop", { "refs.bib": "@book{x}" });
  const ids = await pair(a.core, b.core);
  expect(a.core.pairing).toBeNull(); // the code is used up
  expect(a.core.state().folders[0].copies.map((c) => [c.name, c.waiting])).toEqual([["Laptop", false]]);
  expect(b.core.state().folders[0].copies.map((c) => [c.name, c.waiting])).toEqual([["Office PC", false]]);

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
  expect(copies(a.core)[0].lastSync).toBeGreaterThan(0); // the other side was told
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
  b.core.cancel(); // left without syncing: it says so, and the notice goes at once
  told = 0;
  await new Promise((r) => setTimeout(r, 500));
  expect(a.core.state().guest).toBeNull();
  expect(told).toBeGreaterThan(0); // and the window was told, so it redraws without it
});

test("core: the computer synced with is told how far the sync is, and when it is left", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "text" });
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  const onB = copies(b.core)[0];
  if (onB.kind !== "device") throw new Error("not a device");
  const remote = new RemoteStore(
    new Link(
      `127.0.0.1:${a.core.port}`,
      { id: b.core.config.device.id, port: b.core.port },
      onB.deviceId,
      Buffer.from(b.core.config.devices[0].key, "base64"),
    ),
    new Db(":memory:").scope("peer"),
    new Db(":memory:").scope("peerbase"),
    () => ({ folder: String(onB.remote), from: b.fid }),
  );
  await remote.scan("");
  expect(a.core.state()).toMatchObject({ guest: "Laptop", guestProgress: null }); // comparing: no count yet
  remote.progress = [2, 5];
  await remote.checkpoint();
  expect(a.core.state().guestProgress).toEqual([2, 5]);
  remote.progress = null;
  await remote.checkpoint(); // a request that doesn't say keeps the last count
  expect(a.core.state().guestProgress).toEqual([2, 5]);
  await remote.scan(""); // the next comparison starts from nothing
  expect(a.core.state().guestProgress).toBeNull();
  await remote.left();
  expect(a.core.state()).toMatchObject({ guest: null, guestProgress: null });
  expect(a.core.state().folders[0].guest).toBeNull(); // and a sync can start there again
});

test("core: no sync starts on a folder another computer is syncing with this one, either way", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);

  // the laptop compared: the office PC's folder is its guest's until it is done
  b.core.compare(ids.onB);
  await reach(b.core, "review");
  expect(a.core.state().folders[0].guest).toBe("Laptop");
  expect(() => a.core.compare(ids.onA)).toThrow("Laptop is syncing this folder with this computer");
  expect(a.core.job).toBeNull();
  b.core.start();
  await reach(b.core, "done");
  expect(a.core.state().folders[0].guest).toBeNull(); // it said it was done: free again
  expect(await syncNow(a.core, ids.onA)).toMatchObject({ inSync: true });
  a.core.closeJob();

  // the office PC is comparing (held there for the test): the laptop is told, nothing is scanned for it
  a.core.job = { phase: "scanning", copyId: ids.onA, here: [0, 0], there: [0, 0] };
  b.core.compare(ids.onB);
  const refused = await reach(b.core, "error");
  expect(refused.message).toBe(
    "Office PC is already syncing this folder. Wait for it to end, then try again.",
  );
  expect(a.core.state().folders[0].guest).toBeNull();
  a.core.job = null;
  b.core.closeJob();
  expect(await syncNow(b.core, ids.onB)).toMatchObject({ inSync: true });
});

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

test("core: a folder unshared, or a computer forgotten, on one side is refused, and a wrong code is burnt after five tries", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await a.core.removeCopy(ids.onA);
  b.core.compare(ids.onB);
  expect((await reach(b.core, "error")).message).toContain("no longer shares this folder");
  await a.core.forgetDevice(b.core.config.device.id);
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

test("core: copies on drives from before are forgotten, their files left on the drive", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "t" });
  const usb = scratch("old-usb");
  put(usb, {
    "thesis.tex": "t",
    ".tandem/copy.json": '{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"x"}',
  });
  await a.core.stop();
  const path = join(a.core.stateDir, "config.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.folders[0].copies.push({
    kind: "drive",
    id: "d1",
    name: "USB",
    added: 1,
    marker: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: usb,
  });
  writeFileSync(path, JSON.stringify(saved));
  const db = new Db(join(a.core.stateDir, "index.db"));
  db.scope("drive:d1").put("thesis.tex", {
    size: 1,
    mtime: 1,
    hash: "0000000000000000000000000000000000000000000000000000000000000000",
  });
  db.close();
  const again = new Core(a.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 });
  await again.init();
  running.push(again);
  expect(again.config.folders[0].copies).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8")).folders[0].copies).toEqual([]);
  expect(tree(usb, true)["thesis.tex"]).toBe("t");
  const after = new Db(join(a.core.stateDir, "index.db"));
  expect(after.names("drive:")).toEqual([]);
  after.close();
});

test("core: a folder found empty after it held files stops the sync instead of deleting everything", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1", "ch2.tex": "2" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(a.core, ids.onA);
  rmSync(join(a.folder, "ch1.tex"));
  rmSync(join(a.folder, "ch2.tex")); // as when the folder's disk is not mounted
  a.core.compare(ids.onA);
  expect((await reach(a.core, "error")).message).toContain("is empty, and it held 2 files");
  expect(tree(b.folder)).toEqual({ "ch1.tex": "1", "ch2.tex": "2" });
});

test("core: old versions are filed under this computer's clock, whatever the other computer's says", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "the good text" });
  const b = await tandem("Old laptop");
  await pair(a.core, b.core);
  const onB = copies(b.core)[0];
  if (onB.kind !== "device") throw new Error("not a device");
  // the laptop's clock is years behind: its requests carry an ancient time stamp
  const remote = new RemoteStore(
    new Link(
      `127.0.0.1:${a.core.port}`,
      { id: b.core.config.device.id, port: b.core.port },
      onB.deviceId,
      Buffer.from(b.core.config.devices[0].key, "base64"),
    ),
    new Db(":memory:").scope("peer"),
    new Db(":memory:").scope("peerbase"),
    () => ({ folder: String(onB.remote), from: b.fid }),
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
  const [old] = await a.core.oldVersions(a.fid);
  expect(old.stamp.slice(0, 4)).toBe(String(new Date().getUTCFullYear()));
  // so a restart, which drops old versions past their time, keeps it
  await a.core.stop();
  const again = new Core(a.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 });
  await again.init();
  running.push(again);
  expect((await again.oldVersions(a.fid)).map((o) => o.path)).toEqual(["thesis.tex"]);
});

test("core: a computer gone while the review is open is not written to, nor remembered as synced", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(a.core, ids.onA);
  const synced = copies(a.core)[0].lastSync;
  put(a.folder, { "ch3.tex": "the new chapter" });
  a.core.compare(ids.onA);
  await reach(a.core, "review");
  await b.core.stop();
  a.core.start();
  const done = await reach(a.core, "done");
  expect(done.summary).toMatchObject({ sent: 0, lost: "there", inSync: false });
  expect(copies(a.core)[0].lastSync).toBe(synced);
  expect(tree(b.folder)).toEqual({ "ch1.tex": "1" });
  // back on: still to send, not to delete
  const again = new Core(b.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 });
  await again.init();
  running.push(again);
  a.core.config.devices[0].address = `127.0.0.1:${again.port}`;
  a.core.compare(ids.onA);
  await reach(a.core, "review");
  expect(a.core.items().map((i) => [i.kind, i.path])).toEqual([["send", "ch3.tex"]]);
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
  await a.core.setFolderPath(a.fid, other);
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
  // the laptop can sync once the office PC's comparison has stopped asking it things
  while (b.core.state().folders[0].guest) await new Promise((r) => setTimeout(r, 150));
  await syncNow(b.core, ids.onB);
  a.core.start();
  expect((await reach(a.core, "error")).message).toContain("since the comparison");
  expect(tree(a.folder)).toEqual(tree(b.folder));
}, 10_000);

test("core: files named like things every object has are files like any other", async () => {
  const a = await tandem("Office PC");
  for (const name of ["constructor", "__proto__", "toString", "sub/hasOwnProperty"])
    put(a.folder, { [name]: name });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  expect(await syncNow(a.core, ids.onA)).toMatchObject({ sent: 4, inSync: true });
  expect(Object.keys(tree(b.folder)).sort()).toEqual([
    "__proto__",
    "constructor",
    "sub/hasOwnProperty",
    "toString",
  ]);
  rmSync(join(b.folder, "constructor"));
  put(b.folder, { toString: "t2" });
  expect(await syncNow(a.core, ids.onA)).toMatchObject({ received: 1, removed: 1, inSync: true });
  expect(Object.keys(tree(a.folder)).sort()).toEqual(["__proto__", "sub/hasOwnProperty", "toString"]);
});

test("core: an old version is put back from the window's list", async () => {
  const a = await tandem("Office PC", { "ch.tex": "first" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(a.core, ids.onA);
  put(b.folder, { "ch.tex": "second, from elsewhere" });
  await syncNow(a.core, ids.onA);
  expect(tree(a.folder)).toEqual({ "ch.tex": "second, from elsewhere" });
  const [old] = await a.core.oldVersions(a.fid);
  await a.core.restore(a.fid, old.stamp, old.path);
  expect(tree(a.folder)).toEqual({ "ch.tex": "first" });
  expect((await a.core.oldVersions(a.fid)).length).toBe(2);
});

test("core: what the window is told holds no key", async () => {
  const a = await tandem("Office PC");
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  const key = a.core.config.devices[0].key;
  expect(key.length).toBeGreaterThan(20);
  expect(JSON.stringify(a.core.state())).not.toContain(key);
  expect(JSON.stringify(a.core.state())).not.toContain(a.core.config.device.id);
});

/** A copy's status once the first scans are done and the other computers were asked. */
async function statusOf(core: Core, id: string) {
  await core.settled();
  return core
    .state()
    .folders.flatMap((f) => f.copies)
    .find((c) => c.id === id)!.status!;
}

/** Wait until `check` holds (a watcher waits for the folder to be quiet before it tells). */
async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`still not: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test("core status: in sync, then a change here seen by the watcher", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(a.core, ids.onA);
  const synced = await statusOf(a.core, ids.onA);
  expect(synced).toMatchObject({ synced: true, both: { send: 0, receive: 0, conflict: 0, other: 0 } });
  put(a.folder, { "ch2.tex": "2" });
  await waitFor(async () => (await statusOf(a.core, ids.onA)).both?.send === 1, "one file to send");
  expect((await statusOf(a.core, ids.onA)).here).toEqual({ known: true, changed: 1 });
}, 20_000);

test("core status: another computer is asked for its news, and is 'can't tell' once it's off", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  expect((await statusOf(a.core, ids.onA)).both).toEqual({ send: 0, receive: 0, conflict: 0, other: 0 });
  put(b.folder, { "ch2.tex": "written on the laptop" });
  await waitFor(async () => (await statusOf(a.core, ids.onA)).both?.receive === 1, "one file to receive");
  expect((await statusOf(a.core, ids.onA)).there).toEqual({ known: true, changed: 1 });
  expect(b.core.state().guest).toBeNull(); // being asked for news is not a sync
  await b.core.stop();
  const off = await statusOf(a.core, ids.onA);
  expect(off.there).toEqual({ known: false, why: "off" });
  expect(off.here).toEqual({ known: true, changed: 0 });
  expect(off.both).toBeUndefined();
}, 25_000);

test("core status: a folder that can't be watched is 'can't tell', and a sync still works", async () => {
  const a = await tandem("Office PC", { "ch1.tex": "1" }, { watch: false });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  const s = await statusOf(a.core, ids.onA);
  expect(s.here).toEqual({ known: false, why: "failed" });
  expect(await syncNow(a.core, ids.onA)).toMatchObject({ sent: 1, inSync: true });
});

test("core: the review comes in pages and in folders", async () => {
  const files: Record<string, string> = { "a.tex": "a", "b.tex": "b" };
  for (let i = 0; i < 12; i++) files[`fig/f${i}.pdf`] = String(i);
  for (let i = 0; i < 5; i++) files[`ch/c${i}.tex`] = String(i);
  const a = await tandem("Office PC", files);
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  a.core.compare(ids.onA);
  await reach(a.core, "review");
  const first = a.core.page("send", 0, 5);
  expect(first.total).toBe(19);
  expect(first.items.map((i) => i.path)).toEqual(["a.tex", "b.tex", "ch/c0.tex", "ch/c1.tex", "ch/c2.tex"]);
  expect(a.core.page("send", 15, 5).items.length).toBe(4);
  expect(a.core.groups("send")).toEqual([
    { folder: "fig", count: 12 },
    { folder: "ch", count: 5 },
    { folder: "", count: 2 },
  ]);
  expect(a.core.page("send", 0, 100, "ch").total).toBe(5);
  expect(a.core.page("receive").total).toBe(0);
});

test("core: another computer's list arrives in pages, then only its changes", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 7; i++) files[`f${i}.tex`] = String(i);
  const a = await tandem("Office PC", files);
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  await a.core.settled();
  const onB = copies(b.core)[0];
  if (onB.kind !== "device") throw new Error("not a device");
  const mirror = new Db(":memory:").scope("peer");
  const remote = new RemoteStore(
    new Link(
      `127.0.0.1:${a.core.port}`,
      { id: b.core.config.device.id, port: b.core.port },
      onB.deviceId,
      Buffer.from(b.core.config.devices[0].key, "base64"),
    ),
    mirror,
    new Db(":memory:").scope("peerbase"),
    () => ({ folder: String(onB.remote), from: b.fid }),
  );
  remote.pageSize = 2;
  await remote.pull(false);
  expect(Object.keys(mirror.view()).length).toBe(7);
  const seq = mirror.seq;
  rmSync(join(a.folder, "f3.tex"));
  put(a.folder, { "f9.tex": "9" });
  await waitFor(async () => {
    const st = await remote.status();
    return st.seq >= seq + 2;
  }, "the change number to move");
  await remote.pull(false);
  expect(Object.keys(mirror.view()).sort()).toEqual([
    "f0.tex",
    "f1.tex",
    "f2.tex",
    "f4.tex",
    "f5.tex",
    "f6.tex",
    "f9.tex",
  ]);
}, 20_000);

test("core: the records of Tandem 0.1.0 move into the database, so the next sync is not a first sync", async () => {
  const a = await tandem("Office PC", { "kept.tex": "k", "deleted-here.tex": "d" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(a.core, ids.onA);
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  await a.core.stop();
  // as 0.1.0 left it: the record in base/<copy>.json, then deleted-here.tex deleted on this computer
  const db = new Db(join(a.core.stateDir, "index.db"));
  db.drop(`base:${ids.onA}`);
  db.close();
  put(a.core.stateDir, {
    [`base/${ids.onA}.json`]: JSON.stringify({ "kept.tex": hash("k"), "deleted-here.tex": hash("d") }),
  });
  rmSync(join(a.folder, "deleted-here.tex"));
  const again = new Core(a.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 });
  await again.init();
  running.push(again);
  expect(existsSync(join(a.core.stateDir, "base"))).toBe(false);
  const summary = await syncNow(again, ids.onA);
  expect(summary).toMatchObject({ removed: 1, inSync: true }); // a deletion, not a file brought back
  expect(tree(b.folder)).toEqual({ "kept.tex": "k" });
});

test("core: a new device takes the name it is given (a phone's host name is just localhost), and keeps its own after", async () => {
  const dir = scratch("device-name");
  const core = new Core(dir, { discovery: false, bind: "127.0.0.1", port: 0, deviceName: "Pixel 9" });
  await core.init();
  expect(core.config.device.name).toBe("Pixel 9");
  await core.stop();
  const again = new Core(dir, { discovery: false, bind: "127.0.0.1", port: 0, deviceName: "Other" });
  await again.init();
  expect(again.config.device.name).toBe("Pixel 9");
  await again.stop();
});
