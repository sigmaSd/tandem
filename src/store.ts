// One copy of the synced folder, as the sync sees it (src/plan.ts decides, src/apply.ts acts): list the
// files with their content hashes, read one, write one, take one away. LocalStore is a folder on this
// computer or on a plugged drive; src/remote.ts is the same thing on another computer, over the network.
//
// The rules every store keeps:
// - a file is never overwritten or deleted: the old one moves to .tandem/old/<time>/<same path> first;
// - a file arrives under a temporary name in .tandem/tmp/, is checked against its hash, then renamed into
//   place: a cable pulled mid-copy leaves no half-written file;
// - the caller says what it saw (`expect`, from its scan): if the file changed since, nothing is touched and
//   ChangedError is thrown, so a document being edited during a sync is not replaced under its author.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ignorer } from "./ignore.ts";
import { cleanRel, NameError, OWN, windowsTrouble } from "./names.ts";

/** A file as a scan saw it. `mtime` in whole milliseconds; `hash` is the SHA-256 of the content, in hex. */
export interface Entry {
  size: number;
  mtime: number;
  hash: string;
}
/** Every synced file of one copy, by its path inside the folder. */
export type Listing = Record<string, Entry>;

/**
 * What a scan found. `unread`: files that are there but could not be read (open in a program that locks
 * them, no permission), and folders that could not be opened (their path ends with "/"). They are not
 * absent: the sync must leave them, and their counterparts on the other side, alone.
 */
export interface Scan {
  files: Listing;
  unread: string[];
}

/** The file is no longer what the scan saw (edited, replaced or removed meanwhile): nothing was done. */
export class ChangedError extends Error {}

/** The copy itself is not there any more (a drive unplugged, a folder removed): nothing was done. */
export class GoneError extends Error {}

/**
 * A plain table without Object's own baggage: a file may be named "constructor" or "__proto__", and must be
 * neither found when absent nor mistaken for the table's prototype when written.
 */
export function bare<T>(from?: Record<string, T> | null): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from ?? {});
}

/** A file on its way in. Nothing shows in the folder until commit(). */
export interface Upload {
  write(chunk: Uint8Array): Promise<void>;
  /** Check size and hash, keep the replaced file as an old version under `stamp`, put the new one in place. */
  commit(stamp: string): Promise<Entry>;
  abort(): Promise<void>;
}

export interface FileMeta {
  size: number;
  hash: string;
  mtime: number;
}

export interface Store {
  /** Every file not left out by `ignore` (src/ignore.ts). */
  scan(ignore: string, progress?: (done: number, total: number) => void): Promise<Scan>;
  /** Up to `length` bytes of a file, from `offset`. */
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Start writing `path`. `expect`: what is there now according to the scan (null: nothing). */
  begin(path: string, meta: FileMeta, expect: Entry | null): Promise<Upload>;
  /** Take a file away (to the old versions). */
  retire(path: string, expect: Entry, stamp: string): Promise<void>;
  /** The other computer's record of what both sides held after the last sync, when the copy keeps one. */
  loadBase?(): Promise<Record<string, string> | null>;
  saveBase?(files: Record<string, string>): Promise<void>;
}

export interface OldVersion {
  /** When it was replaced or deleted (names.ts stampOf). */
  stamp: string;
  path: string;
  size: number;
}

/** Bytes per read when copying: small enough to send in one network message, large enough to be quick. */
export const CHUNK = 4 << 20;

export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Flush a folder's list of names to the disk. Best effort: Windows can't, and does it by itself. */
async function syncDir(dir: string) {
  try {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* not supported here */
  }
}

export class LocalStore implements Store {
  readonly root: string;
  readonly #cacheFile?: string;
  readonly #marker?: string;
  /** What the last scan (or write) found: unchanged files are not hashed again. */
  #known: Listing = bare();
  #loaded = false;
  /** Files whose name on disk is not NFC (made on an older Mac): path as we name it → as the disk does. */
  readonly #onDisk = new Map<string, string>();
  #ownMade = false;

  /**
   * `cacheFile`: where the hashes are remembered between runs (outside the folder), when given.
   * `marker`: the id this copy's .tandem/copy.json must carry (a drive, src/drives.ts): with another drive
   * mounted at the same place, or none, the store refuses to work rather than write somewhere else.
   */
  constructor(root: string, cacheFile?: string, marker?: string) {
    this.root = root;
    this.#cacheFile = cacheFile;
    this.#marker = marker;
  }

