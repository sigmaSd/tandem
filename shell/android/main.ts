// Tandem on Android, run by nodeapk (~/dev/nodeapk): Node runs this file on the phone (bundled by `vp pack`
// into dist/android/android.mjs), and the app shows the window it serves in a WebView.
//
// The nodeapk contract: listen on 127.0.0.1 and print one ready line, `nodeapk: <url>`; keep state in
// NODEAPK_DATA. The folder dialog is Android's folder picker, through the shell (globalThis.nodeapk, which
// nodeapk's preload defines): it gives a path like /storage/emulated/0/Documents/X, readable thanks to
// "All files access", which the app asks for on first start. Files can't be opened in another app yet.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "../../src/core.ts";
import { serve } from "../../src/server.ts";

/** What nodeapk's shell offers (its preload sets it before this file runs). */
interface Nodeapk {
  pickFolder(): Promise<string | null>;
}
const nodeapk = (globalThis as { nodeapk?: Nodeapk }).nodeapk;

// the project's root, as on the desktop: this file runs as dist/android/android.mjs
const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const data = process.env.NODEAPK_DATA;
if (!data) {
  console.error("NODEAPK_DATA is not set: this entry is meant to be started by the nodeapk shell");
  process.exit(1);
}

// the phone's name (from its settings, through nodeapk): os.hostname() is "localhost" on every phone
const deviceName = process.env.NODEAPK_DEVICE_NAME?.trim() || undefined;
const core = new Core(join(data, "state"), { deviceName });
core.appVersion = process.env.NODEAPK_VERSION ?? "android";
// LANG is fr_FR.UTF-8 style; Tandem wants BCP 47 (fr-FR)
const lang = process.env.LANG?.split(".")[0]?.replace("_", "-");
core.systemLocales = lang ? [lang] : [];
core.localesDir = join(APP_DIR, "locales", "app");
core.shell = {
  chooseFolder: () => nodeapk?.pickFolder() ?? Promise.resolve(null),
  open: () => Promise.reject(new Error("opening files isn't available on Android yet")),
};
await core.init();
// a phone set up before the name came through is called "localhost", which nobody chose: rename it (the
// paired computers take the new name from its next answer)
if (deviceName && core.config.device.name === "localhost") await core.setSettings({ name: deviceName });

const served = await serve(core, join(APP_DIR, "app", "ui", "dist"));
console.log(`nodeapk: ${served.origin}/?k=${served.secret}`);

process.on("SIGTERM", () => {
  served.close();
  void core.stop().finally(() => process.exit(0));
});
