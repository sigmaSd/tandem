// The whole toolchain, through Vite+ (`vp`):
//   vp build   the window's page (app/ui/index.html and its scripts) → app/ui/dist/
//   vp pack    Electron's main process (everything Tandem does), one file → dist/app/electron.mjs, and the
//              same for the Android app → dist/android/android.mjs
//   vp check   format (Oxfmt), lint (Oxlint) and type-check (TypeScript 7) — at commit (.vite-hooks/pre-commit)
//   vp lint    lint and type-check, no formatting: while editing
//   vp test    the tests (Vitest), tests/*.test.ts
//   vp run dev the app from this checkout (builds, then starts Electron)

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// fileURLToPath, not .pathname: on Windows that gives "/D:/…"
const ui = fileURLToPath(new URL("./app/ui/", import.meta.url));
const pages = ["index"];

const bundle = {
  format: "esm" as const,
  platform: "node" as const,
  target: "node24",
  clean: true,
  dts: false,
  // dependencies bundled in: the package needs no node_modules (Electron itself is the runtime)
  deps: { alwaysBundle: [/.*/], neverBundle: ["electron"], onlyBundle: false as const },
};

export default defineConfig({
  root: ui,
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome140", // Electron's Chromium
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, `${ui}${p}.html`])) },
  },

  fmt: {
    printWidth: 110,
    ignorePatterns: ["app/ui/dist/**", "dist/**", "pnpm-lock.yaml", "*.md", "locales/**", "vendor/**"],
  },
  lint: {
    ignorePatterns: ["app/ui/dist/**", "dist/**", "vendor/**"],
    options: { typeAware: true, typeCheck: true },
    rules: {
      // deliberate: the window starts work it doesn't wait for (each call catches and shows its own errors)
      "typescript/no-floating-promises": "off",
      // deliberate: untyped input (JSON) is cleaned with String(x ?? "")
      "typescript/no-base-to-string": "off",
      "typescript/restrict-template-expressions": "off",
    },
  },
  staged: { "*": "vp check --fix" },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["tests/*.test.ts"],
  },
  // Apart, each with everything it needs: the APK holds nothing of the desktop app, nor the other way round
  pack: [
    { ...bundle, entry: { electron: "shell/electron/main.ts" }, outDir: "dist/app" },
    // run by nodeapk's shell on the phone
    { ...bundle, entry: { android: "shell/android/main.ts" }, outDir: "dist/android" },
  ],
});
