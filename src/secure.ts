// The secrets between two paired computers (docs/network.md has the whole design and what it does not cover).
// Only node:crypto's standard pieces, combined the usual way:
//
// - Pairing code: 12 letters and digits (60 bits) shown on one computer and typed on the other. scrypt turns
//   it into a key, so that someone who recorded the pairing can't find the code by trying them all.
// - Pairing: each side proves it knows the code (HMAC over what was exchanged) and both derive the pair's
//   long-term key from a fresh X25519 exchange: the key never travels, and the code is useless afterwards.
// - Session: before talking, the two prove they hold the pair's key and derive fresh keys from a new X25519
//   exchange: what is recorded today can't be read later even if a computer's key file leaks.
// - Messages: AES-256-GCM, one key per direction, a counter as nonce (never reused: a session's counter only
//   grows, and a replayed or reordered message is refused).

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

/** No I, L, O or U: nothing to mix up when reading a code aloud or copying it by hand. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new pairing code, as shown: "K7QF-2M9X-TB4H". */
export function newCode(): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[randomInt(32)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** A code as typed (any case, with or without dashes or spaces, O for 0, I or L for 1) → its 12 symbols. */
export function normalizeCode(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export const isCode = (typed: string) => /^[0-9A-HJKMNP-TV-Z]{12}$/.test(normalizeCode(typed));

/** The key a pairing code stands for, tied to the computer that shows it. Slow on purpose (about 0.1 s). */
export function codeKey(code: string, shownBy: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      normalizeCode(code),
      `tandem-pair-v1:${shownBy}`,
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 96 << 20 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

/** X25519 public keys travel as their 32 raw bytes, in base64. */
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

export interface Ephemeral {
  priv: KeyObject;
  pub: string;
}

export function ephemeral(): Ephemeral {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { priv: privateKey, pub: der.subarray(der.length - 32).toString("base64") };
}

/** The secret two key pairs share. Throws on a malformed or degenerate public key. */
export function sharedSecret(priv: KeyObject, theirPub: string): Buffer {
  const raw = Buffer.from(String(theirPub), "base64");
  if (raw.length !== 32) throw new Error("bad key");
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
  const secret = diffieHellman({ privateKey: priv, publicKey });
  if (secret.every((b) => b === 0)) throw new Error("bad key");
  return secret;
}

/** HMAC-SHA256 over a label and parts, unambiguously joined. */
export function mac(key: Buffer, label: string, ...parts: string[]): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([label, ...parts]))
    .digest("base64");
}

export function sameMac(a: string, b: unknown): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `bytes` of key material from a secret, bound to the exchange it came from. */
export function derive(secret: Buffer, salt: Buffer, label: string, context: string, bytes: number): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, salt, JSON.stringify([label, context]), bytes));
}

export const nonce16 = () => randomBytes(16).toString("base64");
export const randomId = (bytes = 16) => randomBytes(bytes).toString("hex");

function iv(counter: bigint) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64BE(counter, 4);
  return b;
}

/** Encrypt one message. `counter` must never repeat under a key; `aad` ties it to its session and direction. */
export function seal(key: Buffer, counter: bigint, aad: string, plain: Uint8Array): Buffer {
  const c = createCipheriv("aes-256-gcm", key, iv(counter));
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

/** Decrypt and check one message; throws when it was altered, or made for another session or counter. */
export function unseal(key: Buffer, counter: bigint, aad: string, data: Uint8Array): Buffer {
  if (data.length < 16) throw new Error("too short");
  const d = createDecipheriv("aes-256-gcm", key, iv(counter));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

/** A message's inside: a small JSON part (what is asked, or the answer) and raw bytes (a piece of a file). */
export function pack(json: unknown, payload: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.from(JSON.stringify(json));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([len, head, payload]);
}

export function unpack(buf: Buffer): { json: unknown; payload: Buffer } {
  if (buf.length < 4) throw new Error("too short");
  const n = buf.readUInt32BE(0);
  if (4 + n > buf.length) throw new Error("bad length");
  return { json: JSON.parse(buf.subarray(4, 4 + n).toString("utf8")), payload: buf.subarray(4 + n) };
}

/** The two keys of a session, from the exchange both sides saw. */
export function sessionKeys(secret: Buffer, pairKey: Buffer, transcript: string) {
  const okm = derive(secret, pairKey, "tandem-session-v1", transcript, 64);
  return { c2s: okm.subarray(0, 32), s2c: okm.subarray(32) };
}
