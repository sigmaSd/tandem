# Translating Tandem

Tandem speaks English and French. Adding a language takes no programming: you translate sentences in a
`.po` file, the standard format of translation tools.

There is one file per language: `locales/app/<code>.po`, about 190 short sentences (buttons, messages,
settings). `<code>` is the language's code: `de` German, `es` Spanish, `ar` Arabic, `pt_BR` Brazilian
Portuguese…

## The easy way: Poedit

1. Install [Poedit](https://poedit.net) (free, Windows, macOS, Linux).
2. Take the template: [`locales/app/tandem.pot`](../locales/app/tandem.pot).
3. In Poedit: **Create new translation**, open the template, choose your language.
4. Translate. Poedit shows each English sentence and saves the `.po` file.
5. Send the file to the maintainer, who adds it to `locales/app/`.

To improve an existing language, open its `.po` file in Poedit instead of the template.

## What to keep as it is

- **Words in braces**, like `{n}`, `{name}` or `{path}`, are filled in by the app (a number, a computer's
  name, a file's path). Keep them, in the place your sentence needs them. The note above an entry says what
  it is when that isn't obvious.
- **Plurals**: some entries have a form per count ("1 file", "2 files"). Poedit shows one box per form your
  language has. A form may leave out `{n}` when the word says the number ("one file").
- **Names** stay as they are: Tandem, USB, LaTeX, Windows, macOS.
- No `<`, `>` or `"` in the sentences (use your language's quotation marks, like « » or „ “). A sentence
  with one of them is ignored and shown in English.

## Testing your translation

Put your file in `locales/app/` of a copy of the source, then `vp run dev`. In Settings → Language, your
language appears. Right-to-left languages (Arabic, Persian, Hebrew, Urdu) turn the window around by
themselves.

## For maintainers

The English is in the code: `src/i18n.ts` (the core's and the shell's messages) and `app/ui/i18n.ts` (the
window's words, with notes for translators). The key is each entry's `msgctxt`, so changing the English
keeps the translation, marked fuzzy (shown in English until a translator confirms it).

- `node tools/i18n.ts` writes the template from the English and merges it into every `.po`.
- `node tools/i18n.ts --new nl` starts a language.
- `vp test` fails when the template is out of date, or when French misses an entry or a `{name}`.

The project can also be connected to [Weblate](https://hosted.weblate.org) (free for free software), so
translators work in the browser: file format "gettext PO", file mask `locales/app/*.po`, template
`locales/app/tandem.pot`.
