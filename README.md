# Tandem

Keep one folder the same on several computers, over your own network or with a USB drive. Nothing goes to
the cloud.

Made for people who work in the same folder from two computers and are tired of copying the last version
by hand. Tandem shows every change before it makes it, asks when both sides changed the same
file, and never overwrites or deletes anything without keeping a copy.

## How it works

1. **Choose the folder** on each computer (on the second one an empty folder is fine).
2. **Add a copy**:
   - *Another computer on this network*: one shows a code, the other types it. Once, then they know each
     other. Both must be on, with Tandem open, to sync.
   - *A USB drive or another folder*: Tandem makes its own folder on the drive. On the second computer,
     plug the drive in and choose "Use this copy". Works for computers that are never on together.
3. **Sync**: Tandem compares the two copies and lists what it will do: files to send, to receive, deleted
   on the other side, and conflicts (changed on both sides) with three answers each: this computer's, the
   other's, or both. Text files can be compared side by side first.
4. **Old versions**: every replaced or deleted file is kept for 90 days (`.tandem/old/` in the folder) and
   can be put back from the window.

Several copies are fine: two computers and a drive, three computers, and so on. Each is synced on its own.

## What it does not do (yet)

- It does not sync in the background: you start each sync and see it.
- It does not merge two versions of a file into one. "Keep both" puts them side by side in the folder.
- One folder per computer.
- Empty folders, links and file permissions are not synced.
- No Android app. The core (`src/`) is kept free of anything desktop-only so that one can follow.
- Updates: not automatic until a place to publish releases is chosen (`shell/electron/builder.yml`).

## Develop

Node 24, pnpm, [Vite+](https://viteplus.dev) (`vp`).

```bash
vp install
```

```bash
vp run dev
```

- `vp test` runs the tests, `vp lint` the linter and type checker.
- `vp run browser` starts Tandem without Electron and prints a link for a normal browser
  (`node tools/dev.ts --state=<folder>` for a second copy with its own files).
- `vp run appimage` builds the Linux AppImage, `vp run install-app` also installs it for the current user.
- `vp run dist` builds every package of the current system into `dist/packages/`.

Only the Linux AppImage has been run. The Windows and macOS packages are configured and built by
`.github/workflows/release.yml`, and nobody has tried them yet.

```
src/              the sync itself: no Electron, tested (plan, apply, store, peer, core…)
app/ui/           the window: one page, its styles and words
shell/electron/   all the Electron code: window, menus, updates, packaging
tools/            scripts: dev runner, install, translations
tests/            vp test
locales/app/      translations (.po), see docs/translating.md
docs/             design.md (how the sync decides), network.md (pairing and encryption)
```
