// Imported first by every test that touches files: a scratch folder per test worker, under node_modules/.cache,
// so tests never read or write a real synced folder or the app's own files.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: on Windows that gives "/D:/…"
const base = fileURLToPath(new URL("../node_modules/.cache/tandem-tests/", import.meta.url));
export const TMP = `${base}worker-${process.env.VITEST_POOL_ID ?? 0}`;

/** A fresh, empty folder for one test. */
export function scratch(name: string) {
  const dir = `${TMP}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write files (path → text) into a folder. */
export function put(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A folder's files as path → text, Tandem's own .tandem folder left out. */
export function tree(dir: string, own = false): Record<string, string> {
  // a plain table: a file may be named "__proto__"
  const out = Object.create(null) as Record<string, string>;
  const walk = (d: string, rel: string) => {
    for (const it of readdirSync(d, { withFileTypes: true })) {
      const path = rel ? `${rel}/${it.name}` : it.name;
      if (!own && path === ".tandem") continue;
      if (it.isDirectory()) walk(join(d, it.name), path);
      else out[path] = readFileSync(join(d, it.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}
