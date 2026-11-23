// Tandem itself, without any window: the synced folders, each with its copies (the folders of paired
// computers it is linked to), and the one sync that can run at a time (compare → review → apply → done). The
// window drives it through src/server.ts; other computers reach it through src/peer.ts (`#answer` below
// answers them). No Electron here: what only a desktop shell can do (folder dialogs, opening a file) comes in
// as `shell`.
//
// A paired computer is trusted as a computer (its key), and reaches only the folders shared with it: a folder
// is offered to it, accepted there into a folder of its own choosing, and from then on the two are linked by
// their ids (each computer's own), never by their names or places.
//
// Between syncs it keeps a status for each copy (src/status.ts): the folders are followed by
// a watcher (src/watch.ts) after one scan at start, and paired computers are asked every 30 seconds, while a
// window is open, for their change number, then only for what changed. A side it can't follow is "can't
// tell". A sync never relies on any of that: it reads both disks.
//
// What it keeps, in its own folder (never inside the synced one):
//   config.json   this computer's name and id, the paired computers and their keys, the folders and their
//                 copies, offers waiting for an answer (readable by the user only)
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
import { currentLang, msg, resolveLang, setCoreLanguage } from "./i18n.ts";
import { DEFAULT_IGNORE, skipper } from "./ignore.ts";
import type { Entry, Listing } from "./listing.ts";
import { loadLocales } from "./locales.ts";
import { cleanRel, isTextName, OWN, stampOf } from "./names.ts";
import { type Answer, PeerServer } from "./peer.ts";
import { type Action, agreedBase, plan, type Side } from "./plan.ts";
import type { Translations } from "./po.ts";
import {
  hello,
  Link,
  pairWith,
  type PeerStatus,
  Refused,
  type RemoteInfo,
  RemoteStore,
  Unreachable,
} from "./remote.ts";
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

/** Another computer, paired with this one: it may talk to this one, and reach the folders shared with it. */
export interface Device {
  id: string;
  name: string;
  /** The pair's key (base64). */
  key: string;
  /** Where it last answered (host:port). */
  address?: string;
  added: number;
}

interface CopyBase {
  id: string;
  added: number;
  lastSync?: number;
}
/** A folder shared with a paired computer. */
export interface DeviceCopy extends CopyBase {
  kind: "device";
  deviceId: string;
  /**
   * The other computer's folder it is linked to (its id there). null: offered, not accepted there yet.
   * "legacy": from Tandem 0.2.0, which had one folder: the first exchange tells which.
   */
  remote: string | null;
  /** Offered while pairing: an offer of that computer, made while pairing too, links to it without a question. */
  pairing?: true;
}
/** A copy of a folder: the folder of a paired computer it is linked to. */
export type Copy = DeviceCopy;

/** A folder kept in sync, with its copies. Its id is this computer's own: others link to it by it. */
export interface Folder {
  id: string;
  path: string;
  /** Files left out of this folder's syncs (src/ignore.ts). */
  ignore: string;
  copies: Copy[];
}

/** A folder another computer offers to share with this one, waiting for an answer here. */
export interface Offer {
  deviceId: string;
  /** Its id on that computer. */
  folder: string;
  name: string;
  at: number;
}

export interface Config {
  device: { id: string; name: string };
  port: number;
  devices: Device[];
  folders: Folder[];
  offers: Offer[];
  /** Offers answered "not on this computer": the same offer again is answered so at once. */
  declined: { deviceId: string; folder: string }[];
  /** Days an old version is kept. */
  keepDays: number;
  theme: "auto" | "light" | "dark";
  lang: string;
}

/** What Tandem 0.2.0 saved: one folder, its copies with the pairs' keys in them. */
interface ConfigV2 {
  folder?: string | null;
  ignore?: string;
  /** Paired computers, and copies on drives (no longer kept: their files stay on the drives). */
  copies?: (Record<string, unknown> & { kind: string; id: string; added: number; lastSync?: number })[];
}

const ID = /^[0-9a-f]{32}$/;

