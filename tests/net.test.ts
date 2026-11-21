import { expect, test } from "vite-plus/test";
import { type Answer, PeerServer } from "../src/peer.ts";
import { hello, Link, pairWith, Refused, Unreachable } from "../src/remote.ts";
import { codeKey, isCode, newCode, normalizeCode, pack, seal, unseal } from "../src/secure.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

/** A listener for computer A, with what it was asked kept for the test. */
async function listener() {
  const state = {
    pairing: null as Buffer | null,
    keys: new Map<string, Buffer>(),
    wrong: 0,
    seen: [] as string[],
    asked: [] as { from: string; method: string; args: unknown; payload: string }[],
  };
  const server = new PeerServer({
    device: () => ({ id: ID_A, name: "Office PC" }),
    keyOf: (id) => state.keys.get(id) ?? null,
    pairingKey: () => state.pairing,
    wrongCode: () => void state.wrong++,
    paired: (peer) => void state.keys.set(peer.id, peer.key),
    seen: (_id, address) => void state.seen.push(address),
    async call(from, method, args, payload): Promise<Answer> {
      state.asked.push({ from, method, args, payload: payload.toString() });
      if (method === "boom") throw new Error("it broke");
      return { result: { echo: args }, payload: Buffer.from(`re:${payload.toString()}`) };
    },
  });
  const port = await server.listen(0, "127.0.0.1");
  return { state, server, address: `127.0.0.1:${port}` };
}

test("net: a code is 12 symbols, forgiving of how it is typed", () => {
  const code = newCode();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(isCode(code.toLowerCase().replaceAll("-", " "))).toBe(true);
  expect(normalizeCode("k7qf-2m9x tb4h")).toBe("K7QF2M9XTB4H");
  expect(normalizeCode("OIL0")).toBe("0110"); // letters easily mistaken for digits
  expect(isCode("482 916")).toBe(false);
});

test("net: pairing with the code gives both sides the same key, and the line works", async () => {
  const a = await listener();
  const code = newCode();
  a.state.pairing = await codeKey(code, ID_A);
  expect(await hello(a.address)).toEqual({ id: ID_A, name: "Office PC", pairing: true });
  const peer = await pairWith(a.address, code, { id: ID_B, name: "Laptop", port: 4000 });
  expect(peer.id).toBe(ID_A);
  expect(peer.name).toBe("Office PC");
  expect(a.state.keys.get(ID_B)?.equals(peer.key)).toBe(true);
  expect(peer.key.length).toBe(32);

  const link = new Link(a.address, { id: ID_B, port: 4000 }, ID_A, peer.key);
  const r = await link.call("read", { path: "ch1.tex" }, Buffer.from("hello"));
  expect(r.result).toEqual({ echo: { path: "ch1.tex" } });
  expect(r.payload.toString()).toBe("re:hello");
  expect(a.state.asked).toEqual([
    { from: ID_B, method: "read", args: { path: "ch1.tex" }, payload: "hello" },
  ]);
  await expect(link.call("boom")).rejects.toThrow("it broke");
  // many at once still arrive in order, each answered
  const many = await Promise.all([1, 2, 3, 4, 5].map((n) => link.call("n", { n })));
  expect(many.map((m) => (m.result as { echo: { n: number } }).echo.n)).toEqual([1, 2, 3, 4, 5]);
  a.server.close();
});

test("net: a wrong code pairs nothing, and is counted", async () => {
  const a = await listener();
  a.state.pairing = await codeKey("K7QF-2M9X-TB4H", ID_A);
  await expect(pairWith(a.address, "K7QF-2M9X-TB4J", { id: ID_B, name: "Laptop", port: 1 })).rejects.toThrow(
    Refused,
  );
  expect(a.state.wrong).toBe(1);
  expect(a.state.keys.size).toBe(0);
  a.state.pairing = null;
  await expect(pairWith(a.address, "K7QF-2M9X-TB4H", { id: ID_B, name: "Laptop", port: 1 })).rejects.toThrow(
    "not pairing",
  );
  a.server.close();
});

