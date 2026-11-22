import { put, scratch, tree } from "./_env.ts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { Core, type DeviceCopy } from "../src/core.ts";
import { Db } from "../src/db.ts";
import { Link, RemoteStore } from "../src/remote.ts";
import { copies, pair, reach, running, stopAll, syncNow, tandem } from "./_tandem.ts";

afterEach(stopAll);

/** Another folder for a Tandem, holding `files`. */
async function folder(core: Core, name: string, files: Record<string, string> = {}) {
  const path = scratch(name);
  put(path, files);
  return { path, fid: await core.addFolder(path) };
}

/** The line from `from` to `to`, as `from` would open it. */
function line(from: Core, to: Core) {
  const dev = from.config.devices.find((d) => d.id === to.config.device.id)!;
  return new Link(
    `127.0.0.1:${to.port}`,
    { id: from.config.device.id, port: from.port },
    dev.id,
    Buffer.from(dev.key, "base64"),
  );
}

/** A folder of `to`, as `from` would reach it, saying it asks from its folder `mine`. */
function reachAs(from: Core, to: Core, theirs: string, mine: string) {
  return new RemoteStore(
    line(from, to),
    new Db(":memory:").scope("peer"),
    new Db(":memory:").scope("peerbase"),
    () => ({ folder: theirs, from: mine }),
  );
}

const linked = (core: Core, fid: string) => copies(core, fid).find((c) => c.kind === "device") as DeviceCopy;

test("folders: a paired computer reaches the folder shared with it, and no other", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "t" });
  const photos = await folder(a.core, "Office PC-photos", { "cat.jpg": "meow" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  expect(await syncNow(b.core, ids.onB)).toMatchObject({ received: 1, inSync: true });
  expect(tree(b.folder)).toEqual({ "thesis.tex": "t" });

  // asked directly, with every way of naming the other folder: refused, nothing read
  await expect(reachAs(b.core, a.core, photos.fid, b.fid).status()).rejects.toThrow("unshared");
  await expect(reachAs(b.core, a.core, "legacy", "1".repeat(32)).status()).rejects.toThrow("unshared");
  await expect(reachAs(b.core, a.core, "", b.fid).scan("")).rejects.toThrow("unshared");
  // the shared folder, said to be asked from another folder of the laptop than the one it is linked to
  await expect(reachAs(b.core, a.core, a.fid, "0".repeat(32)).status()).rejects.toThrow("unshared");
  expect(await reachAs(b.core, a.core, a.fid, b.fid).status()).toMatchObject({ folder: a.fid });
  expect(tree(photos.path)).toEqual({ "cat.jpg": "meow" });
});

test("folders: a folder offered after pairing is accepted into a new folder, then synced", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "t" });
  const b = await tandem("Laptop");
  // the laptop pairs from no folder's screen: the office's folder arrives as an offer, not linked
  const ids = await pair(a.core, b.core, a.fid, "");
  await a.core.poll(); // its offer, sent once the pair was saved there
  expect(a.core.state().folders[0].copies[0]).toMatchObject({ waiting: true, name: "Laptop" });
  expect(b.core.state().offers).toEqual([
    { deviceId: a.core.config.device.id, device: "Office PC", folder: a.fid, name: "Office PC-folder" },
  ]);
  expect(() => a.core.compare(ids.onA)).toThrow("hasn't accepted");

  const there = scratch("Laptop-thesis");
  const fid = await b.core.acceptOffer(a.core.config.device.id, a.fid, { path: there });
  expect(b.core.state().offers).toEqual([]);
  expect(linked(a.core, a.fid).remote).toBe(fid); // told at once
  expect(await syncNow(b.core, linked(b.core, fid).id)).toMatchObject({ received: 1, inSync: true });
  expect(tree(there)).toEqual({ "thesis.tex": "t" });
});

