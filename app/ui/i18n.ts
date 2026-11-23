// The window's words. The English is here (the source tools/i18n.ts puts in locales/app/tandem.pot); the
// other languages come from the catalogs (locales/app/<code>.po) through /api/i18n. Also numbers, sizes and
// dates in the window's language. Translations are plain text: markup is added in main.ts, around them.

import { isRtlLang, type Source, Translator } from "../../src/i18n.ts";
import type { Translations } from "../../src/po.ts";

export const UI_SOURCE = {
  // the top bar
  oldVersions: "Old versions",
  settings: "Settings",
  back: "Back",
  close: "Close",
  cancel: "Cancel",
  restartToUpdate: "Restart to update",
  updateReady: "Tandem {v} is downloaded.",
  updateOut: "Tandem {v} is out.",
  downloadUpdate: "Download",
  appClosed: "Tandem was closed. Open it again.",

  // first start
  welcomeTitle: "Choose the folder to keep in sync",
  welcomeText:
    "Tandem keeps it the same on your other computers, over your own network. Nothing goes to the internet.",
  folderLabel: "Folder on this computer",
  folderPlaceholder: "Documents/Project",
  browse: "Browse…",
  continue: "Continue",
  secondComputerNote:
    "Setting up a second computer? Choose where the folder should be on this one. An empty folder is fine: the files arrive at the first sync.",

  // adding a copy
  addCopy: "Add a copy",
  whereOther: "Pair with your other computer",
  viaNetworkSub: "Both computers on at the same time, Tandem open on both",
  showCode: "Show a code here",
  enterCode: "Enter the other computer's code",
  showCodeButton: "Show a code",
  codeHelp:
    "In Tandem on the other computer, choose Add a copy, Another computer, Enter the other computer's code, and type this code. It works for 10 minutes, once.",
  codeAddress: "If the other computer doesn't find this one, give it this address: {address}",
  qrHelp: "On a phone, choose Scan the code instead of typing it.",
  scanCode: "Scan the code",
  scanHelp: "Point the camera at the code on the other computer's screen.",
  scanNotTandem: "That isn't a Tandem code.",
  scanNoCamera: "The camera can't be used: {error}",
  codeLabel: "Code shown on the other computer",
  computerLabel: "Computer",
  noneShowingCode: "No computer is showing a code on this network yet.",
  typeAddress: "Type its address…",
  addressLabel: "Address shown on the other computer",
  pair: "Pair",
  pairing: "Pairing…",
  paired: "Paired with {name}.",
  pairedComputers: "Computers paired already",
  shareWith: "Share",
  offeredToast: "“{folder}” is offered to {name}. It syncs once accepted there.",
  orNewComputer: "Or pair another computer",
  addCopyOf: "Add a copy of “{name}”",

  // more folders, and folders other computers share
  addFolder: "Add a folder",
  addFolderText:
    "Choose another folder to keep in sync. Each folder has its own copies: share it with the computers you want.",
  offerText: "{device} shares “{name}”",
  offerSub: "Choose where it goes on this computer, and the two are kept in sync.",
  offerChoose: "Choose a folder…",
  offerDecline: "Not on this computer",
  acceptTitle: "Where should “{name}” be on this computer?",
  acceptHelp:
    "A new folder, or one of the folders already synced here. At the first sync with {device}, a file on one side only is copied to the other. Nothing is deleted.",
  acceptNew: "A new folder",
  acceptExisting: "Or one of this computer's folders",
  useThisFolder: "Use this folder",
  acceptedToast: "“{name}” is now shared with {device}.",

  // home
  thisComputer: "This computer",
  openFolder: "Open folder",
  copies: "Copies",
  sync: "Sync",
  lastSynced: "Last synced {when}",
  neverSynced: "Never synced",
  guestSyncing: "{name} is syncing with this computer…",
  statusChecking: "Checking…",
  stInSync: "In sync",
  stSame: "Same files on both sides",
  stSend: { one: "{n} to send", other: "{n} to send" },
  stReceive: { one: "{n} to receive", other: "{n} to receive" },
  stConflict: { one: "{n} conflict", other: "{n} conflicts" },
  stOther: { one: "{n} left alone", other: "{n} left alone" },
  stChangedHere: { one: "{n} file changed here", other: "{n} files changed here" },
  stChangedThere: { one: "{n} file changed on {name}", other: "{n} files changed on {name}" },
  stNothingHere: "Nothing changed here",
  stNothingThere: "Nothing changed on {name}",
  stHereUnknown: "This computer: can't tell ({why})",
  stThereUnknown: "{name}: can't tell ({why})",
  whyStarting: "still checking",
  whyOff: "not on the network",
  whyNetwork: "a network folder, changes made elsewhere aren't seen",
  whyFailed: "this folder can't be watched",
  whyMissed: "changes were missed, Sync checks again",
  whyRefused: "it doesn't know this computer any more",
  whyUnshared: "it no longer shares this folder",
  whyWaiting: "it hasn't accepted this folder yet",
  stWaiting: "Waiting for {name} to accept this folder",
  notShared: "Not shared with another computer yet.",
  folderSettings: "Folder settings",
  whyVersion: "it runs another version of Tandem",
  todayAt: "today at {time}",
  yesterdayAt: "yesterday at {time}",

  // comparing
  comparingWith: "Comparing with {name}…",
  readingHere: "This computer: {done} of {total} files",
  readingThere: "{name}: {done} of {total} files",
  readingThereBlind: "{name}: reading its files…",

  // review
  changesWith: "Changes with {name}",
  firstSyncNote:
    "First sync with this copy: a file that exists on one side only is copied to the other. Nothing is deleted.",
  conflictsTitle: { one: "{n} file changed on both sides", other: "{n} files changed on both sides" },
  conflictsHelp: "Choose which version to keep. The other one is saved in the old versions.",
  keepMineAll: "Keep this computer's for all",
  keepTheirsAll: "Keep {name}'s for all",
  keepBothAll: "Keep both for all",
  keepMine: "This computer's",
  keepTheirs: "{name}'s",
  keepBoth: "Both",
  keepFile: "Keep the file",
  deleteIt: "Delete it",
  compare: "Compare",
  editedBoth: "Here: {here}. {name}: {there}.",
  editedHereDeletedThere: "Edited here ({here}), deleted on {name}.",
  deletedHereEditedThere: "Deleted here, edited on {name} ({there}).",
  toSend: { one: "{n} file to send to {name}", other: "{n} files to send to {name}" },
  toReceive: { one: "{n} file to receive from {name}", other: "{n} files to receive from {name}" },
  toRemoveHere: {
    one: "{n} file deleted on {name}: removed here too",
    other: "{n} files deleted on {name}: removed here too",
  },
  toRemoveThere: {
    one: "{n} file deleted here: removed on {name} too",
    other: "{n} files deleted here: removed on {name} too",
  },
  removedKept: "Each one is kept in the old versions.",
  clashTitle: { one: "{n} file left alone", other: "{n} files left alone" },
  unreadTitle: { one: "{n} file could not be read", other: "{n} files could not be read" },
  unreadHelp:
    "They are open in a program that locks them, or their folder can't be opened. They are left alone on both sides: close the program and compare again.",
  newFile: "new",
  changedFile: "changed",
  andMore: { one: "and {n} more", other: "and {n} more" },
  showMore: "Show more",
  topLevel: "Files at the top",
  clashHelpShort:
    "Their names differ only by capital letters from another file or folder. Windows and macOS can't hold both: rename one.",
  openConflictsNote: {
    one: "{n} conflict waits for your choice: it is skipped for now.",
    other: "{n} conflicts wait for your choice: they are skipped for now.",
  },
  safeNote: "Nothing is overwritten or deleted without a copy kept in the old versions.",
  syncFiles: { one: "Sync {n} file", other: "Sync {n} files" },
  nothingToSync: "Nothing to sync yet",

  // side by side
  compareTitle: "{path}",
  hereColumn: "This computer",
  unchangedLines: { one: "{n} unchanged line", other: "{n} unchanged lines" },
  notPaired: "The two versions have almost nothing in common: they are shown one after the other.",
  cantShowText: "This file can't be shown line by line.",
  tooBigToShow: "This file is too large to show line by line.",
  openMine: "Open this computer's version",
  openTheirs: "Open {name}'s version",
  onlyHere: "Only on this computer",
  onlyThere: "Only on {name}",
  loading: "Loading…",

  // syncing
  syncingWith: "Syncing with {name}…",
  fileProgress: "{done} of {total}",
  stop: "Stop",
  stopping: "Stopping after this file…",

  // done
  inSyncTitle: "Both copies match",
  notInSyncTitle: "Synced, with some things left",
  nothingChanged: "Nothing had changed since the last sync.",
  sentCount: { one: "{n} file sent", other: "{n} files sent" },
  receivedCount: { one: "{n} file received", other: "{n} files received" },
  removedCount: { one: "{n} file deleted", other: "{n} files deleted" },
  bothKeptCount: { one: "{n} file kept in both versions", other: "{n} files kept in both versions" },
  unansweredCount: { one: "{n} conflict waits for your choice", other: "{n} conflicts wait for your choice" },
  keptCount: {
    one: "{n} replaced file is kept in the old versions",
    other: "{n} replaced files are kept in the old versions",
  },
  problemChanged: "changed during the sync: left alone",
  problemClash: "name differs only by capital letters: left alone",
  problemUnread: "could not be read: left alone",
  stoppedEarly: "Stopped before the end. The files already copied stay copied.",
  unsavedNote:
    "The files are synced, but the record of it could not be saved on {name}. The next sync may ask about files that did not change.",
  lostThere: "{name} could not be reached any more. The files already copied stay copied.",
  lostHere: "The folder on this computer could not be reached any more.",
  closeBothNote: "You can now close Tandem on both computers.",
  done: "Done",
  compareAgain: "Compare again",
  tryAgain: "Try again",
  couldNotSync: "Could not sync with {name}",

  // old versions
  oldTitleOf: "Old versions of “{name}”",
  oldHelp: {
    one: "Files replaced or deleted by a sync on this computer are kept here for {n} day.",
    other: "Files replaced or deleted by a sync on this computer are kept here for {n} days.",
  },
  oldEmpty: "Nothing yet. When a sync replaces or deletes a file, the old one comes here.",
  open: "Open",
  putBack: "Put back",
  putBackDone: "{path} is back in the folder.",

  // settings
  settingsTitle: "Settings",
  nameLabel: "This computer's name",
  nameHelp: "The name the other computers show for this one.",
  addressHelp: "Its address on this network: {address}",
  folderSection: "Place on this computer",
  changeFolder: "Change…",
  changeFolderNote: "With another folder, the next sync with each copy starts like a first sync.",
  copiesSection: "Copies",
  noCopies: "No copy yet.",
  remove: "Remove",
  removeConfirm: "Remove {name}? Its files are not touched; it only stops being synced with this folder.",
  computersSection: "Paired computers",
  noComputers: "No computer paired yet.",
  sharesFolders: "Shares {names}",
  sharesNothing: "Shares no folder yet",
  forget: "Forget",
  forgetConfirm: "Forget {name}? It can no longer reach any folder here. To share again, pair the two again.",
  removeFolder: "Stop syncing this folder",
  removeFolderHelp: "Its files stay where they are. Its copies are forgotten on this computer.",
  removeFolderButton: "Stop syncing…",
  removeFolderConfirm: "Stop syncing “{name}”? Its files stay where they are; its copies are forgotten here.",
  ignoreSection: "Files left out",
  ignoreHelp:
    "One pattern per line. Files that programs rebuild or lock are not worth syncing and cause most conflicts.",
  ignoreReset: "Back to the usual list",
  keepSection: "Old versions",
  keepLabel: "Keep them for (days)",
  lookSection: "Appearance",
  themeLabel: "Theme",
  themeAuto: "Like the system",
  themeLight: "Light",
  themeDark: "Dark",
  languageLabel: "Language",
  languageAuto: "Like the system",
  aboutSection: "About",
  aboutText:
    "Tandem {v}. Your files travel only between your own computers, encrypted on the network. Nothing is sent to the internet.",
  save: "Save",
  saved: "Saved",
} satisfies Record<string, Source>;

