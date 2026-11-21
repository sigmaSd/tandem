# How Tandem decides

## Why not a plain copy tool

A one-way copy (rsync, a file manager) makes the destination look like the source. Run in the wrong
direction, it replaces the newer work without a word: the accident Tandem exists to prevent. A two-way sync
needs to know who changed what, and for that it needs a memory.

## The base

After each sync with a copy, Tandem records what both sides held: path → content hash. That record is the
*base* (`src/plan.ts`). At the next sync each file is compared three ways: this computer, the other copy, the
base.

| This computer | Other copy | What happens |
|---|---|---|
| same as base | same as base | nothing |
| changed | same as base | sent |
| same as base | changed | received |
| changed | changed, same content | nothing, the base is updated |
| changed | changed, different content | conflict: the user chooses |
| deleted | same as base | deleted there too (kept as an old version) |
| deleted | changed | conflict: keep the file, or delete it |
| not in the base | absent | sent as a new file |
| not in the base, differs on both | | conflict |

Without a base (the first sync) a file on one side only is copied, never deleted: a first sync can only add.

Files are compared by content (SHA-256), not by date: clocks differ between computers and FAT drives round
times. Dates only decide whether a file must be hashed again (`src/store.ts`: unchanged size and time, and
not modified in the last seconds, means the remembered hash is reused).

## Where the base lives

One base per pair, kept outside the synced folder (in the app's own files).

- **Computer and drive**: on the computer. Each computer has its own base with the same drive.
- **Two computers**: each keeps a copy. The one that starts a sync uses only the entries both remember alike
  (`agreedBase`). If a sync was cut before one side saved, the forgotten files are treated as never synced,
  which can add a file or ask a question but never delete.

## The rules that protect files

All in `src/store.ts`, covered by `tests/sync.test.ts`:

- **Nothing is overwritten or deleted.** The old file moves to `.tandem/old/<time>/<same path>` first, on
  the side where it was. Kept 90 days by default.
- **No half-written file.** A file arrives under a temporary name in `.tandem/tmp/`, is checked against its
  size and hash, flushed to the disk, then renamed into place.
- **Nothing is replaced under an author.** Every write and delete says what the comparison saw. If the
  file changed since (someone kept typing), it is skipped and reported.
- **An interrupted sync is truthful.** The base is updated file by file, saved after every deletion, every
  few copies, and at the end. The next sync continues from what really happened.
- **A copy that went away is not written to.** Before each write the store checks that its folder is still
  there, and for a drive that it still carries the copy's marker: a drive pulled during the review is
  reported, its folder is never made again where it was, and nothing is recorded as synced. Another
  computer's folder is named by a token for the run: requests planned against a folder changed since are
  refused.
- **A stale review is not carried out.** If the other computer synced with this one while a review sat
  open, Start asks to compare again.
- **Old versions are filed under the local clock.** A computer whose clock is wrong can't age another
  one's old versions.
- **Conflicts wait.** An unanswered conflict is skipped. Everything else still syncs.
- **Unreadable is not deleted.** A file that is there but can't be read (open in a program that locks it,
  no permission), or a folder that can't be opened, is reported and left alone on both sides.
- **An emptied folder stops the sync.** A side that held files at the last sync and shows none now is more
  likely a disk that is not mounted than a folder emptied on purpose: Tandem says so and plans nothing.
- **Nothing outside the folder.** Paths are relative, without `..`, never through a link, never into
  `.tandem` (`src/names.ts`). This holds for another computer's requests too.

## Left out on purpose

- **Files that programs rebuild or lock** (`src/ignore.ts`): LaTeX's `.aux`, `.log`, `.synctex.gz`…, Word's
  `~$` lock files, `.git`. They cause most conflicts and carry nothing. The list is in the settings. The
  side that starts a sync sends its list, so both sides agree on it.
- **Names that differ only by capital letters.** Linux can hold `Fig.pdf` and `fig.pdf`, Windows and macOS
  cannot. Tandem leaves both alone and says so.
- **Empty folders, links, permissions.**
- **Merging.** "Keep both" writes the other side's version next to the file as
  `name.conflict-<copy>-<date>.ext`, on both sides.

## Known limits

- A rename is a deletion plus a new file: the content is copied again.
- With three or more copies a change travels one sync at a time, so the longer a copy goes unsynced the more
  conflicts it can meet.
- On FAT drives a file changed twice within two seconds, to the same size, can keep its remembered hash
  until its next change. As a source, the copy step refuses it (its hash no longer matches) and reports it.
  As a destination it is replaced, and kept as an old version.
- With three copies synced pair by pair, a file deleted through one pair and put back with the same content
  on a third computer can be deleted again by a later sync of another pair. The review shows it, and the
  file is kept as an old version.
- A drive's base is kept on each computer, not on the drive: a drive restored from an older image looks to
  each computer like files were deleted or changed on it.
- The pairing keys are stored in the app's own folder, readable by the user account only, not encrypted.