/** What only the desktop shell can do. */
export interface ShellHooks {
  chooseFolder(title: string, start?: string): Promise<string | null>;
  /** Open a file or folder with the system's program. */
  open(path: string): Promise<void>;
  setTheme?(theme: Config["theme"]): void;
  installUpdate?(): void;
  /** Open the page where new versions are downloaded (a package that can't update itself). */
  openDownloads?(): void;
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
  folder: Folder;
  copy: Copy;
  a: LocalStore;
  b: RemoteStore;
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

/** One of this computer's folders: its store, its watcher, and whether its list is live. */
interface Side_ {
  /** The folder it belongs to (its list of files to leave out). */
  folder: string;
  store: LocalStore;
  watcher: Watcher | null;
  live: Live;
}

/** The encrypted line to a paired computer, shared by every folder shared with it. */
interface LinkState {
  link: Link;
  address: string;
  key: string;
}

/** A folder shared with another computer: that folder there as a store, and what it last said. */
interface PeerState {
  remote?: RemoteStore;
  link?: Link;
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
  // Windows refuses a rename onto a file that is being replaced or is held a moment (antivirus, the indexer):
  // tried again a few times before giving up
  for (let i = 0; ; i++) {
    try {
      return await rename(tmp, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** Is `inner` the same folder as `outer`, or inside it? */
function within(outer: string, inner: string) {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel));
}

/** Why another computer can't be told about, from what went wrong asking it. */
function whyNot(e: unknown): Why {
  if (e instanceof Refused)
    return e.message === "version" ? "version" : e.message === "unshared" ? "unshared" : "refused";
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
  /** A newer version published, for a package that can't install it itself (a .rpm or .deb). */
  updateOut: string | null = null;
  systemLocales: readonly string[] = [];
  localesDir?: string;
  job: Job | null = null;
  /** The pairing code on screen, and the folder whose "add a copy" screen shows it. */
  pairing: { code: string; key: Buffer; until: number; tries: number; folder?: string } | null = null;

  readonly #options: CoreOptions;
  readonly #listeners = new Set<() => void>();
  readonly #peer: PeerServer;
  #db!: Db;
  #discovery?: Discovery;
  /** This computer's synced folders, by id. */
  readonly #folders = new Map<string, Side_>();
  readonly #links = new Map<string, LinkState>();
  readonly #peers = new Map<string, PeerState>();
  readonly #statuses = new Map<string, CopyStatus>();
  #work: Working | null = null;
  #cancel = false;
  readonly #uploads = new Map<string, { upload: Upload; at: number; device: string; folder: string }>();
  #pollTimer?: ReturnType<typeof setInterval>;
  #pollSoonTimer?: ReturnType<typeof setTimeout>;
  #polling: Promise<void> | null = null;
  #pollAgain = false;
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
  /** The settings write under way (#save). */
  #saving: Promise<void> = Promise.resolve();
  /** Resolves once stopped and the database closed. */
  #closed?: Promise<void>;
  /** The comparison or the sync running now. */
  #running: Promise<void> | null = null;

  constructor(stateDir: string, options: CoreOptions = {}) {
    this.stateDir = stateDir;
    this.#options = options;
    this.#peer = new PeerServer({
      device: () => this.config.device,
      keyOf: (id) => {
        const d = this.#device(id);
        return d ? Buffer.from(d.key, "base64") : null;
      },
      pairingKey: () => (this.pairing && Date.now() < this.pairing.until ? this.pairing.key : null),
      wrongCode: () => {
        if (this.pairing && ++this.pairing.tries >= 5) this.stopPairing(); // the code is burnt: show a new one
      },
      paired: (peer) => {
        // at once, before the answer leaves: the other computer's offer may follow right after it
        this.#addDevice(
          peer.id,
          peer.name,
          peer.key,
          peer.address.endsWith(":0") ? undefined : peer.address,
          this.pairing?.folder,
        );
        this.stopPairing();
      },
      seen: (id, address) => {
        const d = this.#device(id);
        if (d && d.address !== address) {
          d.address = address;
          void this.#save();
        }
      },
      call: (id, method, args, payload) => this.#answer(id, method, args, payload),
    });
  }

  // ------------------------------------------------------------------ start, stop, settings

  async init() {
    await mkdir(this.stateDir, { recursive: true });
    const saved = await readJson<Partial<Config> & ConfigV2>(join(this.stateDir, "config.json"));
    this.config = {
      device: saved?.device ?? { id: hex(16), name: hostname().split(".")[0].slice(0, 40) || "Computer" },
      port: saved?.port ?? this.#options.port ?? PEER_PORT,
      devices: saved?.devices ?? [],
      folders: saved?.folders ?? [],
      offers: saved?.offers ?? [],
      declined: saved?.declined ?? [],
      keepDays: saved?.keepDays ?? 90,
      theme: saved?.theme ?? "auto",
      lang: saved?.lang ?? "auto",
    };
    const second = !!saved && !saved.folders;
    const old = second ? this.#fromSecondVersion(saved) : null;
    // copies on drives are no longer kept: forgotten here, their files stay on the drives
    const copies = this.config.folders.reduce((n, f) => n + f.copies.length, 0);
    for (const f of this.config.folders) f.copies = f.copies.filter((c) => c.kind === "device");
    const dropped = copies !== this.config.folders.reduce((n, f) => n + f.copies.length, 0);
    if (!saved || second || dropped) await this.#save();
    this.#db = new Db(join(this.stateDir, "index.db"));
    // the one folder's list keeps its history under the folder's new name: nothing is read or sent again
    if (old) this.#db.rename("folder", `folder:${old}`);
    for (const name of this.#db.names("drive:")) this.#db.drop(name);
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
    for (const f of this.config.folders) {
      this.#db.scope(`folder:${f.id}`).compact();
      await this.#openFolder(f);
    }
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
  /**
   * Tandem 0.2.0 kept one folder, and each paired computer as a copy of it with the pair's key: the folder
   * becomes the first of the list, each computer a paired device with that folder shared. Which folder it is
   * on the other computer is learned at the first exchange ("legacy"). Returns the folder's new id, if any.
   */
  #fromSecondVersion(saved: ConfigV2): string | null {
    const copies: Copy[] = [];
    for (const c of saved.copies ?? []) {
      if (c.kind === "device") {
        const deviceId = String(c.deviceId);
        if (!this.#device(deviceId))
          this.config.devices.push({
            id: deviceId,
            name: String(c.name ?? "Computer"),
            key: String(c.key),
            address: typeof c.address === "string" ? c.address : undefined,
            added: c.added,
          });
        copies.push({
          kind: "device",
          id: c.id,
          deviceId,
          remote: "legacy",
          added: c.added,
          lastSync: c.lastSync,
        });
      }
    }
    if (!saved.folder) return null; // nothing was ever synced: the pairs stay, with no folder shared yet
    const id = hex(16);
    this.config.folders.push({ id, path: saved.folder, ignore: saved.ignore ?? DEFAULT_IGNORE, copies });
    return id;
  }

  async #importFirstVersion() {
    const dir = join(this.stateDir, "base");
    for (const copy of this.#allCopies()) {
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

  /**
   * Stop: nothing new starts, the running sync stops after its file, files on their way here are dropped, and
   * once what was under way has landed (or after a few seconds) the database is closed. Windows can't delete
   * an open file: until then the app's own folder can't be removed.
   */
  stop(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#stopped = true;
    for (const t of [
      this.#pairTimer,
      this.#emitTimer,
      this.#guestTimer,
      this.#restatusTimer,
      this.#pollSoonTimer,
    ])
      clearTimeout(t);
    clearInterval(this.#pollTimer);
    this.#cancel = true;
    for (const f of this.#folders.values()) f.watcher?.stop();
    this.#discovery?.stop();
    this.#peer.close();
    for (const [id, u] of this.#uploads) {
      void u.upload.abort();
      this.#uploads.delete(id);
    }
    const underway = Promise.allSettled([
      this.#running,
      this.#polling,
      this.#saving,
      ...[...this.#folders.values()].map((s) => s.store.idle()),
    ]);
    this.#closed = Promise.race([underway, new Promise((r) => setTimeout(r, 5000))]).then(() =>
      this.#db.close(),
    );
    return this.#closed;
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

  /** Write the settings. One write at a time: two renames onto the same file at once fail on Windows. */
  #save(): Promise<void> {
    const run = this.#saving.then(() => writeJson(join(this.stateDir, "config.json"), this.config, 0o600));
    this.#saving = run.catch(() => {});
    return run;
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

  /** A folder's own settings: its list of files to leave out. */
  async setFolderSettings(folderId: string, patch: Record<string, unknown>) {
    const f = this.#folderById(folderId);
    if (typeof patch.ignore === "string" && patch.ignore.length < 20_000 && patch.ignore !== f.ignore) {
      f.ignore = patch.ignore;
      await this.#save();
      // another list of files to leave out: the folder's lists are read again with it
      const side = this.#folders.get(f.id);
      if (side) void this.#rescan(side);
    }
    this.changed();
  }

  // ------------------------------------------------------------------ finding things

  #folderById(id: string): Folder {
    const f = this.config.folders.find((x) => x.id === id);
    if (!f) throw new UserError(msg("errNoSuchFolder"));
    return f;
  }

  *#allCopies(): Generator<Copy> {
    for (const f of this.config.folders) yield* f.copies;
  }

  /** A copy and the folder it is a copy of. */
  #find(copyId: string): { folder: Folder; copy: Copy } {
    for (const folder of this.config.folders) {
      const copy = folder.copies.find((c) => c.id === copyId);
      if (copy) return { folder, copy };
    }
    throw new UserError("unknown copy");
  }

  #device(deviceId: string) {
    return this.config.devices.find((d) => d.id === deviceId);
  }

  /** What a copy is called: the other computer's name. */
  #nameOf(copy: Copy) {
    return this.#device(copy.deviceId)?.name ?? "?";
  }

  // ------------------------------------------------------------------ following the folders

  #busy() {
    return this.job?.phase === "scanning" || this.job?.phase === "applying";
  }

