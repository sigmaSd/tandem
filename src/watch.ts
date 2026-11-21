// Watching a folder for changes, as a best effort: the system tells which paths changed, and the store reads
// just those again (LocalStore.refresh). It keeps the list fresh between scans so the window can say what
// changed, without reading the whole folder every few seconds. It can miss things, and the app says so
// rather than guess (src/status.ts): it is stopped by an error, it does not work on network folders
// (another computer's changes make no event here), and a sync, which always reads the disk, finds what it
// missed (src/core.ts counts those and stops trusting it).

import { type FSWatcher, watch } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { OWN } from "./names.ts";

/** Why a folder can't be watched. */
export type Trouble = "network" | "failed";

/** Linux file system types whose files can change from another machine without an event here. */
const REMOTE =
  /^(nfs4?|cifs|smb3?|smbfs|9p|ceph|glusterfs|afs|davfs|fuse\.(sshfs|rclone|gvfsd-fuse|s3fs|gcsfuse|curlftpfs|onedriver|davfs2))$/;

/** Whether `root` is on a network folder, as far as this system can tell (false when it can't). */
export async function onNetwork(root: string): Promise<boolean> {
  if (process.platform === "win32") return root.startsWith("\\\\"); // \\server\share; a mapped letter can't be told
  if (process.platform !== "linux") return false; // macOS: not told apart yet
  let path: string;
  let mounts: string;
  try {
    path = await realpath(root);
    mounts = await readFile("/proc/self/mountinfo", "utf8");
  } catch {
    return false;
  }
  let best = "";
  let type = "";
  for (const line of mounts.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!right) continue;
    const point = (left.split(" ")[4] ?? "").replace(/\\(\d{3})/g, (_m, o: string) =>
      String.fromCharCode(parseInt(o, 8)),
    );
    const inside = path === point || path.startsWith(point === "/" ? "/" : `${point}/`);
    if (inside && point.length >= best.length) {
      best = point;
      type = right.split(" ")[0] ?? "";
    }
  }
  return REMOTE.test(type);
}

export interface WatchEvents {
  /** These paths (relative, with the system's separator) changed, a moment ago. */
  paths(paths: string[]): void;
  /** The system said something changed without saying what: the whole folder must be read again. */
  lost(): void;
  /** Watching stopped, or could not start. */
  trouble(why: Trouble): void;
}

/** Events are gathered until the folder is quiet for this long (a save is often several events)… */
const QUIET = 700;
/** …but never held longer than this. */
const HOLD = 4000;

export class Watcher {
  readonly root: string;
  readonly #on: WatchEvents;
  #fs?: FSWatcher;
  readonly #pending = new Set<string>();
  #timer?: ReturnType<typeof setTimeout>;
  #since = 0;

  constructor(root: string, on: WatchEvents) {
    this.root = root;
    this.#on = on;
  }

  get running() {
    return !!this.#fs;
  }

  /** Start watching; false (and trouble reported) when it can't. */
  async start(): Promise<boolean> {
    if (this.#fs) return true;
    if (await onNetwork(this.root)) {
      this.#on.trouble("network");
      return false;
    }
    try {
      this.#fs = watch(this.root, { recursive: true }, (_event, name) => this.#event(name));
    } catch {
      this.#on.trouble("failed"); // too many folders for the system's limit, or the folder is gone
      return false;
    }
    this.#fs.on("error", () => {
      this.stop();
      this.#on.trouble("failed");
    });
    return true;
  }

  stop() {
    clearTimeout(this.#timer);
    this.#pending.clear();
    try {
      this.#fs?.close();
    } catch {
      /* already closed */
    }
    this.#fs = undefined;
  }

  #event(name: string | Buffer | null) {
    if (name === null || name === undefined) {
      this.#on.lost();
      return;
    }
    const path = String(name);
    const top = path.split(/[\\/]/)[0];
    if (!path || top === OWN) return; // Tandem's own writes in .tandem
    this.#pending.add(path);
    if (!this.#since) this.#since = Date.now();
    clearTimeout(this.#timer);
    const wait = Math.max(0, Math.min(QUIET, this.#since + HOLD - Date.now()));
    this.#timer = setTimeout(() => this.#emit(), wait);
    this.#timer.unref?.();
  }

  #emit() {
    const paths = this.takePending();
    if (paths.length) this.#on.paths(paths);
  }

  /** The paths gathered and not yet reported, now (before a scan, so it starts from them). */
  takePending(): string[] {
    clearTimeout(this.#timer);
    this.#since = 0;
    const paths = [...this.#pending];
    this.#pending.clear();
    return paths;
  }
}
