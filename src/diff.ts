// Two versions of a text file, line by line, for the side-by-side view of a conflict (the window's Compare).
// Myers' algorithm: the shortest list of removed and added lines. Lines changed in place are paired, so the
// two versions of a sentence face each other.

export interface Row {
  /** same: on both sides. change: a line that differs. del: only on the left. add: only on the right. */
  kind: "same" | "change" | "del" | "add";
  left?: string;
  right?: string;
  /** Line numbers, from 1. */
  ln?: number;
  rn?: number;
}

/** Past this many differing lines the files are shown whole, one after the other: nothing useful to pair. */
const MAX_EDITS = 2000;

type Edit = { op: "same" | "del" | "add"; i: number; j: number };

function myers(a: Int32Array, b: Int32Array): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    if (d > MAX_EDITS) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) edits.push({ op: "same", i: --x, j: --y });
    if (down) edits.push({ op: "add", i: x, j: --y });
    else edits.push({ op: "del", i: --x, j: y });
  }
  while (x > 0 && y > 0) edits.push({ op: "same", i: --x, j: --y });
  return edits.reverse();
}

/** The rows of a side-by-side view of two lists of lines; null when they differ too much to pair. */
export function diffLines(left: string[], right: string[]): Row[] | null {
  // equal lines get equal numbers: the algorithm compares numbers
  const ids = new Map<string, number>();
  const id = (s: string) => ids.get(s) ?? (ids.set(s, ids.size), ids.size - 1);
  const a = Int32Array.from(left, id);
  const b = Int32Array.from(right, id);
  // the same beginning and end are set aside first: most edits touch a small part of a chapter
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const edits = myers(a.subarray(head, a.length - tail), b.subarray(head, b.length - tail));
  if (!edits) return null;

  const rows: Row[] = [];
  for (let i = 0; i < head; i++)
    rows.push({ kind: "same", left: left[i], right: right[i], ln: i + 1, rn: i + 1 });
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = () => {
    const pairs = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairs; i++)
      rows.push({
        kind: "change",
        left: left[dels[i]],
        right: right[adds[i]],
        ln: dels[i] + 1,
        rn: adds[i] + 1,
      });
    for (const i of dels.slice(pairs)) rows.push({ kind: "del", left: left[i], ln: i + 1 });
    for (const j of adds.slice(pairs)) rows.push({ kind: "add", right: right[j], rn: j + 1 });
    dels = [];
    adds = [];
  };
  for (const e of edits) {
    if (e.op === "del") dels.push(e.i + head);
    else if (e.op === "add") adds.push(e.j + head);
    else {
      flush();
      rows.push({
        kind: "same",
        left: left[e.i + head],
        right: right[e.j + head],
        ln: e.i + head + 1,
        rn: e.j + head + 1,
      });
    }
  }
  flush();
  for (let t = tail; t > 0; t--) {
    const i = a.length - t;
    const j = b.length - t;
    rows.push({ kind: "same", left: left[i], right: right[j], ln: i + 1, rn: j + 1 });
  }
  return rows;
}

/** A file's bytes are text when nothing in them is a NUL (what git checks too). */
export function looksBinary(bytes: Uint8Array) {
  return bytes.subarray(0, 8000).includes(0);
}

export function toLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop(); // the file's last line end is not an empty line
  return lines;
}
