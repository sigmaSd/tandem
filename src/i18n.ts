// The app's language. The English text lives in the code: here the core's and the shell's messages (errors,
// dialog titles, the right-click menu), in app/ui/i18n.ts the window's. Other languages are gettext
// catalogs, locales/app/<code>.po, that translators edit with Poedit or on Weblate; tools/i18n.ts keeps
// locales/app/tandem.pot and them up to date. Each entry's key is its msgctxt. Nothing here touches the disk:
// src/locales.ts loads the catalogs.

import { pluralRule, type Translations } from "./po.ts";

/** An English entry: a sentence with {names}, or a sentence per count ({n}). */
export type Source = string | { one: string; other: string };
type Vars = Record<string, unknown>;

/** The language to use: the setting, or with "auto" the computer's first preferred one we have. */
export function resolveLang(
  setting: string | undefined,
  systemLocales: readonly string[],
  available: string[],
) {
  if (setting && available.includes(setting)) return setting;
  for (const l of systemLocales) {
    const full = l.replace("_", "-");
    if (available.includes(full)) return full;
    const base = full.toLowerCase().split("-")[0];
    if (available.includes(base)) return base;
  }
  return "en";
}

/** Right-to-left languages among those Tandem could be translated to. */
export const isRtlLang = (lang: string) =>
  ["ar", "fa", "he", "ur", "ps", "ckb", "yi"].includes(lang.split("-")[0]);

/** A language's name in itself ("Français", "العربية"), for the language menu. */
export function nativeName(code: string): string {
  try {
    const n = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (n && n !== code) return n[0].toLocaleUpperCase(code) + n.slice(1);
  } catch {
    /* an unknown code: shown as it is */
  }
  return code;
}

/** French typography: a no-break space before : ; ? ! and inside « », so they never start a line. */
export function typography(lang: string, s: string): string {
  if (!lang.startsWith("fr")) return s;
  return s.replace(/ ([:;?!»])/g, " $1").replace(/« /g, "« ");
}

/** Fill {name} placeholders. */
export function fill(s: string, vars: Vars = {}): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Looks words up: the language's catalog, else the English source. A translation with < > or " in it is
 * ignored (it would be markup in the window: catalogs come from contributors); tests/i18n.test.ts keeps the
 * shipped ones clean.
 */
export class Translator {
  readonly lang: string;
  readonly #source: Record<string, Source>;
  readonly #strings: Record<string, string | string[]>;
  readonly #pick: (n: number) => number;

  constructor(lang: string, source: Record<string, Source>, tr: Translations | null) {
    this.lang = lang;
    this.#source = source;
    this.#strings = tr?.strings ?? {};
    this.#pick = pluralRule(tr?.plural).pick;
  }

  t(key: string, vars: Vars = {}): string {
    const src = this.#source[key];
    if (src === undefined) return key;
    const tr = this.#strings[key];
    let s: string | undefined;
    if (typeof src === "string") s = typeof tr === "string" ? tr : undefined;
    else if (Array.isArray(tr)) s = tr[this.#pick(Number(vars.n))];
    if (!s || /[<>"]/.test(s)) s = typeof src === "string" ? src : Number(vars.n) === 1 ? src.one : src.other;
    return typography(this.lang, fill(s, vars));
  }
}

/** The core's and the shell's messages, in English. */
export const CORE_SOURCE = {
  chooseFolderTitle: "Folder to keep in sync",
  errNoSuchFolder: "That folder is no longer kept in sync here.",
  errAlreadyFolder: "That folder is already kept in sync.",
  errNestedFolder: "That folder is inside {path}, or holds it, which is already synced. Choose another one.",
  errAlreadyShared: "This folder is already shared with that computer.",
  errWaiting: "{name} hasn't accepted this folder yet. Accept it in Tandem there first.",
  errUnshared: "{name} no longer shares this folder with this computer.",
  errFolder: "The folder {path} can't be opened: {error}",
  errInsideOwn: "That folder belongs to Tandem itself. Choose another one.",
  errBusy: "A sync is already running. Wait for it to end.",
  errStale: "{name} synced with this computer since the comparison. Compare again.",
  errUnreachable:
    "{name} did not answer. Check that it is on, on the same network, and that Tandem is open there.",
  errRefused: "{name} no longer recognizes this computer. Remove it here, then pair the two again.",
  errEmptiedHere: {
    one: "The folder on this computer is empty, and it held {n} file at the last sync. Tandem stops here rather than delete it on the other side. If the folder is on a disk, check that the disk is there.",
    other:
      "The folder on this computer is empty, and it held {n} files at the last sync. Tandem stops here rather than delete them on the other side. If the folder is on a disk, check that the disk is there.",
  },
  errEmptiedThere: {
    one: "The folder on {name} is empty, and it held {n} file at the last sync. Tandem stops here rather than delete it on this computer. If you emptied it on purpose, remove this copy in Settings and add it again.",
    other:
      "The folder on {name} is empty, and it held {n} files at the last sync. Tandem stops here rather than delete them on this computer. If you emptied it on purpose, remove this copy in Settings and add it again.",
  },
  errBadCode: "A code has 12 letters and digits, like K7QF-2M9X-TB4H.",
  errWrongCode: "That is not the code shown on the other computer.",
  errNotPairing: "The other computer is not showing a code. Choose “Show a code” there first.",
  errNoTandemAt: "No Tandem answered at {address}.",
  errVersion: "The other computer runs another version of Tandem. Update both.",
  errSelf: "That is this computer.",
  errGoneMeanwhile: "This file changed since the comparison. Compare again.",
  couldNotStart: "Tandem could not start: {error}",
  syncRunningTitle: "A sync is running",
  syncRunningDetail:
    "If you close now, the files already copied stay copied and the rest waits for the next sync.",
  closeAnyway: "Close",
  keepOpen: "Keep open",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select all",
} satisfies Record<string, Source>;

export type MessageKey = keyof typeof CORE_SOURCE;

let core = new Translator("en", CORE_SOURCE, null);
/** The core's language and catalog (src/locales.ts, Core.applyLanguage). */
export function setCoreLanguage(lang: string, tr: Translations | null) {
  core = new Translator(lang, CORE_SOURCE, tr);
}
export const currentLang = () => core.lang;

/** A core or shell message in the app's language. */
export const msg = (key: MessageKey, vars: Vars = {}) => core.t(key, vars);
