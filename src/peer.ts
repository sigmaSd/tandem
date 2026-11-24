// The door other computers knock on: a small HTTP listener on the local network (src/remote.ts is the
// client side). Nothing here trusts the network: a computer gets in only with the key made when it was paired
// (src/secure.ts), and everything it then asks travels encrypted. What it may ask is decided by the host
// (src/core.ts `#answer`): the files of the folders shared with that computer, nothing else on this one.
//
//   GET  /hello     who this is (name, id, whether it is showing a pairing code): public, like a name tag
//   POST /pair      become a pair, for who knows the code this computer shows
//   POST /session   start an encrypted session, for a paired computer
//   POST /rpc       one encrypted question and its answer, inside a session

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ChangedError, CHUNK } from "./store.ts";
import { NameError } from "./names.ts";

/** The folder is being synced with another computer right now: ask again once that sync is over. */
export class BusyError extends Error {}
import {
  derive,
  ephemeral,
  mac,
  nonce16,
  pack,
  randomId,
  sameMac,
  seal,
  sessionKeys,
  sharedSecret,
  unpack,
  unseal,
} from "./secure.ts";

/**
 * 2 (November 2026): lists travel as changes since a change number (src/db.ts). 3: several folders, each
 * request naming one shared with the caller. Both computers need the same.
 */
export const PROTOCOL = 3;

export interface Answer {
  result?: unknown;
  payload?: Uint8Array;
}

/** What the listener needs from the app. */
export interface PeerHost {
  device(): { id: string; name: string };
  /** The key of a paired computer, or null when it isn't one. */
  keyOf(deviceId: string): Buffer | null;
  /** The key of the pairing code on screen, or null when none is shown. */
  pairingKey(): Buffer | null;
  /** Someone tried a wrong code. */
  wrongCode(): void;
  /** A computer proved it knows the code: it is now paired. */
  paired(peer: { id: string; name: string; key: Buffer; address: string }): void;
  /** A paired computer asks something. */
  call(deviceId: string, method: string, args: Record<string, unknown>, payload: Buffer): Promise<Answer>;
  /** A paired computer was heard from at this address. */
  seen?(deviceId: string, address: string): void;
}

interface Session {
  peer: string;
  recv: Buffer;
  send: Buffer;
  last: bigint;
  used: number;
  /** Where the caller said it listens: believed once it has sent a first valid message. */
  address?: string;
  /** It has shown it holds the session's keys (a recorded request replayed by someone else never does). */
  proven: boolean;
}

const MAX_BODY = 2 * CHUNK + (64 << 10);
const IDLE = 15 * 60_000;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The fields of a pairing or session request, in one fixed order: what both sides sign. */
export const canon = (...fields: unknown[]) => JSON.stringify(fields.map((f) => String(f ?? "")));

