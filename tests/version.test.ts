import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";

test("the Android versionCode follows the version: 0.3.6 → 306 (F-Droid reads it from package.json)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    nodeapk: { versionCode: number };
  };
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  expect(pkg.nodeapk.versionCode).toBe(major * 10000 + minor * 100 + patch);
});
