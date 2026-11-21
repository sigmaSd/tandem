// The window: one page that shows what Tandem's core says (src/core.ts state(), through src/server.ts) and
// sends it the user's choices. No state of its own beyond what is being typed and which screen is open: after
// each change notice it reads the state again and redraws.
//
// Screens, in the order a person meets them: choose the folder → add a copy (pair a computer, or a drive) →
// home (the copies) → comparing → review (what will change, conflicts first) → syncing → done. On top of
// those: side-by-side compare of one file, old versions, settings.

import "./desktop.ts";
import type { Choice } from "../../src/apply.ts";
import type { Core, Item, Job } from "../../src/core.ts";
import type { Row } from "../../src/diff.ts";
import { stampTime } from "../../src/names.ts";
import type { Translations } from "../../src/po.ts";
import type { OldVersion } from "../../src/store.ts";
import { bytes, type Key, ltr, num, setUiLang, t, when } from "./i18n.ts";

type State = ReturnType<Core["state"]>;
type Diff = Awaited<ReturnType<Core["diff"]>>;
type Kid = Node | string | null | undefined | false;

// ------------------------------------------------------------------ small helpers

/** Build an element: h("button", { class: "go", onclick }, "Sync"). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> | null,
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value") (el as unknown as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const ICONS = {
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  swap: '<path d="M7 8h13M16 4l4 4-4 4M17 16H4M8 12l-4 4 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  alert:
    '<path d="M12 9v4M12 17h.01M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  laptop: '<path d="M5 6h14v10H5zM3 19h18"/>',
  desktop: '<path d="M4 5h16v11H4zM8 20h8M12 16v4"/>',
  usb: '<path d="M12 4v13M9.5 6.5 12 4l2.5 2.5M7 10v2l5 3M17 9v3l-5 3"/><circle cx="12" cy="19" r="2"/>',
  history: '<path d="M12 7v5l3 2M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.9M4.5 4.5v4.4h4.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

/** One of our own drawings (never text from outside). */
function icon(name: keyof typeof ICONS, cls = "") {
  const span = h("span", { class: "icon-wrap" });
  span.innerHTML = `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstElementChild as SVGElement;
}

async function call<T>(name: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${name}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json", "x-tandem": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, bad = false) {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.className = bad ? "bad" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 7000 : 3500);
}

/** Ask the core for something; a refusal is shown, not thrown. */
async function act(name: string, body: unknown = {}): Promise<boolean> {
  try {
    await call(name, body);
    return true;
  } catch (e) {
    toast((e as Error).message, true);
    return false;
  }
}

// ------------------------------------------------------------------ what the window remembers

let state: State;
let items: Item[] = [];
let itemsRev = -1;
let view: "main" | "add" | "settings" | "old" | "compare" = "main";
/** What is being typed, kept across redraws. */
const form = {
  folder: "",
  via: "network" as "network" | "drive",
  mode: "enter" as "show" | "enter",
  code: "",
  peer: "",
  address: "",
  error: "",
  busy: false,
  name: "",
  ignore: "",
  keepDays: "",
  dirty: false,
  /** Settings: the copy being renamed, and the one whose removal is being confirmed. */
  renaming: "",
  newName: "",
  removing: "",
};
let compare: { path: string; data?: Diff; error?: string; unfolded: Set<number> } | null = null;
let old: OldVersion[] | null = null;
let stopping = false;
let copiesBefore = 0;
/** The review's sections the user opened or closed, by name. */
const sectionOpen = new Map<string, boolean>();
let lastDrawn = "";

const copyOf = (id: string) => state.copies.find((c) => c.id === id);
const nameOf = (id: string) => copyOf(id)?.name ?? "";

// ------------------------------------------------------------------ screens

function welcome(): Kid[] {
  const go = async () => {
    if (!form.folder.trim()) return;
    if (await act("folder", { path: form.folder })) form.folder = "";
  };
  return [
    h("h1", null, t("welcomeTitle")),
    h("p", { class: "lead" }, t("welcomeText")),
    h(
      "label",
      { class: "field" },
      h("span", null, t("folderLabel")),
      h(
        "div",
        { class: "row" },
        h("input", {
          id: "folder",
          type: "text",
          class: "grow",
          value: form.folder,
          placeholder: t("folderPlaceholder"),
          spellcheck: "false",
          oninput: (e: Event) => (form.folder = (e.target as HTMLInputElement).value),
          onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void go(),
        }),
        h(
          "button",
          {
            onclick: async () => {
              const r = await call<{ path: string | null }>("choose-folder", { kind: "folder" }).catch(
                () => null,
              );
              if (r?.path) {
                form.folder = r.path;
                draw(true);
              }
            },
          },
          t("browse"),
        ),
      ),
    ),
    h("div", { class: "row right gap" }, h("button", { class: "go", onclick: go }, t("continue"))),
    h("p", { class: "note gap" }, t("secondComputerNote")),
  ];
}

function addCopy(): Kid[] {
  const first = !state.copies.length;
  const option = (via: typeof form.via, title: Key, sub: Key, ic: keyof typeof ICONS) =>
    h(
      "button",
      {
        class: `option${form.via === via ? " on" : ""}`,
        onclick: () => {
          form.via = via;
          form.error = "";
          draw();
        },
      },
      h("b", null, icon(ic), " ", t(title)),
      h("span", null, t(sub)),
    );
  return [
    !first && backButton(),
    h("h1", null, first ? t("whereOther") : t("addCopy")),
    !first && h("p", { class: "lead" }, t("whereOther")),
    h(
      "div",
      { class: "options" },
      option("network", "viaNetwork", "viaNetworkSub", "desktop"),
      option("drive", "viaDrive", "viaDriveSub", "usb"),
    ),
    ...(form.via === "network" ? viaNetwork() : viaDrive()),
  ];
}

function viaNetwork(): Kid[] {
  const tab = (mode: typeof form.mode, label: Key) =>
    h(
      "button",
      {
        class: form.mode === mode ? "on" : "",
        onclick: () => {
          form.mode = mode;
          form.error = "";
          if (mode === "enter" && state.pairing) void act("pairing-stop");
          draw();
        },
      },
      t(label),
    );
  const tabs = h("div", { class: "tabs" }, tab("enter", "enterCode"), tab("show", "showCode"));
  if (form.mode === "show") {
    return [
      tabs,
      state.pairing
        ? h(
            "div",
            { class: "box gap" },
            h("p", { class: "code" }, state.pairing.code),
            h("p", { class: "sub" }, t("codeHelp")),
            state.addresses.length > 0 &&
              h(
                "p",
                { class: "sub gap selectable" },
                t("codeAddress", { address: state.addresses.join(", ") }),
              ),
            h(
              "div",
              { class: "row right gap" },
              h("button", { onclick: () => act("pairing-stop") }, t("cancel")),
            ),
          )
        : h(
            "div",
            { class: "gap" },
            h("button", { class: "go", onclick: () => act("pairing-start") }, t("showCodeButton")),
          ),
    ];
  }
  const showing = state.nearby.filter((n) => n.pairing);
  if (form.peer !== "manual" && !showing.some((n) => n.address === form.peer))
    form.peer = showing[0]?.address ?? "manual";
  const go = async () => {
    const address = form.peer === "manual" ? form.address : form.peer;
    if (!form.code.trim() || !address.trim() || form.busy) return;
    form.busy = true;
    form.error = "";
    draw();
    try {
      await call("pair", { address, code: form.code });
      form.code = "";
      form.address = "";
    } catch (e) {
      form.error = (e as Error).message;
    }
    form.busy = false;
    draw(true);
  };
  return [
    tabs,
    h(
      "label",
      { class: "field" },
      h("span", null, t("codeLabel")),
      h("input", {
        id: "code",
        type: "text",
        value: form.code,
        placeholder: "K7QF-2M9X-TB4H",
        spellcheck: "false",
        autocapitalize: "characters",
        style: "width: 15em; text-transform: uppercase",
        class: "mono",
        oninput: (e: Event) => (form.code = (e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void go(),
      }),
    ),
    h(
      "label",
      { class: "field" },
      h("span", null, t("computerLabel")),
      h(
        "select",
        {
          id: "peer",
          onchange: (e: Event) => {
            form.peer = (e.target as HTMLSelectElement).value;
            draw();
          },
        },
        ...showing.map((n) => h("option", { value: n.address, selected: n.address === form.peer }, n.name)),
        h("option", { value: "manual", selected: form.peer === "manual" }, t("typeAddress")),
      ),
    ),
    !showing.length && h("p", { class: "sub" }, t("noneShowingCode")),
    form.peer === "manual" &&
      h(
        "label",
        { class: "field" },
        h("span", null, t("addressLabel")),
        h("input", {
          id: "address",
          type: "text",
          value: form.address,
          placeholder: "192.168.1.20",
          spellcheck: "false",
          oninput: (e: Event) => (form.address = (e.target as HTMLInputElement).value),
          onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void go(),
        }),
      ),
    form.error && h("p", { class: "error" }, form.error),
    h(
      "div",
      { class: "row right gap" },
      h("button", { class: "go", onclick: go }, form.busy ? t("pairing") : t("pair")),
    ),
  ];
}

function viaDrive(): Kid[] {
  const add = (path: string, inside: boolean) => async () => {
    if (await act("add-drive", { path, inside })) view = "main";
    draw();
  };
  const rows: Kid[] = [];
  for (const d of state.drives) {
    const copies = d.copies;
    rows.push(
      h(
        "div",
        { class: "tile" },
        icon("usb", "big"),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "name" }, d.name),
          h("div", { class: "sub" }, t("driveFree", { size: bytes(d.free) })),
        ),
        !copies.length && h("button", { onclick: add(d.root, true) }, t("putCopyOn")),
      ),
    );
    for (const c of copies) {
      rows.push(
        h(
          "div",
          { class: "tile" },
          icon("folder", "big"),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "name" }, t("driveHolds", { name: c.name })),
            h("div", { class: "sub mono" }, ltr(c.path)),
          ),
          c.known
            ? h("span", { class: "sub" }, t("alreadyAdded"))
            : h("button", { class: "go", onclick: add(c.path, false) }, t("useThisCopy")),
        ),
      );
    }
  }
  return [
    h("h2", null, t("drivesFound")),
    rows.length ? h("div", { class: "card" }, ...rows) : h("p", { class: "sub" }, t("noDrives")),
    h(
      "div",
      { class: "row gap" },
      h(
        "button",
        {
          onclick: async () => {
            const r = await call<{ path: string | null }>("choose-folder", { kind: "drive" }).catch(
              () => null,
            );
            if (r?.path) await add(r.path, false)();
          },
        },
        t("chooseAnotherFolder"),
      ),
    ),
    h("p", { class: "note gap" }, t("driveNote")),
  ];
}

function home(): Kid[] {
  const folder = state.folder!;
  return [
    h(
      "div",
      { class: "card tile" },
      icon("laptop", "big"),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "name" }, folder.name),
        h("div", { class: "sub mono" }, ltr(folder.path)),
      ),
      h("button", { onclick: () => act("open-folder") }, t("openFolder")),
    ),
    state.guest && h("p", { class: "note" }, t("guestSyncing", { name: state.guest })),
    h("h2", null, t("copies")),
    h(
      "div",
      { class: "card" },
      ...state.copies.map((c) =>
        h(
          "div",
          { class: "tile" },
          icon(c.kind === "drive" ? "usb" : "desktop", "big"),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "name" }, c.name),
            h(
              "div",
              { class: `status${c.available ? " ok" : ""}` },
              h("span", { class: "dot" }),
              t(
                c.kind === "drive"
                  ? c.available
                    ? "pluggedIn"
                    : "notPluggedIn"
                  : c.available
                    ? "onNetwork"
                    : "notOnNetwork",
              ),
            ),
            h(
              "div",
              { class: "sub" },
              c.lastSync ? t("lastSynced", { when: when(c.lastSync) }) : t("neverSynced"),
            ),
          ),
          h(
            "button",
            { class: c.available ? "go" : "", onclick: () => act("compare", { id: c.id }) },
            t("sync"),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "row gap" },
      h(
        "button",
        {
          onclick: () => {
            view = "add";
            form.error = "";
            draw();
          },
        },
        icon("plus"),
        " ",
        t("addCopy"),
      ),
    ),
  ];
}

function scanning(job: Extract<Job, { phase: "scanning" }>): Kid[] {
  const name = nameOf(job.copyId);
  const [hd, ht] = job.here;
  const [td, tt] = job.there;
  return [
    h(
      "div",
      { class: "center" },
      h("h1", null, t("comparingWith", { name })),
      h("progress", ht + tt > 0 ? { max: ht + tt, value: hd + td } : {}),
      h("p", { class: "sub" }, t("readingHere", { done: num(hd), total: num(ht) })),
      h(
        "p",
        { class: "sub" },
        tt ? t("readingThere", { name, done: num(td), total: num(tt) }) : t("readingThereBlind", { name }),
      ),
      h("div", { class: "gap" }, h("button", { onclick: () => act("cancel") }, t("cancel"))),
    ),
  ];
}

const MAX_ROWS = 200;

function section(
  key: string,
  title: string,
  rows: Kid[],
  total: number,
  opts: { cls?: string; help?: Kid; open?: boolean } = {},
) {
  const open = sectionOpen.get(key) ?? opts.open ?? total <= 30;
  return h(
    "details",
    {
      class: `section ${opts.cls ?? ""}`,
      open,
      ontoggle: (e: Event) => sectionOpen.set(key, (e.target as HTMLDetailsElement).open),
    },
    h("summary", null, title),
    opts.help && h("div", { class: "section-help sub" }, opts.help),
    ...rows.slice(0, MAX_ROWS),
    total > MAX_ROWS && h("div", { class: "item sub" }, t("andMore", { n: total - MAX_ROWS })),
  );
}

const stamp = (m?: { size: number; mtime: number }) => (m ? `${when(m.mtime)}, ${bytes(m.size)}` : "");

function openCompare(path: string) {
  compare = { path, unfolded: new Set() };
  view = "compare";
  draw();
  call<Diff>("diff", { path }).then(
    (data) => {
      if (compare?.path === path) compare.data = data;
      draw();
    },
    (e: Error) => {
      if (compare?.path === path) compare.error = e.message;
      draw();
    },
  );
}

function choiceButtons(it: Item, name: string, small = true): HTMLElement {
  const b = (choice: Choice, label: string) =>
    h(
      "button",
      {
        class: `${small ? "small" : ""}${it.choice === choice ? " on" : ""}`,
        onclick: async () => {
          await act("choose", { path: it.path, choice: it.choice === choice ? null : choice });
        },
      },
      label,
    );
  if (it.gone) {
    // one side deleted it: keep the file (the side that still has it) or accept the deletion
    const has: Choice = it.gone === "a" ? "b" : "a";
    return h("div", { class: "choices" }, b(has, t("keepFile")), b(it.gone, t("deleteIt")));
  }
  return h(
    "div",
    { class: "choices" },
    b("a", t("keepMine")),
    b("b", t("keepTheirs", { name })),
    b("both", t("keepBoth")),
  );
}

function review(job: Extract<Job, { phase: "review" }>): Kid[] {
  const name = nameOf(job.copyId);
  const of = (kind: Item["kind"]) => items.filter((i) => i.kind === kind);
  const plain = (it: Item, ic: keyof typeof ICONS, cls: string, meta: string) =>
    h(
      "div",
      { class: "item" },
      icon(ic, cls),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "mono" }, ltr(it.path)),
        h("div", { class: "sub" }, meta),
      ),
      it.fresh !== undefined && h("span", { class: "chip" }, t(it.fresh ? "newFile" : "changedFile")),
      it.fresh === false &&
        it.text &&
        h("button", { class: "small", onclick: () => openCompare(it.path) }, t("compare")),
    );
  const conflicts = of("conflict");
  const all = (choice: Choice | null, label: string) =>
    h("button", { class: "small", onclick: () => act("choose", { path: null, choice }) }, label);
  const out: Kid[] = [
    h("h1", null, t("changesWith", { name })),
    job.first && h("p", { class: "note" }, t("firstSyncNote")),
  ];
  if (conflicts.length) {
    out.push(
      section(
        "conflict",
        t("conflictsTitle", { n: conflicts.length }),
        conflicts.map((it) =>
          h(
            "div",
            { class: "item" },
            icon("alert", "warn"),
            h(
              "div",
              { class: "grow" },
              h("div", { class: "mono" }, ltr(it.path)),
              h(
                "div",
                { class: "sub" },
                it.gone === "b"
                  ? t("editedHereDeletedThere", { here: stamp(it.here), name })
                  : it.gone === "a"
                    ? t("deletedHereEditedThere", { there: stamp(it.there), name })
                    : t("editedBoth", { here: stamp(it.here), there: stamp(it.there), name }),
              ),
              choiceButtons(it, name),
            ),
            h("button", { class: "small", onclick: () => openCompare(it.path) }, t("compare")),
          ),
        ),
        conflicts.length,
        {
          cls: "conflicts",
          open: true,
          help: h(
            "div",
            null,
            h("p", null, t("conflictsHelp")),
            conflicts.length > 1 &&
              h(
                "div",
                { class: "choices" },
                all("a", t("keepMineAll")),
                all("b", t("keepTheirsAll", { name })),
                all("both", t("keepBothAll")),
              ),
          ),
        },
      ),
    );
  }
  const send = of("send");
  const receive = of("receive");
  const rmHere = of("remove-here");
  const rmThere = of("remove-there");
  const clash = of("clash");
  const unread = of("unread");
  if (send.length)
    out.push(
      section(
        "send",
        t("toSend", { n: send.length, name }),
        send.map((it) => plain(it, "right", "send", stamp(it.here))),
        send.length,
      ),
    );
  if (receive.length)
    out.push(
      section(
        "receive",
        t("toReceive", { n: receive.length, name }),
        receive.map((it) => plain(it, "left", "receive", stamp(it.there))),
        receive.length,
      ),
    );
  if (rmHere.length)
    out.push(
      section(
        "rm-here",
        t("toRemoveHere", { n: rmHere.length, name }),
        rmHere.map((it) => plain(it, "trash", "", stamp(it.here))),
        rmHere.length,
        {
          help: t("removedKept"),
        },
      ),
    );
  if (rmThere.length)
    out.push(
      section(
        "rm-there",
        t("toRemoveThere", { n: rmThere.length, name }),
        rmThere.map((it) => plain(it, "trash", "", stamp(it.there))),
        rmThere.length,
        {
          help: t("removedKept"),
        },
      ),
    );
  if (clash.length)
    out.push(
      section(
        "clash",
        t("clashTitle", { n: clash.length }),
        clash.map((it) => plain(it, "alert", "warn", (it.with ?? []).join(", "))),
        clash.length,
        {
          help: t("clashHelp", {
            names: [...new Set(clash.flatMap((c) => c.with ?? []))].slice(0, 6).join(", "),
          }),
        },
      ),
    );
  if (unread.length)
    out.push(
      section(
        "unread",
        t("unreadTitle", { n: unread.length }),
        unread.map((it) => plain(it, "alert", "warn", "")),
        unread.length,
        {
          help: t("unreadHelp"),
          open: true,
        },
      ),
    );
  return out;
}

function reviewFooter(job: Extract<Job, { phase: "review" }>): Kid[] {
  const c = job.counts;
  const n = c.send + c.receive + c["remove-here"] + c["remove-there"] + c.conflict - job.open;
  return [
    h("span", { class: "sub grow" }, job.open ? t("openConflictsNote", { n: job.open }) : t("safeNote")),
    h("button", { onclick: () => act("close") }, t("cancel")),
    h(
      "button",
      { class: "go", onclick: () => n > 0 && act("start") },
      n > 0 ? t("syncFiles", { n }) : t("nothingToSync"),
    ),
  ];
}

function applying(job: Extract<Job, { phase: "applying" }>): Kid[] {
  const p = job.progress;
  return [
    h(
      "div",
      { class: "center" },
      h("h1", null, t("syncingWith", { name: nameOf(job.copyId) })),
      h(
        "progress",
        p.totalBytes > 0
          ? { max: p.totalBytes, value: p.bytes }
          : p.total
            ? { max: p.total, value: p.done }
            : {},
      ),
      h(
        "p",
        { class: "sub" },
        p.total ? t("fileProgress", { done: num(Math.min(p.done + 1, p.total)), total: num(p.total) }) : "",
      ),
      h("p", { class: "sub mono" }, ltr(p.path)),
      h(
        "div",
        { class: "gap" },
        stopping
          ? h("span", { class: "sub" }, t("stopping"))
          : h(
              "button",
              {
                onclick: () => {
                  stopping = true;
                  void act("cancel");
                  draw();
                },
              },
              t("stop"),
            ),
      ),
    ),
  ];
}

function done(job: Extract<Job, { phase: "done" }>): Kid[] {
  const s = job.summary;
  const copy = copyOf(job.copyId);
  const name = copy?.name ?? "";
  const lines: string[] = [];
  if (s.sent) lines.push(t("sentCount", { n: s.sent }));
  if (s.received) lines.push(t("receivedCount", { n: s.received }));
  if (s.removed) lines.push(t("removedCount", { n: s.removed }));
  if (s.bothKept) lines.push(t("bothKeptCount", { n: s.bothKept }));
  if (!lines.length && s.inSync) lines.push(t("nothingChanged"));
  if (s.kept) lines.push(t("keptCount", { n: s.kept }));
  const left: string[] = [];
  if (s.unanswered) left.push(t("unansweredCount", { n: s.unanswered }));
  if (s.lost === "there") left.push(t("lostThere", { name }));
  if (s.lost === "here") left.push(t("lostHere"));
  if (s.cancelled) left.push(t("stoppedEarly"));
  if (s.unsaved) left.push(t("unsavedNote", { name }));
  return [
    h(
      "div",
      { class: "center" },
      h("div", { class: `mark ${s.inSync ? "ok" : "warn"}` }, icon(s.inSync ? "check" : "alert")),
      h("h1", null, t(s.inSync ? "inSyncTitle" : "notInSyncTitle")),
      h(
        "div",
        { class: "list" },
        ...lines.map((l) => h("p", null, l)),
        ...left.map((l) => h("p", { class: "status", style: "color: var(--warn)" }, l)),
      ),
      s.problems.length > 0 &&
        h(
          "div",
          { class: "box problems" },
          ...s.problems.map((p) =>
            h(
              "p",
              null,
              h("span", { class: "mono" }, ltr(p.path)),
              " — ",
              p.result === "changed"
                ? t("problemChanged")
                : p.result === "clash"
                  ? t("problemClash")
                  : p.result === "unread"
                    ? t("problemUnread")
                    : (p.detail ?? ""),
            ),
          ),
        ),
      s.inSync && h("p", { class: "sub" }, t(copy?.kind === "drive" ? "ejectNote" : "closeBothNote")),
      h(
        "div",
        { class: "row gap wrap", style: "justify-content: center" },
        h("button", { class: "go", onclick: () => act("close") }, t("done")),
        !s.inSync && h("button", { onclick: () => act("compare", { id: job.copyId }) }, t("compareAgain")),
        h("button", { onclick: () => act("open-folder") }, t("openFolder")),
        s.kept > 0 && h("button", { onclick: openOld }, t("oldVersions")),
      ),
    ),
  ];
}

function failed(job: Extract<Job, { phase: "error" }>): Kid[] {
  return [
    h(
      "div",
      { class: "center" },
      h("div", { class: "mark warn" }, icon("alert")),
      h("h1", null, t("couldNotSync", { name: nameOf(job.copyId) })),
      h("p", { class: "lead" }, job.message),
      h(
        "div",
        { class: "row gap", style: "justify-content: center" },
        h("button", { onclick: () => act("close") }, t("back")),
        h("button", { class: "go", onclick: () => act("compare", { id: job.copyId }) }, t("tryAgain")),
      ),
    ),
  ];
}

function backButton() {
  return h(
    "div",
    { class: "row", style: "margin-bottom: 10px" },
    h(
      "button",
      {
        class: "ghost",
        onclick: () => {
          if (view === "add" && state.pairing) void act("pairing-stop");
          view = "main";
          compare = null;
          draw();
        },
      },
      icon("back"),
      " ",
      t("back"),
    ),
  );
}

/** Long runs of unchanged lines are folded, three kept around each change. */
function compareRows(rows: Row[], unfolded: Set<number>): Kid[] {
  const out: Kid[] = [];
  const line = (r: Row) =>
    h(
      "div",
      { class: "cmp-row" },
      h("div", { class: "n" }, r.ln ? String(r.ln) : ""),
      h("div", { class: r.kind === "same" ? "" : r.left === undefined ? "none" : "del" }, r.left ?? ""),
      h("div", { class: "n" }, r.rn ? String(r.rn) : ""),
      h("div", { class: r.kind === "same" ? "" : r.right === undefined ? "none" : "add" }, r.right ?? ""),
    );
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "same") {
      out.push(line(rows[i++]));
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "same") j++;
    const head = i === 0 ? 0 : 3;
    const tail = j === rows.length ? 0 : 3;
    if (j - i <= head + tail + 4 || unfolded.has(i)) {
      for (let k = i; k < j; k++) out.push(line(rows[k]));
    } else {
      const start = i;
      for (let k = i; k < i + head; k++) out.push(line(rows[k]));
      out.push(
        h(
          "button",
          {
            class: "cmp-fold",
            onclick: () => {
              unfolded.add(start);
              draw();
            },
          },
          t("unchangedLines", { n: j - i - head - tail }),
        ),
      );
      for (let k = j - tail; k < j; k++) out.push(line(rows[k]));
    }
    i = j;
  }
  return out;
}

function compareView(): Kid[] {
  const c = compare!;
  const it = items.find((i) => i.path === c.path);
  const name = state.job ? nameOf(state.job.copyId) : "";
  const d = c.data;
  const opens = h(
    "div",
    { class: "row gap wrap" },
    it?.here &&
      h("button", { onclick: () => act("open-version", { path: c.path, side: "a" }) }, t("openMine")),
    it?.there &&
      h(
        "button",
        { onclick: () => act("open-version", { path: c.path, side: "b" }) },
        t("openTheirs", { name }),
      ),
  );
  return [
    backButton(),
    h("h1", { class: "mono selectable" }, ltr(c.path)),
    c.error
      ? h("p", { class: "error" }, c.error)
      : !d
        ? h("p", { class: "sub" }, t("loading"))
        : d.kind !== "text"
          ? h(
              "div",
              null,
              h("p", { class: "lead" }, t(d.kind === "big" ? "tooBigToShow" : "cantShowText")),
              opens,
            )
          : h(
              "div",
              null,
              !d.paired && h("p", { class: "note warn" }, t("notPaired")),
              h(
                "div",
                { class: "cmp-head" },
                h(
                  "span",
                  null,
                  it?.here ? `${t("hereColumn")} · ${stamp(it.here)}` : t("onlyThere", { name }),
                ),
                h("span", null, it?.there ? `${name} · ${stamp(it.there)}` : t("onlyHere")),
              ),
              h("div", { class: "cmp" }, ...compareRows(d.rows, c.unfolded)),
              opens,
            ),
  ];
}

function compareFooter(): Kid[] {
  const it = items.find((i) => i.path === compare!.path);
  const name = state.job ? nameOf(state.job.copyId) : "";
  const close = () => {
    view = "main";
    compare = null;
    draw();
  };
  if (it?.kind !== "conflict")
    return [h("span", { class: "grow" }), h("button", { class: "go", onclick: close }, t("close"))];
  return [
    h("div", { class: "grow" }, choiceButtons(it, name, false)),
    h("button", { class: "go", onclick: close }, t("done")),
  ];
}

function openOld() {
  view = "old";
  old = null;
  draw();
  call<OldVersion[]>("old").then(
    (list) => {
      old = list;
      draw();
    },
    () => {
      old = [];
      draw();
    },
  );
}

function oldView(): Kid[] {
  const groups = new Map<string, OldVersion[]>();
  for (const o of old ?? []) groups.set(o.stamp, [...(groups.get(o.stamp) ?? []), o]);
  return [
    backButton(),
    h("h1", null, t("oldTitle")),
    h("p", { class: "lead" }, t("oldHelp", { n: state.settings.keepDays })),
    old === null && h("p", { class: "sub" }, t("loading")),
    old !== null && !old.length && h("p", { class: "box" }, t("oldEmpty")),
    ...[...groups].map(([stampName, list]) =>
      h(
        "div",
        { class: "group" },
        h("p", { class: "sub" }, when(stampTime(stampName))),
        h(
          "div",
          { class: "card" },
          ...list.map((o) =>
            h(
              "div",
              { class: "tile" },
              h(
                "div",
                { class: "grow" },
                h("div", { class: "mono" }, ltr(o.path)),
                h("div", { class: "sub" }, bytes(o.size)),
              ),
              h(
                "button",
                { class: "small", onclick: () => act("open-old", { stamp: o.stamp, path: o.path }) },
                t("open"),
              ),
              h(
                "button",
                {
                  class: "small",
                  onclick: async () => {
                    if (await act("restore", { stamp: o.stamp, path: o.path })) {
                      toast(t("putBackDone", { path: o.path }));
                      openOld();
                    }
                  },
                },
                t("putBack"),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
}

async function saveSettings() {
  if (await act("settings", { name: form.name, ignore: form.ignore, keepDays: Number(form.keepDays) })) {
    form.dirty = false;
    toast(t("saved"));
    draw();
  }
}

function openSettings() {
  view = "settings";
  form.name = state.device.name;
  form.ignore = state.settings.ignore;
  form.keepDays = String(state.settings.keepDays);
  form.dirty = false;
  form.renaming = "";
  form.removing = "";
  draw();
}

let languages: string[] = ["en"];

function settingsView(): Kid[] {
  const s = state.settings;
  const touch = () => {
    if (!form.dirty) {
      form.dirty = true;
      draw();
    }
  };
  const langName = (code: string) => {
    try {
      const n = new Intl.DisplayNames([code], { type: "language" }).of(code);
      return n ? n[0].toLocaleUpperCase(code) + n.slice(1) : code;
    } catch {
      return code;
    }
  };
  return [
    backButton(),
    h("h1", null, t("settingsTitle")),

    h(
      "label",
      { class: "field" },
      h("span", null, t("nameLabel")),
      h("input", {
        id: "name",
        type: "text",
        value: form.name,
        maxlength: "40",
        style: "width: 20em; max-width: 100%",
        oninput: (e: Event) => {
          form.name = (e.target as HTMLInputElement).value;
          touch();
        },
      }),
    ),
    h("p", { class: "sub" }, t("nameHelp")),
    state.addresses.length > 0 &&
      h("p", { class: "sub selectable" }, t("addressHelp", { address: state.addresses.join(", ") })),

    h("h2", null, t("folderSection")),
    h(
      "div",
      { class: "card tile" },
      h("div", { class: "grow mono selectable" }, ltr(state.folder?.path ?? "")),
      h(
        "button",
        {
          onclick: async () => {
            const r = await call<{ path: string | null }>("choose-folder", { kind: "folder" }).catch(
              () => null,
            );
            if (r?.path) await act("folder", { path: r.path });
          },
        },
        t("changeFolder"),
      ),
    ),
    h("p", { class: "sub", style: "margin-top: 6px" }, t("changeFolderNote")),

    h("h2", null, t("copiesSection")),
    state.copies.length
      ? h("div", { class: "card" }, ...state.copies.map((c) => copyRow(c)))
      : h("p", { class: "sub" }, t("noCopies")),

    h("h2", null, t("ignoreSection")),
    h("p", { class: "sub", style: "margin-bottom: 6px" }, t("ignoreHelp")),
    h("textarea", {
      id: "ignore",
      spellcheck: "false",
      value: form.ignore,
      oninput: (e: Event) => {
        form.ignore = (e.target as HTMLTextAreaElement).value;
        touch();
      },
    }),
    h(
      "div",
      { class: "row", style: "margin-top: 6px" },
      h(
        "button",
        {
          class: "small",
          onclick: () => {
            form.ignore = s.defaultIgnore;
            form.dirty = true;
            draw(true);
          },
        },
        t("ignoreReset"),
      ),
    ),

    h("h2", null, t("keepSection")),
    h(
      "label",
      { class: "row" },
      h("span", { class: "sub" }, t("keepLabel")),
      h("input", {
        id: "keep",
        type: "number",
        min: "1",
        max: "3650",
        value: form.keepDays,
        style: "width: 6em",
        oninput: (e: Event) => {
          form.keepDays = (e.target as HTMLInputElement).value;
          touch();
        },
      }),
    ),

    h("h2", null, t("lookSection")),
    h(
      "div",
      { class: "row wrap" },
      h("span", { class: "sub" }, t("themeLabel")),
      h(
        "select",
        {
          id: "theme",
          onchange: (e: Event) => act("settings", { theme: (e.target as HTMLSelectElement).value }),
        },
        ...(["auto", "light", "dark"] as const).map((v) =>
          h(
            "option",
            { value: v, selected: s.theme === v },
            t(v === "auto" ? "themeAuto" : v === "light" ? "themeLight" : "themeDark"),
          ),
        ),
      ),
      h("span", { class: "sub", style: "margin-inline-start: 14px" }, t("languageLabel")),
      h(
        "select",
        {
          id: "lang",
          onchange: async (e: Event) => {
            await act("settings", { lang: (e.target as HTMLSelectElement).value });
            await loadLanguage();
            draw(true);
          },
        },
        h("option", { value: "auto", selected: s.lang === "auto" }, t("languageAuto")),
        ...languages.map((code) => h("option", { value: code, selected: s.lang === code }, langName(code))),
      ),
    ),

    h("h2", null, t("aboutSection")),
    h("p", { class: "sub" }, t("aboutText", { v: state.version })),
  ];
}

/** A copy in the settings: its name and place, renamed in place, removed after a second click. */
function copyRow(c: State["copies"][number]) {
  const ic = icon(c.kind === "drive" ? "usb" : "desktop", "big");
  if (form.removing === c.id) {
    return h(
      "div",
      { class: "tile" },
      ic,
      h("div", { class: "grow sub" }, t("removeConfirm", { name: c.name })),
      h(
        "button",
        {
          class: "small",
          onclick: () => {
            form.removing = "";
            draw();
          },
        },
        t("cancel"),
      ),
      h(
        "button",
        {
          class: "small danger",
          onclick: async () => {
            form.removing = "";
            await act("copy-remove", { id: c.id });
            draw();
          },
        },
        t("remove"),
      ),
    );
  }
  if (form.renaming === c.id) {
    const done = async () => {
      form.renaming = "";
      if (form.newName.trim()) await act("copy-rename", { id: c.id, name: form.newName });
      draw();
    };
    return h(
      "div",
      { class: "tile" },
      ic,
      h("input", {
        id: "rename",
        type: "text",
        class: "grow",
        maxlength: "40",
        value: form.newName,
        oninput: (e: Event) => (form.newName = (e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void done(),
      }),
      h("button", { class: "small go", onclick: done }, t("save")),
    );
  }
  return h(
    "div",
    { class: "tile" },
    ic,
    h(
      "div",
      { class: "grow" },
      h("div", { class: "name" }, c.name),
      h("div", { class: "sub mono" }, ltr(c.where)),
    ),
    h(
      "button",
      {
        class: "small",
        onclick: () => {
          form.renaming = c.id;
          form.newName = c.name;
          form.removing = "";
          draw();
        },
      },
      t("rename"),
    ),
    h(
      "button",
      {
        class: "small danger",
        onclick: () => {
          form.removing = c.id;
          form.renaming = "";
          draw();
        },
      },
      t("remove"),
    ),
  );
}

function settingsFooter(): Kid[] {
  return [h("span", { class: "grow" }), h("button", { class: "go", onclick: saveSettings }, t("save"))];
}

// ------------------------------------------------------------------ drawing

function applyTheme() {
  const theme = state.settings.theme;
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Redraw the window from the state. Skipped when nothing it shows changed (`force`: redraw anyway). */
function draw(force = false) {
  if (!state) return;
  const job = state.job;
  if (job?.phase !== "applying") stopping = false;
  if (view === "compare" && (!compare || job?.phase !== "review")) {
    view = "main";
    compare = null;
  }
  // the copy asked for arrived (paired from here, or from the other computer while this one showed its code)
  if (state.copies.length > copiesBefore && view === "add") {
    view = "main";
    toast(t("paired", { name: state.copies.at(-1)!.name }));
  }
  copiesBefore = state.copies.length;

  const key = JSON.stringify([
    view,
    state,
    itemsRev,
    form,
    compare?.path,
    compare?.data ? 1 : 0,
    compare?.error,
    [...(compare?.unfolded ?? [])],
    old,
    stopping,
  ]);
  if (!force && key === lastDrawn) return;
  lastDrawn = key;
  applyTheme();

  let body: Kid[];
  let foot: Kid[] | null = null;
  let wide = false;
  if (view === "settings") {
    body = settingsView();
    if (form.dirty) foot = settingsFooter();
  } else if (view === "old") body = oldView();
  else if (!state.folder) body = welcome();
  else if (view === "add" || !state.copies.length) body = addCopy();
  else if (view === "compare") {
    body = compareView();
    foot = compareFooter();
    wide = true;
  } else if (!job) body = home();
  else if (job.phase === "scanning") body = scanning(job);
  else if (job.phase === "review") {
    body = review(job);
    foot = reviewFooter(job);
  } else if (job.phase === "applying") body = applying(job);
  else if (job.phase === "done") body = done(job);
  else body = failed(job);

  // what is being typed stays where it is across a redraw
  const main = document.getElementById("main")!;
  const active = document.activeElement as HTMLInputElement | null;
  const focus =
    active?.id && main.contains(active)
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;
  const scroll = main.scrollTop;
  main.classList.toggle("wide", wide);
  main.replaceChildren(...body.filter((k): k is Node | string => !!k));
  main.scrollTop = scroll;
  if (focus) {
    const el = document.getElementById(focus.id) as HTMLInputElement | null;
    el?.focus();
    try {
      if (focus.start !== null) el?.setSelectionRange(focus.start, focus.end);
    } catch {
      /* a field without a text selection (number, select) */
    }
  }
  const footer = document.getElementById("footer")!;
  footer.hidden = !foot;
  footer.classList.toggle("wide", wide);
  footer.replaceChildren(...(foot ?? []).filter((k): k is Node | string => !!k));

  document.getElementById("version")!.textContent = state.version;
  const tools = document.getElementById("tools")!;
  const tool = (ic: keyof typeof ICONS, label: Key, onclick: () => void) =>
    h("button", { class: "ghost icon", title: t(label), "aria-label": t(label), onclick }, icon(ic));
  tools.replaceChildren(
    ...(state.folder && state.copies.length
      ? [tool("history", "oldVersions", openOld), tool("gear", "settings", openSettings)]
      : []),
  );
  const banner = document.getElementById("banner")!;
  banner.hidden = !state.update;
  if (state.update)
    banner.replaceChildren(
      h("span", { class: "grow" }, t("updateReady", { v: state.update })),
      h("button", { class: "small", onclick: () => act("install-update") }, t("restartToUpdate")),
    );
}

async function refresh() {
  state = await call<State>("state");
  const job = state.job;
  if (job?.phase === "review") {
    if (job.rev !== itemsRev) {
      items = await call<Item[]>("items");
      itemsRev = job.rev;
    }
  } else if (itemsRev !== -1) {
    items = [];
    itemsRev = -1;
    sectionOpen.clear();
  }
  draw();
}

async function loadLanguage() {
  const l = await call<{ lang: string; catalog: Translations | null; available: string[] }>("i18n");
  setUiLang(l.lang, l.catalog);
  languages = l.available;
}

async function start() {
  await loadLanguage();
  let pending = false;
  let running = false;
  const pull = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await refresh();
    } catch {
      /* the app is closing, or a notice came mid-restart: the next one redraws */
    }
    running = false;
    if (pending) {
      pending = false;
      void pull();
    }
  };
  const events = new EventSource("/api/events");
  events.onmessage = () => void pull();
  events.onerror = () => {
    // the app was closed under a page left open in a browser
    if (events.readyState === EventSource.CLOSED) toast(t("appClosed"), true);
  };
  await pull();
}

void start();