/** Notes for translators (the "#." lines of the catalogs). */
export const UI_NOTES: Partial<Record<keyof typeof UI_SOURCE, string>> = {
  stHereUnknown:
    "A copy's status when this computer's side can't be known; {why} is one of the why… sentences",
  stThereUnknown:
    "A copy's status when the other side can't be known; {name} is that computer, {why} one of the why… sentences",
  stSend: "Status of a copy: how many files a sync would send there",
  stOther: "Status of a copy: files a sync would leave alone (unreadable, or names clashing)",
  keepTheirs: "A button: keep the version of the other copy, {name} is that computer's name",
  keepMine: "A button: keep the version of this computer",
  keepBoth: "A button: keep both versions of the file",
  newFile: "A small label on a file that does not exist on the other side yet",
  changedFile: "A small label on a file that exists on both sides with different content",
  sync: "A button: compare with this copy, then sync",
  compare: "A button: show the two versions of a file side by side",
  putBack: "A button: put an old version back in the folder",
  compareTitle: "The title of the side-by-side view: only the file's path",
  offerText: "{device} is another computer, {name} the name of a folder on it",
  shareWith: "A button: offer this folder to a computer paired already",
  offerDecline: "A button: answer no to a folder another computer offers to share",
};

export type Key = keyof typeof UI_SOURCE;

