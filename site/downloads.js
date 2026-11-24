// The download buttons: the files of the latest release, asked of GitHub's API by the visitor's browser, so
// the site never needs updating for a release. Without an answer (offline, rate-limited), the page's own
// link to the release page stays. The visitor's system comes first.

const REPO = "sigmaSd/tandem";
const DOWNLOAD = `https://github.com/${REPO}/releases/download/`;

const PLATFORMS = [
  {
    id: "android",
    name: "Android",
    files: [{ match: /-android-arm64\.apk$/, label: "APK" }],
    hint: "Android 9 and later. A newer APK installs over the old one.",
  },
  {
    id: "linux",
    name: "Linux",
    files: [
      { match: /\.AppImage$/, label: "AppImage" },
      { match: /\.deb$/, label: ".deb" },
      { match: /\.rpm$/, label: ".rpm" },
    ],
    hint: "The AppImage runs anywhere and updates itself. .deb for Debian and Ubuntu, .rpm for Fedora and openSUSE.",
  },
  {
    id: "windows",
    name: "Windows",
    files: [{ match: /-setup\.exe$/, label: "Installer" }],
    hint: "Not signed yet: Windows asks before running it.",
  },
  {
    id: "macos",
    name: "macOS",
    files: [
      { match: /-arm64\.dmg$/, label: "Apple silicon" },
      { match: /-\d+\.\d+\.\d+\.dmg$/, label: "Intel" }, // Tandem-0.3.8.dmg (not …-arm64.dmg)
    ],
    hint: "Not signed yet: right-click the app and choose Open the first time.",
  },
];

function visitorSystem() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "";
}

function el(tag, props, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

async function main() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return;
  const release = await res.json();
  const assets = (release.assets ?? []).filter((a) => String(a.browser_download_url).startsWith(DOWNLOAD));
  const mine = visitorSystem();
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine));
  const blocks = [];
  for (const p of platforms) {
    const links = [];
    for (const f of p.files) {
      const asset = assets.find((a) => f.match.test(a.name));
      if (!asset) continue;
      const size = `${Math.round(asset.size / 1048576)} MB`;
      links.push(
        el(
          "a",
          {
            className: `button${p.id === mine && links.length === 0 ? "" : " secondary"}`,
            href: asset.browser_download_url,
          },
          f.label,
          el("span", { className: "size" }, size),
        ),
      );
    }
    if (!links.length) continue;
    blocks.push(
      el(
        "div",
        { className: `platform${p.id === mine ? " mine" : ""}` },
        el("h3", {}, p.name, p.id === mine ? el("span", { className: "tag" }, "this device") : ""),
        el("div", { className: "buttons" }, ...links),
        p.hint ? el("p", { className: "fine" }, p.hint) : "",
      ),
    );
  }
  if (!blocks.length) return;
  const version = String(release.tag_name ?? "").replace(/^v/, "");
  blocks.push(
    el(
      "p",
      { className: "fine" },
      `Version ${version}. `,
      el("a", { href: release.html_url }, "What's new, and every file"),
    ),
  );
  document.getElementById("downloads").replaceChildren(...blocks);
}

main().catch(() => {});
