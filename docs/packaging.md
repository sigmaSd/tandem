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

The Android APK is built by [nodeapk](https://github.com/sigmaSd/nodeapk) from `shell/android/main.ts` (the
`nodeapk` block in `package.json`), from its sources in `vendor/nodeapk` (a git submodule:
`git submodule update --init` once):

```bash
vp build && vp pack && node vendor/nodeapk/src/cli.ts build . --install
```

The release and F-Droid build the same APK, byte for byte before signing: same nodeapk sources (the
submodule), same Node. The release takes Node from [node-android](https://github.com/sigmaSd/node-android)'s
release; F-Droid builds that release from source with `vendor/node-android` (its `reproduce` workflow checks a
release rebuilds bit for bit). Updating either means moving its submodule, then releasing.

Built here it is signed with this machine's debug key: fine for trying it on a phone, but a phone that has
the released APK refuses it (and the reverse). `vp run install-dev` makes the menu's Tandem run this checkout.

## Releasing

1. Raise `version` in `package.json`, and `nodeapk.versionCode` with it (0.3.7 → 307: F-Droid reads it there).
   Write what changed, for the people who use Tandem: `docs/releases/v<version>.md` (the release's notes on
   GitHub, with screenshots in `docs/releases/images/` when a change can be seen, linked as `images/…`) and
   `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt` (F-Droid's, plain text, 500 characters at
   most). `vp test` checks the version code and that both exist. Commit, push.
2. A tag `v<version>` (or `gh release create v<version>`) starts the release workflow: it builds Linux,
   Windows and macOS packages and attaches them, with the update files (`latest-linux.yml`, `latest.yml`,
   `latest-mac.yml`, `*.blockmap`), to that tag's release, and the Android APK
   (`Tandem-<version>-android-arm64.apk`), signed with Tandem's release key: the `ANDROID_KEYSTORE_BASE64`
   and `ANDROID_KEYSTORE_PASSWORD` secrets. The key itself is kept outside the repository; every APK must be
   signed with it, or phones won't update.
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
- The Android app doesn't check: a newer APK from the releases page installs over the old one (same key).

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
- Windows and macOS: the tests pass there on every push (Check runs on Linux, Windows and macOS). Their
  packages are built only by the release workflow, from 0.3.1 on (`setup.exe`; a .dmg and a .zip each for
  Intel and Apple Silicon), and have never been started. On macOS one watcher test is timing-sensitive: a
  failed job can be run again (`gh run rerun <id> --failed`), and the release is published only once every
  system's job has passed.
- Android: the APK runs on an Android 16 phone (pairing by QR, a sync); 0.3.3 is the first with an APK in
  the release.
- No desktop package is signed. The APK is, with Tandem's release key.
