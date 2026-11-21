// Tandem itself, without any window: the synced folder, its other copies (paired computers and drives), and
// the one sync that can run at a time (compare → review → apply → done). The window drives it through
// src/server.ts; other computers reach it through src/peer.ts (`call` below answers them). No Electron here:
// what only a desktop shell can do (folder dialogs, opening a file) comes in as `shell`.
//
// Between syncs it keeps a status for each copy (src/status.ts): the folder and plugged drives are followed by
// a watcher (src/watch.ts) after one scan at start, and paired computers are asked every 30 seconds, while a
// window is open, for their change number, then only for what changed. A side it can't follow is "can't
// tell". A sync never relies on any of that: it reads both disks.
//
// What it keeps, in its own folder (never inside the synced one):
//   config.json   this computer's name and id, the folder, the copies and their keys (readable by the user only)
//   index.db      the lists of files and the records of past syncs (src/db.ts)
//   view/         files fetched from another computer to look at them, emptied at start

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { apply, type Choice, type Outcome, type Progress } from "./apply.ts";
import { Db } from "./db.ts";
import { diffLines, looksBinary, type Row, toLines } from "./diff.ts";
import { Discovery, DISCOVERY_PORT, localAddresses } from "./discovery.ts";
import { type Drive, findCopy, listDrives, placeOnDrive, readMarker, writeMarker } from "./drives.ts";
import { currentLang, msg, resolveLang, setCoreLanguage } from "./i18n.ts";
import { DEFAULT_IGNORE, skipper } from "./ignore.ts";
import type { Entry, Listing } from "./listing.ts";
import { loadLocales } from "./locales.ts";
import { cleanRel, isTextName, OWN, stampOf } from "./names.ts";
import { type Answer, PeerServer } from "./peer.ts";
import { type Action, agreedBase, plan, type Side } from "./plan.ts";
import type { Translations } from "./po.ts";
import { hello, Link, pairWith, type PeerStatus, Refused, RemoteStore, Unreachable } from "./remote.ts";
import { codeKey, isCode, newCode } from "./secure.ts";
import { type CopyStatus, copyStatus, type SideView, type Why } from "./status.ts";
import {
  CHUNK,
  ChangedError,
  type LocalScan,
  LocalStore,
  type OldVersion,
  type Store,
  type Upload,
} from "./store.ts";
import { Watcher } from "./watch.ts";

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

export type ItemKind = "send" | "receive" | "remove-here" | "remove-there" | "conflict" | "clash" | "unread";

/** One line of the review screen. */
export interface Item {
  path: string;
  kind: ItemKind;
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
      counts: Record<ItemKind, number>;
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
  /** The actions shown in the review, by kind (in path order). */
  byKind: Record<ItemKind, Action[]>;
  conflicts: string[];
  choices: Record<string, Choice>;
  first: boolean;
  /** The record's change number when the comparison was made: a sync since makes the review out of date. */
  baseSeq: number;
}

/** Whether a side's list follows its disk right now. */
type Live = { live: true } | { live: false; why: Why };

/** This computer's folder, or a plugged drive: its store, its watcher, and whether its list is live. */
interface Side_ {
  store: LocalStore;
  watcher: Watcher | null;
  live: Live;
}

interface DriveState {
  /** Where the drive's copy is now; null: not plugged in. */
  at: string | null;
  side: Side_ | null;
}

interface PeerState {
  remote?: RemoteStore;
  address?: string;
  key?: string;
  /** Its last answer, while it answers. */
  status?: PeerStatus;
  /** Why it can't be told about (no answer, refused…). */
  why?: Why;
}

export interface CoreOptions {
  /** Shout on the network and listen for other computers (off in tests). */
  discovery?: boolean;
  discoveryPort?: number;
  /** The listener's address: every interface, or 127.0.0.1 in tests. */
  bind?: string;
  /** The listener's port when the config has none yet. */
  port?: number;
  /** Seconds between status questions to paired computers while a window is open. */
  pollSeconds?: number;
  /** Watch folders for changes (off: as on a system where watching fails, for tests). */
  watch?: boolean;
}

const noShell: ShellHooks = {
  chooseFolder: () => Promise.resolve(null),
  open: () => Promise.resolve(),
};

const KINDS: ItemKind[] = ["conflict", "send", "receive", "remove-here", "remove-there", "clash", "unread"];

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

