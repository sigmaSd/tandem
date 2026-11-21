import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { resolveLang, Translator, typography } from "../src/i18n.ts";
import { parsePo, pluralRule, translations, writePo } from "../src/po.ts";
import { APP_LOCALES, appTemplate, merge } from "../tools/i18n.ts";

const SHIPPED = ["fr"]; // complete in every release
const names = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

async function catalogs() {
  const files = (await readdir(APP_LOCALES)).filter((f) => f.endsWith(".po"));
  return Promise.all(
    files.map(async (f) => ({
      lang: f.slice(0, -3),
      cat: parsePo(await readFile(join(APP_LOCALES, f), "utf8")),
    })),
  );
}

const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout without .gitattributes

test("i18n: the template matches the English in the code (run node tools/i18n.ts)", async () => {
  expect(lf(await readFile(join(APP_LOCALES, "tandem.pot"), "utf8"))).toBe(writePo(appTemplate()));
});

test("i18n: every catalog is merged with the template", async () => {
  const pot = appTemplate();
  for (const { lang, cat } of await catalogs()) {
    expect(
      cat.entries.map((e) => e.ctx),
      `${lang}.po`,
    ).toEqual(pot.entries.map((e) => e.ctx));
    expect(writePo(merge(cat, pot, lang))).toBe(writePo(cat));
  }
});

test("i18n: French is complete; every catalog keeps each {name} and holds no markup", async () => {
  const all = await catalogs();
  expect(all.map((c) => c.lang)).toEqual(expect.arrayContaining(SHIPPED));
  for (const { lang, cat } of all) {
    const forms = pluralRule(cat.headers["Plural-Forms"]).count;
    for (const e of cat.entries) {
      const where = `${lang}.po ${e.ctx}`;
      if (SHIPPED.includes(lang)) {
        expect(e.fuzzy, where).toBe(false);
        expect(e.str.every(Boolean), where).toBe(true);
      }
      if (e.plural !== undefined) expect(e.str.length, where).toBe(forms);
      const english = new Set([...names(e.id), ...names(e.plural ?? "")]);
      for (const s of e.str.filter(Boolean)) {
        // a plural form may leave {n} out ("one file"); every other name must be there
        for (const n of english)
          if (n !== "n" || e.plural === undefined) expect(names(s), where).toContain(n);
        for (const n of names(s)) expect(english, where).toContain(n);
        expect(s, where).not.toMatch(/[<>"]/);
      }
    }
  }
});

test("i18n: plural forms are chosen by the catalog's own rule", () => {
  const ar = pluralRule(
    "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);",
  );
  expect([0, 1, 2, 5, 11, 100, 103].map(ar.pick)).toEqual([0, 1, 2, 3, 4, 5, 3]);
  expect(pluralRule("nplurals=2; plural=(n > 1);").pick(1)).toBe(0);
  expect(pluralRule("nplurals=2; plural=(n > 1);").pick(0)).toBe(0);
});

test("i18n: a translator falls back to English, picks plurals, ignores markup, spaces French", () => {
  const source = { hi: "Hello {name}", files: { one: "{n} file", other: "{n} files" }, bad: "Safe" };
  const tr = new Translator("fr", source, {
    plural: "nplurals=2; plural=(n > 1);",
    strings: { hi: "Bonjour {name} !", files: ["{n} fichier", "{n} fichiers"], bad: '<img src="x">' },
  });
  expect(tr.t("hi", { name: "Ada" })).toBe("Bonjour Ada\u00a0!");
  expect(tr.t("files", { n: 0 })).toBe("0 fichier");
  expect(tr.t("files", { n: 3 })).toBe("3 fichiers");
  expect(tr.t("bad")).toBe("Safe");
  expect(new Translator("de", source, null).t("files", { n: 1 })).toBe("1 file");
  expect(typography("fr", "« Oui » : non")).toBe("«\u00a0Oui\u00a0»\u00a0: non");
});

test("i18n: the app's language follows the setting, else the computer's", () => {
  const have = ["en", "fr"];
  expect(resolveLang("fr", ["en-US"], have)).toBe("fr");
  expect(resolveLang("auto", ["fr-FR", "en-US"], have)).toBe("fr");
  expect(resolveLang("auto", ["nl-NL"], have)).toBe("en");
  expect(resolveLang("de", ["fr-TN"], have)).toBe("fr"); // a language no longer there: the computer's
});

test("i18n: catalogs round-trip through the writer, multi-line text included", () => {
  const cat = {
    headers: { Language: "fr", "Plural-Forms": "nplurals=2; plural=(n > 1);" },
    entries: [
      {
        ctx: "a",
        id: 'Say "hi"\nthen go',
        str: ["Dis « salut »\npuis va"],
        fuzzy: false,
        comments: ["note"],
      },
      {
        ctx: "b",
        id: "{n} file",
        plural: "{n} files",
        str: ["{n} fichier", "{n} fichiers"],
        fuzzy: true,
        comments: [],
        previous: "old",
      },
      // backslashes (a path in a sentence) and a tab
      { ctx: "c", id: "In C:\\thesis\tand \\\\", str: ["Dans C:\\thesis"], fuzzy: false, comments: [] },
    ],
  };
  const back = parsePo(writePo(cat));
  expect(back.headers).toEqual(cat.headers);
  expect(back.entries).toEqual(cat.entries);
  expect(translations(back).strings).toEqual({ a: "Dis « salut »\npuis va", c: "Dans C:\\thesis" }); // fuzzy: left out
});
