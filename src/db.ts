// What Tandem remembers about files, in one SQLite database in the app's own folder (Node's built-in
// node:sqlite): for each copy it knows, every file with its size, date and content hash, and a change number
// that only goes up. Kept file by file, so a sync or a change on the disk costs one row, not a rewrite.
//
// A scope is one list of files:
//   folder:<id>       one of this computer's synced folders (kept by its scans and its watcher, src/store.ts)
//   base:<copy>       what both sides held after the last sync with that copy (src/plan.ts)
//   peer:<copy>       the last known list of another computer's folder, brought up to date with its changes
//   peerbase:<copy>   that computer's own record of the last sync with this one
//
// Change numbers let another computer ask "what changed since number N?" and get only that. A file that goes
// away leaves a row marked gone, with its change number, so the deletion travels too. A scope's epoch names
// one continuous history: a new folder, or a list rebuilt from nothing, starts a new epoch, and whoever kept
// a copy of the old one starts again from the whole list.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { bare, type Entry, type Listing } from "./listing.ts";

/** One change as it travels: a path and what is there now, or null when it went away. */
export type Change = [path: string, entry: Entry | null];

export interface Changes {
  epoch: string;
  /** The scope's change number after these changes. */
  seq: number;
  /** The caller's copy is from another history: throw it away before applying these. */
  reset: boolean;
  changes: Change[];
  /** There are more after these: ask again from `seq`. */
  more: boolean;
}

const newEpoch = () => randomBytes(8).toString("hex");

interface Row {
  path: string;
  size: number;
  mtime: number;
  hash: string;
  seq: number;
  gone: number;
}

export class Db {
  readonly sql: DatabaseSync;
  readonly #scopes = new Map<string, Scope>();
  #depth = 0;

