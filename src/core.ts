// Tandem itself, without any window: the synced folder, its other copies (paired computers and drives), and
// the one sync that can run at a time (compare → review → apply → done). The window drives it through
// src/server.ts; other computers reach it through src/peer.ts (`call` below answers them). No Electron here:
// what only a desktop shell can do (folder dialogs, opening a file) comes in as `shell`.
//
// What it keeps, in its own folder (never inside the synced one):
//   config.json     this computer's name and id, the folder, the copies and their keys (readable by the user only)
//   base/<copy>.json  what both sides held after the last sync with that copy (src/plan.ts)
//   cache/<copy>.json the hashes of unchanged files, so they aren't read again at each sync
//   view/           files fetched from another computer to look at them, emptied at start

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { apply, type Choice, type Outcome, type Progress } from "./apply.ts";
import { diffLines, looksBinary, type Row, toLines } from "./diff.ts";
import { Discovery, DISCOVERY_PORT, localAddresses } from "./discovery.ts";
import { type Drive, findCopy, listDrives, placeOnDrive, readMarker, writeMarker } from "./drives.ts";
import { currentLang, msg, resolveLang, setCoreLanguage } from "./i18n.ts";
import { DEFAULT_IGNORE } from "./ignore.ts";
import { loadLocales } from "./locales.ts";
import { cleanRel, isTextName, OWN, stampOf } from "./names.ts";
import { type Answer, PeerServer } from "./peer.ts";
import { type Action, agreedBase, plan, type Side } from "./plan.ts";
import type { Translations } from "./po.ts";
import { hello, Link, pairWith, Refused, RemoteStore, Unreachable } from "./remote.ts";
import { codeKey, isCode, newCode } from "./secure.ts";
import {
  bare,
  CHUNK,
  ChangedError,
  type Entry,
  type Listing,
  LocalStore,
  type OldVersion,
  type Store,
  type Upload,
} from "./store.ts";

/** The listener's usual port, so an address can be typed without one. */
export const PEER_PORT = 47811;

interface CopyBase {
  id: string;
  name: string;
  added: number;
  lastSync?: number;
}
/** Another computer, paired with this one. */
export interface DeviceCopy extends CopyBase {
  kind: "device";
  deviceId: string;
  /** The pair's key (base64). */
  key: string;
  /** Where it last answered (host:port). */
  address?: string;
}
/** A folder on a drive. */
export interface DriveCopy extends CopyBase {
  kind: "drive";
  marker: string;
  path: string;
  /** Its place below the drive's mount point, when it is on a drive we can find again. */
  sub?: string;
}
export type Copy = DeviceCopy | DriveCopy;

export interface Config {
  device: { id: string; name: string };
  port: number;
  folder: string | null;
  ignore: string;
  /** Days an old version is kept. */
  keepDays: number;
  theme: "auto" | "light" | "dark";
  lang: string;
  copies: Copy[];
}

/** What only the desktop shell can do. */
export interface ShellHooks {
  chooseFolder(title: string, start?: string): Promise<string | null>;
  /** Open a file or folder with the system's program. */
  open(path: string): Promise<void>;
  setTheme?(theme: Config["theme"]): void;
  installUpdate?(): void;
}

/** An error whose message is meant for the user, already in their language. */
export class UserError extends Error {}

/** One line of the review screen. */
export interface Item {
  path: string;
  kind: "send" | "receive" | "remove-here" | "remove-there" | "conflict" | "clash" | "unread";
  /** send/receive: the file doesn't exist on the other side yet. */
  fresh?: boolean;
  /** conflict: the side that deleted the file, when one did. */
  gone?: Side;
  here?: { size: number; mtime: number };
  there?: { size: number; mtime: number };
  choice?: Choice;
  /** Can be shown side by side as text. */
  text: boolean;
  /** clash: the names it collides with. */
  with?: string[];
}

export interface Summary {
  sent: number;
  received: number;
  removed: number;
  bothKept: number;
  unanswered: number;
  /** Files that could not be synced, with why. */
  problems: Outcome[];
  /** The sync stopped because a side went away. */
  lost?: "here" | "there";
  cancelled: boolean;
  /** The record of the sync could not be saved on one side: the next sync will ask more than needed. */
  unsaved: boolean;
  /** Nothing is left to do: the two copies match. */
  inSync: boolean;
  /** Old versions this sync made (replaced and deleted files). */
  kept: number;
}

export type Job =
  | { phase: "scanning"; copyId: string; here: [number, number]; there: [number, number] }
  | {
      phase: "review";
      copyId: string;
      rev: number;
      first: boolean;
      counts: Record<Item["kind"], number>;
      open: number;
    }
  | { phase: "applying"; copyId: string; progress: Progress }
  | { phase: "done"; copyId: string; at: number; summary: Summary }
  | { phase: "error"; copyId: string; message: string };

interface Working {
  copy: Copy;
  a: LocalStore;
  b: Store;
  listA: Listing;
  listB: Listing;
  base: Record<string, string>;
  actions: Action[];
  choices: Record<string, Choice>;
  first: boolean;
  /** #baseWrites for this copy when the comparison was made. */
  rev: number;
}

