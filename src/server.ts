// The window's way in: a small HTTP server on 127.0.0.1 (a random port) serving the built page (app/ui/dist),
// a JSON API and a stream of change notices. Only Tandem's own window can use it: it carries a secret cookie
// that the shell sets (src/guard.ts; --dev prints a link that sets it in a normal browser). Changes come only
// as POSTs with an X-Tandem header from the same origin, so no web page can make them.
// Other computers never come through here: they have their own door (src/peer.ts).

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Choice } from "./apply.ts";
import { type Core, type ItemKind, UserError } from "./core.ts";
import { CSP, guard, newSecret } from "./guard.ts";
import { NameError } from "./names.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface Served {
  origin: string;
  secret: string;
  close: () => void;
}

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const CHOICES = ["a", "b", "both"];

/** What the window may ask, by name: POST /api/<name> with a JSON body. */
function actions(core: Core): Record<string, (b: Record<string, unknown>) => unknown> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    "folder-add": async (b) => ({ id: await core.addFolder(str(b.path)) }),
    "folder-path": (b) => core.setFolderPath(str(b.folder), str(b.path)),
    "folder-remove": (b) => core.removeFolder(str(b.folder)),
    "folder-settings": (b) => core.setFolderSettings(str(b.folder), b),
    "choose-folder": async () => ({ path: await core.chooseFolder() }),
    "pairing-start": async (b) => ({ code: await core.startPairing(str(b.folder) || undefined) }),
    "pairing-stop": () => core.stopPairing(),
    pair: (b) => core.pair(str(b.address), str(b.code), str(b.folder) || undefined),
    share: (b) => core.share(str(b.folder), str(b.device)),
    "offer-accept": async (b) => ({
      id: await core.acceptOffer(
        str(b.device),
        str(b.folder),
        typeof b.into === "string" ? { folder: b.into } : { path: str(b.path) },
      ),
    }),
    "offer-decline": (b) => core.declineOffer(str(b.device), str(b.folder)),
    "device-forget": (b) => core.forgetDevice(str(b.device)),
    "copy-remove": (b) => core.removeCopy(str(b.id)),
    compare: (b) => core.compare(str(b.id)),
    choose: (b) =>
      core.choose(
        typeof b.path === "string" ? b.path : null,
        CHOICES.includes(str(b.choice)) ? (b.choice as Choice) : null,
      ),
    start: () => core.start(),
    // the window came to the front: news from the other computers now, not in up to 30 seconds
    focus: () => void core.poll(),
    cancel: () => core.cancel(),
    close: () => core.closeJob(),
    diff: (b) => core.diff(str(b.path)),
    "open-version": (b) => core.openVersion(str(b.path), b.side === "b" ? "b" : "a"),
    restore: (b) => core.restore(str(b.folder), str(b.stamp), str(b.path)),
    "open-old": (b) => core.openOld(str(b.folder), str(b.stamp), str(b.path)),
    "open-folder": (b) => core.openFolder(str(b.folder)),
    settings: (b) => core.setSettings(b),
    "install-update": () => core.shell.installUpdate?.(),
    "open-downloads": () => core.shell.openDownloads?.(),
  };
}

export async function serve(core: Core, uiDir: string, wantPort = 0): Promise<Served> {
  const secret = newSecret();
  let port = 0;
  const api = actions(core);
  const streams = new Set<ServerResponse>();

  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : body === undefined ? "{}" : JSON.stringify(body));
  };

  const off = core.onChange(() => {
    for (const res of streams) res.write("data: changed\n\n");
  });
  const beat = setInterval(() => {
    for (const res of streams) res.write(": still here\n\n");
  }, 25_000);
  beat.unref?.();

  const server = createServer((req, res) => {
    void (async () => {
      const refused = guard(req, secret, port);
      if (refused) {
        res.writeHead(refused.status, refused.headers);
        return res.end(refused.body);
      }
      const url = new URL(req.url ?? "/", "http://x");
      const path = decodeURIComponent(url.pathname);

      if (path.startsWith("/api/")) {
        const name = path.slice(5);
        if (req.method === "GET") {
          if (name === "state") return send(res, 200, core.state());
          if (name === "page") {
            const q = url.searchParams;
            return send(
              res,
              200,
              core.page(
                (q.get("kind") ?? "") as ItemKind,
                Number(q.get("offset")) || 0,
                Number(q.get("limit")) || 200,
                q.has("folder") ? (q.get("folder") ?? "") : undefined,
              ),
            );
          }
          if (name === "groups")
            return send(res, 200, core.groups((url.searchParams.get("kind") ?? "") as ItemKind));
          if (name === "i18n") return send(res, 200, core.language());
          if (name === "old")
            return send(res, 200, await core.oldVersions(url.searchParams.get("folder") ?? ""));
          if (name === "events") {
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              connection: "keep-alive",
            });
            res.write("data: changed\n\n");
            streams.add(res);
            core.viewer(1); // a window is open: paired computers are asked for news (src/core.ts poll)
            req.on("close", () => {
              streams.delete(res);
              core.viewer(-1);
            });
            return;
          }
          return send(res, 404, { error: "not found" });
        }
        const run = api[name];
        if (req.method !== "POST" || !run) return send(res, 404, { error: "not found" });
        if (req.headers["x-tandem"] !== "1") return send(res, 403, { error: "refused" });
        const text = (await readBody(req)).toString("utf8");
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        return send(res, 200, (await run(body)) ?? {});
      }

      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "not allowed" });
      const root = resolve(uiDir);
      const file = normalize(join(root, path === "/" ? "index.html" : path));
      if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: "refused" });
      if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-security-policy": CSP,
        "x-content-type-options": "nosniff",
        // the page's scripts have their content in their name: kept; the page itself is always read again
        "cache-control": path.startsWith("/assets/") ? "max-age=31536000, immutable" : "no-store",
      });
      createReadStream(file).pipe(res);
    })().catch((e: Error) => {
      if (res.headersSent) return res.destroy();
      const mine = e instanceof UserError || e instanceof NameError;
      if (!mine) console.error(e);
      send(res, mine ? 400 : 500, { error: e.message });
    });
  });

  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(wantPort, "127.0.0.1", done);
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : wantPort;
  return {
    origin: `http://127.0.0.1:${port}`,
    secret,
    close() {
      off();
      clearInterval(beat);
      for (const res of streams) res.end();
      server.close();
      server.closeAllConnections();
    },
  };
}