/** "192.168.1.20" → "192.168.1.20:47811"; IPv4 written inside IPv6 ("::ffff:192.168.1.20") unwrapped. */
export function addressOf(remote: string | undefined, port: number) {
  const host = (remote ?? "").replace(/^::ffff:/, "");
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export class PeerServer {
  readonly #host: PeerHost;
  readonly #sessions = new Map<string, Session>();
  /** Session requests already answered, so that a recorded one sent again is refused. */
  readonly #heard = new Set<string>();
  #server?: Server;
  port = 0;

  constructor(host: PeerHost) {
    this.#host = host;
  }

  /** Listen on every network interface; `port` 0 picks a free one. Returns the port. */
  async listen(port: number, bind = "0.0.0.0"): Promise<number> {
    const server = createServer((req, res) => void this.#handle(req, res));
    server.requestTimeout = 10 * 60_000;
    const tryPort = (p: number) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, bind, () => {
          server.off("error", reject);
          resolve();
        });
      });
    try {
      await tryPort(port);
    } catch (e) {
      if (!port || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      await tryPort(0); // the usual port is taken (a second Tandem on this computer): any free one
    }
    this.#server = server;
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
    return this.port;
  }

  close() {
    this.#server?.close();
    this.#server?.closeAllConnections();
    this.#sessions.clear();
  }

  #json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/hello") {
        const me = this.#host.device();
        return this.#json(res, 200, {
          app: "tandem",
          v: PROTOCOL,
          id: me.id,
          name: me.name,
          pairing: !!this.#host.pairingKey(),
        });
      }
      if (req.method !== "POST") return this.#json(res, 404, { error: "not found" });
      if (path === "/pair") return await this.#pair(req, res);
      if (path === "/session") return await this.#session(req, res);
      if (path === "/rpc") return await this.#rpc(req, res);
      this.#json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) this.#json(res, 400, { error: (e as Error).message });
      else res.destroy();
    }
  }

  async #pair(req: IncomingMessage, res: ServerResponse) {
    const m = JSON.parse((await readBody(req, 4096)).toString("utf8")) as Record<string, unknown>;
    const key = this.#host.pairingKey();
    if (!key) return this.#json(res, 409, { error: "not pairing" });
    const me = this.#host.device();
    const id = String(m.id ?? "");
    const name = String(m.name ?? "").slice(0, 64);
    if (!/^[0-9a-f]{32}$/.test(id) || id === me.id) return this.#json(res, 400, { error: "bad request" });
    const asked = canon(id, name, m.eph, m.nonce, m.port);
    if (!sameMac(mac(key, "tandem-pair-req", me.id, asked), m.mac)) {
      this.#host.wrongCode();
      return this.#json(res, 403, { error: "wrong code" });
    }
    const eph = ephemeral();
    const secret = sharedSecret(eph.priv, String(m.eph));
    const answered = canon(me.id, me.name, eph.pub, nonce16());
    const pairKey = derive(secret, key, "tandem-pair-key-v1", `${asked}\n${answered}`, 32);
    const port = Number(m.port);
    this.#host.paired({
      id,
      name,
      key: pairKey,
      address: addressOf(
        req.socket.remoteAddress,
        Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
      ),
    });
    const fields = JSON.parse(answered) as string[];
    this.#json(res, 200, {
      id: fields[0],
      name: fields[1],
      eph: fields[2],
      nonce: fields[3],
      mac: mac(key, "tandem-pair-res", asked, answered),
    });
  }

  async #session(req: IncomingMessage, res: ServerResponse) {
    const m = JSON.parse((await readBody(req, 4096)).toString("utf8")) as Record<string, unknown>;
    const from = String(m.from ?? "");
    const key = this.#host.keyOf(from);
    const me = this.#host.device();
    const asked = canon(from, me.id, m.eph, m.nonce, m.port);
    // the same answer for "unknown computer" and "wrong key": nothing to learn from the difference
    if (!key || !sameMac(mac(key, "tandem-session-req", asked), m.mac))
      return this.#json(res, 401, { error: "not paired" });
    // a request already answered is a recording played again: nothing new is made for it
    if (this.#heard.has(asked)) return this.#json(res, 401, { error: "not paired" });
    if (this.#heard.size >= 4096) this.#heard.clear(); // bounded; an old recording then only opens an unusable session
    this.#heard.add(asked);
    const eph = ephemeral();
    const secret = sharedSecret(eph.priv, String(m.eph));
    const sid = randomId();
    const answered = canon(sid, eph.pub, nonce16());
    const keys = sessionKeys(secret, key, `${asked}\n${answered}`);
    const now = Date.now();
    for (const [id, s] of this.#sessions) if (now - s.used > IDLE) this.#sessions.delete(id);
    // room is made among this computer's own sessions only, unproven ones first: nobody else's is dropped
    const theirs = [...this.#sessions].filter(([, s]) => s.peer === from);
    if (theirs.length >= 8) this.#sessions.delete((theirs.find(([, s]) => !s.proven) ?? theirs[0])[0]);
    const port = Number(m.port);
    this.#sessions.set(sid, {
      peer: from,
      recv: keys.c2s,
      send: keys.s2c,
      last: 0n,
      used: now,
      proven: false,
      address:
        Number.isInteger(port) && port > 0 && port < 65536
          ? addressOf(req.socket.remoteAddress, port)
          : undefined,
    });
    const fields = JSON.parse(answered) as string[];
    this.#json(res, 200, {
      sid,
      eph: fields[1],
      nonce: fields[2],
      mac: mac(key, "tandem-session-res", asked, answered),
    });
  }

  async #rpc(req: IncomingMessage, res: ServerResponse) {
    const sid = String(req.headers["x-tandem-session"] ?? "");
    const session = this.#sessions.get(sid);
    // gone (this computer restarted, or the session sat idle): the caller starts a new one
    if (!session || !this.#host.keyOf(session.peer)) return this.#json(res, 401, { error: "no session" });
    const body = await readBody(req, MAX_BODY);
    if (body.length < 8) return this.#json(res, 400, { error: "bad request" });
    const counter = body.readBigUInt64BE(0);
    if (counter <= session.last) return this.#json(res, 400, { error: "replayed" });
    let asked;
    try {
      asked = unpack(unseal(session.recv, counter, `${sid}:c2s`, body.subarray(8)));
    } catch {
      return this.#json(res, 400, { error: "bad message" });
    }
    session.last = counter;
    session.used = Date.now();
    if (!session.proven) {
      // only now is the caller known to be the paired computer, and its address worth remembering
      session.proven = true;
      if (session.address) this.#host.seen?.(session.peer, session.address);
    }
    const { m: method, a: args } = asked.json as { m: string; a: Record<string, unknown> };
    let answer: Buffer;
    try {
      const r = await this.#host.call(session.peer, String(method), args ?? {}, asked.payload);
      answer = pack({ ok: true, r: r.result ?? null }, r.payload);
    } catch (e) {
      const code =
        e instanceof ChangedError
          ? "changed"
          : e instanceof NameError
            ? "name"
            : e instanceof BusyError
              ? "busy"
              : "error";
      answer = pack({ ok: false, code, error: (e as Error).message });
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    res.end(seal(session.send, counter, `${sid}:s2c`, answer));
  }
}
