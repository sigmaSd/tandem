// Tandem without Electron, for trying the window in a browser and for tests by hand:
//   node tools/dev.ts --state=<folder> [--port=8787] [--peer-port=0] [--no-discovery]
// starts the core (its own files in <folder>, never the real ones) and the window's server, and prints a link
// that opens the page. What needs the desktop shell (the folder dialog, opening a file) does nothing here:
// type the folder's path instead. `vp build` first: the page is served from app/ui/dist.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../src/core.ts";
import { serve } from "../src/server.ts";

const arg = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const root = fileURLToPath(new URL("..", import.meta.url));
const state = arg("state");
if (!state) {
  console.error("usage: node tools/dev.ts --state=<folder> [--port=8787] [--peer-port=0] [--no-discovery]");
  process.exit(1);
}

const core = new Core(state, {
  discovery: !process.argv.includes("--no-discovery"),
  port: arg("peer-port") === undefined ? undefined : Number(arg("peer-port")),
});
core.appVersion = "dev";
core.localesDir = join(root, "locales", "app");
core.systemLocales = [Intl.DateTimeFormat().resolvedOptions().locale];
core.shell = {
  chooseFolder: () => Promise.resolve(null),
  open: (path) => Promise.resolve(console.log(`(would open ${path})`)),
};
await core.init();
const served = await serve(core, join(root, "app", "ui", "dist"), Number(arg("port") ?? 0));
console.log(`Tandem: ${served.origin}/?k=${served.secret}`);
console.log(`other computers reach it on port ${core.port}`);
process.on("SIGINT", () => {
  served.close();
  void core.stop().finally(() => process.exit(0));
});