test("folders: an offer is accepted into a folder that has files; one declined is taken back, and stays declined", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "t" });
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  const notesA = await folder(a.core, "Office PC-notes", { "a.md": "from the office" });
  const notesB = await folder(b.core, "Laptop-notes", { "b.md": "from the laptop" });
  const laptop = b.core.config.device.id;
  const office = a.core.config.device.id;

  await a.core.share(notesA.fid, laptop);
  await b.core.acceptOffer(office, notesA.fid, { folder: notesB.fid });
  // a first sync: each side's files go to the other, nothing is deleted
  expect(await syncNow(a.core, linked(a.core, notesA.fid).id)).toMatchObject({ sent: 1, received: 1 });
  expect(tree(notesA.path)).toEqual({ "a.md": "from the office", "b.md": "from the laptop" });
  expect(tree(notesB.path)).toEqual(tree(notesA.path));
  // the folder already linked can't take another folder of that computer
  const music = await folder(a.core, "Office PC-music");
  await a.core.share(music.fid, laptop);
  await expect(b.core.acceptOffer(office, music.fid, { folder: notesB.fid })).rejects.toThrow(
    "already shared",
  );

  await b.core.declineOffer(office, music.fid);
  expect(copies(a.core, music.fid)).toEqual([]); // taken back over there
  await a.core.share(music.fid, laptop);
  expect(copies(a.core, music.fid)).toEqual([]); // the same offer again: answered at once
  expect(b.core.state().offers).toEqual([]);
});

test("folders: an offer made while the other computer is off arrives at the next look", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "t" });
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  await b.core.stop();
  const notes = await folder(a.core, "Office PC-notes", { "n.md": "n" });
  await a.core.share(notes.fid, b.core.config.device.id);
  expect(linked(a.core, notes.fid).remote).toBeNull();

  const again = new Core(b.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 });
  await again.init();
  running.push(again);
  a.core.config.devices[0].address = `127.0.0.1:${again.port}`; // where discovery would find it
  await a.core.poll();
  expect(again.state().offers.map((o) => o.name)).toEqual(["Office PC-notes"]);
});

test("folders: two folders named alike on both computers stay apart", async () => {
  const a = await tandem("Office PC");
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  const office = a.core.config.device.id;
  const one = await folder(a.core, "work/Notes", { "work.md": "w" });
  const two = await folder(a.core, "home/Notes", { "home.md": "h" });
  for (const f of [one, two]) await a.core.share(f.fid, b.core.config.device.id);
  expect(b.core.state().offers.map((o) => o.name)).toEqual(["Notes", "Notes"]);
  const intoOne = await b.core.acceptOffer(office, one.fid, { path: scratch("laptop-work/Notes") });
  const intoTwo = await b.core.acceptOffer(office, two.fid, { path: scratch("laptop-home/Notes") });
  await syncNow(b.core, linked(b.core, intoOne).id);
  await syncNow(b.core, linked(b.core, intoTwo).id);
  expect(tree(b.core.config.folders[1].path)).toEqual({ "work.md": "w" });
  expect(tree(b.core.config.folders[2].path)).toEqual({ "home.md": "h" });
});