  /** Whether the copy is there: its folder exists, and it is the expected one. */
  async present(): Promise<boolean> {
    try {
      if (!(await stat(this.root)).isDirectory()) return false;
      if (!this.#marker) return true;
      const m = JSON.parse(await readFile(join(this.root, OWN, "copy.json"), "utf8")) as { id?: string };
      return m.id === this.#marker;
    } catch {
      return false;
    }
  }

  /** Nothing is read from or written to a copy that is gone: its folder is never made again by accident. */
  async #mustBeThere() {
    if (!(await this.present())) throw new GoneError(`${this.root} is not there any more`);
  }

  #abs(rel: string) {
    return join(this.root, ...(this.#onDisk.get(rel) ?? rel).split("/"));
  }

  /** Tandem's folder inside this one, made (and hidden on Windows) on first use. */
  async #own(...parts: string[]) {
    const own = join(this.root, OWN);
    if (!this.#ownMade) {
      // not recursive: the folder itself must exist (never recreated where a drive used to be)
      await mkdir(own).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      this.#ownMade = true;
      if (process.platform === "win32") execFile("attrib", ["+h", own], () => {}); // best effort
    }
    return join(own, ...parts);
  }

  async #loadKnown() {
    if (this.#loaded || !this.#cacheFile) return;
    this.#loaded = true;
    try {
      this.#known = bare(JSON.parse(await readFile(this.#cacheFile, "utf8")) as Listing);
    } catch {
      /* no cache yet, or unreadable: every file is hashed */
    }
  }

