// Make the Tandem in the desktop menu run this checkout (`vp run install-dev`), for working on it: every launch
// rebuilds the window and the Electron entry (well under a second) and starts Electron on the source, so what
// opens is always the code as it is now. A build that fails keeps the last one.
//   ~/.local/bin/tandem                         the launcher (a shell script)
//   ~/.local/share/applications/tandem.desktop  the menu entry, pointing at it
// `vp run install-app` puts the installed AppImage back. The app's own files (~/.config/Tandem) are shared by
// both and not touched; updates don't apply (Electron's updater only runs in a packaged app).

import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const home = process.env.HOME!;
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const bin = `${home}/.local/bin/tandem`;
const desktop = `${home}/.local/share/applications/tandem.desktop`;
const iconDir = `${home}/.local/share/icons/hicolor/scalable/apps`;

await mkdir(`${home}/.local/bin`, { recursive: true });
await rm(bin).catch(() => {}); // the AppImage's symlink
await writeFile(
  bin,
  `#!/bin/sh
# Tandem from the checkout at ${root} (written by its tools/install-dev.ts;
# \`vp run install-app\` there puts the AppImage back)
cd "${root}" || exit 1
log="\${XDG_STATE_HOME:-$HOME/.local/state}/tandem-dev-build.log"
mkdir -p "$(dirname "$log")"
# the page and the Electron entry as the source is now; on failure the last build stays (see the log)
{ node_modules/.bin/vp build && node_modules/.bin/vp pack; } > "$log" 2>&1
exec node_modules/.bin/electron . "$@"
`,
);
await chmod(bin, 0o755);

await mkdir(iconDir, { recursive: true });
await copyFile(`${root}/app/icon.svg`, `${iconDir}/tandem.svg`);
await mkdir(`${home}/.local/share/applications`, { recursive: true });
await writeFile(
  desktop,
  `[Desktop Entry]
Type=Application
Name=Tandem
Comment=Keep a folder the same on several computers, without the cloud
Exec=${bin} %U
Icon=tandem
Terminal=false
StartupWMClass=tandem
Categories=Utility;
`,
);
console.log(`Tandem in the menu now runs ${root}:\n  ${bin}\n  ${desktop}`);