  /** Start following a folder: a watcher, then one scan (the list is live once both are done). */
  async #follow(folder: string, store: LocalStore): Promise<Side_> {
    const side: Side_ = { folder, store, watcher: null, live: { live: false, why: "starting" } };
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
      const ignore = this.config.folders.find((f) => f.id === side.folder)?.ignore ?? DEFAULT_IGNORE;
      const scan = await side.store.scan(ignore, progress);
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

  async #openFolder(f: Folder) {
    this.#unfollow(this.#folders.get(f.id));
    this.#folders.delete(f.id);
    const store = new LocalStore(f.path, { scope: this.#db.scope(`folder:${f.id}`) });
    if (!(await store.present())) {
      this.#folders.set(f.id, { folder: f.id, store, watcher: null, live: { live: false, why: "failed" } });
      return;
    }
    await store.cleanTmp();
    await store.pruneOld(this.config.keepDays);
    this.#folders.set(f.id, await this.#follow(f.id, store));
  }

  /**
   * Where a folder can be kept (made when it doesn't exist yet): never inside or around another synced folder,
   * whose files would then be synced twice. `except`: the folder being moved.
   */
  async #placeFor(path: string, except?: string): Promise<string> {
    const place = resolve(path.trim());
    if (place.split(sep).includes(OWN)) throw new UserError(msg("errInsideOwn"));
    for (const f of this.config.folders) {
      if (f.id === except) continue;
      if (resolve(f.path) === place) throw new UserError(msg("errAlreadyFolder"));
      if (within(f.path, place) || within(place, f.path))
        throw new UserError(msg("errNestedFolder", { path: f.path }));
    }
    try {
      await mkdir(place, { recursive: true });
      if (!(await stat(place)).isDirectory()) throw new Error("not a folder");
    } catch (e) {
      throw new UserError(msg("errFolder", { path: place, error: (e as Error).message }));
    }
    return place;
  }

  /** Keep another folder in sync (made when it doesn't exist yet). Returns its id. */
  async addFolder(path: string): Promise<string> {
    const place = await this.#placeFor(path);
    const f: Folder = { id: hex(16), path: place, ignore: DEFAULT_IGNORE, copies: [] };
    this.config.folders.push(f);
    await this.#save();
    await this.#openFolder(f);
    this.#restatusSoon();
    this.changed();
    return f.id;
  }

