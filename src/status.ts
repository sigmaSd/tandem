// What the home screen says about each copy, without touching anything: how this computer's folder and the
// copy compare, from the lists the watchers and the last scans keep (src/db.ts). It says only what it knows.
// A side it can't see (a computer that is off, a folder it can't watch) is "can't tell",
// with why: never a guess, and never "in sync" from old news.

import { type Listing } from "./listing.ts";
import { plan } from "./plan.ts";

/** Why a side can't be told about. */
export type Why =
  | "starting" // its first scan since Tandem started is not done
  | "off" // another computer that does not answer
  | "network" // a network folder: changes made elsewhere make no event here
  | "failed" // the watcher could not start, or stopped
  | "missed" // the watcher missed changes a sync then found: it is not trusted until Tandem restarts
  | "refused" // the other computer no longer knows this one
  | "unshared" // the other computer no longer shares this folder with this one
  | "waiting" // offered to the other computer, not accepted there yet
  | "version"; // the other computer runs a Tandem that speaks another protocol

export type SideView = { known: true; files: Listing; unread: string[] } | { known: false; why: Why };

export type Half = { known: true; changed: number } | { known: false; why: Why };

export interface CopyStatus {
  /** A sync with this copy happened before (there is a record to compare with). */
  synced: boolean;
  /** When both sides are known: what a sync would do now. */
  both?: { send: number; receive: number; conflict: number; other: number };
  /** Each side on its own: how many files differ from the record of the last sync. */
  here: Half;
  there: Half;
}

/** How many files of a side differ from the record (changed, added or deleted since the last sync). */
function changedSince(files: Listing, base: Record<string, string>, skip: (p: string) => boolean) {
  let n = 0;
  for (const p of Object.keys(files)) if (!skip(p) && files[p].hash !== base[p]) n++;
  for (const p of Object.keys(base)) if (!skip(p) && !Object.hasOwn(files, p)) n++;
  return n;
}

export function copyStatus(
  here: SideView,
  there: SideView,
  base: Record<string, string>,
  skip: (path: string) => boolean,
): CopyStatus {
  const half = (s: SideView): Half =>
    s.known ? { known: true, changed: changedSince(s.files, base, skip) } : { known: false, why: s.why };
  const out: CopyStatus = { synced: Object.keys(base).length > 0, here: half(here), there: half(there) };
  if (here.known && there.known) {
    const both = { send: 0, receive: 0, conflict: 0, other: 0 };
    for (const act of plan(here.files, there.files, base, [...here.unread, ...there.unread], skip)) {
      if (act.kind === "copy") both[act.from === "a" ? "send" : "receive"]++;
      else if (act.kind === "delete") both[act.on === "b" ? "send" : "receive"]++;
      else if (act.kind === "conflict") both.conflict++;
      else if (act.kind !== "settle") both.other++;
    }
    out.both = both;
  }
  return out;
}
