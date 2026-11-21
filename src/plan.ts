// What a sync has to do, decided from three lists: what this computer holds (a), what the other copy holds
// (b), and what both held after the last sync (base: path → content hash; empty the first time). Nothing here
// touches a disk: src/apply.ts carries the actions out.
//
// For each file, the base tells who changed it:
//   same on both sides                         nothing (the base is brought up to date)
//   changed on one side only                   copied to the other
//   deleted on one side, untouched on the other  deleted there too (kept as an old version)
//   changed on both sides, differently         a conflict: the user chooses, nothing is done until then
//   deleted on one side, changed on the other  a conflict too
// Without a base (first sync, or a file neither side had before), a file on one side only is copied to the
// other, never deleted: the first sync can only add.

import { bare, type Listing } from "./listing.ts";

/** a: this computer. b: the other copy. */
export type Side = "a" | "b";

export type Action =
  /** Send a file to the side that lacks it or has the older content. `fresh`: it isn't there at all. */
  | { kind: "copy"; path: string; from: Side; fresh: boolean }
  /** The other side deleted it, and it didn't change here: delete it on `on`. */
  | { kind: "delete"; path: string; on: Side }
  /** Both sides changed. `gone`: the side that deleted it, when one did. */
  | { kind: "conflict"; path: string; gone?: Side }
  /** One side has it but could not read it (locked, no permission): unknown, so left alone on both sides. */
  | { kind: "unread"; path: string }
  /** Names that differ only by capital letters: Windows and macOS can't hold both. Left alone. */
  | { kind: "clash"; path: string; with: string[] }
  /** Nothing to copy, but the base is out of date (both sides made the same change). */
  | { kind: "settle"; path: string; hash: string | null };

/**
 * `unread`: paths a side could not read (src/store.ts Scan). `skip`: paths left out of the sync by either
 * side's list of files to leave out: neither copied nor deleted, whatever the lists say (two computers may
 * leave out different things, and a file one of them doesn't list must not look deleted).
 */
export function plan(
  listA: Listing,
  listB: Listing,
  lastBase: Record<string, string>,
  unread: string[] = [],
  skip: (path: string) => boolean = () => false,
): Action[] {
  // plain tables: a file may be named like something every object has ("constructor")
  const a = bare(listA);
  const b = bare(listB);
  const base = bare(lastBase);
  const paths = [
    ...new Set([
      ...Object.keys(a),
      ...Object.keys(b),
      ...Object.keys(base),
      ...unread.filter((u) => !u.endsWith("/")),
    ]),
  ]
    .filter((p) => !skip(p))
    .sort();
  /** A file a scan could not read, or anything in a folder it could not open: not known to be absent. */
  const unknown = (p: string) => unread.some((u) => p === u || (u.endsWith("/") && p.startsWith(u)));

  // files of today (not the base's memory of deleted ones) whose names collide without their capitals
  const folded = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!(p in a) && !(p in b)) continue;
    // every folder on the way counts: "Fig/a.pdf" and "fig/b.pdf" can't both exist on Windows either
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = prefix.toLowerCase();
      if (!folded.has(key)) folded.set(key, new Set());
      folded.get(key)!.add(prefix);
    }
  }
  const clashing = [...folded.values()].filter((s) => s.size > 1).flatMap((s) => [...s]);
  const clashOf = (p: string) => clashing.filter((c) => p === c || p.startsWith(`${c}/`));

  const actions: Action[] = [];
  for (const path of paths) {
    if (unknown(path)) {
      actions.push({ kind: "unread", path });
      continue;
    }
    const ha = a[path]?.hash;
    const hb = b[path]?.hash;
    const h0 = base[path];
    if (ha === hb) {
      // the same on both sides (or gone from both)
      if (h0 !== ha) actions.push({ kind: "settle", path, hash: ha ?? null });
      continue;
    }
    const mine = clashOf(path);
    if (mine.length) {
      const others = clashing.filter((c) => mine.some((m) => m !== c && m.toLowerCase() === c.toLowerCase()));
      actions.push({ kind: "clash", path, with: others });
      continue;
    }
    if (h0 === undefined) {
      // never synced: a file on one side only is new; on both, two different files of the same name
      if (ha === undefined) actions.push({ kind: "copy", path, from: "b", fresh: true });
      else if (hb === undefined) actions.push({ kind: "copy", path, from: "a", fresh: true });
      else actions.push({ kind: "conflict", path });
      continue;
    }
    const aChanged = ha !== h0;
    const bChanged = hb !== h0;
    if (aChanged && bChanged) {
      actions.push({
        kind: "conflict",
        path,
        ...(ha === undefined ? { gone: "a" } : hb === undefined ? { gone: "b" } : {}),
      });
    } else if (aChanged) {
      if (ha === undefined) actions.push({ kind: "delete", path, on: "b" });
      else actions.push({ kind: "copy", path, from: "a", fresh: false });
    } else {
      if (hb === undefined) actions.push({ kind: "delete", path, on: "a" });
      else actions.push({ kind: "copy", path, from: "b", fresh: false });
    }
  }
  return actions;
}

/**
 * The base two computers agree on, when each kept its own record: only the files both remember with the same
 * content. A file one of them forgot (a sync cut short before its record was saved) is treated as never
 * synced, which can only add files or ask, never delete.
 */
export function agreedBase(mine: Record<string, string>, theirs: Record<string, string> | null) {
  const out = bare<string>();
  if (!theirs) return out;
  const there = bare(theirs);
  for (const [path, hash] of Object.entries(mine)) if (there[path] === hash) out[path] = hash;
  return out;
}