  async #saveKnown() {
    if (!this.#cacheFile) return;
    try {
      await mkdir(dirname(this.#cacheFile), { recursive: true });
      await writeFile(this.#cacheFile, JSON.stringify(this.#known));
    } catch {
      /* only a cache */
    }
  }

  async scan(ignore: string, progress?: (done: number, total: number) => void): Promise<Scan> {
    await this.#mustBeThere();
    await this.#loadKnown();
    const skip = ignorer(ignore);
    const found: string[] = [];
    const unread: string[] = [];
    this.#onDisk.clear();
    const walk = async (dir: string, rel: string) => {
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if (!rel) throw e; // the folder itself can't be read: say so
        unread.push(`${rel}/`); // a folder inside that can't be opened: there, but unknown
        return;
      }
      for (const it of items) {
        const name = it.name.normalize("NFC");
        const path = rel ? `${rel}/${name}` : name;
        if (name.includes("\\")) continue; // can't exist on Windows, and "\" is not a separator for us
        if (it.name !== name)
          this.#onDisk.set(path, rel ? `${this.#onDisk.get(rel) ?? rel}/${it.name}` : it.name);
        if (it.isDirectory()) {
          if (!skip(path, true)) await walk(join(dir, it.name), path);
        } else if (it.isFile() && !skip(path, false)) found.push(path); // links and devices are left alone
      }
    };
    await walk(this.root, "");

    const listing: Listing = bare();
    const now = Date.now();
    let done = 0;
    for (const rel of found.sort()) {
      progress?.(done++, found.length);
      let st;
      try {
        st = await lstat(this.#abs(rel));
      } catch (e) {
        if (!isMissing(e)) unread.push(rel); // listed but not readable: there, unknown
        continue; // else gone since the walk
      }
      const size = st.size;
      const mtime = Math.round(st.mtimeMs);
      const known = this.#known[rel];
      // a file changed in the last seconds is hashed again: a second edit could keep both size and time
      if (known && known.size === size && known.mtime === mtime && now - mtime > 3000) {
        listing[rel] = known;
        continue;
      }
      try {
        listing[rel] = { size, mtime, hash: await hashFile(this.#abs(rel)) };
      } catch (e) {
        // deleted meanwhile: gone. Anything else (locked by another program, no permission): there, unknown
        if (!isMissing(e)) unread.push(rel);
      }
    }
    progress?.(found.length, found.length);
    this.#known = bare(listing);
    await this.#saveKnown();
    return { files: listing, unread };
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const rel = cleanRel(path);
    // only a plain file of the folder: never through a link to somewhere else on the computer
    await this.#noLinks(rel);
    if (!(await lstat(this.#abs(rel))).isFile()) throw new NameError(`${rel}: not a file`);
    const fh = await open(this.#abs(rel), "r");
    try {
      const buf = Buffer.alloc(Math.min(Math.max(0, length), 2 * CHUNK));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** The file must still be what the scan saw. */
  async #check(rel: string, expect: Entry | null) {
    let st;
    try {
      st = await lstat(this.#abs(rel));
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    if (!expect) {
      if (st) throw new ChangedError(`${rel}: a file appeared there`);
      return;
    }
    if (!st?.isFile() || st.size !== expect.size || Math.round(st.mtimeMs) !== expect.mtime)
      throw new ChangedError(`${rel}: changed since it was compared`);
  }

  /** No folder on the way to `rel` may be a link: it could lead outside the synced folder. */
  async #noLinks(rel: string) {
    const parts = rel.split("/").slice(0, -1);
    let dir = this.root;
    for (const part of parts) {
      dir = join(dir, part);
      let st;
      try {
        st = await lstat(dir);
      } catch (e) {
        if (isMissing(e)) return; // not there yet: we make it
        throw e;
      }
      if (st.isSymbolicLink()) throw new NameError(`${rel}: goes through a link`);
      if (!st.isDirectory()) throw new ChangedError(`${rel}: a file is in the way`);
    }
  }

  #usable(path: string) {
    const rel = cleanRel(path);
    const bad = process.platform === "win32" ? windowsTrouble(rel) : null;
    if (bad) throw new NameError(`${rel}: Windows can't hold a file named “${bad}”`);
    return rel;
  }

  /** Move a file of the folder to the old versions. */
  async #toOld(rel: string, stamp: string) {
    if (!/^\d{8}-\d{6}$/.test(stamp)) throw new NameError("not a time stamp");
    let target = await this.#own("old", stamp, ...rel.split("/"));
    for (let n = 2; ; n++) {
      try {
        await lstat(target);
      } catch {
        break;
      }
      target = await this.#own("old", `${stamp}-${n}`, ...rel.split("/")); // replaced twice in one sync
    }
    await mkdir(dirname(target), { recursive: true });
    await rename(this.#abs(rel), target);
  }

  async begin(path: string, meta: FileMeta, expect: Entry | null): Promise<Upload> {
    const rel = this.#usable(path);
    await this.#mustBeThere();
    await this.#noLinks(rel);
    await this.#check(rel, expect);
    const tmp = await this.#own("tmp", randomBytes(8).toString("hex"));
    await mkdir(dirname(tmp), { recursive: true });
    const fh = await open(tmp, "wx");
    const hash = createHash("sha256");
    let written = 0;
    let closed = false;
    const drop = async () => {
      if (!closed) await fh.close().catch(() => {});
      closed = true;
      await rm(tmp, { force: true }).catch(() => {});
    };
    return {
      write: async (chunk) => {
        written += chunk.length;
        if (written > meta.size) throw new ChangedError(`${rel}: grew while it was copied`);
        hash.update(chunk);
        await fh.write(chunk);
      },
      commit: async (stamp) => {
        try {
          await fh.sync(); // on the disk before it replaces anything (a drive pulled right after)
          await fh.close();
          closed = true;
          if (written !== meta.size || hash.digest("hex") !== meta.hash)
            throw new ChangedError(`${rel}: changed while it was copied`);
          await utimes(tmp, new Date(), new Date(meta.mtime)).catch(() => {}); // keeps the document's date
          await this.#mustBeThere();
          await this.#check(rel, expect);
          if (expect) await this.#toOld(rel, stamp);
          const dest = this.#abs(rel);
          await mkdir(dirname(dest), { recursive: true });
          await rename(tmp, dest);
          await syncDir(dirname(dest)); // the new name itself on the disk, for a drive pulled right after
          const st = await lstat(dest);
          const entry = { size: st.size, mtime: Math.round(st.mtimeMs), hash: meta.hash };
          this.#known[rel] = entry;
          return entry;
        } catch (e) {
          await drop();
          throw e;
        }
      },
      abort: drop,
    };
  }

  async retire(path: string, expect: Entry, stamp: string) {
    const rel = cleanRel(path);
    await this.#mustBeThere();
    await this.#noLinks(rel);
    await this.#check(rel, expect);
    await this.#toOld(rel, stamp);
    delete this.#known[rel];
    this.#onDisk.delete(rel);
    // folders left empty go too (never the synced folder itself)
    let dir = dirname(this.#abs(rel));
    for (let n = rel.split("/").length - 1; n > 0; n--) {
      try {
        await rmdir(dir);
      } catch {
        break; // not empty
      }
      dir = dirname(dir);
    }
  }

  /** Remember the hashes now (after a sync wrote files). */
  async flush() {
    await this.#saveKnown();
  }

  /** What a file is right now (for an old version put back), or null. */
  async current(path: string): Promise<Entry | null> {
    const rel = cleanRel(path);
    try {
      const st = await lstat(this.#abs(rel));
      if (!st.isFile()) return null;
      return { size: st.size, mtime: Math.round(st.mtimeMs), hash: await hashFile(this.#abs(rel)) };
    } catch {
      return null;
    }
  }

  /** The replaced and deleted files kept in this folder, newest first. */
  async listOld(): Promise<OldVersion[]> {
    const out: OldVersion[] = [];
    const base = join(this.root, OWN, "old");
    const walk = async (dir: string, stamp: string, rel: string) => {
      for (const it of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) await walk(join(dir, it.name), stamp, path);
        else if (it.isFile()) {
          const st = await lstat(join(dir, it.name)).catch(() => null);
          if (st) out.push({ stamp, path, size: st.size });
        }
      }
    };
    for (const it of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (it.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(it.name))
        await walk(join(base, it.name), it.name, "");
    }
    return out.sort((a, b) =>
      a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.path.localeCompare(b.path),
    );
  }

  /** Where an old version is on the disk (to open it). */
  oldPath(stamp: string, path: string) {
    if (!/^\d{8}-\d{6}(-\d+)?$/.test(stamp)) throw new NameError("not a time stamp");
    return join(this.root, OWN, "old", stamp, ...cleanRel(path).split("/"));
  }

  /** Put an old version back in the folder; what is there now becomes an old version itself (`stamp`). */
  async restoreOld(oldStamp: string, path: string, stamp: string) {
    const rel = cleanRel(path);
    const from = this.oldPath(oldStamp, rel);
    const st = await lstat(from);
    const meta = { size: st.size, hash: await hashFile(from), mtime: Math.round(st.mtimeMs) };
    const up = await this.begin(rel, meta, await this.current(rel));
    try {
      for await (const chunk of createReadStream(from, { highWaterMark: CHUNK }))
        await up.write(chunk as Buffer);
      await up.commit(stamp);
    } catch (e) {
      await up.abort();
      throw e;
    }
    await this.#saveKnown();
  }

  /** Forget old versions kept for longer than `days`; returns how many folders went. */
  async pruneOld(days: number, now = Date.now()) {
    const base = join(this.root, OWN, "old");
    let gone = 0;
    for (const it of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(it.name);
      if (!m || !it.isDirectory()) continue;
      const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (now - at > days * 86_400_000) {
        await rm(join(base, it.name), { recursive: true, force: true }).catch(() => {});
        gone++;
      }
    }
    return gone;
  }

  /** Drop what interrupted copies left behind. Only when nothing is being written (at start). */
  async cleanTmp() {
    await rm(join(this.root, OWN, "tmp"), { recursive: true, force: true }).catch(() => {});
  }
}

/** Copy one file from a store to another, in pieces; returns what now is at the destination. */
export async function transfer(
  from: Store,
  to: Store,
  path: string,
  source: Entry,
  expect: Entry | null,
  stamp: string,
  destPath = path,
  moved?: (bytes: number) => void,
): Promise<Entry> {
  const up = await to.begin(destPath, source, expect);
  try {
    for (let offset = 0; offset < source.size;) {
      const chunk = await from.read(path, offset, CHUNK);
      if (!chunk.length) break; // shorter than the scan said: commit() refuses it
      await up.write(chunk);
      offset += chunk.length;
      moved?.(chunk.length);
    }
    return await up.commit(stamp);
  } catch (e) {
    await up.abort().catch(() => {});
    throw e;
  }
}
