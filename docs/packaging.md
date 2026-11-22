# Packages, releases and updates

Config: `shell/electron/builder.yml` (electron-builder). Updates: `shell/electron/updates.ts`. CI:
`.github/workflows/release.yml`.

## Building

```bash
vp build && vp pack
```

```bash
npx electron-builder --config shell/electron/builder.yml --linux AppImage rpm deb --x64 --publish never
```

Everything lands in `dist/packages/`: the AppImage, the .rpm, the .deb, and `latest-linux.yml` (the file
installed apps read to find a new version). `vp run appimage` builds the AppImage alone, `vp run install-app`
also installs it for the current user.

## Releasing

1. Raise `version` in `package.json`, commit, push.
2. A tag `v<version>` (or `gh release create v<version>`) starts the release workflow: it builds Linux,
   Windows and macOS packages and attaches them, with the update files (`latest-linux.yml`, `latest.yml`,
   `latest-mac.yml`, `*.blockmap`), to that tag's release.
3. Or build the Linux packages here and attach them yourself:
   `gh release upload v<version> dist/packages/{*.AppImage,*.rpm,*.deb,latest-linux.yml} --clobber`.
   Always upload `latest-linux.yml` together with the packages it describes: it carries their sizes and
   hashes, and an update whose hash doesn't match is refused.

## Updates

The packages carry `app-update.yml` (from `publish:` in `builder.yml`): they ask the GitHub releases of
sigmaSd/tandem at launch and once a day.

- The AppImage (and Windows, macOS) downloads a new version, checks its hash, and offers "Restart to update".
- An .rpm or .deb only says "Tandem x.y.z is out", with a button to the releases page: installing needs root,
  so it's left to the package manager. electron-builder writes `resources/package-type` into these packages,
  which is how the app knows what it was installed as.
- A copy started from the checkout (`electron .`) never asks.

## The .rpm and /usr/lib/.build-id

rpmbuild normally adds a link in `/usr/lib/.build-id/` for each binary in the package. Every Electron app
ships nearly the same binaries, so two Electron apps installed with dnf claim the same link, and the second
install fails:

```
file /usr/lib/.build-id/8a/59b1… from install of tandem-0.3.0-1.x86_64 conflicts with file from package inktyset-1.1.0-1.x86_64
```

`builder.yml` turns those links off for the .rpm (`fpm: ["--rpm-rpmbuild-define", "_build_id_links none"]`).
To check a built package: `rpm -qlp dist/packages/tandem-*.rpm | grep -c build-id` must say 0. (Built on
Fedora the links were missing anyway; built on Ubuntu, as in CI, there were 13.)

## What has been tried

- Linux: the AppImage, .rpm and .deb are built on Fedora and on Ubuntu (CI). The AppImage is started and
  checks for updates. The .rpm built without the links has not yet been installed next to another Electron
  app: the first one released (CI-built, with the links) failed that way.
- Windows and macOS: built only by CI, never started. In the 0.3.0 run their jobs stopped at the tests, before
  packaging: on Windows the tests can't delete the scratch folders of a Tandem still open (`EPERM`), and on
  macOS one watcher test timed out. Neither is in the 0.3.0 release.
- No package is signed.