let tr = new Translator("en", UI_SOURCE, null);
export const uiLang = () => tr.lang;

/** A sentence in the window's language. */
export const t = (key: Key, vars: Record<string, unknown> = {}) => tr.t(key, vars);

export const num = (n: number) => new Intl.NumberFormat(tr.lang).format(n);

/** A size as people read it: 12 KB, 3.4 MB. */
export function bytes(n: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return new Intl.NumberFormat(tr.lang, {
    style: "unit",
    unit: units[i],
    unitDisplay: i === 0 ? "long" : "short",
    maximumFractionDigits: v < 10 && i > 0 ? 1 : 0,
  }).format(v);
}

/** A moment as people say it: "today at 14:10", "yesterday at 21:30", else the date and time. */
export function when(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = new Intl.DateTimeFormat(tr.lang, { timeStyle: "short" }).format(d);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(d)) / 86_400_000);
  if (days === 0) return t("todayAt", { time });
  if (days === 1) return t("yesterdayAt", { time });
  return new Intl.DateTimeFormat(tr.lang, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** Left-to-right text (a path) inside right-to-left text: isolated, so it keeps its own order. */
export const ltr = (s: string) => `⁦${s}⁩`;

/** Switch the window's language: its catalog and <html lang dir>. */
export function setUiLang(lang: string, catalog: Translations | null) {
  tr = new Translator(lang, UI_SOURCE, catalog);
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtlLang(lang) ? "rtl" : "ltr";
}
