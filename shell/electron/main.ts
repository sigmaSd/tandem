// Tandem in Electron. The main process runs Tandem itself (src/core.ts), the door for other computers
// (src/peer.ts, started by the core) and the small server its window talks to (src/server.ts). All the
// Electron code is in this folder; the rest of Tandem doesn't know it's there.
//
//   --dev        print a link that opens the window's page in a normal browser (for testing)
//   --no-window  start without opening the window (testing; stop it with Ctrl+C)
// TANDEM_USERDATA moves the app's own files (testing: never the real settings, keys and window place).

import { app, type BrowserWindow, dialog, Menu, nativeTheme, session, shell } from "electron";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, Core } from "../../src/core.ts";
import { cookieName } from "../../src/guard.ts";
import { msg } from "../../src/i18n.ts";
import { serve } from "../../src/server.ts";
import { appMenu } from "./menu.ts";
import { DOWNLOADS, installNow, watchUpdates } from "./updates.ts";
import { openWindow } from "./windows.ts";

/** The application's files: the checkout, or the package (this file is dist/app/electron.mjs in both). */
const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DEV = process.argv.includes("--dev");
const NO_WINDOW = process.argv.includes("--no-window");
const ICON = join(APP_DIR, "app", "icon.png");

if (process.env.TANDEM_USERDATA) app.setPath("userData", process.env.TANDEM_USERDATA);
// Chromium's own log lines: only fatal ones in the package (on GNOME's Wayland it writes one every few frames)
if (app.isPackaged) app.commandLine.appendSwitch("log-level", "3");

let mainWindow: BrowserWindow | null = null;
let quitting = false;

/**
 * The main process's output, kept for when something goes wrong (userData/journal.log, restarted past 5 MB):
 * a desktop app's stderr goes nowhere anyone looks. Still printed too, from a terminal.
 */
function journal() {
  const path = join(app.getPath("userData"), "journal.log");
  let big = false;
  try {
    big = statSync(path).size > 5_000_000;
  } catch {
    /* none yet */
  }
  mkdirSync(app.getPath("userData"), { recursive: true });
  const out = createWriteStream(path, { flags: big ? "w" : "a" });
  out.write(`\n--- ${new Date().toISOString()} Tandem ${app.getVersion()}\n`);
  for (const level of ["log", "warn", "error"] as const) {
    const print = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      out.write(`${args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" ")}\n`);
      print(...args);
    };
  }
}

const themeSource = (theme: Config["theme"]) => (theme === "auto" ? "system" : theme);

function createWindow(origin: string, core: Core) {
  const win = openWindow(origin, ICON); // windows.ts: our own title bar, locked down, remembered place
  let asking = false;
  win.on("close", (e) => {
    if (quitting || core.job?.phase !== "applying") return;
    // files are being copied: closing now is safe (what is copied stays, the rest waits), but say so first
    e.preventDefault();
    if (asking) return;
    asking = true;
    void dialog
      .showMessageBox(win, {
        type: "question",
        message: msg("syncRunningTitle"),
        detail: msg("syncRunningDetail"),
        buttons: [msg("keepOpen"), msg("closeAnyway")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        asking = false;
        if (response === 1) app.quit();
      });
  });
  win.on("closed", () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });
  return win;
}

async function main() {
  journal();
  Menu.setApplicationMenu(appMenu());
  const ses = session.defaultSession;
  const allowed = new Set(["clipboard-sanitized-write"]);
  ses.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const core = new Core(join(app.getPath("userData"), "state"));
  core.appVersion = app.getVersion();
  core.systemLocales = app.getPreferredSystemLanguages();
  core.localesDir = join(app.getAppPath(), "locales", "app");
  core.shell = {
    async chooseFolder(title, start) {
      const options = {
        title,
        defaultPath: start ?? app.getPath("documents"),
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const r = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async open(path) {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
    setTheme: (theme) => (nativeTheme.themeSource = themeSource(theme)),
    installUpdate: installNow,
    openDownloads: () => void shell.openExternal(DOWNLOADS),
  };
  await core.init();
  nativeTheme.themeSource = themeSource(core.config.theme);

  const served = await serve(core, join(APP_DIR, "app", "ui", "dist"));
  await ses.cookies.set({
    url: served.origin,
    name: cookieName(Number(new URL(served.origin).port)),
    value: served.secret,
    httpOnly: true,
    sameSite: "strict",
  });
  watchUpdates(
    (version) => {
      core.update = version; // offered in the window: "Restart to update"
      core.changed();
    },
    (version) => {
      core.updateOut = version; // a .rpm or .deb: "Tandem 0.4.0 is out", with a button to download it
      core.changed();
    },
  );

  app.on("before-quit", () => {
    quitting = true;
    core.stop();
    served.close();
  });
  app.on("second-instance", () => {
    if (!mainWindow) mainWindow = createWindow(served.origin, core);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  if (DEV) console.log(`Tandem: ${served.origin}/?k=${served.secret}`);
  if (!NO_WINDOW) mainWindow = createWindow(served.origin, core);
}

// one Tandem: a second launch brings the first forward
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("window-all-closed", () => {
    if (!NO_WINDOW) app.quit();
  });
  app
    .whenReady()
    .then(main)
    .catch((e: Error) => {
      console.error(e);
      dialog.showErrorBox("Tandem", msg("couldNotStart", { error: e.message }));
      app.quit();
    });
}
