// Carrying out a plan (src/plan.ts) between two stores, one file at a time. Each file that lands updates the
// base right away, so a sync cut short (a drive pulled, the other computer shut down) leaves a true record:
// the next sync picks up where this one stopped. A file that changed since it was compared is skipped and
// reported, never forced; so is a conflict the user left unanswered.

import { conflictName } from "./names.ts";
import type { Action, Side } from "./plan.ts";
import { ChangedError, type Entry, type Listing, type Store, transfer } from "./store.ts";

/** A conflict's answer: keep this computer's file (a), the other copy's (b), or both. */
export type Choice = "a" | "b" | "both";

export interface Outcome {
  path: string;
  result:
    | "sent"
    | "received"
    | "removed-here"
    | "removed-there"
    | "both-kept"
    | "unanswered" // a conflict left for later
    | "clash" // names differing only by capitals
    | "unread" // one side could not read it: left alone
    | "changed" // edited while the sync ran: left alone
    | "failed"
    | "stopped"; // not reached: cancelled, or the other copy went away
  /** The error, or for "both-kept" the name the other side's version got. */
  detail?: string;
}

export interface Progress {
  done: number;
  total: number;
  path: string;
  bytes: number;
  totalBytes: number;
}

export interface ApplyOptions {
  a: Store;
  b: Store;
  /** What the scans found; kept up to date as files land (so are `base`'s entries). */
  listA: Listing;
  listB: Listing;
  base: Record<string, string>;
  actions: Action[];
  /** Answers to conflicts, by path. */
  choices: Record<string, Choice>;
  /** This sync's time stamp: the old versions it makes are filed under it. */
  stamp: string;
  /** The other copy's name, for the files kept twice ("ch2.conflict-Office-PC-….tex"). */
  nameB: string;
  progress?: (p: Progress) => void;
  cancelled?: () => boolean;
  /** Persist `base`: called every few files and at the end, whatever happened. */
  save?: () => Promise<void>;
  /** Whether a store can still be reached, asked after a failure: when not, the sync stops there. */
  alive?: (side: Side) => Promise<boolean>;
}

export interface ApplyResult {
  outcomes: Outcome[];
  /** The side that could no longer be reached, when the sync stopped for that. */
  lost?: Side;
  cancelled: boolean;
  /** The record of what was synced could not be saved at the end: the next sync will ask more than needed. */
  unsaved: boolean;
}

/** How many bytes an action will copy (for the progress bar). */
function weight(action: Action, o: ApplyOptions): number {
  const { listA, listB, choices } = o;
  if (action.kind === "copy") return (action.from === "a" ? listA : listB)[action.path]?.size ?? 0;
  if (action.kind !== "conflict") return 0;
  const choice = choices[action.path];
  if (!choice) return 0;
  const sa = listA[action.path]?.size ?? 0;
  const sb = listB[action.path]?.size ?? 0;
  if (action.gone) return choice === action.gone ? 0 : sa + sb; // one of them is 0
  return choice === "a" ? sa : choice === "b" ? sb : sa + 2 * sb;
}

export async function apply(o: ApplyOptions): Promise<ApplyResult> {
  const { a, b, listA, listB, base, stamp } = o;
  const store = { a, b };
  const list = { a: listA, b: listB };
  const other = (s: Side): Side => (s === "a" ? "b" : "a");

  // what both sides already agree on needs no work: only the record
  for (const act of o.actions) {
    if (act.kind !== "settle") continue;
    if (act.hash === null) delete base[act.path];
    else base[act.path] = act.hash;
  }

  const work = o.actions.filter((x) => x.kind !== "settle");
  const totalBytes = work.reduce((n, x) => n + weight(x, o), 0);
  let bytes = 0;
  let done = 0;
  const outcomes: Outcome[] = [];
  let lost: Side | undefined;
  let cancelled = false;
  let unsaved = false;

  /** Copy `path` from one side to the other (as `dest` there), and record it. */
  const copy = async (from: Side, path: string, dest = path): Promise<Entry> => {
    const to = other(from);
    const source = list[from][path];
    const landed = await transfer(
      store[from],
      store[to],
      path,
      source,
      list[to][dest] ?? null,
      stamp,
      dest,
      (n) => {
        bytes += n;
        o.progress?.({ done, total: work.length, path, bytes, totalBytes });
      },
    );
    list[to][dest] = landed;
    base[dest] = source.hash;
    return landed;
  };
  const remove = async (on: Side, path: string) => {
    await store[on].retire(path, list[on][path], stamp);
    delete list[on][path];
    delete base[path];
    // recorded at once: a deletion forgotten by a sync cut short could be repeated on a file put back since
    await o.save?.().catch(() => {});
  };

  const run = async (act: Action): Promise<Outcome> => {
    const path = act.path;
    if (act.kind === "copy") {
      await copy(act.from, path);
      return { path, result: act.from === "a" ? "sent" : "received" };
    }
    if (act.kind === "delete") {
      await remove(act.on, path);
      return { path, result: act.on === "a" ? "removed-here" : "removed-there" };
    }
    if (act.kind === "clash") return { path, result: "clash", detail: act.with.join(", ") };
    if (act.kind === "unread") return { path, result: "unread" };
    if (act.kind !== "conflict") return { path, result: "stopped" };

    const choice = o.choices[path];
    if (!choice) return { path, result: "unanswered" };
    if (act.gone) {
      // one side deleted it, the other changed it: the changed file wins unless the deletion was chosen
      const has = other(act.gone);
      if (choice === act.gone) {
        await remove(has, path);
        return { path, result: has === "a" ? "removed-here" : "removed-there" };
      }
      await copy(has, path);
      return { path, result: has === "a" ? "sent" : "received" };
    }
    if (choice !== "both") {
      await copy(choice, path);
      return { path, result: choice === "a" ? "sent" : "received" };
    }
    // both kept: the other copy's version gets a name of its own on both sides, ours keeps the name
    const name = conflictName(
      path,
      o.nameB,
      stamp,
      (p) => Object.hasOwn(listA, p) || Object.hasOwn(listB, p),
    );
    const theirs = listB[path];
    listA[name] = await transfer(b, a, path, theirs, null, stamp, name, (n) => (bytes += n));
    await copy("a", path); // theirs goes to their old versions, and comes back under the new name:
    await copy("a", name);
    base[name] = theirs.hash;
    return { path, result: "both-kept", detail: name };
  };

  try {
    for (const act of work) {
      if (lost || cancelled || o.cancelled?.()) {
        cancelled ||= !lost;
        outcomes.push({ path: act.path, result: "stopped" });
        continue;
      }
      o.progress?.({ done, total: work.length, path: act.path, bytes, totalBytes });
      try {
        outcomes.push(await run(act));
      } catch (e) {
        if (e instanceof ChangedError) outcomes.push({ path: act.path, result: "changed" });
        else {
          outcomes.push({ path: act.path, result: "failed", detail: (e as Error).message });
          // a drive unplugged or a computer gone: no point failing every file after it one by one
          for (const side of ["a", "b"] as const) {
            if (o.alive && !(await o.alive(side).catch(() => false))) lost = side;
          }
        }
      }
      done++;
      if (done % 25 === 0) await o.save?.().catch(() => {});
    }
  } finally {
    unsaved = o.save
      ? await o.save().then(
          () => false,
          () => true,
        )
      : false;
  }
  o.progress?.({ done, total: work.length, path: "", bytes, totalBytes });
  return { outcomes, lost, cancelled, unsaved: unsaved && !lost };
}