  /** Keep a folder somewhere else: what was remembered about the old place is forgotten. */
  async setFolderPath(folderId: string, path: string) {
    const f = this.#folderById(folderId);
    if (this.#busy()) throw new UserError(msg("errBusy"));
    const place = await this.#placeFor(path, f.id);
    if (place !== f.path) {
      // another folder: what was remembered about the old one is not true of this one. A new history for its
      // list also makes other computers' writes planned against the old folder fail (#answer, sameFolder).
      this.#db.scope(`folder:${f.id}`).clear();
      for (const c of f.copies) {
        this.#db.drop(`base:${c.id}`);
        delete c.lastSync;
      }
      this.#leave(f);
      f.path = place;
      await this.#save();
    }
    if (place !== this.#folders.get(f.id)?.store.root || !this.#folders.get(f.id)?.watcher)
      await this.#openFolder(f);
    this.#restatusSoon();
    this.changed();
  }

  /** Stop keeping a folder in sync. Its files stay where they are; its copies are forgotten. */
  async removeFolder(folderId: string) {
    const f = this.#folderById(folderId);
    if (this.#busy() && f.copies.some((c) => c.id === this.job?.copyId)) throw new UserError(msg("errBusy"));
    this.#leave(f);
    for (const c of f.copies) this.#forgetCopy(c);
    this.#unfollow(this.#folders.get(f.id));
    this.#folders.delete(f.id);
    this.#db.drop(`folder:${f.id}`);
    this.config.folders = this.config.folders.filter((x) => x !== f);
    await this.#save();
    this.#restatusSoon();
    this.changed();
  }

  /** Let go of what concerns a folder: its open review, files on their way into it. */
  #leave(f: Folder) {
    if (this.job && f.copies.some((c) => c.id === this.job!.copyId)) {
      this.job = null;
      this.#work = null;
    }
    for (const [id, u] of this.#uploads) {
      if (u.folder !== f.id) continue;
      void u.upload.abort(); // a file on its way into the old folder
      this.#uploads.delete(id);
    }
  }

  /** Forget everything kept about a copy (it is already out of its folder's list, or about to be). */
  #forgetCopy(c: Copy) {
    if (this.job?.copyId === c.id) {
      this.job = null;
      this.#work = null;
    }
    this.#peers.delete(c.id);
    this.#statuses.delete(c.id);
    for (const scope of [`base:${c.id}`, `peer:${c.id}`, `peerbase:${c.id}`]) this.#db.drop(scope);
  }

  /** Ask for a folder with the system's dialog; null when cancelled. */
  chooseFolder() {
    return this.shell.chooseFolder(msg("chooseFolderTitle"), this.config.folders[0]?.path);
  }

  /**
   * A computer just paired: remembered at once, and the folder whose "add a copy" screen was open shared with
   * it (offered once saved). Paired again (the other side forgot this one): the same computer, a new key.
   */
  #addDevice(deviceId: string, name: string, key: Buffer, address?: string, folderId?: string) {
    const old = this.#device(deviceId);
    if (old) {
      old.key = key.toString("base64");
      old.name = name || old.name;
      old.address = address ?? old.address;
    } else {
      this.config.devices.push({
        id: deviceId,
        name: name || "Computer",
        key: key.toString("base64"),
        address,
        added: Date.now(),
      });
    }
    const folder = this.config.folders.find((f) => f.id === folderId);
    let copy: DeviceCopy | undefined;
    if (folder && !folder.copies.some((c) => c.kind === "device" && c.deviceId === deviceId)) {
      copy = { kind: "device", id: hex(8), deviceId, remote: null, pairing: true, added: Date.now() };
      folder.copies.push(copy);
    }
    const saved = this.#save().then(() => {
      this.changed();
      this.#pollSoon(0);
    });
    return { saved, offered: folder && copy ? saved.then(() => this.#offer(folder, copy)) : saved };
  }

  /** Forget a copy of a folder: that computer is no longer let into this folder. */
  async removeCopy(id: string) {
    const { folder, copy } = this.#find(id);
    if (this.job?.copyId === id && this.#busy()) throw new UserError(msg("errBusy"));
    folder.copies = folder.copies.filter((c) => c !== copy);
    this.#forgetCopy(copy);
    await this.#save();
    this.#restatusSoon();
    this.changed();
  }

  // ------------------------------------------------------------------ paired computers

  /**
   * Ask a paired computer something at each address it was seen at, until one answers. The line to it is
   * shared by every folder shared with it.
   */
  async #at<T>(dev: Device, fn: (link: Link) => Promise<T>): Promise<T> {
    const addresses = [
      ...new Set([this.#discovery?.find(dev.id)?.address, this.#links.get(dev.id)?.address, dev.address]),
    ].filter((a): a is string => a !== undefined);
    let failure: unknown = new Unreachable("no address");
    for (const address of addresses) {
      let ls = this.#links.get(dev.id);
      if (!ls || ls.address !== address || ls.key !== dev.key) {
        ls = {
          link: new Link(
            address,
            { id: this.config.device.id, port: this.#peer.port },
            dev.id,
            Buffer.from(dev.key, "base64"),
          ),
          address,
          key: dev.key,
        };
        this.#links.set(dev.id, ls);
      }
      try {
        const out = await fn(ls.link);
        if (dev.address !== address) {
          dev.address = address;
          void this.#save();
        }
        return out;
      } catch (e) {
        failure = e;
        if (whyNot(e) !== "off") break; // it answered: no other address will say otherwise
      }
    }
    throw failure;
  }

  /** Which folder a request to the other computer is about: its id there, and this computer's. */
  #where(copy: DeviceCopy) {
    const folder = this.config.folders.find((f) => f.copies.includes(copy));
    return { folder: copy.remote ?? "", from: folder?.id ?? "" };
  }

  /** Reach the folder a paired computer shares: its store and its status. */
  async #reach(copy: DeviceCopy): Promise<{ remote: RemoteStore; st: PeerStatus }> {
    const dev = this.#device(copy.deviceId);
    if (!dev) throw new Refused("not paired");
    const p = this.#peers.get(copy.id) ?? {};
    this.#peers.set(copy.id, p);
    return this.#at(dev, async (link) => {
      if (!p.remote || p.link !== link) {
        p.remote = new RemoteStore(
          link,
          this.#db.scope(`peer:${copy.id}`),
          this.#db.scope(`peerbase:${copy.id}`),
          () => this.#where(copy),
        );
        p.link = link;
      }
      const st = await p.remote.status();
      let save = false;
      if (copy.remote === "legacy" && ID.test(String(st.folder))) {
        copy.remote = st.folder; // from 0.2.0: now it is known which of its folders this is
        save = true;
      }
      if (st.name && st.name !== dev.name) {
        dev.name = st.name.slice(0, 40);
        save = true;
      }
      if (save) void this.#save();
      return { remote: p.remote, st };
    });
  }

  /** Offer a folder to the computer it is shared with. Its answer links it, or takes the share back. */
  async #offer(folder: Folder, copy: DeviceCopy) {
    const dev = this.#device(copy.deviceId);
    if (!dev || copy.remote !== null) return;
    let r: { answer?: unknown; folder?: unknown };
    try {
      r = (
        await this.#at(dev, (link) =>
          link.call(
            "offer",
            { folder: folder.id, name: basename(folder.path), pairing: copy.pairing === true },
            undefined,
            8000,
          ),
        )
      ).result as typeof r;
    } catch {
      return; // off, or not paired there yet: offered again at the next look
    }
    if (copy.remote !== null || !folder.copies.includes(copy)) return; // settled meanwhile
    if (r?.answer === "linked" && ID.test(String(r.folder))) {
      copy.remote = String(r.folder);
      delete copy.pairing;
      this.config.offers = this.config.offers.filter(
        (o) => !(o.deviceId === dev.id && o.folder === copy.remote),
      );
    } else if (r?.answer === "declined") {
      folder.copies = folder.copies.filter((c) => c !== copy);
      this.#forgetCopy(copy);
    } else return;
    await this.#save();
    this.#restatusSoon();
    this.changed();
    this.#pollSoon(0);
  }

  /** Share a folder with a paired computer: offered there, linked when it is accepted. */
  async share(folderId: string, deviceId: string) {
    const f = this.#folderById(folderId);
    if (!this.#device(deviceId)) throw new UserError("unknown computer");
    if (f.copies.some((c) => c.kind === "device" && c.deviceId === deviceId))
      throw new UserError(msg("errAlreadyShared"));
    const copy: DeviceCopy = { kind: "device", id: hex(8), deviceId, remote: null, added: Date.now() };
    f.copies.push(copy);
    await this.#save();
    this.#restatusSoon();
    this.changed();
    await this.#offer(f, copy);
  }

  /**
   * Accept a folder another computer offers: into one of this computer's folders (`folder`), or a new one
   * made at `path`. Told there at once when it answers; otherwise its first request links it.
   */
  async acceptOffer(deviceId: string, theirs: string, into: { folder?: string; path?: string }) {
    const offer = this.config.offers.find((o) => o.deviceId === deviceId && o.folder === theirs);
    if (!offer) throw new UserError(msg("errGoneMeanwhile"));
    if (into.folder !== undefined) {
      const existing = this.#folderById(into.folder).copies.find(
        (c) => c.kind === "device" && c.deviceId === deviceId,
      );
      if (existing?.kind === "device" && existing.remote !== null && existing.remote !== theirs)
        throw new UserError(msg("errAlreadyShared"));
    }
    const f = this.#folderById(into.folder ?? (await this.addFolder(into.path ?? "")));
    const pending = f.copies.find((c): c is DeviceCopy => c.kind === "device" && c.deviceId === deviceId);
    if (pending) {
      pending.remote = theirs;
      delete pending.pairing;
    } else f.copies.push({ kind: "device", id: hex(8), deviceId, remote: theirs, added: Date.now() });
    this.config.offers = this.config.offers.filter((o) => o !== offer);
    await this.#save();
    this.#restatusSoon();
    this.changed();
    const dev = this.#device(deviceId);
    if (dev)
      await this.#at(dev, (link) =>
        link.call("accept", { folder: theirs, from: f.id }, undefined, 8000),
      ).catch(() => {});
    this.#pollSoon(0);
    return f.id;
  }

  /** Answer an offer "not on this computer": the same offer again is answered so without asking. */
  async declineOffer(deviceId: string, theirs: string) {
    this.config.offers = this.config.offers.filter((o) => !(o.deviceId === deviceId && o.folder === theirs));
    if (!this.config.declined.some((d) => d.deviceId === deviceId && d.folder === theirs))
      this.config.declined.push({ deviceId, folder: theirs });
    this.config.declined = this.config.declined.slice(-200);
    await this.#save();
    this.changed();
    const dev = this.#device(deviceId);
    if (dev)
      await this.#at(dev, (link) => link.call("decline", { folder: theirs }, undefined, 8000)).catch(
        () => {},
      );
  }

  /** Forget a paired computer: its key, and every folder shared with it. */
  async forgetDevice(deviceId: string) {
    const copies = this.config.folders.flatMap((f) =>
      f.copies.filter((c) => c.kind === "device" && c.deviceId === deviceId),
    );
    if (this.#busy() && copies.some((c) => c.id === this.job?.copyId)) throw new UserError(msg("errBusy"));
    for (const f of this.config.folders) f.copies = f.copies.filter((c) => !copies.includes(c));
    for (const c of copies) this.#forgetCopy(c);
    this.config.devices = this.config.devices.filter((d) => d.id !== deviceId);
    this.config.offers = this.config.offers.filter((o) => o.deviceId !== deviceId);
    this.config.declined = this.config.declined.filter((o) => o.deviceId !== deviceId);
    this.#links.delete(deviceId);
    await this.#save();
    this.#restatusSoon();
    this.changed();
  }

  /** Ask a paired computer for news soon (it appeared, a window opened). */
  #pollSoon(delay = 1500) {
    if (this.#viewers === 0 && delay > 0) return;
    clearTimeout(this.#pollSoonTimer);
    this.#pollSoonTimer = setTimeout(() => void this.poll(), delay);
    this.#pollSoonTimer.unref?.();
  }

  /**
   * Ask every paired computer for the status of each folder it shares, then only for what changed since the
   * last look (its list and its record). Cheap when nothing changed: one small question each. A folder still
   * waiting for an answer is offered again.
   */
  poll(): Promise<void> {
    if (this.#polling) {
      this.#pollAgain = true; // asked for news that came after this round started: one more round
      return this.#polling;
    }
    const run = async () => {
      for (const f of this.config.folders) {
        for (const copy of f.copies) {
          if (this.#stopped) continue;
          if (copy.remote === null) {
            await this.#offer(f, copy);
            continue;
          }
          if (this.#busy() && this.job?.copyId === copy.id) continue; // the sync has the fresh lists
          const p = this.#peers.get(copy.id) ?? {};
          this.#peers.set(copy.id, p);
          try {
            const { remote, st } = await this.#reach(copy);
            if (!remote.current(st)) await remote.pull(false);
            if (!remote.baseCurrent(st)) await remote.loadBase();
            p.status = st;
            p.why = undefined;
          } catch (e) {
            p.status = undefined;
            p.why = whyNot(e);
          }
        }
      }
    };
    // cleared in .finally, which always runs after this assignment (even when nothing had to be asked)
    this.#polling = run().finally(() => {
      this.#polling = null;
      this.#restatus();
      if (this.#pollAgain && !this.#stopped) {
        this.#pollAgain = false;
        void this.poll();
      }
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
    for (const f of this.config.folders) {
      const here = view(this.#folders.get(f.id), "failed");
      for (const copy of f.copies) {
        const mine = this.#db.scope(`base:${copy.id}`).hashes();
        const p = this.#peers.get(copy.id);
        const st = p?.status;
        let there: SideView;
        if (copy.remote === null) there = { known: false, why: "waiting" };
        else if (!p) there = { known: false, why: "starting" }; // not asked yet
        else if (!st || p.why) there = { known: false, why: p.why ?? "off" };
        else if (!st.live) there = { known: false, why: st.why ?? "failed" };
        else
          there = {
            known: true,
            files: this.#db.scope(`peer:${copy.id}`).view(),
            unread: p.remote?.unread ?? [],
          };
        const theirs = this.#db.scope(`peerbase:${copy.id}`);
        const base = theirs.size || theirs.seq ? agreedBase(mine, theirs.hashes()) : mine;
        this.#statuses.set(copy.id, copyStatus(here, there, base, skipper(f.ignore, st?.ignore ?? "")));
      }
    }
    this.changed();
  }

  /** Work out the statuses now (tests; the window gets them by itself). */
  async refreshStatus() {
    await this.poll();
  }

  // ------------------------------------------------------------------ pairing

  /** Show a pairing code for ten minutes. `folder`: shared with the computer that pairs with it. */
  async startPairing(folder?: string) {
    const code = newCode();
    this.pairing = {
      code,
      key: await codeKey(code, this.config.device.id),
      until: Date.now() + 10 * 60_000,
      tries: 0,
      folder: this.config.folders.some((f) => f.id === folder) ? folder : undefined,
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

  /**
   * Pair with the computer showing `code`, at `address` (host, or host:port). `folder`: shared with it, and
   * linked at once when it shares one too while pairing.
   */
  async pair(address: string, code: string, folder?: string) {
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
      await this.#addDevice(peer.id, peer.name, peer.key, at, folder).offered;
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

  /** Compare a folder with one of its copies; the job goes to "review" (or straight to "done"). */
  compare(copyId: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    const { folder: f, copy } = this.#find(copyId);
    const name = this.#nameOf(copy);
    if (copy.remote === null) throw new UserError(msg("errWaiting", { name }));
    this.#work = null;
    this.#cancel = false;
    this.job = { phase: "scanning", copyId, here: [0, 0], there: [0, 0] };
    this.changed();
    const run = async () => {
      const folder = this.#folders.get(f.id);
      if (!folder) throw new UserError(msg("errNoSuchFolder"));
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
      let b: RemoteStore;
      try {
        b = (await this.#reach(copy)).remote;
      } catch (e) {
        if (e instanceof UserError) throw e;
        const why = whyNot(e);
        throw new UserError(
          msg(
            why === "version"
              ? "errVersion"
              : why === "refused"
                ? "errRefused"
                : why === "unshared"
                  ? "errUnshared"
                  : "errUnreachable",
            { name },
          ),
        );
      }
      const scans = await Promise.all([this.#rescan(folder, true, here), b.scan("", there)]);
      const theirIgnore = b.ignore;
      const theirBase = await b.loadBase();
      const [scanA, scanB] = scans;
      const listA = scanA.files;
      const listB = scanB.files;
      const baseScope = this.#db.scope(`base:${copy.id}`);
      const mine = baseScope.hashes();
      const base = theirBase ? agreedBase(mine, theirBase) : mine;
      const skip = skipper(f.ignore, theirIgnore);
      // a side that held files at the last sync and shows none now is more likely a disk that is not there
      // (an empty mount point) than a folder emptied on purpose: stop rather than plan to delete everything
      const known = Object.keys(base).filter((p) => !skip(p)).length;
      if (known > 0 && !scanA.unread.length && !scanB.unread.length) {
        if (!Object.keys(listA).length) throw new UserError(msg("errEmptiedHere", { n: known }));
        if (!Object.keys(listB).length) throw new UserError(msg("errEmptiedThere", { name, n: known }));
      }
      const actions = plan(listA, listB, base, [...scanA.unread, ...scanB.unread], skip);
      const byKind = Object.fromEntries(KINDS.map((k) => [k, [] as Action[]])) as Record<ItemKind, Action[]>;
      for (const act of actions) {
        const kind = this.#kindOf(act);
        if (kind) byKind[kind].push(act);
      }
      this.#work = {
        folder: f,
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
    this.#track(run().catch((e: Error) => this.#failed(copyId, e)));
  }

  /** Remember the comparison or sync under way: stop() waits for it. */
  #track(p: Promise<void>) {
    this.#running = p;
    void p.finally(() => {
      if (this.#running === p) this.#running = null;
    });
  }

  #kindOf(act: Action): ItemKind | null {
    if (act.kind === "settle") return null;
    if (act.kind === "copy") return act.from === "a" ? "send" : "receive";
    if (act.kind === "delete") return act.on === "a" ? "remove-here" : "remove-there";
    return act.kind;
  }

  #failed(copyId: string, e: Error) {
    if (this.#stopped) return; // stopped under it: nothing to tell
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
    this.#track(this.#apply().catch((e: Error) => this.#failed(this.#work?.copy.id ?? "", e)));
  }

  async #apply() {
    const w = this.#work!;
    const copy = w.copy;
    const baseScope = this.#db.scope(`base:${copy.id}`);
    // the other computer synced with this one while the review sat open: its plan is about another state
    if (baseScope.seq !== w.baseSeq) throw new UserError(msg("errStale", { name: this.#nameOf(copy) }));
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
      nameB: this.#nameOf(copy),
      progress: (p) => {
        this.job = { phase: "applying", copyId: copy.id, progress: p };
        this.changed();
      },
      cancelled: () => this.#cancel,
      record: (path, hash) => {
        forHere.push([path, hash]);
        forThere.push([path, hash]);
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
        if (forThere.length) {
          const sending = forThere.slice();
          await w.b.saveBase(sending);
          forThere.splice(0, sending.length);
        }
      },
      alive: (side) => (side === "a" ? w.a.present() : w.b.alive()),
    });
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
      await w.b.synced();
    }
    this.#work = null;
    this.job = { phase: "done", copyId: copy.id, at: now.getTime(), summary };
    this.changed();
    // the home screen's status, from what the sync just left (and the other computer's news)
    void this.poll();
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

  #folderStore(folderId: string): LocalStore {
    const side = this.#folders.get(this.#folderById(folderId).id);
    if (!side) throw new UserError(msg("errNoSuchFolder"));
    return side.store;
  }

  async oldVersions(folderId: string): Promise<OldVersion[]> {
    const side = this.#folders.get(folderId);
    if (!side) return [];
    return (await side.store.listOld()).slice(0, 2000);
  }

  async restore(folderId: string, stamp: string, path: string) {
    if (this.#busy()) throw new UserError(msg("errBusy"));
    await this.#folderStore(folderId).restoreOld(stamp, path, stampOf(new Date()));
    this.#restatusSoon();
    this.changed();
  }

  async openOld(folderId: string, stamp: string, path: string) {
    await this.shell.open(this.#folderStore(folderId).oldPath(stamp, path));
  }

  async openFolder(folderId: string) {
    await this.shell.open(this.#folderById(folderId).path);
  }

  /** Wait until the first scans are done, then ask paired computers: the statuses are then as good as they get. */
  async settled() {
    for (let i = 0; i < 3; i++) {
      // one scan at a time per store: a refresh queued behind the scan waits for it
      const sides = [...this.#folders.values()];
      await Promise.all(sides.map((s) => s.store.refresh([]).catch(() => [])));
      if (sides.every((s) => s.live.live || s.live.why !== "starting")) break;
    }
    await this.poll();
  }

  // ------------------------------------------------------------------ what the window shows

  state() {
    const c = this.config;
    const seen = this.#discovery?.seen() ?? [];
    const near = (deviceId: string) => seen.some((s) => s.id === deviceId);
    return {
      version: this.appVersion,
      update: this.update,
      updateOut: this.updateOut,
      device: { name: c.device.name },
      addresses: localAddresses().map((a) => (this.#peer.port === PEER_PORT ? a : `${a}:${this.#peer.port}`)),
      folders: c.folders.map((f) => {
        const side = this.#folders.get(f.id);
        return {
          id: f.id,
          path: f.path,
          name: basename(f.path),
          live: !!side?.live.live,
          why: side && !side.live.live ? side.live.why : null,
          ignore: f.ignore,
          copies: f.copies.map((copy) => ({
            id: copy.id,
            name: this.#nameOf(copy),
            deviceId: copy.deviceId,
            /** Offered to that computer, not accepted there yet. */
            waiting: copy.remote === null,
            lastSync: copy.lastSync ?? null,
            where: this.#device(copy.deviceId)?.address ?? "",
            available: copy.remote !== null && (near(copy.deviceId) || !!this.#peers.get(copy.id)?.status),
            status: this.#statuses.get(copy.id) ?? null,
          })),
        };
      }),
      /** Paired computers. */
      devices: c.devices.map((d) => ({
        id: d.id,
        name: d.name,
        address: d.address ?? "",
        available: near(d.id),
      })),
      /** Folders other computers offer to share with this one. */
      offers: c.offers.map((o) => ({
        deviceId: o.deviceId,
        device: this.#device(o.deviceId)?.name ?? "?",
        folder: o.folder,
        name: o.name,
      })),
      settings: {
        keepDays: c.keepDays,
        theme: c.theme,
        lang: c.lang,
        defaultIgnore: DEFAULT_IGNORE,
      },
      pairing: this.pairing
        ? { code: this.pairing.code, until: this.pairing.until, folder: this.pairing.folder ?? null }
        : null,
      /** Computers heard on the network that are not paired with this one yet. */
      nearby: seen
        .filter((s) => !this.#device(s.id))
        .map((s) => ({ name: s.name, address: s.address, pairing: s.pairing })),
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

  /**
   * The folder a paired computer's request is about, if it is shared with it: `folder` is its id here, `from`
   * the caller's own. A folder offered to that computer and not answered yet (or one from 0.2.0) is linked by
   * the first request about it; from then on only that folder of the caller reaches it. Anything else: refused.
   */
  #shared(deviceId: string, args: Record<string, unknown>): { folder: Folder; copy: DeviceCopy } {
    const asked = String(args.folder ?? "");
    const from = String(args.from ?? "");
    if (!ID.test(from)) throw new Error("not shared");
    for (const folder of this.config.folders) {
      if (asked !== "legacy" && folder.id !== asked) continue;
      for (const copy of folder.copies) {
        if (copy.kind !== "device" || copy.deviceId !== deviceId) continue;
        if (copy.remote === from) return { folder, copy };
        const open =
          asked === "legacy" ? copy.remote === "legacy" : copy.remote === null || copy.remote === "legacy";
        if (!open) continue;
        copy.remote = from;
        delete copy.pairing;
        this.config.offers = this.config.offers.filter(
          (o) => !(o.deviceId === deviceId && o.folder === from),
        );
        void this.#save();
        this.#restatusSoon();
        this.changed();
        return { folder, copy };
      }
    }
    throw new Error("not shared");
  }

  /** Another computer offers a folder: already linked, linked now (offered both ways while pairing), declined, or kept for the user. */
  async #offered(dev: Device, args: Record<string, unknown>): Promise<{ answer: string; folder?: string }> {
    const theirs = String(args.folder ?? "");
    if (!ID.test(theirs)) throw new Error("bad request");
    const name = String(args.name ?? "").slice(0, 100) || "?";
    if (this.config.declined.some((d) => d.deviceId === dev.id && d.folder === theirs))
      return { answer: "declined" };
    const mine = (match: (c: DeviceCopy) => boolean) => {
      for (const folder of this.config.folders)
        for (const copy of folder.copies)
          if (copy.kind === "device" && copy.deviceId === dev.id && match(copy)) return { folder, copy };
      return null;
    };
    const linked = mine((c) => c.remote === theirs);
    if (linked) return { answer: "linked", folder: linked.folder.id };
    // both people were on "add a copy" while pairing: the two folders were chosen for each other
    const mutual = args.pairing === true ? mine((c) => c.remote === null && c.pairing === true) : null;
    if (mutual) {
      mutual.copy.remote = theirs;
      delete mutual.copy.pairing;
      this.config.offers = this.config.offers.filter((o) => !(o.deviceId === dev.id && o.folder === theirs));
      await this.#save();
      this.#restatusSoon();
      this.changed();
      this.#pollSoon(0);
      return { answer: "linked", folder: mutual.folder.id };
    }
    const old = this.config.offers.find((o) => o.deviceId === dev.id && o.folder === theirs);
    if (old) old.name = name;
    else {
      if (this.config.offers.filter((o) => o.deviceId === dev.id).length >= 20)
        throw new Error("too many offers");
      this.config.offers.push({ deviceId: dev.id, folder: theirs, name, at: Date.now() });
    }
    await this.#save();
    this.changed();
    return { answer: "ok" };
  }

  async #answer(
    deviceId: string,
    method: string,
    args: Record<string, unknown>,
    payload: Buffer,
  ): Promise<Answer> {
    const dev = this.#device(deviceId);
    if (!dev) throw new Error("not paired");
    // about this computer, not about a folder
    if (method === "info")
      return { result: { name: this.config.device.name, version: this.appVersion } satisfies RemoteInfo };
    if (method === "offer") return { result: await this.#offered(dev, args) };
    if (method === "decline") {
      // it doesn't want the folder offered to it: the offer is taken back
      for (const f of this.config.folders) {
        if (f.id !== String(args.folder ?? "")) continue;
        const copy = f.copies.find(
          (c) => c.kind === "device" && c.deviceId === deviceId && c.remote === null,
        );
        if (!copy) continue;
        f.copies = f.copies.filter((c) => c !== copy);
        this.#forgetCopy(copy);
        await this.#save();
        this.#restatusSoon();
        this.changed();
      }
      return {};
    }

    const { folder: f, copy } = this.#shared(deviceId, args);
    const folder = this.#folders.get(f.id);
    const baseScope = this.#db.scope(`base:${copy.id}`);
    // questions that only look (its status poll): no "is syncing" notice, nothing read from the disk
    if (method === "accept") {
      this.#pollSoon(0);
      return {};
    }
    if (method === "status") {
      const scope = this.#db.scope(`folder:${f.id}`);
      return {
        result: {
          name: this.config.device.name,
          folder: f.id,
          folderName: basename(f.path),
          epoch: scope.epoch,
          seq: scope.seq,
          baseEpoch: baseScope.epoch,
          baseSeq: baseScope.seq,
          live: !!folder?.live.live,
          why: folder && !folder.live.live ? folder.live.why : undefined,
          ignore: f.ignore,
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
        this.#guestHere(dev.name); // a sync is starting there
        await this.#rescan(folder, true);
      }
      return {
        result: {
          ...store.scope.changesSince(String(args.epoch ?? ""), Number(args.since) || 0, limit),
          unread: [...store.unread],
          ignore: f.ignore,
        },
      };
    }
    this.#guestHere(dev.name);

    for (const [id, u] of this.#uploads) {
      if (Date.now() - u.at > 30 * 60_000) {
        void u.upload.abort();
        this.#uploads.delete(id);
      }
    }
    /** A file on its way, started by this computer into this folder: nobody else's. */
    const upload = () => {
      const u = this.#uploads.get(String(args.id));
      if (!u || u.device !== deviceId || u.folder !== f.id) throw new Error("unknown upload");
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
          device: deviceId,
          folder: f.id,
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
        const u = upload();
        this.#uploads.delete(String(args.id));
        await u.upload.abort();
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
