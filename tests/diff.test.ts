import { expect, test } from "vite-plus/test";
import { diffLines, looksBinary, toLines } from "../src/diff.ts";

const show = (rows: ReturnType<typeof diffLines>) =>
  rows!.map((r) => `${r.kind[0]} ${r.left ?? "·"} | ${r.right ?? "·"}`);

test("diff: a changed line faces its new version, added and removed lines stand alone", () => {
  const left = ["\\section{Intro}", "We prove X.", "Old remark.", "The end."];
  const right = ["\\section{Intro}", "We prove X and Y.", "The end.", "A new line."];
  expect(show(diffLines(left, right))).toEqual([
    "s \\section{Intro} | \\section{Intro}",
    "c We prove X. | We prove X and Y.",
    "d Old remark. | ·",
    "s The end. | The end.",
    "a · | A new line.",
  ]);
});

test("diff: line numbers follow each side", () => {
  const rows = diffLines(["a", "b", "c"], ["a", "x", "y", "c"])!;
  expect(rows.map((r) => [r.ln, r.rn])).toEqual([
    [1, 1],
    [2, 2],
    [undefined, 3],
    [3, 4],
  ]);
});

test("diff: equal files, empty files, and one empty side", () => {
  expect(show(diffLines(["a", "b"], ["a", "b"]))).toEqual(["s a | a", "s b | b"]);
  expect(diffLines([], [])).toEqual([]);
  expect(show(diffLines([], ["a"]))).toEqual(["a · | a"]);
  expect(show(diffLines(["a"], []))).toEqual(["d a | ·"]);
});

test("diff: rebuilding either side from the rows gives the files back, whatever the edits", () => {
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 200; round++) {
    const left = Array.from({ length: rnd(30) }, () => `line ${rnd(8)}`);
    const right = left.flatMap((l) => (rnd(4) === 0 ? [] : rnd(5) === 0 ? [l, `new ${rnd(9)}`] : [l]));
    const rows = diffLines(left, right)!;
    expect(rows.filter((r) => r.left !== undefined).map((r) => r.left)).toEqual(left);
    expect(rows.filter((r) => r.right !== undefined).map((r) => r.right)).toEqual(right);
    for (const r of rows) if (r.kind === "same") expect(r.left).toBe(r.right);
  }
});

test("diff: files with nothing in common are not paired line by line", () => {
  const left = Array.from({ length: 2500 }, (_, i) => `left ${i}`);
  const right = Array.from({ length: 2500 }, (_, i) => `right ${i}`);
  expect(diffLines(left, right)).toBeNull();
});

test("diff: text or not, and lines without their line ends", () => {
  expect(looksBinary(new TextEncoder().encode("\\documentclass{book}\n"))).toBe(false);
  expect(looksBinary(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2]))).toBe(true);
  expect(toLines(new TextEncoder().encode("a\r\nb\n\nc\n"))).toEqual(["a", "b", "", "c"]);
  expect(toLines(new TextEncoder().encode(""))).toEqual([]);
});
