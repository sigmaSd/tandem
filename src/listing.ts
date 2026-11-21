// The shape every list of files has, shared by the stores (src/store.ts), the database (src/db.ts) and the
// sync's decisions (src/plan.ts).

/** A file as a scan saw it. `mtime` in whole milliseconds; `hash` is the SHA-256 of the content, in hex. */
export interface Entry {
  size: number;
  mtime: number;
  hash: string;
}

/** Every synced file of one copy, by its path inside the folder. */
export type Listing = Record<string, Entry>;

/**
 * A plain table without Object's own baggage: a file may be named "constructor" or "__proto__", and must be
 * neither found when absent nor mistaken for the table's prototype when written.
 */
export function bare<T>(from?: Record<string, T> | null): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from ?? {});
}