  /** `path`: the database file, or ":memory:" (tests, and stores that need no memory between runs). */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    // WAL: readers never wait for a writer. FULL: a committed change survives a power cut
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS scopes (
        name TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        scope TEXT NOT NULL, path TEXT NOT NULL,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL, hash TEXT NOT NULL,
        seq INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, path)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS files_by_seq ON files (scope, seq);
    `);
  }

  /** The scope of this name, made empty the first time. */
  scope(name: string): Scope {
    let s = this.#scopes.get(name);
    if (!s) {
      s = new Scope(this, name);
      this.#scopes.set(name, s);
    }
    return s;
  }

  /** Forget a scope entirely (a copy removed, a folder changed). */
  drop(name: string) {
    this.#scopes.get(name)?.forget();
    this.#scopes.delete(name);
    this.sql.prepare("DELETE FROM files WHERE scope = ?").run(name);
    this.sql.prepare("DELETE FROM scopes WHERE name = ?").run(name);
  }

  /** Give a scope another name, its files and history with it (nothing when it is missing, or the name taken). */
  rename(from: string, to: string) {
    const has = (name: string) => !!this.sql.prepare("SELECT 1 FROM scopes WHERE name = ?").get(name);
    if (!has(from) || has(to)) return;
    this.transaction(() => {
      this.sql.prepare("UPDATE files SET scope = ? WHERE scope = ?").run(to, from);
      this.sql.prepare("UPDATE scopes SET name = ? WHERE name = ?").run(to, from);
    });
    for (const name of [from, to]) {
      this.#scopes.get(name)?.forget();
      this.#scopes.delete(name);
    }
  }

  /** Every scope whose name starts with `prefix`. */
  names(prefix: string): string[] {
    return (
      this.sql.prepare("SELECT name FROM scopes WHERE name >= ? AND name < ?").all(prefix, `${prefix}￿`) as {
        name: string;
      }[]
    ).map((r) => r.name);
  }

  /** Run `fn` as one transaction: all its changes land together, or none (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.#depth++;
    this.sql.exec("BEGIN");
    try {
      const out = fn();
      this.sql.exec("COMMIT");
      return out;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      for (const s of this.#scopes.values()) s.forget(); // their memory may hold what was rolled back
      throw e;
    } finally {
      this.#depth--;
    }
  }

  close() {
    this.sql.close();
  }
}

export class Scope {
  readonly name: string;
  readonly #db: Db;
  #epoch = "";
  #seq = 0;
  /** The live files, kept in memory once read (null: not read yet). */
  #live: Listing | null = null;
  readonly #put: StatementSync;
  readonly #meta: StatementSync;

  constructor(db: Db, name: string) {
    this.#db = db;
    this.name = name;
    const row = db.sql.prepare("SELECT epoch, seq FROM scopes WHERE name = ?").get(name) as
      | { epoch: string; seq: number }
      | undefined;
    if (row) {
      this.#epoch = row.epoch;
      this.#seq = row.seq;
    } else {
      this.#epoch = newEpoch();
      db.sql.prepare("INSERT INTO scopes (name, epoch, seq) VALUES (?, ?, 0)").run(name, this.#epoch);
    }
    this.#put = db.sql.prepare(
      `INSERT INTO files (scope, path, size, mtime, hash, seq, gone) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
         hash = excluded.hash, seq = excluded.seq, gone = excluded.gone`,
    );
    this.#meta = db.sql.prepare("UPDATE scopes SET epoch = ?, seq = ? WHERE name = ?");
  }

  get epoch() {
    return this.#epoch;
  }
  get seq() {
    return this.#seq;
  }

  forget() {
    this.#live = null;
  }

  /** Several changes at once, landing together (see Db.transaction). */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn);
  }

  #load(): Listing {
    if (this.#live) return this.#live;
    const live = bare<Entry>();
    const rows = this.#db.sql
      .prepare("SELECT path, size, mtime, hash FROM files WHERE scope = ? AND gone = 0")
      .all(this.name) as unknown as Row[];
    for (const r of rows) live[r.path] = { size: r.size, mtime: r.mtime, hash: r.hash };
    this.#live = live;
    return live;
  }

  /** The live files. Read only: change them with put and remove. */
  view(): Readonly<Listing> {
    return this.#load();
  }

  /** A copy of the live files, free to change (a sync's working list). */
  snapshot(): Listing {
    return bare(this.#load());
  }

  /** path → content hash, of the live files. */
  hashes(): Record<string, string> {
    const out = bare<string>();
    for (const [p, e] of Object.entries(this.#load())) out[p] = e.hash;
    return out;
  }

  get(path: string): Entry | undefined {
    return Object.hasOwn(this.#load(), path) ? this.#live![path] : undefined;
  }

  get size() {
    return Object.keys(this.#load()).length;
  }

  #write(path: string, e: Entry, gone: boolean) {
    this.#seq++;
    this.#put.run(this.name, path, e.size, e.mtime, e.hash, this.#seq, gone ? 1 : 0);
    this.#meta.run(this.#epoch, this.#seq, this.name);
  }

  /** Record a file as it is now. Nothing happens (and the change number stays) when it is already so. */
  put(path: string, e: Entry): boolean {
    const live = this.#load();
    const old = Object.hasOwn(live, path) ? live[path] : undefined;
    if (old && old.size === e.size && old.mtime === e.mtime && old.hash === e.hash) return false;
    const entry = { size: e.size, mtime: e.mtime, hash: e.hash };
    this.#write(path, entry, false);
    live[path] = entry;
    return true;
  }

  /** Record that a file went away. */
  remove(path: string): boolean {
    const live = this.#load();
    if (!Object.hasOwn(live, path)) return false;
    this.#write(path, live[path], true);
    delete live[path];
    return true;
  }

  /** Every live path equal to `path` or below it (a folder that went away). */
  under(path: string): string[] {
    const live = this.#load();
    const prefix = `${path}/`;
    return Object.keys(live).filter((p) => p === path || p.startsWith(prefix));
  }

  /** What changed after change number `since` of history `epoch`, at most `limit` changes. */
  changesSince(epoch: string, since: number, limit = 20_000): Changes {
    const reset = epoch !== this.#epoch || since > this.#seq;
    const from = reset ? 0 : since;
    const rows = this.#db.sql
      .prepare(
        "SELECT path, size, mtime, hash, seq, gone FROM files WHERE scope = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(this.name, from, limit) as unknown as Row[];
    return {
      epoch: this.#epoch,
      seq: rows.length ? rows.at(-1)!.seq : this.#seq,
      reset,
      changes: rows.map((r) => [r.path, r.gone ? null : { size: r.size, mtime: r.mtime, hash: r.hash }]),
      more: rows.length === limit,
    };
  }

  /**
   * Bring a copy of another scope up to date (peer: and peerbase: scopes) with what it sent: its own epoch and
   * change number are kept, so the next question asks only for what is newer.
   */
  mirror(c: Changes) {
    this.#db.transaction(() => {
      if (c.reset) this.clear(c.epoch);
      const live = this.#load();
      for (const [path, e] of c.changes) {
        if (e) {
          this.#put.run(this.name, path, e.size, e.mtime, e.hash, c.seq, 0);
          live[path] = { size: e.size, mtime: e.mtime, hash: e.hash };
        } else {
          this.#db.sql.prepare("DELETE FROM files WHERE scope = ? AND path = ?").run(this.name, path);
          delete live[path];
        }
      }
      this.#epoch = c.epoch;
      this.#seq = c.seq;
      this.#meta.run(this.#epoch, this.#seq, this.name);
    });
  }

  /** Empty the scope and start a new history (or take `epoch`, a mirror following another one). */
  clear(epoch = newEpoch()) {
    this.#db.sql.prepare("DELETE FROM files WHERE scope = ?").run(this.name);
    this.#epoch = epoch;
    this.#seq = 0;
    this.#live = bare();
    this.#meta.run(this.#epoch, this.#seq, this.name);
  }

  /**
   * Drop the rows of files long gone when there are many of them: a new history, so whoever follows this
   * scope fetches the whole list once. Returns whether it did.
   */
  compact(): boolean {
    const { n } = this.#db.sql
      .prepare("SELECT count(*) AS n FROM files WHERE scope = ? AND gone = 1")
      .get(this.name) as { n: number };
    if (n < 5000 || n < this.size) return false;
    this.#db.transaction(() => {
      this.#db.sql.prepare("DELETE FROM files WHERE scope = ? AND gone = 1").run(this.name);
      this.#epoch = newEpoch();
      this.#meta.run(this.#epoch, this.#seq, this.name);
    });
    return true;
  }
}
