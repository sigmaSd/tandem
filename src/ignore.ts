// Which files are left out of the sync: files that programs rebuild or lock (LaTeX's .aux and .log, Word's
// "~$" lock files), and system clutter. One pattern per line, as in .gitignore but simpler:
//   *.aux          a name, anywhere in the folder (a matching folder is left out with all it holds)
//   build/         a folder of that name, anywhere
//   notes/draft.*  with a "/" inside: counted from the top of the synced folder
//   *  any letters but "/",  **  any letters,  ?  one letter;  capital letters don't matter;  # a comment
// The same list is used for both sides of a sync (the side that starts it sends its list), so a file ignored
// here is never copied from there.

import { OWN } from "./names.ts";

export const DEFAULT_IGNORE = `# LaTeX files that are rebuilt at each compilation
*.aux
*.log
*.out
*.toc
*.lof
*.lot
*.fls
*.fdb_latexmk
*.synctex.gz
*.synctex(busy)
*.nav
*.snm
*.vrb
*.bcf
*.run.xml
*.blg
# files that editors keep only while a document is open
~$*
.~lock.*#
*.swp
*~
*.tmp
# system files
.DS_Store
Thumbs.db
desktop.ini
$RECYCLE.BIN/
System Volume Information/
.Spotlight-V100/
.fseventsd/
.Trashes/
.Trash-*/
# tools that have their own way to sync
.git/
node_modules/
__pycache__/`;

interface Rule {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

function compile(line: string): Rule | null {
  let p = line.trim();
  if (!p || p.startsWith("#")) return null;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const fromTop = p.startsWith("/"); // "/build": only the one at the top
  if (fromTop) p = p.slice(1);
  if (!p) return null;
  const anchored = fromTop || p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp(`^${re}$`, "iu"), dirOnly, anchored };
}

/** A test for one list of patterns: is this file or folder (its path inside the synced folder) left out? */
export function ignorer(patterns: string): (rel: string, isDir: boolean) => boolean {
  const rules = patterns
    .split(/\r?\n/)
    .map(compile)
    .filter((r) => r !== null);
  return (rel, isDir) => {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (rel === OWN || rel.startsWith(`${OWN}/`)) return true; // Tandem's own folder, always
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.anchored ? rel : name)) return true;
    }
    return false;
  };
}

/**
 * One test for a whole path, folders on the way included ("build/out.pdf" is left out by "build/"), across
 * several lists: what any of them leaves out is left out (two computers may each leave out their own things).
 */
export function skipper(...lists: string[]): (path: string) => boolean {
  const tests = lists.map(ignorer);
  const memo = new Map<string, boolean>();
  const dir = (p: string): boolean => {
    let v = memo.get(p);
    if (v === undefined) {
      const slash = p.lastIndexOf("/");
      v = (slash > 0 && dir(p.slice(0, slash))) || tests.some((t) => t(p, true));
      memo.set(p, v);
    }
    return v;
  };
  return (path) => {
    const slash = path.lastIndexOf("/");
    return (slash > 0 && dir(path.slice(0, slash))) || tests.some((t) => t(path, false));
  };
}
