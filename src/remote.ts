// Another computer's copy of the folder, reached over the local network: the client side of src/peer.ts.
// A Link is the encrypted line to one paired computer; RemoteStore makes that computer's folder look like any
// other store (src/store.ts), so the sync itself doesn't know whether the other copy is a drive or a computer.

import { NameError } from "./names.ts";
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
import {
  bare,
  ChangedError,
  type Entry,
  type FileMeta,
  type Scan,
  type Store,
  type Upload,
} from "./store.ts";

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
  folder: string | null;
  version: string;
}

export class RemoteStore implements Store {
  readonly #link: Link;
  /**
   * Which folder the scan saw, as the other computer names it for this run: sent back with every later
   * request, which it refuses when its folder was changed (or Tandem restarted there) in between.
   */
  #token = "";

  constructor(link: Link) {
    this.#link = link;
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

  async scan(ignore: string, progress?: (done: number, total: number) => void): Promise<Scan> {
    progress?.(0, 0);
    // hashing a big folder for the first time takes a while over there
    const r = (await this.#link.call("scan", { ignore }, undefined, 30 * MINUTE)).result as Scan & {
      token: string;
    };
    this.#token = String(r.token ?? "");
    return { files: bare(r.files), unread: Array.isArray(r.unread) ? r.unread.map(String) : [] };
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    return (await this.#link.call("read", { path, offset, length, token: this.#token })).payload;
  }

  async begin(path: string, meta: FileMeta, expect: Entry | null): Promise<Upload> {
    const id = (await this.#link.call("putBegin", { path, meta, expect, token: this.#token }))
      .result as string;
    return {
      write: async (chunk) => void (await this.#link.call("putChunk", { id }, chunk)),
      commit: async (stamp) => (await this.#link.call("putCommit", { id, stamp })).result as Entry,
      abort: async () => void (await this.#link.call("putAbort", { id }).catch(() => {})),
    };
  }

  async retire(path: string, expect: Entry, stamp: string) {
    await this.#link.call("retire", { path, expect, stamp, token: this.#token });
  }

  async loadBase(): Promise<Record<string, string> | null> {
    const r = (await this.#link.call("baseGet")).result as Record<string, string> | null;
    return r ? bare(r) : null;
  }

  /** In pieces: a folder of tens of thousands of files makes a record too large for one message. */
  async saveBase(files: Record<string, string>) {
    const entries = Object.entries(files);
    const PIECE = 20_000;
    for (let i = 0; i === 0 || i < entries.length; i += PIECE) {
      await this.#link.call("baseSet", {
        files: entries.slice(i, i + PIECE),
        first: i === 0,
        last: i + PIECE >= entries.length,
        token: this.#token,
      });
    }
  }

  /** Tell the other computer a sync with it just ended (its window shows the time). */
  async synced() {
    await this.#link.call("synced").catch(() => {});
  }
}
