import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { releaseNotes } from "../tools/release-notes.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  nodeapk: { versionCode: number };
};

test("the Android versionCode follows the version: 0.3.6 → 306 (F-Droid reads it from package.json)", () => {
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  expect(pkg.nodeapk.versionCode).toBe(major * 10000 + minor * 100 + patch);
});

test("this version has its release notes and its F-Droid changelog, written before it is tagged", () => {
  expect(existsSync(new URL(`../docs/releases/v${pkg.version}.md`, import.meta.url))).toBe(true);
  const changelog = `../fastlane/metadata/android/en-US/changelogs/${pkg.nodeapk.versionCode}.txt`;
  expect(existsSync(new URL(changelog, import.meta.url))).toBe(true);
});

test("release notes: images are linked where GitHub's release page can show them, then where to download", () => {
  const notes = releaseNotes("## New\n\n![A screen](images/x.jpg)\n", "v1.2.3");
  expect(notes).toContain(
    "](https://raw.githubusercontent.com/sigmaSd/tandem/v1.2.3/docs/releases/images/x.jpg)",
  );
  expect(notes).toContain("https://sigmasd.github.io/tandem/");
});