test("net: without the pair's key there is no session, and no question is heard", async () => {
  const a = await listener();
  const key = Buffer.alloc(32, 7);
  a.state.keys.set(ID_B, key);
  const stranger = new Link(a.address, { id: "c".repeat(32), port: 1 }, ID_A, key);
  await expect(stranger.call("read")).rejects.toThrow(Refused);
  const wrongKey = new Link(a.address, { id: ID_B, port: 1 }, ID_A, Buffer.alloc(32, 8));
  await expect(wrongKey.call("read")).rejects.toThrow(Refused);
  // a made-up session, or none
  for (const sid of ["", "0".repeat(32)]) {
    const res = await fetch(`http://${a.address}/rpc`, {
      method: "POST",
      headers: { "x-tandem-session": sid },
      body: "x".repeat(64),
    });
    expect(res.status).toBe(401);
  }
  expect(a.state.asked).toEqual([]);
  a.server.close();
});

test("net: a recorded message can't be sent again, changed, or read", async () => {
  const a = await listener();
  const key = Buffer.alloc(32, 7);
  a.state.keys.set(ID_B, key);
  const sent: { sid: string; body: Uint8Array }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/rpc"))
      sent.push({
        sid: (init!.headers as Record<string, string>)["x-tandem-session"],
        body: new Uint8Array(init!.body as Buffer),
      });
    return realFetch(url, init);
  };
  try {
    const link = new Link(a.address, { id: ID_B, port: 1 }, ID_A, key);
    await link.call("read", { path: "secret-chapter.tex" }, Buffer.from("the proof"));
  } finally {
    globalThis.fetch = realFetch;
  }
  const { sid, body } = sent[0];
  const text = Buffer.from(body).toString("latin1");
  expect(text).not.toContain("secret-chapter");
  expect(text).not.toContain("the proof");
  const resend = (bytes: Uint8Array) =>
    fetch(`http://${a.address}/rpc`, {
      method: "POST",
      headers: { "x-tandem-session": sid },
      body: bytes as BodyInit,
    });
  const again = await resend(body);
  expect(again.status).toBe(400); // replayed
  const altered = Uint8Array.from(body);
  altered[7] = 9; // a later counter, same content
  altered[20] ^= 1;
  expect((await resend(altered)).status).toBe(400);
  expect(a.state.asked.length).toBe(1);
  a.server.close();
});

test("net: a recorded session request sent again opens nothing and moves no address", async () => {
  const a = await listener();
  const key = Buffer.alloc(32, 7);
  a.state.keys.set(ID_B, key);
  let recorded = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/session")) recorded = String(init!.body);
    return realFetch(url, init);
  };
  const link = new Link(a.address, { id: ID_B, port: 4000 }, ID_A, key);
  try {
    await link.call("first");
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(a.state.seen).toEqual(["127.0.0.1:4000"]); // believed once the caller proved itself
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`http://${a.address}/session`, { method: "POST", body: recorded });
    expect(res.status).toBe(401);
  }
  expect(a.state.seen.length).toBe(1);
  expect((await link.call("still-works")).result).toEqual({ echo: {} }); // the real session was not pushed out
  a.server.close();
});

test("net: nobody home is told apart from a refusal", async () => {
  await expect(hello("127.0.0.1:9", 500)).rejects.toThrow(Unreachable);
  const link = new Link("127.0.0.1:9", { id: ID_B, port: 1 }, ID_A, Buffer.alloc(32));
  await expect(link.call("info", {}, undefined, 500)).rejects.toThrow(Unreachable);
});

test("net: a sealed message opens only with its key, counter and session", () => {
  const key = Buffer.alloc(32, 1);
  const box = seal(key, 5n, "sid:c2s", pack({ m: "x" }, Buffer.from("data")));
  expect(unseal(key, 5n, "sid:c2s", box).subarray(-4).toString()).toBe("data");
  expect(() => unseal(key, 6n, "sid:c2s", box)).toThrow();
  expect(() => unseal(key, 5n, "sid:s2c", box)).toThrow(); // an answer can't be passed off as a question
  expect(() => unseal(Buffer.alloc(32, 2), 5n, "sid:c2s", box)).toThrow();
});
