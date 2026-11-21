// Install the built app for the current user, on Linux (`vp run install-app` builds the AppImage, then runs
// this):
//   ~/.local/share/tandem/app/Tandem.AppImage          the app (it updates itself in place, once a source is set)
//   ~/.local/bin/tandem                                symlink to it
//   ~/.local/share/applications/tandem.desktop         the menu entry (its window belongs to it)
//   ~/.local/share/icons/hicolor/scalable/apps/tandem.svg
// The app's own files (settings, pairing keys) are elsewhere (~/.config/Tandem) and are not touched.

import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Does this program run? (false when it is missing) */
const works = (cmd: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

const home = process.env.HOME!;
const packages = fileURLToPath(new URL("../dist/packages/", import.meta.url));
const dest = `${process.env.XDG_DATA_HOME ?? `${home}/.local/share`}/tandem/app`;
const appImage = `${dest}/Tandem.AppImage`;
const bin = `${home}/.local/bin/tandem`;
const desktop = `${home}/.local/share/applications/tandem.desktop`;
const iconDir = `${home}/.local/share/icons/hicolor/scalable/apps`;

const built = (await readdir(packages).catch(() => [])).filter((f) => /^Tandem-.+\.AppImage$/.test(f)).sort();
if (!built.length) {
  console.error("No AppImage in dist/packages: run `vp run install-app`, which builds it first.");
  process.exit(1);
}
const source = join(packages, built.at(-1)!);

await rm(dest, { recursive: true }).catch(() => {}); // the previous build
await mkdir(dest, { recursive: true });
await copyFile(source, appImage);
await chmod(appImage, 0o755);

await mkdir(`${home}/.local/bin`, { recursive: true });
await rm(bin).catch(() => {});
await symlink(appImage, bin);

await mkdir(iconDir, { recursive: true });
await copyFile(fileURLToPath(new URL("../app/icon.svg", import.meta.url)), `${iconDir}/tandem.svg`);
// only refresh an existing cache: creating one could hide icons other apps install later
const hicolor = `${home}/.local/share/icons/hicolor`;
if (
  await stat(`${hicolor}/icon-theme.cache`).then(
    () => true,
    () => false,
  )
) {
  await works("gtk-update-icon-cache", ["-f", "-t", hicolor]);
}

await mkdir(`${home}/.local/share/applications`, { recursive: true });
await writeFile(
  desktop,
  `[Desktop Entry]
Type=Application
Name=Tandem
Comment=Keep a folder the same on several computers, without the cloud
Exec=${appImage} %U
Icon=tandem
Terminal=false
StartupWMClass=tandem
Categories=Utility;
`,
);
console.log(`Installed (${built.at(-1)}):\n  ${appImage}\n  ${bin}\n  ${desktop}\n  ${iconDir}/tandem.svg`);
// the AppImage mounts itself with FUSE (its runtime has libfuse 3 inside, but needs the system's fusermount3);
// without it, it quits at once — from the menu, without a word
if (!(await works("fusermount3", ["-V"])))
  console.warn(
    "Tandem will not open yet: the AppImage needs fusermount3, missing here.\n  sudo dnf install fuse3",
  );
