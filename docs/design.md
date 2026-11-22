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

## Several folders

Each folder kept in sync has its own copies, its own list of files left out, and its own old versions
(`.tandem/old/` inside it). A sync is always between one folder and one of its copies, one sync at a time.

Paired computers are separate from folders. Pairing (`docs/network.md`) makes two computers trust each other;
it shares nothing by itself. A folder is then **offered** to a paired computer and **accepted** there into a
folder of that computer's choosing: a new one, or one it already syncs. From then on the two folders are
**linked** by their ids, each computer's own, never by their names or places: either side can rename or
move its folder, and two folders named alike stay apart.

- Offered while both people are on a folder's "add a copy" screen during pairing, the two folders are linked
  at once: choosing the folder, then pairing, stays one step.
- An offer made while the other computer is off is made again at the next look.
- "Not on this computer" is remembered: the same offer again is answered no without asking, and the offering
  side takes its copy back.
- A paired computer reaches only the folders linked to it (`src/core.ts`, `#shared`): every request names
  the folder, and anything else is refused.
- A folder can't be inside another synced folder, nor hold one: its files would be synced twice.
- Stopping syncing a folder forgets its copies and records; its files stay where they are.

Tandem 0.2.0 had one folder: it becomes the first folder, its paired computers stay paired with that folder
shared, and its list and records keep their history, so the next sync is not a first sync. Which folder it
is on the other computer is learned at the first exchange once both are updated. Its copies on drives are forgotten
(Tandem no longer syncs with drives); their files stay on the drives.

## Where the lists live

Everything Tandem remembers about files is in one SQLite database in the app's own files
(`index.db`, `src/db.ts`), kept row by row: a change on the disk or a file a sync writes costs one row, not
a rewrite of a list. Each list has a change number that only goes up, and a deleted file leaves a row marked
gone, so another computer can ask "what changed since number N?" and get only that.

- `folder:<id>`: one of this computer's synced folders, with each file's size, date and hash.
- `base:<copy>`: the record of the last sync with that copy (the base below).
- `peer:<copy>` and `peerbase:<copy>`: another computer's list and its own record, followed by their
  changes.

One base per pair (a folder and one of its copies), kept outside the synced folder. Each computer keeps a
copy of it. The one that starts a sync uses only the entries both remember alike
(`agreedBase`). If a sync was cut before one side saved, the forgotten files are treated as never synced,
which can add a file or ask a question but never delete.

## Between syncs: the status of each copy

The home screen says what a sync would do with each copy, without doing it (`src/status.ts`):

- **This computer's folders** are scanned once when Tandem starts (or when a folder is added), then
  followed by a watcher (`src/watch.ts`). The watcher names the paths that changed, and only those
  are read again. Nothing reads the whole folder on a timer.
- **A paired computer** is asked every 30 seconds while a window is open, and when the window comes to the
  front, for its change number. Only when that moved does it send what changed. A status question is answered
  from the list, never from the disk.
- **Only what is known is said.** "In sync" needs both sides known. A side that can't be followed is "can't
  tell", with why: still checking, not on the network, not accepted there yet, no longer shared, a network folder (changes made by
  other machines make no event here), a folder that can't be watched, or a watcher that missed changes.
- **A sync never relies on any of it.** Pressing Sync reads both disks. If that finds changes older than a
  few seconds that the watcher never reported, the watcher is not trusted on that folder until Tandem
  restarts, and the status says "can't tell" there.

Two computers can each leave different files out (Settings → Files left out). A file left out on either side
is neither copied nor deleted, so a file one side doesn't list never looks deleted.

## The rules that protect files

All in `src/store.ts`, covered by `tests/sync.test.ts`:

- **Nothing is overwritten or deleted.** The old file moves to `.tandem/old/<time>/<same path>` first, on
  the side where it was. Kept 90 days by default.
- **No half-written file.** A file arrives under a temporary name in `.tandem/tmp/`, is checked against its
  size and hash, flushed to the disk, then renamed into place.
- **Nothing is replaced under an author.** Every write and delete says what the comparison saw. If the
  file changed since (someone kept typing), it is skipped and reported.
- **An interrupted sync is truthful.** The base is updated file by file, saved after every deletion, every
  few copies, and at the end, each time only with what changed. The files reach the disk first (their
  folders are flushed), then the record says they landed. The next sync continues from what really
  happened.
- **A copy that went away is not written to.** Before each write the store checks that its folder is still
  there: a folder whose disk is gone during the review is reported, never made again where it was, and
  nothing is recorded as synced. Another computer's folder is named by a token for the run: requests planned
  against a folder changed since are refused.
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

- Copying many tiny files is bound by the disk: each file is flushed before it takes its place, about 60
  small files a second on this computer's SSD. Files are still copied one at a time.
- Watching is not proven on Windows and macOS. Network folders are recognized on Linux (from the mount
  table) and as `\\server\share` paths on Windows; a network drive mapped to a letter on Windows, or a
  network folder on macOS, is not recognized: it is followed like a local folder, and changes other machines
  make there are not shown until the next Sync.

- A rename is a deletion plus a new file: the content is copied again.
- With three or more copies a change travels one sync at a time, so the longer a copy goes unsynced the more
  conflicts it can meet.
- On FAT drives a file changed twice within two seconds, to the same size, can keep its remembered hash
  until its next change. As a source, the copy step refuses it (its hash no longer matches) and reports it.
  As a destination it is replaced, and kept as an old version.
- With three copies synced pair by pair, a file deleted through one pair and put back with the same content
  on a third computer can be deleted again by a later sync of another pair. The review shows it, and the
  file is kept as an old version.
- The pairing keys are stored in the app's own folder, readable by the user account only, not encrypted.
