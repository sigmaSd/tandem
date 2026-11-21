// The names of the files inside a synced folder: always relative, "/" between folders, Unicode NFC, the same
// on every system. Every path that comes from outside (another computer, the window) goes through cleanRel()
// before it touches the disk: nothing may point outside the folder, or into Tandem's own .tandem folder.

/** Tandem's own folder inside a synced folder: old versions, temporary files, the drive's marker. */
export const OWN = ".tandem";

export class NameError extends Error {}

/** Names Windows refuses, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A path as Tandem keeps it; throws NameError when it could leave the folder or isn't a plain file path. */
export function cleanRel(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 4096) throw new NameError("not a path");
  if (path.includes("\0") || path.includes("\\")) throw new NameError(`not allowed: ${path}`);
  const parts = path.normalize("NFC").split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw new NameError(`not allowed: ${path}`);
  }
  if (parts[0].toLowerCase() === OWN) throw new NameError(`not allowed: ${path}`);
  return parts.join("/");
}

/** Why Windows can't hold a file of this name, or null when it can. */
export function windowsTrouble(rel: string): string | null {
  for (const part of rel.split("/")) {
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what Windows refuses
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) return part;
    if (/[. ]$/.test(part)) return part;
    if (RESERVED.test(part)) return part;
  }
  return null;
}

/** "chapter3.tex" → ["chapter3", ".tex"]; "Makefile" → ["Makefile", ""]; ".bashrc" → [".bashrc", ""]. */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/**
 * The name the other side's version gets when both are kept: "notes/ch2.tex" from "Office PC" becomes
 * "notes/ch2.conflict-Office-PC-20261120-1703.tex" (the time on this computer's clock). Same extension, so it still opens in the same program.
 */
export function conflictName(rel: string, from: string, stamp: string, taken: (rel: string) => boolean) {
  const slash = rel.lastIndexOf("/");
  const dir = rel.slice(0, slash + 1);
  const [stem, ext] = splitExt(rel.slice(slash + 1));
  const who =
    from
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "other";
  const when = localLabel(stamp);
  for (let n = 1; ; n++) {
    const name = `${dir}${stem}.conflict-${who}-${when}${n > 1 ? `-${n}` : ""}${ext}`;
    if (!taken(name)) return name;
  }
}

/** A sortable time stamp for old versions and conflict names: 20261120-160312 (UTC). */
export function stampOf(date: Date) {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/** A stamp's day and minute on this computer's clock, for a file name: 20261120-1703. */
export function localLabel(stamp: string) {
  const d = new Date(stampTime(stamp));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The time a stamp names (milliseconds), or NaN. */
export function stampTime(stamp: string) {
  const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(stamp);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/** Extensions shown side by side as text (src/diff.ts); anything else is compared by date and size. */
const TEXT = new Set(
  (
    "tex bib sty cls bst ltx tikz txt md markdown rst org typ csv tsv json yaml yml toml xml html htm css js ts " +
    "py r jl m c h cpp hpp java rs go sh bat ps1 ini cfg conf gitignore svg lyx asy gp dat"
  ).split(" "),
);
export const isTextName = (rel: string) =>
  TEXT.has(splitExt(rel.split("/").pop()!)[1].slice(1).toLowerCase());
