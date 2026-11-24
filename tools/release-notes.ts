// A release's notes, as GitHub shows them: docs/releases/<tag>.md, written by hand for the people who use
// Tandem, with its images (docs/releases/images/, linked relatively so they show in the repository too)
// linked at `ref` so they show on the release page, then where to download.
//   node tools/release-notes.ts <tag> [ref]      ref: where the images are (default: the tag itself)
// Fails when the notes are missing: a release is not made without them (.github/workflows/release.yml).

import { readFileSync } from "node:fs";

const REPO = "sigmaSd/tandem";
const SITE = "https://sigmasd.github.io/tandem/";

export function releaseNotes(markdown: string, ref: string): string {
  const raw = `https://raw.githubusercontent.com/${REPO}/${ref}/docs/releases/images/`;
  return `${markdown.trim().replace(/\]\(images\//g, `](${raw}`)}

---

**Download for your system:** ${SITE} (or pick a file below).
`;
}

if (import.meta.main) {
  const [tag, ref = tag] = process.argv.slice(2);
  if (!tag) {
    console.error("usage: node tools/release-notes.ts <tag> [ref]");
    process.exit(1);
  }
  const file = new URL(`../docs/releases/${tag}.md`, import.meta.url);
  let markdown: string;
  try {
    markdown = readFileSync(file, "utf8");
  } catch {
    console.error(`no release notes for ${tag}: write docs/releases/${tag}.md first`);
    process.exit(1);
  }
  process.stdout.write(releaseNotes(markdown, ref));
}
