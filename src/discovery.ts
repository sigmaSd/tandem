// Finding the other computers on the local network without typing addresses: every few seconds, while Tandem
// is open, it shouts its name on the network (a UDP broadcast) and listens for the others'. A shout is only a
// hint of where a computer is: it proves nothing and carries no secret; trust comes from the pair's key
// (src/secure.ts). Networks that block broadcasts (some guest and campus Wi-Fi) still work by typing the
// address shown in the other computer's window.

import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";

export const DISCOVERY_PORT = 47810;
const EVERY = 2000;
const FRESH = 7000;

export interface Seen {
  id: string;
  name: string;
  /** host:port of its listener (src/peer.ts). */
  address: string;
  /** It is showing a pairing code right now. */
  pairing: boolean;
  at: number;
}

export interface Beacon {
  id: string;
  name: string;
  port: number;
  pairing: boolean;
}

/** The broadcast address of every network this computer is on. */
export function broadcastAddresses(): string[] {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const ip = ni.address.split(".").map(Number);
      const mask = ni.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join("."));
    }
  }
  return [...out];
}

/** This computer's addresses on the local network (shown in the window, to type on the other one). */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
  }
  return out;
}

export class Discovery {
  readonly #me: () => Beacon;
  readonly #changed: () => void;
  readonly #seen = new Map<string, Seen>();
  readonly #port: number;
  #socket?: Socket;
  #timer?: ReturnType<typeof setInterval>;

  constructor(me: () => Beacon, changed: () => void, port = DISCOVERY_PORT) {
    this.#me = me;
    this.#changed = changed;
    this.#port = port;
  }

  start() {
    if (this.#socket) return;
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.#socket = socket;
    socket.on("error", () => {
      /* no network, or the port refused: discovery is off, addresses can still be typed */
    });
    socket.on("message", (msg, from) => this.#heard(msg, from.address));
    socket.bind(this.#port, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* closed meanwhile */
      }
      this.shout();
    });
    this.#timer = setInterval(() => {
      this.shout();
      this.#forget();
    }, EVERY);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
    try {
      this.#socket?.close();
    } catch {
      /* not open */
    }
    this.#socket = undefined;
    this.#seen.clear();
  }

  /** Say now who and where this computer is (also called when a pairing code appears or goes). */
  shout() {
    const me = this.#me();
    if (!me.port || !this.#socket) return;
    const msg = Buffer.from(JSON.stringify({ t: "tandem", v: 1, ...me }));
    for (const to of broadcastAddresses()) {
      try {
        this.#socket.send(msg, this.#port, to, () => {});
      } catch {
        /* that network is down */
      }
    }
  }

  #heard(msg: Buffer, from: string) {
    if (msg.length > 1024) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(msg.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const port = Number(m.port);
    if (m.t !== "tandem" || m.v !== 1 || typeof m.id !== "string" || !/^[0-9a-f]{32}$/.test(m.id)) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || m.id === this.#me().id) return;
    const next: Seen = {
      id: m.id,
      name: String(m.name ?? "").slice(0, 64),
      address: `${from}:${port}`,
      pairing: !!m.pairing,
      at: Date.now(),
    };
    const old = this.#seen.get(next.id);
    this.#seen.set(next.id, next);
    if (!old || old.address !== next.address || old.pairing !== next.pairing || old.name !== next.name)
      this.#changed();
  }

  #forget() {
    let gone = false;
    for (const [id, s] of this.#seen) {
      if (Date.now() - s.at > FRESH) {
        this.#seen.delete(id);
        gone = true;
      }
    }
    if (gone) this.#changed();
  }

  /** The computers heard in the last seconds. */
  seen(): Seen[] {
    return [...this.#seen.values()].filter((s) => Date.now() - s.at <= FRESH);
  }

  find(id: string): Seen | undefined {
    return this.seen().find((s) => s.id === id);
  }
}