/** Why another computer can't be told about, from what went wrong asking it. */
function whyNot(e: unknown): Why {
  if (e instanceof Refused) return e.message === "version" ? "version" : "refused";
  if (e instanceof Unreachable) return "off";
  // a Tandem of the first protocol answers "unknown: status"
  return (e as Error).message.startsWith("unknown: ") ? "version" : "off";
}

/**
 * What a sync's scan found that a working watcher should have told before: changed files older than the last
 * few seconds, and files gone (a watcher sees deletions at once).
 */
export function missedBy(changed: string[], entryOf: (path: string) => Entry | undefined, started: number) {
  return changed.filter((p) => {
    const e = entryOf(p);
    return !e || e.mtime < started - 5000;
  });
}

/** A side's list, or why it can't be told about. */
function view(side: Side_ | null | undefined, absent: Why): SideView {
  if (!side) return { known: false, why: absent };
  if (!side.live.live) return { known: false, why: side.live.why };
  return { known: true, files: side.store.scope.view(), unread: [...side.store.unread] };
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
  #db!: Db;
  #discovery?: Discovery;
  /** This computer's synced folder, once chosen. */
  #folder: Side_ | null = null;
  readonly #drives = new Map<string, DriveState>();
  readonly #peers = new Map<string, PeerState>();
  readonly #statuses = new Map<string, CopyStatus>();
  #work: Working | null = null;
  #cancel = false;
  readonly #uploads = new Map<string, { upload: Upload; at: number }>();
  #plugged: Drive[] = [];
  #driveTimer?: ReturnType<typeof setInterval>;
  #pollTimer?: ReturnType<typeof setInterval>;
  #pollSoonTimer?: ReturnType<typeof setTimeout>;
  #polling: Promise<void> | null = null;
  #restatusTimer?: ReturnType<typeof setTimeout>;
  #pairTimer?: ReturnType<typeof setTimeout>;
  /** Windows open on this computer (src/server.ts): other computers are asked for news only then. */
  #viewers = 0;
  /** A paired computer is working in this folder right now. */
  #guest: string | null = null;
  #guestTimer?: ReturnType<typeof setTimeout>;
  #locales: Record<string, Translations> = {};
  #lastEmit = 0;
  #emitTimer?: ReturnType<typeof setTimeout>;
  #stopped = false;

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
    this.#db = new Db(join(this.stateDir, "index.db"));
    await this.#importFirstVersion();
    if (this.localesDir) this.#locales = await loadLocales(this.localesDir);
    this.applyLanguage();
    await rm(join(this.stateDir, "view"), { recursive: true, force: true }).catch(() => {});
    await this.#peer.listen(this.config.port, this.#options.bind);
    if (this.#options.discovery !== false) {
      this.#discovery = new Discovery(
        () => ({
          id: this.config.device.id,
          name: this.config.device.name,
          port: this.#peer.port,
          pairing: !!this.pairing,
        }),
        () => {
          this.changed();
          this.#pollSoon(); // a paired computer just appeared: ask it now
        },
        this.#options.discoveryPort ?? DISCOVERY_PORT,
      );
      this.#discovery.start();
    }
    this.#db.scope("folder").compact();
    await this.#openFolder();
    await this.#lookForDrives();
    this.#driveTimer = setInterval(() => void this.#lookForDrives(), 3000);
    this.#driveTimer.unref?.();
    this.#pollTimer = setInterval(
      () => {
        if (this.#viewers > 0) void this.poll();
      },
      (this.#options.pollSeconds ?? 30) * 1000,
    );
    this.#pollTimer.unref?.();
  }

  /**
   * Tandem 0.1.0 kept each pair's record of the last sync as base/<copy>.json, and hashes in cache/: the
   * records move into the database once (without them the next sync would start over as a first sync), the
   * hashes are read again.
   */
  async #importFirstVersion() {
    const dir = join(this.stateDir, "base");
    for (const copy of this.config.copies) {
      const old = await readJson<Record<string, unknown>>(join(dir, `${copy.id}.json`));
      const scope = this.#db.scope(`base:${copy.id}`);
      if (!old || scope.seq > 0) continue;
      scope.transaction(() => {
        for (const [path, hash] of Object.entries(old)) {
          if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) continue;
          try {
            scope.put(cleanRel(path), { size: 0, mtime: 0, hash });
          } catch {
            /* a path no longer allowed: left out of the record */
          }
        }
      });
    }
    for (const old of ["base", "cache"]) await rm(join(this.stateDir, old), { recursive: true, force: true });
  }

  stop() {
    this.#stopped = true;
    for (const t of [
      this.#pairTimer,
      this.#emitTimer,
      this.#guestTimer,
      this.#restatusTimer,
      this.#pollSoonTimer,
    ])
      clearTimeout(t);
    clearInterval(this.#driveTimer);
    clearInterval(this.#pollTimer);
    this.#cancel = true;
    this.#folder?.watcher?.stop();
    for (const d of this.#drives.values()) d.side?.watcher?.stop();
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

  /** A window opened (+1) or closed (-1): paired computers are asked for news only while one is open. */
  viewer(delta: 1 | -1) {
    this.#viewers = Math.max(0, this.#viewers + delta);
    if (delta === 1 && this.#viewers === 1) this.#pollSoon(0);
  }

  /** Tell the window something changed (at most a few times a second: progress moves fast). */
  changed() {
    if (this.#stopped) return;
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
    const ignoreBefore = c.ignore;
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
    // another list of files to leave out: the lists are read again with it
    if (c.ignore !== ignoreBefore) {
      if (this.#folder) void this.#rescan(this.#folder);
      for (const d of this.#drives.values()) if (d.side) void this.#rescan(d.side);
    }
    this.changed();
  }

  // ------------------------------------------------------------------ following the folder and the drives

  #busy() {
    return this.job?.phase === "scanning" || this.job?.phase === "applying";
  }

  /** Start following a folder or a drive: a watcher, then one scan (the list is live once both are done). */
  async #follow(store: LocalStore): Promise<Side_> {
    const side: Side_ = { store, watcher: null, live: { live: false, why: "starting" } };
    const watcher = new Watcher(store.root, {
      paths: (paths) => void this.#changedOnDisk(side, paths),
      lost: () => void this.#rescan(side),
      trouble: (why) => {
        side.live = { live: false, why };
        this.#restatusSoon();
      },
    });
    side.watcher = watcher;
    if (this.#options.watch !== false) await watcher.start();
    void this.#rescan(side);
    return side;
  }

  #unfollow(side: Side_ | null | undefined) {
    side?.watcher?.stop();
    if (side) side.watcher = null;
  }

  /** The watcher named paths: read just those again. */
  async #changedOnDisk(side: Side_, paths: string[]) {
    try {
      const changed = await side.store.refresh(paths);
      if (changed.length) this.#restatusSoon();
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Read a whole folder again. `check` (a sync's scan): what it finds that a live watcher should have told is
   * counted, and if anything, the watcher is no longer trusted there.
   */
  async #rescan(
    side: Side_,
    check = false,
    progress?: (done: number, total: number) => void,
  ): Promise<LocalScan> {
    const pending = side.watcher?.takePending() ?? [];
    if (pending.length) await side.store.refresh(pending);
    const wasLive = side.live.live;
    const started = Date.now();
    try {
      const scan = await side.store.scan(this.config.ignore, progress);
      if (check && wasLive && missedBy(scan.changed, (p) => side.store.scope.get(p), started).length)
        side.live = { live: false, why: "missed" };
      if (!side.live.live && side.live.why === "starting")
        side.live = side.watcher?.running ? { live: true } : { live: false, why: "failed" };
      return scan;
    } catch (e) {
      if (!side.live.live && side.live.why === "starting") side.live = { live: false, why: "failed" };
      throw e;
    } finally {
      this.#restatusSoon();
    }
  }

  async #openFolder() {
    this.#unfollow(this.#folder);
    this.#folder = null;
    const folder = this.config.folder;
    if (!folder) return;
    const store = new LocalStore(folder, { scope: this.#db.scope("folder") });
    if (!(await store.present())) {
      this.#folder = { store, watcher: null, live: { live: false, why: "failed" } };
      return;
    }
    await store.cleanTmp();
    await store.pruneOld(this.config.keepDays);
    this.#folder = await this.#follow(store);
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
      // another folder: what was remembered about the old one is not true of this one. A new history for its
      // list also makes other computers' writes planned against the old folder fail (#answer, sameFolder).
      this.#db.scope("folder").clear();
      for (const name of this.#db.names("base:")) this.#db.drop(name);
      for (const c of this.config.copies) delete c.lastSync;
      this.job = null;
      this.#work = null;
      for (const [id, u] of this.#uploads) {
        void u.upload.abort(); // a file on its way into the old folder
        this.#uploads.delete(id);
      }
    }
    this.config.folder = folder;
    await this.#save();
    if (this.#folder?.store.root !== folder) await this.#openFolder();
    this.#restatusSoon();
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
    this.#pollSoon(0);
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
    this.#unfollow(this.#drives.get(id)?.side);
    this.#drives.delete(id);
    this.#peers.delete(id);
    this.#statuses.delete(id);
    for (const scope of [`base:${id}`, `drive:${id}`, `peer:${id}`, `peerbase:${id}`]) this.#db.drop(scope);
    await this.#save();
    this.changed();
  }

  /** Every few seconds: which drive copies are plugged in. One that appears is scanned and watched. */
  async #lookForDrives() {
    if (this.#stopped) return;
    let moved = false;
    for (const c of this.config.copies) {
      if (c.kind !== "drive") continue;
      const at = await findCopy(c);
      const state = this.#drives.get(c.id) ?? { at: null, side: null };
      this.#drives.set(c.id, state);
      if (state.at === at && (at === null || state.side)) continue;
      moved = true;
      this.#unfollow(state.side);
      state.at = at;
      state.side = null;
      if (at) {
        if (at !== c.path) {
          c.path = at;
          void this.#save();
        }
        state.side = await this.#follow(
          new LocalStore(at, { scope: this.#db.scope(`drive:${c.id}`), marker: c.marker }),
        );
      }
    }
    const drives = await listDrives().catch(() => []);
    if (
      JSON.stringify(drives.map((d) => [d.root, d.copies])) !==
      JSON.stringify(this.#plugged.map((d) => [d.root, d.copies]))
    )
      moved = true;
    this.#plugged = drives;
    if (moved) {
      this.#restatusSoon();
      this.changed();
    }
  }

  /** A drive copy, plugged in now and followed; a UserError when it is not there. */
  async #driveSide(copy: DriveCopy): Promise<Side_> {
    await this.#lookForDrives();
    const side = this.#drives.get(copy.id)?.side;
    if (!side) throw new UserError(msg("errNotPlugged", { name: copy.name }));
    return side;
  }

  // ------------------------------------------------------------------ paired computers

  /** Reach a paired computer: its store and its status, from the addresses it was seen at. */
  async #reach(copy: DeviceCopy): Promise<{ remote: RemoteStore; st: PeerStatus }> {
    const p = this.#peers.get(copy.id) ?? {};
    this.#peers.set(copy.id, p);
    const addresses = [
      ...new Set([this.#discovery?.find(copy.deviceId)?.address, p.address, copy.address]),
    ].filter((a): a is string => a !== undefined);
    let failure: unknown = new Unreachable("no address");
    for (const address of addresses) {
      if (!p.remote || p.address !== address || p.key !== copy.key) {
        p.remote = new RemoteStore(
          new Link(
            address,
            { id: this.config.device.id, port: this.#peer.port },
            copy.deviceId,
            Buffer.from(copy.key, "base64"),
          ),
          this.#db.scope(`peer:${copy.id}`),
          this.#db.scope(`peerbase:${copy.id}`),
        );
        p.address = address;
        p.key = copy.key;
      }
      try {
        const st = await p.remote.status();
        if (copy.address !== address || (st.name && st.name !== copy.name)) {
          copy.address = address;
          copy.name = st.name || copy.name;
          void this.#save();
        }
        return { remote: p.remote, st };
      } catch (e) {
        failure = e;
        if (whyNot(e) !== "off") break; // it answered: no other address will say otherwise
      }
    }
    throw failure;
  }

  /** Ask a paired computer for news soon (it appeared, a window opened). */
  #pollSoon(delay = 1500) {
    if (this.#viewers === 0 && delay > 0) return;
    clearTimeout(this.#pollSoonTimer);
    this.#pollSoonTimer = setTimeout(() => void this.poll(), delay);
    this.#pollSoonTimer.unref?.();
  }

  /**
   * Ask every paired computer for its status, then only for what changed since the last look (its list and
   * its record). Cheap when nothing changed: one small question each.
   */
  poll(): Promise<void> {
    if (this.#polling) return this.#polling;
    const run = async () => {
      for (const copy of this.config.copies) {
        if (copy.kind !== "device" || this.#stopped) continue;
        if (this.#busy() && this.job?.copyId === copy.id) continue; // the sync has the fresh lists
        const p = this.#peers.get(copy.id) ?? {};
        this.#peers.set(copy.id, p);
        try {
          const { remote, st } = await this.#reach(copy);
          if (st.folder) {
            if (!remote.current(st)) await remote.pull(false);
            if (!remote.baseCurrent(st)) await remote.loadBase();
          }
          p.status = st;
          p.why = st.folder ? undefined : "nofolder";
        } catch (e) {
          p.status = undefined;
          p.why = whyNot(e);
        }
      }
    };
    // cleared in .finally, which always runs after this assignment (even when nothing had to be asked)
    this.#polling = run().finally(() => {
      this.#polling = null;
      this.#restatus();
    });
    return this.#polling;
  }

  // ------------------------------------------------------------------ the status of each copy

  #restatusSoon() {
    if (this.#stopped) return;
    clearTimeout(this.#restatusTimer);
    this.#restatusTimer = setTimeout(() => this.#restatus(), 400);
    this.#restatusTimer.unref?.();
  }

  /** Work out what the home screen says about each copy (src/status.ts). */
  #restatus() {
    if (this.#stopped) return;
    if (this.job?.phase === "applying") return this.#restatusSoon(); // after the sync: its lists are moving
    this.#statuses.clear();
    if (!this.config.folder) return this.changed();
    const here = view(this.#folder, "failed");
    for (const copy of this.config.copies) {
      const mine = this.#db.scope(`base:${copy.id}`).hashes();
      if (copy.kind === "drive") {
        const there = view(this.#drives.get(copy.id)?.side, "unplugged");
        this.#statuses.set(copy.id, copyStatus(here, there, mine, skipper(this.config.ignore)));
        continue;
      }
      const p = this.#peers.get(copy.id);
      const st = p?.status;
      let there: SideView;
      if (!st || p.why) there = { known: false, why: p?.why ?? "off" };
      else if (!st.live) there = { known: false, why: st.why ?? "failed" };
      else
        there = {
          known: true,
          files: this.#db.scope(`peer:${copy.id}`).view(),
          unread: p.remote?.unread ?? [],
        };
      const theirs = this.#db.scope(`peerbase:${copy.id}`);
      const base = theirs.size || theirs.seq ? agreedBase(mine, theirs.hashes()) : mine;
      this.#statuses.set(
        copy.id,
        copyStatus(here, there, base, skipper(this.config.ignore, st?.ignore ?? "")),
      );
    }
    this.changed();
  }

  /** Work out the statuses now (tests; the window gets them by itself). */
  async refreshStatus() {
    await this.poll();
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

  /** Compare the folder with one of its copies; the job goes to "review" (or straight to "done"). */
  compare(copyId: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    const copy = this.#copy(copyId);
    this.#work = null;
    this.#cancel = false;
    this.job = { phase: "scanning", copyId, here: [0, 0], there: [0, 0] };
    this.changed();
    const run = async () => {
      const folder = this.#folder;
      if (!folder) throw new UserError(msg("errNoFolder"));
      const a = folder.store;
      if (!(await a.present())) throw new UserError(msg("errFolder", { path: a.root, error: "not found" }));
      const scanning = this.job as Extract<Job, { phase: "scanning" }>;
      const here = (done: number, total: number) => {
        scanning.here = [done, total];
        this.changed();
      };
      const there = (done: number, total: number) => {
        scanning.there = [done, total];
        this.changed();
      };
      let b: Store;
      let scans: [LocalScan, { files: Listing; unread: string[] }];
      let theirIgnore = "";
      let theirBase: Record<string, string> | null = null;
      if (copy.kind === "drive") {
        const drive = await this.#driveSide(copy);
        b = drive.store;
        scans = await Promise.all([this.#rescan(folder, true, here), this.#rescan(drive, true, there)]);
      } else {
        let remote: RemoteStore;
        try {
          const reached = await this.#reach(copy);
          remote = reached.remote;
          if (!reached.st.folder) throw new UserError(msg("errNoFolderThere", { name: copy.name }));
        } catch (e) {
          if (e instanceof UserError) throw e;
          const why = whyNot(e);
          throw new UserError(
            msg(why === "version" ? "errVersion" : why === "refused" ? "errRefused" : "errUnreachable", {
              name: copy.name,
            }),
          );
        }
        b = remote;
        scans = await Promise.all([this.#rescan(folder, true, here), remote.scan("", there)]);
        theirIgnore = remote.ignore;
        theirBase = await remote.loadBase();
      }
      const [scanA, scanB] = scans;
      const listA = scanA.files;
      const listB = scanB.files;
      const baseScope = this.#db.scope(`base:${copy.id}`);
      const mine = baseScope.hashes();
      const base = theirBase ? agreedBase(mine, theirBase) : mine;
      const skip = skipper(this.config.ignore, theirIgnore);
      // a side that held files at the last sync and shows none now is more likely a disk that is not there
      // (an empty mount point) than a folder emptied on purpose: stop rather than plan to delete everything
      const known = Object.keys(base).filter((p) => !skip(p)).length;
      if (known > 0 && !scanA.unread.length && !scanB.unread.length) {
        if (!Object.keys(listA).length) throw new UserError(msg("errEmptiedHere", { n: known }));
        if (!Object.keys(listB).length)
          throw new UserError(msg("errEmptiedThere", { name: copy.name, n: known }));
      }
      const actions = plan(listA, listB, base, [...scanA.unread, ...scanB.unread], skip);
      const byKind = Object.fromEntries(KINDS.map((k) => [k, [] as Action[]])) as Record<ItemKind, Action[]>;
      for (const act of actions) {
        const kind = this.#kindOf(act);
        if (kind) byKind[kind].push(act);
      }
      this.#work = {
        copy,
        a,
        b,
        listA,
        listB,
        base,
        actions,
        byKind,
        conflicts: byKind.conflict.map((x) => x.path),
        choices: {},
        first: Object.keys(base).length === 0,
        baseSeq: baseScope.seq,
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

  #kindOf(act: Action): ItemKind | null {
    if (act.kind === "settle") return null;
    if (act.kind === "copy") return act.from === "a" ? "send" : "receive";
    if (act.kind === "delete") return act.on === "a" ? "remove-here" : "remove-there";
    return act.kind;
  }

  #failed(copyId: string, e: Error) {
    if (!(e instanceof UserError)) console.error(e);
    this.#work = null;
    this.job = { phase: "error", copyId, message: e.message };
    this.changed();
  }

  #review() {
    const w = this.#work!;
    const counts = Object.fromEntries(KINDS.map((k) => [k, w.byKind[k].length])) as Record<ItemKind, number>;
    const prev = this.job?.phase === "review" ? this.job.rev : 0;
    this.job = {
      phase: "review",
      copyId: w.copy.id,
      rev: prev + 1,
      first: w.first,
      counts,
      open: w.conflicts.filter((p) => !Object.hasOwn(w.choices, p)).length,
    };
    this.changed();
  }

  #item(w: Working, act: Action): Item {
    const meta = (e?: Entry) => (e ? { size: e.size, mtime: e.mtime } : undefined);
    const item: Item = {
      path: act.path,
      kind: this.#kindOf(act)!,
      here: meta(w.listA[act.path]),
      there: meta(w.listB[act.path]),
      text: isTextName(act.path),
    };
    if (act.kind === "copy") item.fresh = act.fresh;
    if (act.kind === "clash") item.with = act.with;
    if (act.kind === "conflict") {
      item.gone = act.gone;
      if (Object.hasOwn(w.choices, act.path)) item.choice = w.choices[act.path];
    }
    return item;
  }

  /** Every line of the review (tests; the window reads it in pages). */
  items(): Item[] {
    const w = this.#work;
    if (!w) return [];
    return w.actions.filter((x) => x.kind !== "settle").map((x) => this.#item(w, x));
  }

  /** A page of one kind of lines, optionally only below a folder. */
  page(kind: ItemKind, offset = 0, limit = 200, folder?: string): { total: number; items: Item[] } {
    const w = this.#work;
    if (!w || !KINDS.includes(kind)) return { total: 0, items: [] };
    let list = w.byKind[kind];
    if (folder !== undefined) list = list.filter((x) => topFolder(x.path) === folder);
    const start = Math.max(0, offset);
    return {
      total: list.length,
      items: list.slice(start, start + Math.min(Math.max(1, limit), 1000)).map((x) => this.#item(w, x)),
    };
  }

  /** One kind of lines counted by top folder ("" for files at the top), largest first. */
  groups(kind: ItemKind): { folder: string; count: number }[] {
    const w = this.#work;
    if (!w || !KINDS.includes(kind)) return [];
    const count = new Map<string, number>();
    for (const x of w.byKind[kind]) count.set(topFolder(x.path), (count.get(topFolder(x.path)) ?? 0) + 1);
    return [...count]
      .map(([folder, n]) => ({ folder, count: n }))
      .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
  }

  /** Answer one conflict (null: undecided again), or with `path` null every conflict at once. */
  choose(path: string | null, choice: Choice | null) {
    const w = this.#work;
    if (!w || this.job?.phase !== "review") return;
    for (const p of path === null ? w.conflicts : w.conflicts.filter((c) => c === path)) {
      if (choice) w.choices[p] = choice;
      else delete w.choices[p];
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
    const baseScope = this.#db.scope(`base:${copy.id}`);
    // the other computer synced with this one while the review sat open: its plan is about another state
    if (baseScope.seq !== w.baseSeq) throw new UserError(msg("errStale", { name: copy.name }));
    this.#cancel = false;
    const blank: Progress = { done: 0, total: 0, path: "", bytes: 0, totalBytes: 0 };
    this.job = { phase: "applying", copyId: copy.id, progress: blank };
    this.changed();
    const now = new Date();
    // changes to the record, kept until they are saved here and on the other computer
    const forHere: [string, string | null][] = [];
    const forThere: [string, string | null][] = [];
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
      record: (path, hash) => {
        forHere.push([path, hash]);
        if (w.b instanceof RemoteStore) forThere.push([path, hash]);
      },
      save: async () => {
        // the files first, on the disks; then the record says they landed
        await w.a.checkpoint();
        await w.b.checkpoint();
        const batch = forHere.splice(0);
        baseScope.transaction(() => {
          for (const [p, h] of batch) {
            if (h === null) baseScope.remove(p);
            else baseScope.put(p, { size: 0, mtime: 0, hash: h });
          }
        });
        if (forThere.length && w.b instanceof RemoteStore) {
          const sending = forThere.slice();
          await w.b.saveBase(sending);
          forThere.splice(0, sending.length);
        }
      },
      alive: (side) =>
        side === "a"
          ? w.a.present()
          : w.b instanceof RemoteStore
            ? w.b.alive()
            : (w.b as LocalStore).present(),
    });
    if (w.b instanceof LocalStore) await w.b.pruneOld(this.config.keepDays).catch(() => {});
    await w.a.pruneOld(this.config.keepDays).catch(() => {});

    const count = (...kinds: Outcome["result"][]) =>
      result.outcomes.filter((o) => kinds.includes(o.result)).length;
    const problems = result.outcomes.filter((o) =>
      ["changed", "failed", "clash", "unread"].includes(o.result),
    );
    const outcomeOf = new Map(result.outcomes.map((o) => [o.path, o.result]));
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
        const r = outcomeOf.get(x.path);
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
    // the home screen's status, from what the sync just left (and the other computer's news)
    if (copy.kind === "device") void this.poll();
    else this.#restatusSoon();
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

  async #folderStore(): Promise<LocalStore> {
    if (!this.#folder) throw new UserError(msg("errNoFolder"));
    return this.#folder.store;
  }

  async oldVersions(): Promise<OldVersion[]> {
    if (!this.#folder) return [];
    return (await this.#folder.store.listOld()).slice(0, 2000);
  }

  async restore(stamp: string, path: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    await (await this.#folderStore()).restoreOld(stamp, path, stampOf(new Date()));
    this.#restatusSoon();
    this.changed();
  }

  async openOld(stamp: string, path: string) {
    await this.shell.open((await this.#folderStore()).oldPath(stamp, path));
  }

  async openFolder() {
    if (this.config.folder) await this.shell.open(this.config.folder);
  }

  /** Wait until the first scans are done, then ask paired computers: the statuses are then as good as they get. */
  async settled() {
    await this.#lookForDrives();
    for (let i = 0; i < 3; i++) {
      // one scan at a time per store: a refresh queued behind the scan waits for it
      const sides = [this.#folder, ...[...this.#drives.values()].map((d) => d.side)].filter(
        (s) => s !== null,
      );
      await Promise.all(sides.map((s) => s!.store.refresh([]).catch(() => [])));
      if (sides.every((s) => s!.live.live || s!.live.why !== "starting")) break;
    }
    await this.poll();
  }

  // ------------------------------------------------------------------ what the window shows

  state() {
    const c = this.config;
    const seen = this.#discovery?.seen() ?? [];
    const folder = this.#folder;
    return {
      version: this.appVersion,
      update: this.update,
      device: { name: c.device.name },
      addresses: localAddresses().map((a) => (this.#peer.port === PEER_PORT ? a : `${a}:${this.#peer.port}`)),
      folder: c.folder
        ? {
            path: c.folder,
            name: basename(c.folder),
            live: !!folder?.live.live,
            why: folder && !folder.live.live ? folder.live.why : null,
          }
        : null,
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
          copy.kind === "drive"
            ? !!this.#drives.get(copy.id)?.at
            : seen.some((s) => s.id === copy.deviceId) || !!this.#peers.get(copy.id)?.status,
        status: this.#statuses.get(copy.id) ?? null,
      })),
      pairing: this.pairing ? { code: this.pairing.code, until: this.pairing.until } : null,
      /** Computers heard on the network that are not paired with this one yet. */
      nearby: seen
        .filter((s) => !this.#device(s.id))
        .map((s) => ({ name: s.name, address: s.address, pairing: s.pairing })),
      drives: this.#plugged.map((d) => ({
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
    const folder = this.#folder;
    const baseScope = this.#db.scope(`base:${copy.id}`);
    // questions that only look (its status poll): no "is syncing" notice, nothing read from the disk
    if (method === "info") {
      return {
        result: {
          name: this.config.device.name,
          folder: this.config.folder ? basename(this.config.folder) : null,
          version: this.appVersion,
        },
      };
    }
    if (method === "status") {
      const scope = this.#db.scope("folder");
      return {
        result: {
          name: this.config.device.name,
          folder: folder ? basename(folder.store.root) : null,
          epoch: scope.epoch,
          seq: scope.seq,
          baseEpoch: baseScope.epoch,
          baseSeq: baseScope.seq,
          live: !!folder?.live.live,
          why: folder && !folder.live.live ? folder.live.why : undefined,
          ignore: this.config.ignore,
        } satisfies PeerStatus,
      };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 20_000, 1), 20_000);
    if (method === "baseChanges")
      return { result: baseScope.changesSince(String(args.epoch ?? ""), Number(args.since) || 0, limit) };
    if (!folder) throw new Error("no folder");
    const store = folder.store;
    if (method === "changes") {
      if (args.scan === true) {
        this.#guestHere(copy.name); // a sync is starting there
        await this.#rescan(folder, true);
      }
      return {
        result: {
          ...store.scope.changesSince(String(args.epoch ?? ""), Number(args.since) || 0, limit),
          unread: [...store.unread],
          ignore: this.config.ignore,
        },
      };
    }
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
    /** The request was planned against the folder as it is now (not one changed since): its list's history. */
    const sameFolder = () => {
      if (args.token !== store.scope.epoch)
        throw new ChangedError("the folder there is not the one that was compared");
    };
    // old versions are filed under this computer's own clock, whatever the caller's says: they are pruned by
    // age here, and a clock set wrong elsewhere must not age them
    const stamp = () => stampOf(new Date());
    switch (method) {
      case "read":
        sameFolder();
        return {
          payload: await store.read(
            String(args.path),
            Number(args.offset) || 0,
            Math.min(Number(args.length) || 0, CHUNK),
          ),
        };
      case "put": {
        // a small file, whole
        sameFolder();
        if (!isEntry(args.meta) || payload.length > CHUNK) throw new Error("bad request");
        const up = await store.begin(String(args.path), args.meta, expect());
        try {
          await up.write(payload);
          return { result: await up.commit(stamp()) };
        } catch (e) {
          await up.abort();
          throw e;
        }
      }
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
      case "checkpoint":
        sameFolder();
        await store.checkpoint();
        return {};
      case "baseApply": {
        // the changes its sync made to the record of this pair, as they land
        sameFolder();
        if (!Array.isArray(args.changes) || args.changes.length > 20_000) throw new Error("bad request");
        const changes = (args.changes as unknown[]).map((c): [string, string | null] => {
          const [path, hash] = Array.isArray(c) ? (c as unknown[]) : [];
          if (hash !== null && (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)))
            throw new Error("bad request");
          return [cleanRel(path), hash];
        });
        baseScope.transaction(() => {
          for (const [p, h] of changes) {
            if (h === null) baseScope.remove(p);
            else baseScope.put(p, { size: 0, mtime: 0, hash: h });
          }
        });
        return {};
      }
      case "synced":
        this.#guestGone(); // it says it is done: the notice goes at once
        copy.lastSync = Date.now();
        await this.#save();
        this.changed();
        this.#pollSoon(); // its news, for this window's status
        return {};
      default:
        throw new Error(`unknown: ${method}`);
    }
  }
}

/** The first folder of a path, "" for a file at the top. */
function topFolder(path: string) {
  const slash = path.indexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
