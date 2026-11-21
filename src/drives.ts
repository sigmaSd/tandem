// A copy on a drive (a USB stick, an external disk, or any folder, a network share included). The drive is
// recognized by a small marker file Tandem writes in the copy's folder (.tandem/copy.json), not by where the
// system mounts it: a stick is E: on one computer, F: on the next, /run/media/… on Linux.

import { mkdir, readdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { OWN } from "./names.ts";

export interface Marker {
  id: string;
  /** The synced folder's name when the copy was made ("Project"). */
  name: string;
}

export async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const m = JSON.parse(await readFile(join(dir, OWN, "copy.json"), "utf8")) as Marker;
    return typeof m.id === "string" && /^[0-9a-f]{32}$/.test(m.id)
      ? { id: m.id, name: String(m.name ?? "") }
      : null;
  } catch {
    return null;
  }
}

export async function writeMarker(dir: string, marker: Marker) {
  await mkdir(join(dir, OWN), { recursive: true });
  await writeFile(join(dir, OWN, "copy.json"), JSON.stringify(marker));
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** Where plugged drives show up on this system. */
export async function mountRoots(): Promise<string[]> {
  const out: string[] = [];
  const under = async (dir: string) => {
    for (const it of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (it.isDirectory() || it.isSymbolicLink()) out.push(join(dir, it.name));
    }
  };
  if (process.platform === "win32") {
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZAB") {
      if (await isDir(`${letter}:\\`)) out.push(`${letter}:\\`);
    }
  } else if (process.platform === "darwin") {
    await under("/Volumes");
  } else {
    let user = "";
    try {
      user = userInfo().username;
    } catch {
      /* no user name: only the shared places */
    }
    if (user) {
      await under(`/run/media/${user}`);
      await under(`/media/${user}`);
    }
    await under("/mnt");
  }
  return out;
}

export interface Drive {
  /** Where it is mounted. */
  root: string;
  /** Its label ("MY-USB"). */
  name: string;
  free: number;
  /** Folders on it that already hold a Tandem copy. */
  copies: { path: string; name: string; id: string }[];
}

/** The drives plugged in now, with the Tandem copies found at their top or one folder down. */
export async function listDrives(): Promise<Drive[]> {
  const drives: Drive[] = [];
  for (const root of await mountRoots()) {
    let free = 0;
    try {
      const fs = await statfs(root);
      free = fs.bavail * fs.bsize;
    } catch {
      continue; // not readable: not a drive we can use
    }
    const copies: Drive["copies"] = [];
    const here = await readMarker(root);
    if (here) copies.push({ path: root, ...here });
    for (const it of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!it.isDirectory() || it.name === OWN) continue;
      const m = await readMarker(join(root, it.name));
      if (m) copies.push({ path: join(root, it.name), ...m });
    }
    const label = process.platform === "win32" ? root.slice(0, 2) : basename(root);
    drives.push({ root, name: label, free, copies });
  }
  return drives;
}

/** A folder's place on its drive: [mount root, path below it], or null when it is on no plugged drive. */
export async function placeOnDrive(path: string): Promise<{ root: string; sub: string } | null> {
  for (const root of await mountRoots()) {
    const rel = relative(root, path);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)))
      return { root, sub: rel };
  }
  return null;
}

/**
 * Where a known copy is right now: its last place, or the same folder on whichever drive carries its marker.
 * null: not plugged in.
 */
export async function findCopy(copy: { marker: string; path: string; sub?: string }): Promise<string | null> {
  if ((await readMarker(copy.path))?.id === copy.marker) return copy.path;
  if (copy.sub === undefined) return null;
  for (const root of await mountRoots()) {
    const candidate = copy.sub ? join(root, copy.sub) : root;
    if (candidate !== copy.path && (await readMarker(candidate))?.id === copy.marker) return candidate;
  }
  return null;
}