export interface CoreOptions {
  /** Shout on the network and listen for other computers (off in tests). */
  discovery?: boolean;
  discoveryPort?: number;
  /** The listener's address: every interface, or 127.0.0.1 in tests. */
  bind?: string;
  /** The listener's port when the config has none yet. */
  port?: number;
}

const noShell: ShellHooks = {
  chooseFolder: () => Promise.resolve(null),
  open: () => Promise.resolve(),
};

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const isEntry = (e: unknown): e is Entry => {
  const x = e as Entry;
  return (
    !!x &&
    Number.isSafeInteger(x.size) &&
    x.size >= 0 &&
    Number.isFinite(x.mtime) &&
    /^[0-9a-f]{64}$/.test(String(x.hash))
  );
};
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Written whole or not at all: a crash never leaves half a file. */
async function writeJson(path: string, value: unknown, mode?: number) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${hex(4)}.tmp`;
  const fh = await open(tmp, "w", mode ?? 0o644);
  try {
    await fh.writeFile(JSON.stringify(value));
    await fh.sync(); // on the disk before it takes the old one's place: a power cut leaves one or the other
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

/** Is `inner` the same folder as `outer`, or inside it? */
function within(outer: string, inner: string) {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

export class Core {
  readonly stateDir: string;
  config!: Config;
  shell: ShellHooks = noShell;
  appVersion = "dev";
  /** A downloaded update waiting for a restart. */
  update: string | null = null;
  systemLocales: readonly string[] = [];
  localesDir?: string;
  job: Job | null = null;
  /** The pairing code on screen. */
  pairing: { code: string; key: Buffer; until: number; tries: number } | null = null;

  readonly #options: CoreOptions;
  readonly #listeners = new Set<() => void>();
  readonly #peer: PeerServer;
  #discovery?: Discovery;
  #local?: LocalStore;
  #work: Working | null = null;
  #cancel = false;
  readonly #uploads = new Map<string, { upload: Upload; at: number }>();
  /** Which drive copies are plugged in, and where. */
  readonly #plugged = new Map<string, string | null>();
  #drives: Drive[] = [];
  #watch?: ReturnType<typeof setInterval>;
  #pairTimer?: ReturnType<typeof setTimeout>;
  /** A paired computer is working in this folder right now. */
  #guest: string | null = null;
  #guestTimer?: ReturnType<typeof setTimeout>;
  #locales: Record<string, Translations> = {};
  #lastEmit = 0;
  /**
   * Names the synced folder for the computers that sync with it during this run: new at each start and each
   * time the folder is changed, so a request planned against another folder is refused (#answer).
   */
  #folderToken = hex(8);
  /** How many times each copy's base was written here: a review older than the last write is out of date. */
  readonly #baseWrites = new Map<string, number>();
  /** A base arriving in pieces from another computer, by copy. */
  readonly #incoming = new Map<string, Record<string, string>>();
  #emitTimer?: ReturnType<typeof setTimeout>;

  constructor(stateDir: string, options: CoreOptions = {}) {
    this.stateDir = stateDir;
    this.#options = options;
    this.#peer = new PeerServer({
      device: () => this.config.device,
      keyOf: (id) => {
        const c = this.#device(id);
        return c ? Buffer.from(c.key, "base64") : null;
      },
      pairingKey: () => (this.pairing && Date.now() < this.pairing.until ? this.pairing.key : null),
      wrongCode: () => {
        if (this.pairing && ++this.pairing.tries >= 5) this.stopPairing(); // the code is burnt: show a new one
      },
      paired: (peer) => {
        void this.#addDevice(
          peer.id,
          peer.name,
          peer.key,
          peer.address.endsWith(":0") ? undefined : peer.address,
        );
        this.stopPairing();
      },
      seen: (id, address) => {
        const c = this.#device(id);
        if (c && c.address !== address) {
          c.address = address;
          void this.#save();
        }
      },
      call: (id, method, args, payload) => this.#answer(id, method, args, payload),
    });
  }

  // ------------------------------------------------------------------ start, stop, settings

  async init() {
    await mkdir(this.stateDir, { recursive: true });
    const saved = await readJson<Partial<Config>>(join(this.stateDir, "config.json"));
    this.config = {
      device: saved?.device ?? { id: hex(16), name: hostname().split(".")[0].slice(0, 40) || "Computer" },
      port: saved?.port ?? this.#options.port ?? PEER_PORT,
      folder: saved?.folder ?? null,
      ignore: saved?.ignore ?? DEFAULT_IGNORE,
      keepDays: saved?.keepDays ?? 90,
      theme: saved?.theme ?? "auto",
      lang: saved?.lang ?? "auto",
      copies: saved?.copies ?? [],
    };
    if (!saved) await this.#save();
    if (this.localesDir) this.#locales = await loadLocales(this.localesDir);
    this.applyLanguage();
    await rm(join(this.stateDir, "view"), { recursive: true, force: true }).catch(() => {});
    const local = await this.#folderStore().catch(() => null);
    if (local) {
      await local.cleanTmp();
      await local.pruneOld(this.config.keepDays);
    }
    await this.#peer.listen(this.config.port, this.#options.bind);
    if (this.#options.discovery !== false) {
      this.#discovery = new Discovery(
        () => ({
          id: this.config.device.id,
          name: this.config.device.name,
          port: this.#peer.port,
          pairing: !!this.pairing,
        }),
        () => this.changed(),
        this.#options.discoveryPort ?? DISCOVERY_PORT,
      );
      this.#discovery.start();
    }
    await this.#lookForDrives();
    this.#watch = setInterval(() => void this.#lookForDrives(), 3000);
    this.#watch.unref?.();
  }

  stop() {
    clearInterval(this.#watch);
    clearTimeout(this.#pairTimer);
    clearTimeout(this.#emitTimer);
    clearTimeout(this.#guestTimer);
    this.#cancel = true;
    this.#discovery?.stop();
    this.#peer.close();
  }

  /** The port other computers reach this one on. */
  get port() {
    return this.#peer.port;
  }

  onChange(fn: () => void) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Tell the window something changed (at most a few times a second: progress moves fast). */
  changed() {
    const wait = 120 - (performance.now() - this.#lastEmit); // a clock that never steps back
    if (wait > 0) {
      this.#emitTimer ??= setTimeout(() => {
        this.#emitTimer = undefined;
        this.changed();
      }, wait);
      return;
    }
    this.#lastEmit = performance.now();
    for (const fn of this.#listeners) fn();
  }

  async #save() {
    await writeJson(join(this.stateDir, "config.json"), this.config, 0o600);
  }

  applyLanguage() {
    const lang = resolveLang(this.config.lang, this.systemLocales, ["en", ...Object.keys(this.#locales)]);
    setCoreLanguage(lang, this.#locales[lang] ?? null);
  }

  /** The window's language and its catalog. */
  language() {
    const lang = currentLang();
    return { lang, catalog: this.#locales[lang] ?? null, available: ["en", ...Object.keys(this.#locales)] };
  }

  async setSettings(patch: Record<string, unknown>) {
    const c = this.config;
    if (typeof patch.name === "string" && patch.name.trim()) c.device.name = patch.name.trim().slice(0, 40);
    if (typeof patch.ignore === "string" && patch.ignore.length < 20_000) c.ignore = patch.ignore;
    if (Number.isInteger(patch.keepDays)) c.keepDays = Math.min(3650, Math.max(1, patch.keepDays as number));
    if (patch.theme === "auto" || patch.theme === "light" || patch.theme === "dark") {
      c.theme = patch.theme;
      this.shell.setTheme?.(c.theme);
    }
    if (typeof patch.lang === "string" && /^[a-zA-Z-]{2,12}$/.test(patch.lang)) {
      c.lang = patch.lang;
      this.applyLanguage();
    }
    await this.#save();
    this.#discovery?.shout();
    this.changed();
  }

  // ------------------------------------------------------------------ the folder and its copies

  #busy() {
    return this.job?.phase === "scanning" || this.job?.phase === "applying";
  }

  async #folderStore(): Promise<LocalStore> {
    const folder = this.config.folder;
    if (!folder) throw new UserError(msg("errNoFolder"));
    if (this.#local?.root !== folder)
      this.#local = new LocalStore(folder, join(this.stateDir, "cache", "folder.json"));
    return this.#local;
  }

  /** Choose the folder to keep in sync (made when it doesn't exist yet). */
  async setFolder(path: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    const folder = resolve(path.trim());
    if (folder.split(sep).includes(OWN)) throw new UserError(msg("errInsideOwn"));
    try {
      await mkdir(folder, { recursive: true });
      if (!(await stat(folder)).isDirectory()) throw new Error("not a folder");
    } catch (e) {
      throw new UserError(msg("errFolder", { path: folder, error: (e as Error).message }));
    }
    if (folder !== this.config.folder) {
      // another folder: what was remembered about the old one is not true of this one
      await rm(join(this.stateDir, "base"), { recursive: true, force: true });
      await rm(join(this.stateDir, "cache"), { recursive: true, force: true });
      for (const c of this.config.copies) delete c.lastSync;
      this.job = null;
      this.#work = null;
      this.#folderToken = hex(8);
      this.#incoming.clear();
      for (const [id, u] of this.#uploads) {
        void u.upload.abort(); // a file on its way into the old folder
        this.#uploads.delete(id);
      }
    }
    this.config.folder = folder;
    await this.#save();
    this.changed();
  }

  /** Ask for a folder with the system's dialog; null when cancelled. */
  chooseFolder(kind: "folder" | "drive") {
    return this.shell.chooseFolder(
      msg(kind === "folder" ? "chooseFolderTitle" : "chooseDriveTitle"),
      this.config.folder ?? undefined,
    );
  }

  #device(deviceId: string) {
    return this.config.copies.find((c): c is DeviceCopy => c.kind === "device" && c.deviceId === deviceId);
  }

  #copy(id: string): Copy {
    const copy = this.config.copies.find((c) => c.id === id);
    if (!copy) throw new UserError("unknown copy");
    return copy;
  }

  async #addDevice(deviceId: string, name: string, key: Buffer, address?: string) {
    const old = this.#device(deviceId);
    if (old) {
      // paired again (the other side forgot us): same copy, new key
      old.key = key.toString("base64");
      old.name = name || old.name;
      old.address = address ?? old.address;
    } else {
      this.config.copies.push({
        kind: "device",
        id: hex(8),
        name: name || "Computer",
        added: Date.now(),
        deviceId,
        key: key.toString("base64"),
        address,
      });
    }
    await this.#save();
    this.changed();
  }

  /**
   * Add a copy on a drive. `path` is the folder that holds (or will hold) the copy; with `inside`, a folder
   * named like the synced one is made in it (for a drive's top: its other files are none of our business).
   */
  async addDrive(path: string, inside = false) {
    const folder = this.config.folder;
    if (!folder) throw new UserError(msg("errNoFolder"));
    const picked = resolve(path.trim());
    let dir = picked;
    if (inside && !(await readMarker(dir))) dir = join(dir, basename(folder));
    if (resolve(dir) === resolve(folder)) throw new UserError(msg("errSameFolder"));
    if (within(folder, dir) || within(dir, folder)) throw new UserError(msg("errNested"));
    if (dir.split(sep).includes(OWN)) throw new UserError(msg("errInsideOwn"));
    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      throw new UserError(msg("errFolder", { path: dir, error: (e as Error).message }));
    }
    let marker = await readMarker(dir);
    if (!marker) {
      marker = { id: hex(16), name: basename(folder) };
      await writeMarker(dir, marker);
    }
    const place = await placeOnDrive(dir);
    // named after the drive, or for a plain folder after the folder that was chosen
    const name = place
      ? process.platform === "win32"
        ? place.root.slice(0, 2)
        : basename(place.root)
      : basename(picked);
    const old = this.config.copies.find((c) => c.kind === "drive" && c.marker === marker.id);
    if (old?.kind === "drive") {
      old.path = dir;
      old.sub = place?.sub;
    } else {
      this.config.copies.push({
        kind: "drive",
        id: hex(8),
        name,
        added: Date.now(),
        marker: marker.id,
        path: dir,
        sub: place?.sub,
      });
    }
    await this.#save();
    await this.#lookForDrives();
    this.changed();
  }

  async renameCopy(id: string, name: string) {
    if (name.trim()) this.#copy(id).name = name.trim().slice(0, 40);
    await this.#save();
    this.changed();
  }

  async removeCopy(id: string) {
    if (this.job?.copyId === id && this.#busy()) throw new UserError(msg("errBusy"));
    this.config.copies = this.config.copies.filter((c) => c.id !== id);
    if (this.job?.copyId === id) this.closeJob();
    await rm(join(this.stateDir, "base", `${id}.json`), { force: true });
    await rm(join(this.stateDir, "cache", `${id}.json`), { force: true });
    await this.#save();
    this.changed();
  }

  async #lookForDrives() {
    let moved = false;
    for (const c of this.config.copies) {
      if (c.kind !== "drive") continue;
      const at = await findCopy(c);
      if (this.#plugged.get(c.id) !== at) moved = true;
      this.#plugged.set(c.id, at);
      if (at && at !== c.path) {
        c.path = at;
        void this.#save();
      }
    }
    const drives = await listDrives().catch(() => []);
    if (
      JSON.stringify(drives.map((d) => [d.root, d.copies])) !==
      JSON.stringify(this.#drives.map((d) => [d.root, d.copies]))
    )
      moved = true;
    this.#drives = drives;
    if (moved) this.changed();
  }

  // ------------------------------------------------------------------ pairing

  /** Show a pairing code for ten minutes. */
  async startPairing() {
    const code = newCode();
    this.pairing = {
      code,
      key: await codeKey(code, this.config.device.id),
      until: Date.now() + 10 * 60_000,
      tries: 0,
    };
    clearTimeout(this.#pairTimer);
    this.#pairTimer = setTimeout(() => this.stopPairing(), 10 * 60_000);
    this.#pairTimer.unref?.();
    this.#discovery?.shout();
    this.changed();
    return code;
  }

  stopPairing() {
    if (!this.pairing) return;
    this.pairing = null;
    clearTimeout(this.#pairTimer);
    this.#discovery?.shout();
    this.changed();
  }

  /** Pair with the computer showing `code`, at `address` (host, or host:port). */
  async pair(address: string, code: string) {
    if (!isCode(code)) throw new UserError(msg("errBadCode"));
    let at = address
      .trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    if (!/:\d+$/.test(at)) at = `${at}:${PEER_PORT}`;
    try {
      const them = await hello(at);
      if (them.id === this.config.device.id) throw new UserError(msg("errSelf"));
      const peer = await pairWith(at, code, { ...this.config.device, port: this.#peer.port });
      await this.#addDevice(peer.id, peer.name, peer.key, at);
    } catch (e) {
      if (e instanceof Unreachable) throw new UserError(msg("errNoTandemAt", { address: at }));
      if (e instanceof Refused)
        throw new UserError(
          msg(
            e.message === "version"
              ? "errVersion"
              : e.message === "not pairing"
                ? "errNotPairing"
                : "errWrongCode",
          ),
        );
      throw e;
    }
  }

  // ------------------------------------------------------------------ a sync

  /** The store of a copy, reachable now; a UserError says why not. */
  async #storeOf(copy: Copy): Promise<Store> {
    if (copy.kind === "drive") {
      const at = await findCopy(copy);
      this.#plugged.set(copy.id, at); // the window's "plugged in" follows what was just found
      if (!at) throw new UserError(msg("errNotPlugged", { name: copy.name }));
      copy.path = at;
      return new LocalStore(at, join(this.stateDir, "cache", `${copy.id}.json`), copy.marker);
    }
    const addresses = [...new Set([this.#discovery?.find(copy.deviceId)?.address, copy.address])].filter(
      (a) => a !== undefined,
    );
    let refused = false;
    for (const address of addresses) {
      const remote = new RemoteStore(
        new Link(
          address,
          { id: this.config.device.id, port: this.#peer.port },
          copy.deviceId,
          Buffer.from(copy.key, "base64"),
        ),
      );
      try {
        const info = await remote.info();
        if (!info.folder) throw new UserError(msg("errNoFolderThere", { name: copy.name }));
        if (copy.address !== address || (info.name && info.name !== copy.name)) {
          copy.address = address;
          copy.name = info.name || copy.name;
          void this.#save();
        }
        return remote;
      } catch (e) {
        if (e instanceof Refused) refused = true;
        else if (!(e instanceof Unreachable)) throw e;
      }
    }
    throw new UserError(msg(refused ? "errRefused" : "errUnreachable", { name: copy.name }));
  }

  #basePath(copyId: string) {
    return join(this.stateDir, "base", `${copyId}.json`);
  }

  async #writeBase(copyId: string, files: Record<string, string>) {
    this.#baseWrites.set(copyId, (this.#baseWrites.get(copyId) ?? 0) + 1);
    await writeJson(this.#basePath(copyId), files);
  }

  /** Compare the folder with one of its copies; the job goes to "review" (or straight to "done"). */
  compare(copyId: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    const copy = this.#copy(copyId);
    this.#work = null;
    this.#cancel = false;
    this.job = { phase: "scanning", copyId, here: [0, 0], there: [0, 0] };
    this.changed();
    const run = async () => {
      const a = await this.#folderStore();
      if (!(await exists(a.root)))
        throw new UserError(msg("errFolder", { path: a.root, error: "not found" }));
      const b = await this.#storeOf(copy);
      const scanning = this.job as Extract<Job, { phase: "scanning" }>;
      const [scanA, scanB] = await Promise.all([
        a.scan(this.config.ignore, (done, total) => {
          scanning.here = [done, total];
          this.changed();
        }),
        b.scan(this.config.ignore, (done, total) => {
          scanning.there = [done, total];
          this.changed();
        }),
      ]);
      const listA = bare(scanA.files);
      const listB = bare(scanB.files);
      const rev = this.#baseWrites.get(copy.id) ?? 0;
      const mine = bare(await readJson<Record<string, string>>(this.#basePath(copy.id)));
      const base = b.loadBase ? agreedBase(mine, await b.loadBase()) : mine;
      // a side that held files at the last sync and shows none now is more likely a disk that is not there
      // (an empty mount point) than a folder emptied on purpose: stop rather than plan to delete everything
      const known = Object.keys(base).length;
      if (known > 0 && !scanA.unread.length && !scanB.unread.length) {
        if (!Object.keys(listA).length) throw new UserError(msg("errEmptiedHere", { n: known }));
        if (!Object.keys(listB).length)
          throw new UserError(msg("errEmptiedThere", { name: copy.name, n: known }));
      }
      const actions = plan(listA, listB, base, [...scanA.unread, ...scanB.unread]);
      this.#work = {
        copy,
        a,
        b,
        listA,
        listB,
        base,
        actions,
        choices: {},
        first: Object.keys(base).length === 0,
        rev,
      };
      if (this.#cancel) {
        // cancelled while comparing: back to the start, nothing was touched
        this.#work = null;
        this.job = null;
        return this.changed();
      }
      if (actions.every((x) => x.kind === "settle")) return await this.#apply(); // nothing to ask: done
      this.#review();
    };
    void run().catch((e: Error) => this.#failed(copyId, e));
  }

  #failed(copyId: string, e: Error) {
    if (!(e instanceof UserError)) console.error(e);
    this.#work = null;
    this.job = { phase: "error", copyId, message: e.message };
    this.changed();
  }

  #review() {
    const w = this.#work!;
    const items = this.items();
    const counts = {
      send: 0,
      receive: 0,
      "remove-here": 0,
      "remove-there": 0,
      conflict: 0,
      clash: 0,
      unread: 0,
    };
    for (const it of items) counts[it.kind]++;
    const prev = this.job?.phase === "review" ? this.job.rev : 0;
    this.job = {
      phase: "review",
      copyId: w.copy.id,
      rev: prev + 1,
      first: w.first,
      counts,
      open: items.filter((i) => i.kind === "conflict" && !i.choice).length,
    };
    this.changed();
  }

  /** The review screen's lines. */
  items(): Item[] {
    const w = this.#work;
    if (!w) return [];
    const meta = (e?: Entry) => (e ? { size: e.size, mtime: e.mtime } : undefined);
    const out: Item[] = [];
    for (const act of w.actions) {
      if (act.kind === "settle") continue;
      const here = meta(w.listA[act.path]);
      const there = meta(w.listB[act.path]);
      const common = { path: act.path, here, there, text: isTextName(act.path) };
      if (act.kind === "copy")
        out.push({ ...common, kind: act.from === "a" ? "send" : "receive", fresh: act.fresh });
      else if (act.kind === "delete")
        out.push({ ...common, kind: act.on === "a" ? "remove-here" : "remove-there" });
      else if (act.kind === "clash") out.push({ ...common, kind: "clash", with: act.with });
      else if (act.kind === "unread") out.push({ ...common, kind: "unread" });
      else out.push({ ...common, kind: "conflict", gone: act.gone, choice: w.choices[act.path] });
    }
    return out;
  }

  /** Answer one conflict (null: undecided again), or with `path` null every conflict at once. */
  choose(path: string | null, choice: Choice | null) {
    const w = this.#work;
    if (!w || this.job?.phase !== "review") return;
    for (const act of w.actions) {
      if (act.kind !== "conflict" || (path !== null && act.path !== path)) continue;
      if (choice) w.choices[act.path] = choice;
      else delete w.choices[act.path];
    }
    this.#review();
  }

  /** Carry out the plan as reviewed. */
  start() {
    if (this.job?.phase !== "review" || !this.#work) return;
    void this.#apply().catch((e: Error) => this.#failed(this.#work?.copy.id ?? "", e));
  }

  async #apply() {
    const w = this.#work!;
    const copy = w.copy;
    // the other computer synced with this one while the review sat open: its plan is about another state
    if ((this.#baseWrites.get(copy.id) ?? 0) !== w.rev)
      throw new UserError(msg("errStale", { name: copy.name }));
    this.#cancel = false;
    const blank: Progress = { done: 0, total: 0, path: "", bytes: 0, totalBytes: 0 };
    this.job = { phase: "applying", copyId: copy.id, progress: blank };
    this.changed();
    const now = new Date();
    const result = await apply({
      a: w.a,
      b: w.b,
      listA: w.listA,
      listB: w.listB,
      base: w.base,
      actions: w.actions,
      choices: w.choices,
      stamp: stampOf(now),
      nameB: copy.name,
      progress: (p) => {
        this.job = { phase: "applying", copyId: copy.id, progress: p };
        this.changed();
      },
      cancelled: () => this.#cancel,
      save: async () => {
        await this.#writeBase(copy.id, w.base);
        await w.b.saveBase?.(w.base);
      },
      alive: (side) =>
        side === "a"
          ? w.a.present()
          : w.b instanceof RemoteStore
            ? w.b.alive()
            : (w.b as LocalStore).present(),
    });
    await w.a.flush();
    if (w.b instanceof LocalStore) {
      await w.b.flush();
      await w.b.pruneOld(this.config.keepDays).catch(() => {});
    }
    await w.a.pruneOld(this.config.keepDays).catch(() => {});

    const count = (...kinds: Outcome["result"][]) =>
      result.outcomes.filter((o) => kinds.includes(o.result)).length;
    const problems = result.outcomes.filter((o) =>
      ["changed", "failed", "clash", "unread"].includes(o.result),
    );
    const summary: Summary = {
      sent: count("sent"),
      received: count("received"),
      removed: count("removed-here", "removed-there"),
      bothKept: count("both-kept"),
      unanswered: count("unanswered"),
      problems: problems.slice(0, 200),
      lost: result.lost === "a" ? "here" : result.lost === "b" ? "there" : undefined,
      cancelled: result.cancelled,
      unsaved: result.unsaved,
      inSync:
        !result.lost &&
        !result.cancelled &&
        !result.unsaved &&
        count("unanswered", "stopped") + problems.length === 0,
      kept: w.actions.filter((x) => {
        const r = result.outcomes.find((o) => o.path === x.path)?.result;
        return (
          (x.kind === "copy" && !x.fresh && (r === "sent" || r === "received")) ||
          (x.kind === "delete" && (r === "removed-here" || r === "removed-there")) ||
          (x.kind === "conflict" &&
            r !== undefined &&
            ["sent", "received", "removed-here", "removed-there", "both-kept"].includes(r))
        );
      }).length,
    };
    if (!result.lost) {
      copy.lastSync = now.getTime();
      await this.#save();
      if (w.b instanceof RemoteStore) await w.b.synced();
    }
    this.#work = null;
    this.job = { phase: "done", copyId: copy.id, at: now.getTime(), summary };
    this.changed();
  }

  /** Stop the running sync after the file being copied. */
  cancel() {
    this.#cancel = true;
    if (this.job?.phase === "review") this.closeJob();
  }

  /** Leave the review, done or error screen. */
  closeJob() {
    if (this.#busy()) return;
    this.job = null;
    this.#work = null;
    this.changed();
  }

  async #readAll(store: Store, path: string, size: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < size;) {
      const chunk = await store.read(path, offset, CHUNK);
      if (!chunk.length) break;
      parts.push(chunk);
      offset += chunk.length;
    }
    return Buffer.concat(parts);
  }

  /** The two versions of a file of the plan, side by side. */
  async diff(
    path: string,
  ): Promise<{ kind: "text"; rows: Row[]; paired: boolean } | { kind: "binary" | "big" }> {
    const w = this.#work;
    const rel = cleanRel(path);
    if (!w) throw new UserError(msg("errGoneMeanwhile"));
    const a = w.listA[rel];
    const b = w.listB[rel];
    if ((a?.size ?? 0) > 1 << 20 || (b?.size ?? 0) > 1 << 20) return { kind: "big" };
    try {
      const left = a ? await this.#readAll(w.a, rel, a.size) : new Uint8Array();
      const right = b ? await this.#readAll(w.b, rel, b.size) : new Uint8Array();
      if (looksBinary(left) || looksBinary(right)) return { kind: "binary" };
      const l = toLines(left);
      const r = toLines(right);
      const rows = diffLines(l, r);
      if (rows) return { kind: "text", rows, paired: true };
      // nothing in common: one after the other
      return {
        kind: "text",
        paired: false,
        rows: [
          ...l.slice(0, 3000).map((left, i): Row => ({ kind: "del", left, ln: i + 1 })),
          ...r.slice(0, 3000).map((right, i): Row => ({ kind: "add", right, rn: i + 1 })),
        ],
      };
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(msg("errGoneMeanwhile"));
    }
  }

  /** Open one side's version of a file of the plan with the system's program. */
  async openVersion(path: string, side: Side) {
    const w = this.#work;
    const rel = cleanRel(path);
    if (!w) throw new UserError(msg("errGoneMeanwhile"));
    if (side === "a") return this.shell.open(join(w.a.root, ...rel.split("/")));
    if (w.b instanceof LocalStore) return this.shell.open(join(w.b.root, ...rel.split("/")));
    // on another computer: fetched to look at, under its own name so the right program opens it
    const entry = w.listB[rel];
    if (!entry) throw new UserError(msg("errGoneMeanwhile"));
    const dir = join(this.stateDir, "view", hex(4));
    await mkdir(dir, { recursive: true });
    const file = join(dir, rel.split("/").pop()!);
    await writeFile(file, await this.#readAll(w.b, rel, entry.size), { mode: 0o400 });
    await this.shell.open(file);
  }

  // ------------------------------------------------------------------ old versions

  async oldVersions(): Promise<OldVersion[]> {
    if (!this.config.folder) return [];
    return (await (await this.#folderStore()).listOld()).slice(0, 2000);
  }

  async restore(stamp: string, path: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    await (await this.#folderStore()).restoreOld(stamp, path, stampOf(new Date()));
    this.changed();
  }

  async openOld(stamp: string, path: string) {
    await this.shell.open((await this.#folderStore()).oldPath(stamp, path));
  }

  async openFolder() {
    if (this.config.folder) await this.shell.open(this.config.folder);
  }

  // ------------------------------------------------------------------ what the window shows

  state() {
    const c = this.config;
    const seen = this.#discovery?.seen() ?? [];
    return {
      version: this.appVersion,
      update: this.update,
      device: { name: c.device.name },
      addresses: localAddresses().map((a) => (this.#peer.port === PEER_PORT ? a : `${a}:${this.#peer.port}`)),
      folder: c.folder ? { path: c.folder, name: basename(c.folder) } : null,
      settings: {
        ignore: c.ignore,
        keepDays: c.keepDays,
        theme: c.theme,
        lang: c.lang,
        defaultIgnore: DEFAULT_IGNORE,
      },
      copies: c.copies.map((copy) => ({
        id: copy.id,
        kind: copy.kind,
        name: copy.name,
        lastSync: copy.lastSync ?? null,
        where: copy.kind === "drive" ? copy.path : (copy.address ?? ""),
        available:
          copy.kind === "drive" ? !!this.#plugged.get(copy.id) : seen.some((s) => s.id === copy.deviceId),
      })),
      pairing: this.pairing ? { code: this.pairing.code, until: this.pairing.until } : null,
      /** Computers heard on the network that are not paired with this one yet. */
      nearby: seen
        .filter((s) => !this.#device(s.id))
        .map((s) => ({ name: s.name, address: s.address, pairing: s.pairing })),
      drives: this.#drives.map((d) => ({
        root: d.root,
        name: d.name,
        free: d.free,
        copies: d.copies.map((x) => ({
          path: x.path,
          name: x.name,
          known: c.copies.some((k) => k.kind === "drive" && k.marker === x.id),
        })),
      })),
      job: this.job,
      guest: this.#guest,
    };
  }

  // ------------------------------------------------------------------ what a paired computer may ask

  /**
   * Show "<name> is syncing with this computer" while a paired computer works in the folder. The notice goes
   * when that computer says it is done, or has asked nothing for a few seconds (it was closed, or cancelled):
   * the timer starts again at every request, so it can only fire after the last one.
   */
  #guestHere(name: string) {
    if (this.#guest !== name) {
      this.#guest = name;
      this.changed();
    }
    clearTimeout(this.#guestTimer);
    this.#guestTimer = setTimeout(() => this.#guestGone(), 4000);
    this.#guestTimer.unref?.();
  }

  #guestGone() {
    clearTimeout(this.#guestTimer);
    if (this.#guest === null) return;
    this.#guest = null;
    this.changed();
  }

  async #answer(
    deviceId: string,
    method: string,
    args: Record<string, unknown>,
    payload: Buffer,
  ): Promise<Answer> {
    const copy = this.#device(deviceId);
    if (!copy) throw new Error("not paired");
    if (method === "info") {
      return {
        result: {
          name: this.config.device.name,
          folder: this.config.folder ? basename(this.config.folder) : null,
          version: this.appVersion,
        },
      };
    }
    const store = await this.#folderStore();
    this.#guestHere(copy.name);

    for (const [id, u] of this.#uploads) {
      if (Date.now() - u.at > 30 * 60_000) {
        void u.upload.abort();
        this.#uploads.delete(id);
      }
    }
    const upload = () => {
      const u = this.#uploads.get(String(args.id));
      if (!u) throw new Error("unknown upload");
      u.at = Date.now();
      return u;
    };
    const expect = (): Entry | null => {
      if (args.expect === null || args.expect === undefined) return null;
      if (!isEntry(args.expect)) throw new Error("bad request");
      return args.expect;
    };
    /** The request was planned against the folder as it is now (not one changed, or a Tandem restarted, since). */
    const sameFolder = () => {
      if (args.token !== this.#folderToken)
        throw new ChangedError("the folder there is not the one that was compared");
    };
    // old versions are filed under this computer's own clock, whatever the caller's says: they are pruned by
    // age here, and a clock set wrong elsewhere must not age them
    const stamp = () => stampOf(new Date());
    switch (method) {
      case "scan":
        return {
          result: {
            ...(await store.scan(String(args.ignore ?? "").slice(0, 20_000))),
            token: this.#folderToken,
          },
        };
      case "read":
        sameFolder();
        return {
          payload: await store.read(
            String(args.path),
            Number(args.offset) || 0,
            Math.min(Number(args.length) || 0, CHUNK),
          ),
        };
      case "putBegin": {
        sameFolder();
        if (!isEntry(args.meta)) throw new Error("bad request");
        if (this.#uploads.size >= 64) throw new Error("too many files at once");
        const id = hex(8);
        this.#uploads.set(id, {
          upload: await store.begin(String(args.path), args.meta, expect()),
          at: Date.now(),
        });
        return { result: id };
      }
      case "putChunk":
        await upload().upload.write(payload);
        return {};
      case "putCommit": {
        const u = upload();
        this.#uploads.delete(String(args.id));
        return { result: await u.upload.commit(stamp()) };
      }
      case "putAbort": {
        const u = this.#uploads.get(String(args.id));
        this.#uploads.delete(String(args.id));
        await u?.upload.abort();
        return {};
      }
      case "retire": {
        sameFolder();
        const e = expect();
        if (!e) throw new Error("bad request");
        await store.retire(String(args.path), e, stamp());
        return {};
      }
      case "baseGet":
        return { result: await readJson<Record<string, string>>(this.#basePath(copy.id)) };
      case "baseSet": {
        // in pieces (a large folder's record doesn't fit one message): [path, hash] pairs, first … last
        sameFolder();
        if (!Array.isArray(args.files)) throw new Error("bad request");
        const whole = args.first === true ? bare<string>() : this.#incoming.get(copy.id);
        if (!whole) throw new Error("bad request");
        for (const pair of args.files as unknown[]) {
          const [path, hash] = Array.isArray(pair) ? (pair as unknown[]) : [];
          if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("bad request");
          whole[cleanRel(path)] = hash;
        }
        if (Object.keys(whole).length > 2_000_000) throw new Error("too large");
        if (args.last === true) {
          this.#incoming.delete(copy.id);
          await this.#writeBase(copy.id, whole);
        } else this.#incoming.set(copy.id, whole);
        return {};
      }
      case "synced":
        this.#guestGone(); // it says it is done: the notice goes at once
        copy.lastSync = Date.now();
        await store.flush();
        await this.#save();
        this.changed();
        return {};
      default:
        throw new Error(`unknown: ${method}`);
    }
  }
}
