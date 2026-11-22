// Updates (electron-updater), as in MedStation's shell/electron/updates.ts: checked at launch and once a day.
// The AppImage (and Windows, macOS) downloads a new version in the background, verifies it (sha512), then the
// window offers "Restart to update": never a restart in the middle of a sync; otherwise it's installed when
// Tandem is closed. A .rpm or .deb is the package manager's job (installing needs root): the window only says
// a new version is out, with a button to its download page.
//
// Where updates come from: electron-builder's `publish` (shell/electron/builder.yml: GitHub releases) writes
// app-update.yml into the package; or TANDEM_UPDATE_URL, a folder on a web server (the "generic" provider),
// for testing. Neither: no updates, nothing asked, nothing sent.

import { app } from "electron";
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";

const { autoUpdater } = electronUpdater;
const DAY = 24 * 60 * 60 * 1000;

/** Where the versions are listed, for a package that can't install them itself. */
export const DOWNLOADS = "https://github.com/sigmaSd/tandem/releases/latest";

/** Whether this copy looks for updates (packaged, with a source configured). */
function updatable() {
  if (!app.isPackaged) return false;
  if (process.env.TANDEM_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: "generic", url: process.env.TANDEM_UPDATE_URL });
    return true;
  }
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

/**
 * Start watching for updates: `ready(version)` once one is downloaded and verified (it installs itself), or
 * for a .rpm or .deb `out(version)` when a newer one is published (the user downloads it).
 */
export function watchUpdates(ready: (version: string) => void, out: (version: string) => void) {
  if (!updatable()) return;
  const itself = process.platform !== "linux" || !!process.env.APPIMAGE;
  autoUpdater.autoDownload = itself;
  autoUpdater.autoInstallOnAppQuit = itself;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
  autoUpdater.on("update-downloaded", (info) => ready(info.version));
  if (!itself) autoUpdater.on("update-available", (info) => out(info.version));
  const check = () =>
    autoUpdater.checkForUpdates().catch((e: Error) => console.error(`Update check: ${e.message}`));
  void check();
  setInterval(() => void check(), DAY);
}

/** Restart into the downloaded version (the user chose to). */
export function installNow() {
  autoUpdater.quitAndInstall();
}
