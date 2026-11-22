// Another computer's copy of the folder, reached over the local network: the client side of src/peer.ts.
// A Link is the encrypted line to one paired computer; RemoteStore makes that computer's folder look like any
// other store (src/store.ts): the sync itself works the same on any two stores.

import { cleanRel, NameError } from "./names.ts";
import { canon, PROTOCOL } from "./peer.ts";
import {
  codeKey,
  derive,
  ephemeral,
  mac,
  nonce16,
  pack,
  sameMac,
  seal,
  sessionKeys,
  sharedSecret,
  unpack,
  unseal,
} from "./secure.ts";
import type { Change, Changes, Scope } from "./db.ts";
import type { Entry, Listing } from "./listing.ts";
import type { Why } from "./status.ts";
import { ChangedError, type FileMeta, type Scan, type Store, type Upload } from "./store.ts";

/** The other computer didn't answer: off, asleep, Tandem closed there, or another network. */
export class Unreachable extends Error {}
/** It answered, and refused: the pairing is gone on its side, or the code was wrong. */
export class Refused extends Error {}

const MINUTE = 60_000;

async function post(
  address: string,
  path: string,
  body: Uint8Array | string,
  headers: Record<string, string>,
  timeout: number,
) {
  let res: Response;
  try {
    res = await fetch(`http://${address}${path}`, {
      method: "POST",
      body: body as BodyInit,
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Unreachable((e as Error).message);
  }
  return res;
}

export interface Hello {
  id: string;
  name: string;
  pairing: boolean;
}

/** Who answers at this address, or Unreachable. */
export async function hello(address: string, timeout = 4000): Promise<Hello> {
  let res: Response;
  try {
    res = await fetch(`http://${address}/hello`, { signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new Unreachable((e as Error).message);
  }
  const m = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (m.app !== "tandem" || typeof m.id !== "string") throw new Unreachable("not Tandem");
  if (m.v !== PROTOCOL) throw new Refused("version");
  return { id: m.id, name: String(m.name ?? ""), pairing: !!m.pairing };
}

/** Pair with the computer showing `code` at `address`; returns it and the key the pair now shares. */
export async function pairWith(
  address: string,
  code: string,
  me: { id: string; name: string; port: number },
) {
  const them = await hello(address);
  if (!them.pairing) throw new Refused("not pairing");
  const key = await codeKey(code, them.id);
  const eph = ephemeral();
  const fields = [me.id, me.name, eph.pub, nonce16(), me.port] as const;
  const asked = canon(...fields);
  const res = await post(
    address,
    "/pair",
    JSON.stringify({
      id: fields[0],
      name: fields[1],
      eph: fields[2],
      nonce: fields[3],
      port: fields[4],
      mac: mac(key, "tandem-pair-req", them.id, asked),
    }),
    { "content-type": "application/json" },
    10_000,
  );
  if (res.status === 403) throw new Refused("wrong code");
  if (!res.ok) throw new Refused("not pairing");
  const m = (await res.json()) as Record<string, unknown>;
  const answered = canon(m.id, m.name, m.eph, m.nonce);
  // the answer proves the other side knows the code too: nobody stands in between
  if (m.id !== them.id || !sameMac(mac(key, "tandem-pair-res", asked, answered), m.mac))
    throw new Refused("wrong code");
  const pairKey = derive(
    sharedSecret(eph.priv, String(m.eph)),
    key,
    "tandem-pair-key-v1",
    `${asked}\n${answered}`,
    32,
  );
  return { id: them.id, name: String(m.name ?? ""), key: pairKey };
}

interface Open {
  sid: string;
  send: Buffer;
  recv: Buffer;
  counter: bigint;
}

/** The encrypted line to one paired computer. Questions go one at a time, in order. */
export class Link {
  readonly address: string;
  readonly #me: { id: string; port: number };
  readonly #them: string;
  readonly #key: Buffer;
  #open?: Open;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(address: string, me: { id: string; port: number }, them: string, key: Buffer) {
    this.address = address;
    this.#me = me;
    this.#them = them;
    this.#key = key;
  }

  async #start(): Promise<Open> {
    const eph = ephemeral();
    const nonce = nonce16();
    const asked = canon(this.#me.id, this.#them, eph.pub, nonce, this.#me.port);
    const res = await post(
      this.address,
      "/session",
      JSON.stringify({
        from: this.#me.id,
        eph: eph.pub,
        nonce,
        port: this.#me.port,
        mac: mac(this.#key, "tandem-session-req", asked),
      }),
      { "content-type": "application/json" },
      10_000,
    );
    if (res.status === 401) throw new Refused("not paired");
    if (!res.ok) throw new Unreachable(`answered ${res.status}`);
    const m = (await res.json()) as Record<string, unknown>;
    const answered = canon(m.sid, m.eph, m.nonce);
    // only the paired computer can sign this: an impostor at its address is found out here
    if (!sameMac(mac(this.#key, "tandem-session-res", asked, answered), m.mac))
      throw new Refused("not paired");
    const keys = sessionKeys(sharedSecret(eph.priv, String(m.eph)), this.#key, `${asked}\n${answered}`);
    return { sid: String(m.sid), send: keys.c2s, recv: keys.s2c, counter: 0n };
  }

  async #once(method: string, args: unknown, payload: Uint8Array | undefined, timeout: number) {
    const s = (this.#open ??= await this.#start());
    const counter = ++s.counter;
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(counter);
    const body = Buffer.concat([
      head,
      seal(s.send, counter, `${s.sid}:c2s`, pack({ m: method, a: args }, payload)),
    ]);
    const res = await post(
      this.address,
      "/rpc",
      body,
      { "x-tandem-session": s.sid, "content-type": "application/octet-stream" },
      timeout,
    );
    if (res.status === 401) return null; // the session is gone there: start again
    if (!res.ok) throw new Unreachable(`answered ${res.status}`);
    let answer;
    try {
      answer = unpack(unseal(s.recv, counter, `${s.sid}:s2c`, new Uint8Array(await res.arrayBuffer())));
    } catch (e) {
      if (e instanceof TypeError || (e as Error).name === "AbortError")
        throw new Unreachable((e as Error).message);
      throw new Refused("bad answer");
    }
    const j = answer.json as { ok: boolean; r?: unknown; code?: string; error?: string };
    if (!j.ok) {
      if (j.code === "changed") throw new ChangedError(j.error);
      if (j.error === "not shared") throw new Refused("unshared");
      if (j.code === "name") throw new NameError(j.error);
      throw new Error(j.error ?? "error");
    }
    return { result: j.r, payload: answer.payload };
  }

  /** Ask the other computer something (src/core.ts `call` answers there). */
  call(method: string, args: unknown = {}, payload?: Uint8Array, timeout = 2 * MINUTE) {
    const run = async () => {
      const first = await this.#once(method, args, payload, timeout);
      if (first) return first;
      this.#open = undefined;
      const second = await this.#once(method, args, payload, timeout);
      if (!second) throw new Refused("no session");
      return second;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }
}

export interface RemoteInfo {
  name: string;
  version: string;
}

/** What another computer says about a folder it shares when asked for its status (cheap: nothing is read). */
export interface PeerStatus {
  name: string;
  /** The folder there: its id, and its name. */
  folder: string;
  folderName: string;
  /** Its folder's history and change number (src/db.ts). */
  epoch: string;
  seq: number;
  /** Its record of the last sync with this computer: history and change number. */
  baseEpoch: string;
  baseSeq: number;
  /** Whether its list follows its disk right now, and when not, why (src/status.ts). */
  live: boolean;
  why?: Why;
  /** Its own list of files to leave out (src/ignore.ts). */
  ignore: string;
}

/** A file up to this size travels in one message, both ways. */
export const SMALL = 1 << 20;

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

/** A list of changes from another computer, checked before it is kept: plain paths, well-formed entries. */
function checked(raw: unknown): Changes & { unread: string[]; ignore: string } {
  const r = raw as Changes & { unread?: unknown; ignore?: unknown };
  if (!r || typeof r.epoch !== "string" || !Number.isSafeInteger(r.seq) || !Array.isArray(r.changes))
    throw new Refused("bad answer");
  const changes: Change[] = r.changes.map((c) => {
    const [path, e] = Array.isArray(c) ? (c as unknown[]) : [];
    if (e !== null && !isEntry(e)) throw new Refused("bad answer");
    return [cleanRel(path), e === null ? null : { size: e.size, mtime: e.mtime, hash: e.hash }];
  });
  return {
    epoch: r.epoch,
    seq: r.seq,
    reset: r.reset === true,
    more: r.more === true,
    changes,
    unread: Array.isArray(r.unread) ? r.unread.map(String).slice(0, 100_000) : [],
    ignore: typeof r.ignore === "string" ? r.ignore.slice(0, 20_000) : "",
  };
}

/**
 * A folder another computer shares, as a store. Every question names that folder (its id there) and this
 * computer's own (`where`): the other computer answers only about a folder shared with this one. Its list is followed in a local scope (`mirror`): each time, only
 * what changed since the last look travels. Its record of the last sync with this computer is followed the
 * same way (`baseMirror`).
 */
export class RemoteStore implements Store {
  readonly #link: Link;
  readonly #mirror: Scope;
  readonly #baseMirror: Scope;
  /**
   * Which folder the list is about, as the other computer names it (its folder's history): sent back with
   * every write, which it refuses when its folder was changed in between.
   */
  #token = "";
  /** What the other computer could not read, at its last scan. */
  unread: string[] = [];
  /** Its own list of files to leave out. */
  ignore = "";
  /** Changes asked for at once (the other computer caps it too). */
  pageSize = 20_000;

  readonly #where: () => { folder: string; from: string };

  constructor(link: Link, mirror: Scope, baseMirror: Scope, where: () => { folder: string; from: string }) {
    this.#link = link;
    this.#mirror = mirror;
    this.#baseMirror = baseMirror;
    this.#where = where;
  }

  /** Ask about the folder. */
  #call(method: string, args: Record<string, unknown> = {}, payload?: Uint8Array, timeout?: number) {
    return this.#link.call(method, { ...args, ...this.#where() }, payload, timeout);
  }

  async info(timeout = 8000): Promise<RemoteInfo> {
    return (await this.#link.call("info", {}, undefined, timeout)).result as RemoteInfo;
  }

  async alive() {
    try {
      await this.info(5000);
      return true;
    } catch {
      return false;
    }
  }

  async status(timeout = 8000): Promise<PeerStatus> {
    return (await this.#call("status", {}, undefined, timeout)).result as PeerStatus;
  }

  /** Whether the local copy of its list is as new as the status says. */
  current(st: PeerStatus) {
    return st.epoch === this.#mirror.epoch && st.seq === this.#mirror.seq;
  }

  /** Bring the copy of its list up to date. `scan`: it reads its disk first (for a sync: the truth). */
  async pull(scan: boolean) {
    for (let first = true; ; first = false) {
      const ask = scan && first;
      const r = checked(
        (
          await this.#call(
            "changes",
            { epoch: this.#mirror.epoch, since: this.#mirror.seq, scan: ask, limit: this.pageSize },
            undefined,
            ask ? 30 * MINUTE : 2 * MINUTE, // hashing a big folder for the first time takes a while there
          )
        ).result,
      );
      this.#mirror.mirror(r);
      this.#token = r.epoch;
      this.unread = r.unread;
      this.ignore = r.ignore;
      if (!r.more) return;
    }
  }

  /** The list as it is on its disk now. */
  async scan(_ignore: string, progress?: (done: number, total: number) => void): Promise<Scan> {
    progress?.(0, 0);
    await this.pull(true);
    return { files: this.#mirror.snapshot(), unread: this.unread };
  }

  /** The list as last fetched, without asking (the status of a copy that is not reachable now). */
  known(): Listing {
    return this.#mirror.snapshot();
  }

  /** Its record of the last sync with this computer, brought up to date. */
  async loadBase(): Promise<Record<string, string>> {
    for (;;) {
      const r = checked(
        (
          await this.#call("baseChanges", {
            epoch: this.#baseMirror.epoch,
            since: this.#baseMirror.seq,
            limit: this.pageSize,
          })
        ).result,
      );
      this.#baseMirror.mirror(r);
      if (!r.more) return this.#baseMirror.hashes();
    }
  }

  /** Whether the local copy of its record is as new as the status says. */
  baseCurrent(st: PeerStatus) {
    return st.baseEpoch === this.#baseMirror.epoch && st.baseSeq === this.#baseMirror.seq;
  }

  knownBase(): Record<string, string> {
    return this.#baseMirror.hashes();
  }

  /** Tell it the changes this sync made to the record (path, and hash or null), in pieces. */
  async saveBase(changes: [string, string | null][]) {
    for (let i = 0; i < changes.length; i += 20_000) {
      await this.#call("baseApply", { token: this.#token, changes: changes.slice(i, i + 20_000) });
    }
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    return (await this.#call("read", { path, offset, length, token: this.#token })).payload;
  }

  async begin(path: string, meta: FileMeta, expect: Entry | null): Promise<Upload> {
    if (meta.size <= SMALL) {
      // a small file goes whole, in one message: one round trip instead of three
      const parts: Uint8Array[] = [];
      let size = 0;
      return {
        write: async (chunk) => {
          size += chunk.length;
          if (size > meta.size) throw new ChangedError(`${path}: grew while it was copied`);
          parts.push(chunk);
        },
        commit: async () =>
          (await this.#call("put", { path, meta, expect, token: this.#token }, Buffer.concat(parts)))
            .result as Entry,
        abort: async () => {},
      };
    }
    const id = (await this.#call("putBegin", { path, meta, expect, token: this.#token })).result as string;
    return {
      write: async (chunk) => void (await this.#call("putChunk", { id }, chunk)),
      commit: async () => (await this.#call("putCommit", { id })).result as Entry,
      abort: async () => void (await this.#call("putAbort", { id }).catch(() => {})),
    };
  }

  async retire(path: string, expect: Entry, _stamp: string) {
    await this.#call("retire", { path, expect, token: this.#token });
  }

  async checkpoint() {
    await this.#call("checkpoint", { token: this.#token });
  }

  /** Tell the other computer a sync with it just ended (its window shows the time). */
  async synced() {
    await this.#call("synced").catch(() => {});
  }
}
