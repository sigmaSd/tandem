- Don't format code (no `vp check --fix`, no `vp fmt`): the pre-commit hook does it. Check with `vp lint` and `vp test`.
- Heavy commands run capped, or the machine runs out of memory and everything is killed:
  `systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 vp lint`.
- Test the app with its own files moved aside, never on the real folder:
  `node tools/dev.ts --state=<dir>` starts Tandem without Electron and prints a link that opens the window's
  page in a browser; `TANDEM_USERDATA=<dir> electron . --dev --no-window` does the same inside Electron.
  `electron .` with any other flag opens the real app.
- Temporary files go in ~/dev/tmp, never /tmp.
- `src/` has no Electron in it (node:* and web standards only): everything Electron is in `shell/electron/`.
- Every word the app shows is translated (docs/translating.md): new or changed English goes in src/i18n.ts or
  app/ui/i18n.ts, then `node tools/i18n.ts` and a French translation in locales/app/fr.po. `vp test` fails
  until it is there.
- A file is never overwritten or deleted without a copy kept in the folder's `.tandem/old/` (src/store.ts):
  keep it that way in any change to the sync code, and cover it with a test.