test("folders: a folder no longer synced keeps its files, and the other computer is told it's not shared", async () => {
  const a = await tandem("Office PC", { "thesis.tex": "t" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  await a.core.removeFolder(a.fid);
  expect(a.core.config.folders).toEqual([]);
  expect(tree(a.folder)).toEqual({ "thesis.tex": "t" });
  await b.core.settled();
  const s = b.core.state().folders[0].copies[0].status!;
  expect(s.there).toEqual({ known: false, why: "unshared" });
  expect(b.core.config.devices.length).toBe(1); // still paired
});

test("folders: a folder can't be inside another, nor hold one", async () => {
  const a = await tandem("Office PC", { "x.tex": "x" });
  await expect(a.core.addFolder(a.folder)).rejects.toThrow("already kept in sync");
  await expect(a.core.addFolder(join(a.folder, "sub"))).rejects.toThrow("is inside");
  await expect(a.core.addFolder(join(a.folder, ".."))).rejects.toThrow("is inside");
  expect(existsSync(join(a.folder, "sub"))).toBe(false);
  const other = await folder(a.core, "Office PC-other");
  await expect(a.core.setFolderPath(other.fid, join(a.folder, "inner"))).rejects.toThrow("is inside");
  expect(a.core.config.folders.length).toBe(2);
});

test("folders: a file on its way can't be finished by a request about another folder", async () => {
  const a = await tandem("Office PC");
  const b = await tandem("Laptop");
  await pair(a.core, b.core);
  const notesA = await folder(a.core, "Office PC-notes");
  const notesB = await folder(b.core, "Laptop-notes");
  await a.core.share(notesA.fid, b.core.config.device.id);
  await b.core.acceptOffer(a.core.config.device.id, notesA.fid, { folder: notesB.fid });
  const link = line(b.core, a.core);
  const st = (await link.call("status", { folder: a.fid, from: b.fid })).result as { epoch: string };
  const meta = {
    size: 3,
    hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    mtime: 1,
  };
  const id = (
    await link.call("putBegin", {
      folder: a.fid,
      from: b.fid,
      path: "x.txt",
      meta,
      expect: null,
      token: st.epoch,
    })
  ).result;
  await expect(
    link.call("putChunk", { id, folder: notesA.fid, from: notesB.fid }, Buffer.from("abc")),
  ).rejects.toThrow("unknown upload");
  await link.call("putChunk", { id, folder: a.fid, from: b.fid }, Buffer.from("abc"));
  await link.call("putCommit", { id, folder: a.fid, from: b.fid });
  expect(tree(a.folder)).toEqual({ "x.txt": "abc" });
  expect(tree(notesA.path)).toEqual({});
});

test("folders: Tandem 0.2.0's one folder and its pairs carry over, and the next sync is not a first sync", async () => {
  const a = await tandem("Office PC", { "kept.tex": "k", "gone.tex": "g" });
  const b = await tandem("Laptop");
  const ids = await pair(a.core, b.core);
  await syncNow(b.core, ids.onB);
  // as 0.2.0 kept them: one folder, the pairs as its copies with their keys, the folder's list as "folder"
  for (const { core, fid } of [a, b]) {
    await core.stop();
    const f = core.config.folders[0];
    const dev = core.config.devices[0];
    const copy = f.copies[0] as DeviceCopy;
    const path = join(core.stateDir, "config.json");
    const now = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        device: now.device,
        port: 0,
        folder: f.path,
        ignore: f.ignore,
        keepDays: 90,
        theme: "auto",
        lang: "auto",
        copies: [
          {
            kind: "device",
            id: copy.id,
            name: dev.name,
            added: copy.added,
            lastSync: copy.lastSync,
            deviceId: dev.id,
            key: dev.key,
            address: dev.address,
          },
        ],
      }),
    );
    const db = new Db(join(core.stateDir, "index.db"));
    db.rename(`folder:${fid}`, "folder");
    db.close();
  }
  const [a2, b2] = [a, b].map(
    (x) => new Core(x.core.stateDir, { discovery: false, bind: "127.0.0.1", port: 0 }),
  );
  for (const c of [a2, b2]) {
    await c.init();
    running.push(c);
  }
  a2.config.devices[0].address = `127.0.0.1:${b2.port}`;
  b2.config.devices[0].address = `127.0.0.1:${a2.port}`;
  expect(a2.config.folders.map((f) => f.path)).toEqual([a.folder]);
  expect(a2.config.devices.map((d) => d.name)).toEqual(["Laptop"]);
  expect((a2.config.folders[0].copies[0] as DeviceCopy).remote).toBe("legacy");

  rmSync(join(b.folder, "gone.tex"));
  b2.compare(ids.onB);
  const review = await reach(b2, "review");
  expect(review.first).toBe(false); // the record of the last sync is still there
  expect(b2.items().map((i) => [i.kind, i.path])).toEqual([["remove-there", "gone.tex"]]);
  b2.start();
  await reach(b2, "done");
  expect(tree(a.folder)).toEqual({ "kept.tex": "k" });
  // and now each knows which folder the other's is
  expect((b2.config.folders[0].copies[0] as DeviceCopy).remote).toBe(a2.config.folders[0].id);
  expect((a2.config.folders[0].copies[0] as DeviceCopy).remote).toBe(b2.config.folders[0].id);
}, 20_000);
