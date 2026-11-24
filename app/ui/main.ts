// The window: one page that shows what Tandem's core says (src/core.ts state(), through src/server.ts) and
// sends it the user's choices. No state of its own beyond what is being typed and which screen is open: after
// each change notice it reads the state again and redraws.
//
// Screens, in the order a person meets them: choose a folder → add a copy (pair a computer, or share with one) →
// home (each folder and its copies, and folders other computers offer) → comparing → review (what will
// change, conflicts first) → syncing → done. On top of those: side-by-side compare of one file, old versions,
// another folder, accepting an offered folder, a folder's settings, settings.

import "./desktop.ts";
import type { Choice } from "../../src/apply.ts";
import type { Core, Item, ItemKind, Job } from "../../src/core.ts";
import type { CopyStatus, Why } from "../../src/status.ts";
import type { Row } from "../../src/diff.ts";
import { stampTime } from "../../src/names.ts";
import type { Translations } from "../../src/po.ts";
import type { OldVersion } from "../../src/store.ts";
import { bytes, type Key, ltr, num, setUiLang, t, when } from "./i18n.ts";
import { pairLink, parsePairLink } from "../../src/pairlink.ts";
import { qrCode, scanQr } from "./qr.ts";

type State = ReturnType<Core["state"]>;
type FolderView = State["folders"][number];
type CopyView = FolderView["copies"][number];
type OfferView = State["offers"][number];
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
  history: '<path d="M12 7v5l3 2M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.9M4.5 4.5v4.4h4.4"/>',
  // a cog with eight teeth (rays around a circle read as the sun: the light theme)
  gear: '<circle cx="12" cy="12" r="3"/><path d="M10.3 5L10.7 2.6A9.5 9.5 0 0 1 13.3 2.6L13.7 5A7.2 7.2 0 0 1 15.7 5.8L17.7 4.4A9.5 9.5 0 0 1 19.6 6.3L18.2 8.3A7.2 7.2 0 0 1 19 10.3L21.4 10.7A9.5 9.5 0 0 1 21.4 13.3L19 13.7A7.2 7.2 0 0 1 18.2 15.7L19.6 17.7A9.5 9.5 0 0 1 17.7 19.6L15.7 18.2A7.2 7.2 0 0 1 13.7 19L13.3 21.4A9.5 9.5 0 0 1 10.7 21.4L10.3 19A7.2 7.2 0 0 1 8.3 18.2L6.3 19.6A9.5 9.5 0 0 1 4.4 17.7L5.8 15.7A7.2 7.2 0 0 1 5 13.7L2.6 13.3A9.5 9.5 0 0 1 2.6 10.7L5 10.3A7.2 7.2 0 0 1 5.8 8.3L4.4 6.3A9.5 9.5 0 0 1 6.3 4.4L8.3 5.8A7.2 7.2 0 0 1 10.3 5Z"/>',
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
/** The review's lines as loaded so far, by kind: all of them, or (for many) by top folder, page by page. */
interface Lines {
  total: number;
  items: Item[];
  limit: number;
}
interface Loaded extends Lines {
  /** Set for a long list of files to copy or delete: its top folders, each opened on demand. */
  groups?: { folder: string; count: number }[];
  folders: Map<string, Lines>;
}
let sections: Partial<Record<ItemKind, Loaded>> = {};
let reviewRev = -1;
/** Up to this many lines a kind is shown whole; past it, by folder (conflicts: page by page). */
const WHOLE = 300;
const PAGE = 200;
let view: "main" | "add" | "settings" | "old" | "compare" | "newFolder" | "accept" | "folder" = "main";
/** The folder the add, old versions and folder settings screens are about. */
let current = "";
/** The offer being accepted. */
let accepting: OfferView | null = null;
/** What is being typed, kept across redraws. */
const form = {
  folder: "",
  acceptPath: "",
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
  /** Settings: the copy, folder or computer whose removal is being confirmed. */
  removing: "",
};
let compare: { path: string; item: Item; data?: Diff; error?: string; unfolded: Set<number> } | null = null;
let old: OldVersion[] | null = null;
let stopping = false;
/** How many copies the folder on screen had at the last redraw. */
let copiesBefore = { folder: "", n: 0 };
/** The review's sections the user opened or closed, by name. */
const sectionOpen = new Map<string, boolean>();
let lastDrawn = "";

const folderOf = (id: string) => state.folders.find((f) => f.id === id);
const folderOfCopy = (id: string) => state.folders.find((f) => f.copies.some((c) => c.id === id));
const copyOf = (id: string) => folderOfCopy(id)?.copies.find((c) => c.id === id);
const nameOf = (id: string) => copyOf(id)?.name ?? "";

/** Ask the system for a folder, into a field of the form. */
async function browse(field: "folder" | "acceptPath") {
  const r = await call<{ path: string | null }>("choose-folder", { kind: "folder" }).catch(() => null);
  if (r?.path) {
    form[field] = r.path;
    draw(true);
  }
}

/** A folder path field with its Browse button. */
function folderField(id: string, field: "folder" | "acceptPath", go: () => unknown, label: Key) {
  return h(
    "label",
    { class: "field" },
    h("span", null, t(label)),
    h(
      "div",
      { class: "row" },
      h("input", {
        id,
        type: "text",
        class: "grow",
        value: form[field],
        placeholder: t("folderPlaceholder"),
        spellcheck: "false",
        oninput: (e: Event) => (form[field] = (e.target as HTMLInputElement).value),
        onkeydown: (e: KeyboardEvent) => e.key === "Enter" && void go(),
      }),
      h("button", { onclick: () => void browse(field) }, t("browse")),
    ),
  );
}

// ------------------------------------------------------------------ screens

/** The first screen, or (`again`) another folder to keep in sync: then a copy of it is added. */
function welcome(again = false): Kid[] {
  const go = async () => {
    if (!form.folder.trim()) return;
    try {
      const r = await call<{ id: string }>("folder-add", { path: form.folder });
      form.folder = "";
      form.error = "";
      current = r.id;
      view = "add";
      await refresh(); // the new folder in the state before its screen is drawn
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return [
    again && backButton(),
    h("h1", null, t(again ? "addFolder" : "welcomeTitle")),
    h("p", { class: "lead" }, t(again ? "addFolderText" : "welcomeText")),
    folderField("folder", "folder", go, "folderLabel"),
    h("div", { class: "row right gap" }, h("button", { class: "go", onclick: go }, t("continue"))),
    !again && offersCard(),
    !again && h("p", { class: "note gap" }, t("secondComputerNote")),
  ];
}

/** Folders other computers offer to share with this one. */
function offersCard(): Kid {
  if (!state.offers.length) return null;
  return h(
    "div",
    { class: "card offers" },
    ...state.offers.map((o) =>
      h(
        "div",
        { class: "tile" },
        icon("desktop", "big"),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "name" }, t("offerText", { device: o.device, name: o.name })),
          h("div", { class: "sub" }, t("offerSub")),
        ),
        h(
          "button",
          {
            class: "go",
            onclick: () => {
              accepting = o;
              form.acceptPath = "";
              view = "accept";
              draw();
            },
          },
          t("offerChoose"),
        ),
        h(
          "button",
          { onclick: () => act("offer-decline", { device: o.deviceId, folder: o.folder }) },
          t("offerDecline"),
        ),
      ),
    ),
  );
}

/** Where an offered folder goes on this computer: a new folder, or one of its folders. */
function acceptView(o: OfferView): Kid[] {
  const send = async (body: Record<string, unknown>) => {
    try {
      await call("offer-accept", { device: o.deviceId, folder: o.folder, ...body });
      accepting = null;
      form.acceptPath = "";
      view = "main";
      toast(t("acceptedToast", { name: o.name, device: o.device }));
      await refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const fresh = () => form.acceptPath.trim() && send({ path: form.acceptPath });
  // a folder already linked to another folder of that computer can't take this one too
  const usable = state.folders.filter((f) => !f.copies.some((c) => c.deviceId === o.deviceId && !c.waiting));
  return [
    backButton(),
    h("h1", null, t("acceptTitle", { name: o.name })),
    h("p", { class: "lead" }, t("acceptHelp", { device: o.device })),
    h("h2", null, t("acceptNew")),
    folderField("accept-path", "acceptPath", fresh, "folderLabel"),
    h("div", { class: "row right gap" }, h("button", { class: "go", onclick: fresh }, t("continue"))),
    usable.length > 0 && h("h2", null, t("acceptExisting")),
    usable.length > 0 &&
      h(
        "div",
        { class: "card" },
        ...usable.map((f) =>
          h(
            "div",
            { class: "tile" },
            icon("laptop", "big"),
            h(
              "div",
              { class: "grow" },
              h("div", { class: "name" }, f.name),
              h("div", { class: "sub mono" }, ltr(f.path)),
            ),
            h("button", { onclick: () => send({ into: f.id }) }, t("useThisFolder")),
          ),
        ),
      ),
  ];
}

function addCopy(f: FolderView): Kid[] {
  const first = state.folders.length === 1 && !f.copies.length;
  return [
    !first && backButton(),
    h("h1", null, first ? t("whereOther") : t("addCopyOf", { name: f.name })),
    h("p", { class: "lead" }, t("viaNetworkSub")),
    ...viaNetwork(f),
  ];
}

function viaNetwork(f: FolderView): Kid[] {
  // computers paired already: shared with in one click, no code
  const others = state.devices.filter((d) => !f.copies.some((c) => c.deviceId === d.id));
  const known: Kid[] = others.length
    ? [
        h("h2", null, t("pairedComputers")),
        h(
          "div",
          { class: "card" },
          ...others.map((d) =>
            h(
              "div",
              { class: "tile" },
              icon("desktop", "big"),
              h("div", { class: "grow" }, h("div", { class: "name" }, d.name)),
              h(
                "button",
                {
                  class: "go",
                  onclick: async () => {
                    if (!(await act("share", { folder: f.id, device: d.id }))) return;
                    view = "main";
                    toast(t("offeredToast", { name: d.name, folder: f.name }));
                    draw();
                  },
                },
                t("shareWith"),
              ),
            ),
          ),
        ),
        h("h2", null, t("orNewComputer")),
      ]
    : [];
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
      ...known,
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
            state.addresses.length > 0 && pairingQr(pairLink(state.pairing.code, state.addresses)),
            state.addresses.length > 0 && h("p", { class: "sub" }, t("qrHelp")),
            h(
              "div",
              { class: "row right gap" },
              h("button", { onclick: () => act("pairing-stop") }, t("cancel")),
            ),
          )
        : h(
            "div",
            { class: "gap" },
            h(
              "button",
              { class: "go", onclick: () => act("pairing-start", { folder: f.id }) },
              t("showCodeButton"),
            ),
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
      await call("pair", { address, code: form.code, folder: f.id });
      form.code = "";
      form.address = "";
    } catch (e) {
      form.error = (e as Error).message;
    }
    form.busy = false;
    draw(true);
  };
  // a phone: read the other computer's QR code, then try its addresses in turn (the first that answers pairs)
  const scan = async () => {
    form.error = "";
    let text: string | null;
    try {
      text = await scanQr(t("scanHelp"), t("cancel"));
    } catch (e) {
      form.error = t("scanNoCamera", { error: (e as Error).message });
      draw();
      return;
    }
    if (text === null) return;
    const link = parsePairLink(text);
    if (!link) {
      form.error = t("scanNotTandem");
      draw();
      return;
    }
    form.code = link.code;
    form.busy = true;
    draw();
    for (const address of link.addresses) {
      try {
        await call("pair", { address, code: link.code, folder: f.id });
        form.code = "";
        form.error = "";
        break;
      } catch (e) {
        form.error = (e as Error).message;
      }
    }
    form.busy = false;
    draw(true);
  };
  return [
    ...known,
    tabs,
    state.phone &&
      h(
        "div",
        { class: "gap" },
        h("button", { class: "go", onclick: () => void scan() }, form.busy ? t("pairing") : t("scanCode")),
      ),
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

/** The pairing QR code, kept across redraws while its text is the same (it is drawn asynchronously). */
let shownQr: { text: string; el: HTMLElement } | null = null;
function pairingQr(text: string): HTMLElement {
  if (shownQr?.text !== text) shownQr = { text, el: qrCode(text) };
  return shownQr.el;
}

function home(): Kid[] {
  return [
    offersCard(),
    state.guest && h("p", { class: "note" }, t("guestSyncing", { name: state.guest })),
    ...state.folders.map(folderCard),
    h(
      "div",
      { class: "row gap" },
      h(
        "button",
        {
          onclick: () => {
            form.folder = "";
            view = "newFolder";
            draw();
          },
        },
        icon("plus"),
        " ",
        t("addFolder"),
      ),
    ),
  ];
}

/** A folder on the home screen: where it is, then its copies, each with its status and Sync. */
function folderCard(f: FolderView): HTMLElement {
  const small = (ic: keyof typeof ICONS, label: Key, onclick: () => void) =>
    h("button", { class: "ghost icon", title: t(label), "aria-label": t(label), onclick }, icon(ic));
  return h(
    "section",
    { class: "folder-block" },
    h(
      "div",
      { class: "card tile" },
      icon("laptop", "big"),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "name" }, f.name),
        h("div", { class: "sub mono" }, ltr(f.path)),
      ),
      !state.phone && h("button", { onclick: () => act("open-folder", { folder: f.id }) }, t("openFolder")),
      small("history", "oldVersions", () => openOld(f.id)),
      small("gear", "folderSettings", () => openFolderSettings(f.id)),
    ),
    f.copies.length
      ? h("div", { class: "card copies" }, ...f.copies.map(copyTile))
      : h("p", { class: "sub" }, t("notShared")),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "small",
          onclick: () => {
            current = f.id;
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
  );
}

function copyTile(c: CopyView): HTMLElement {
  // the other side doesn't know this computer any more (it was reset or reinstalled, or forgot this one): this
  // pairing can never sync again, so its row offers to forget it rather than a Sync that can't work
  const dead = c.status?.there.known === false && c.status.there.why === "refused";
  if (dead && form.removing === c.deviceId) return forgetConfirm(c.deviceId, c.name);
  return h(
    "div",
    { class: "tile" },
    icon("desktop", "big"),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "name" }, c.name),
      ...(c.waiting
        ? [h("div", { class: "status" }, t("stWaiting", { name: c.name }))]
        : [
            ...statusLines(c.status, c.name),
            h(
              "div",
              { class: "sub" },
              c.lastSync ? t("lastSynced", { when: when(c.lastSync) }) : t("neverSynced"),
            ),
          ]),
    ),
    dead
      ? h(
          "button",
          {
            onclick: () => {
              form.removing = c.deviceId;
              draw();
            },
          },
          t("forget"),
        )
      : !c.waiting &&
          h(
            "button",
            { class: c.available ? "go" : "", onclick: () => act("compare", { id: c.id }) },
            t("sync"),
          ),
  );
}

const WHY: Record<Why, Key> = {
  starting: "whyStarting",
  off: "whyOff",
  network: "whyNetwork",
  failed: "whyFailed",
  missed: "whyMissed",
  refused: "whyRefused",
  unshared: "whyUnshared",
  waiting: "whyWaiting",
  version: "whyVersion",
};

/**
 * What the home screen says about a copy: what a sync would do when both sides are known, else each side on
 * its own, and "can't tell" with why for a side it can't see. Never "in sync" without both sides.
 */
function statusLines(s: CopyStatus | null, name: string): Kid[] {
  if (!s) return [h("div", { class: "status" }, t("statusChecking"))];
  if (s.both) {
    const b = s.both;
    const parts: string[] = [];
    if (b.send) parts.push(t("stSend", { n: b.send }));
    if (b.receive) parts.push(t("stReceive", { n: b.receive }));
    if (b.conflict) parts.push(t("stConflict", { n: b.conflict }));
    if (b.other) parts.push(t("stOther", { n: b.other }));
    if (!parts.length)
      return [
        h("div", { class: "status ok" }, h("span", { class: "dot" }), t(s.synced ? "stInSync" : "stSame")),
      ];
    return [
      h(
        "div",
        { class: `status${b.conflict ? " warn" : " news"}` },
        h("span", { class: "dot" }),
        parts.join(" · "),
      ),
    ];
  }
  const half = (side: CopyStatus["here"], here: boolean) => {
    if (!side.known)
      return h(
        "div",
        { class: "status warn" },
        icon("alert"),
        " ",
        t(here ? "stHereUnknown" : "stThereUnknown", { name, why: t(WHY[side.why]) }),
      );
    if (!s.synced) return null; // no record yet: nothing to compare one side with
    return h(
      "div",
      { class: `status${side.changed ? " news" : ""}` },
      side.changed
        ? t(here ? "stChangedHere" : "stChangedThere", { n: side.changed, name })
        : t(here ? "stNothingHere" : "stNothingThere", { name }),
    );
  };
  return [half(s.here, true), half(s.there, false)];
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

/** Load the review's lines again (a new review, or an answer changed one): what was open stays open. */
async function loadSections(job: Extract<Job, { phase: "review" }>) {
  const next: Partial<Record<ItemKind, Loaded>> = {};
  const page = (kind: ItemKind, limit: number, folder?: string) =>
    call<Lines>(
      `page?kind=${kind}&offset=0&limit=${limit}${folder === undefined ? "" : `&folder=${encodeURIComponent(folder)}`}`,
    ).then((r) => ({ ...r, limit }));
  for (const kind of Object.keys(job.counts) as ItemKind[]) {
    const count = job.counts[kind];
    if (!count) continue;
    const before = sections[kind];
    if (count <= WHOLE) next[kind] = { ...(await page(kind, count)), folders: new Map() };
    else if (kind === "conflict")
      next[kind] = { ...(await page(kind, Math.max(before?.limit ?? PAGE, PAGE))), folders: new Map() };
    else {
      const groups = await call<{ folder: string; count: number }[]>(`groups?kind=${kind}`);
      const folders = new Map<string, Lines>();
      for (const [folder, lines] of before?.folders ?? [])
        if (groups.some((g) => g.folder === folder))
          folders.set(folder, await page(kind, lines.limit, folder));
      next[kind] = { total: count, items: [], limit: 0, groups, folders };
    }
  }
  sections = next;
}

/** Load more lines of a kind, or of one of its folders (opened for the first time: its first page). */
async function more(kind: ItemKind, folder?: string) {
  const data = sections[kind];
  if (!data) return;
  const have = folder === undefined ? data : data.folders.get(folder);
  const limit = (have?.limit ?? 0) + PAGE;
  const r = await call<Lines>(
    `page?kind=${kind}&offset=0&limit=${limit}${folder === undefined ? "" : `&folder=${encodeURIComponent(folder)}`}`,
  ).catch(() => null);
  if (!r) return;
  if (folder === undefined) Object.assign(data, r, { limit });
  else data.folders.set(folder, { ...r, limit });
  draw(true);
}

/** Every loaded line (the compare view looks its file up here). */
function loadedItems(): Item[] {
  return Object.values(sections).flatMap((d) => [
    ...d!.items,
    ...[...d!.folders.values()].flatMap((f) => f.items),
  ]);
}

function moreButton(lines: Lines, kind: ItemKind, folder?: string) {
  if (lines.total <= lines.items.length) return null;
  return h(
    "div",
    { class: "item" },
    h("span", { class: "sub grow" }, t("andMore", { n: lines.total - lines.items.length })),
    h("button", { class: "small", onclick: () => void more(kind, folder) }, t("showMore")),
  );
}

function section(
  kind: ItemKind,
  title: string,
  row: (it: Item) => Kid,
  opts: { cls?: string; help?: Kid; open?: boolean } = {},
) {
  const data = sections[kind];
  if (!data) return null;
  const open = sectionOpen.get(kind) ?? opts.open ?? data.total <= 30;
  const body: Kid[] = [];
  if (data.groups) {
    // many files: by top folder, each loaded when opened
    for (const g of data.groups) {
      const key = `${kind}/${g.folder}`;
      const lines = data.folders.get(g.folder);
      body.push(
        h(
          "details",
          {
            class: "folder",
            open: !!sectionOpen.get(key),
            ontoggle: (e: Event) => {
              const isOpen = (e.target as HTMLDetailsElement).open;
              sectionOpen.set(key, isOpen);
              if (isOpen && !lines) void more(kind, g.folder);
            },
          },
          h(
            "summary",
            { class: "item" },
            icon("folder"),
            h("span", { class: "mono grow" }, g.folder ? ltr(`${g.folder}/`) : t("topLevel")),
            h("span", { class: "chip" }, num(g.count)),
          ),
          ...(lines ? lines.items.map(row) : [h("div", { class: "item sub" }, t("loading"))]),
          lines && moreButton(lines, kind, g.folder),
        ),
      );
    }
  } else {
    body.push(...data.items.map(row), moreButton(data, kind));
  }
  return h(
    "details",
    {
      class: `section ${opts.cls ?? ""}`,
      open,
      ontoggle: (e: Event) => sectionOpen.set(kind, (e.target as HTMLDetailsElement).open),
    },
    h("summary", null, title),
    opts.help && h("div", { class: "section-help sub" }, opts.help),
    ...body,
  );
}

const stamp = (m?: { size: number; mtime: number }) => (m ? `${when(m.mtime)}, ${bytes(m.size)}` : "");

function openCompare(item: Item) {
  const path = item.path;
  compare = { path, item, unfolded: new Set() };
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
  const n = job.counts;
  const plain = (ic: keyof typeof ICONS, cls: string, meta: (it: Item) => string) => (it: Item) =>
    h(
      "div",
      { class: "item" },
      icon(ic, cls),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "mono" }, ltr(it.path)),
        h("div", { class: "sub" }, meta(it)),
      ),
      it.fresh !== undefined && h("span", { class: "chip" }, t(it.fresh ? "newFile" : "changedFile")),
      it.fresh === false &&
        it.text &&
        h("button", { class: "small", onclick: () => openCompare(it) }, t("compare")),
    );
  const all = (choice: Choice | null, label: string) =>
    h("button", { class: "small", onclick: () => act("choose", { path: null, choice }) }, label);
  const conflict = (it: Item) =>
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
      h("button", { class: "small", onclick: () => openCompare(it) }, t("compare")),
    );
  return [
    h("h1", null, t("changesWith", { name })),
    job.first && h("p", { class: "note" }, t("firstSyncNote")),
    n.conflict > 0 &&
      section("conflict", t("conflictsTitle", { n: n.conflict }), conflict, {
        cls: "conflicts",
        open: true,
        help: h(
          "div",
          null,
          h("p", null, t("conflictsHelp")),
          n.conflict > 1 &&
            h(
              "div",
              { class: "choices" },
              all("a", t("keepMineAll")),
              all("b", t("keepTheirsAll", { name })),
              all("both", t("keepBothAll")),
            ),
        ),
      }),
    n.send > 0 &&
      section(
        "send",
        t("toSend", { n: n.send, name }),
        plain("right", "send", (it) => stamp(it.here)),
      ),
    n.receive > 0 &&
      section(
        "receive",
        t("toReceive", { n: n.receive, name }),
        plain("left", "receive", (it) => stamp(it.there)),
      ),
    n["remove-here"] > 0 &&
      section(
        "remove-here",
        t("toRemoveHere", { n: n["remove-here"], name }),
        plain("trash", "", (it) => stamp(it.here)),
        {
          help: t("removedKept"),
        },
      ),
    n["remove-there"] > 0 &&
      section(
        "remove-there",
        t("toRemoveThere", { n: n["remove-there"], name }),
        plain("trash", "", (it) => stamp(it.there)),
        { help: t("removedKept") },
      ),
    n.clash > 0 &&
      section(
        "clash",
        t("clashTitle", { n: n.clash }),
        plain("alert", "warn", (it) => (it.with ?? []).join(", ")),
        {
          help: t("clashHelpShort"),
        },
      ),
    n.unread > 0 &&
      section(
        "unread",
        t("unreadTitle", { n: n.unread }),
        plain("alert", "warn", () => ""),
        {
          help: t("unreadHelp"),
          open: true,
        },
      ),
  ];
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
  const folder = folderOfCopy(job.copyId);
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
      s.inSync && h("p", { class: "sub" }, t("closeBothNote")),
      h(
        "div",
        { class: "row gap wrap", style: "justify-content: center" },
        h("button", { class: "go", onclick: () => act("close") }, t("done")),
        !s.inSync && h("button", { onclick: () => act("compare", { id: job.copyId }) }, t("compareAgain")),
        folder &&
          !state.phone &&
          h("button", { onclick: () => act("open-folder", { folder: folder.id }) }, t("openFolder")),
        folder && s.kept > 0 && h("button", { onclick: () => openOld(folder.id) }, t("oldVersions")),
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
          accepting = null;
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
  const it = loadedItems().find((i) => i.path === c.path) ?? c.item;
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
  const it = loadedItems().find((i) => i.path === compare!.path) ?? compare!.item;
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

function openOld(folderId: string) {
  current = folderId;
  view = "old";
  old = null;
  draw();
  call<OldVersion[]>(`old?folder=${encodeURIComponent(folderId)}`).then(
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
  const folder = current;
  const groups = new Map<string, OldVersion[]>();
  for (const o of old ?? []) groups.set(o.stamp, [...(groups.get(o.stamp) ?? []), o]);
  return [
    backButton(),
    h("h1", null, t("oldTitleOf", { name: folderOf(folder)?.name ?? "" })),
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
              !state.phone &&
                h(
                  "button",
                  {
                    class: "small",
                    onclick: () => act("open-old", { folder, stamp: o.stamp, path: o.path }),
                  },
                  t("open"),
                ),
              h(
                "button",
                {
                  class: "small",
                  onclick: async () => {
                    if (await act("restore", { folder, stamp: o.stamp, path: o.path })) {
                      toast(t("putBackDone", { path: o.path }));
                      openOld(folder);
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
  if (await act("settings", { name: form.name, keepDays: Number(form.keepDays) })) {
    form.dirty = false;
    toast(t("saved"));
    draw();
  }
}

function openSettings() {
  view = "settings";
  form.name = state.device.name;
  form.keepDays = String(state.settings.keepDays);
  form.dirty = false;
  form.removing = "";
  draw();
}

let languages: string[] = ["en"];

/** Mark the open settings as changed: the Save button shows. */
function touch() {
  if (!form.dirty) {
    form.dirty = true;
    draw();
  }
}

function settingsView(): Kid[] {
  const s = state.settings;
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

    h("h2", null, t("computersSection")),
    state.devices.length
      ? h("div", { class: "card" }, ...state.devices.map((d) => deviceRow(d)))
      : h("p", { class: "sub" }, t("noComputers")),

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

/** Forgetting a paired computer, the second click: in the settings, or on a pairing that can't work any more. */
function forgetConfirm(deviceId: string, name: string): HTMLElement {
  return h(
    "div",
    { class: "tile" },
    icon("desktop", "big"),
    h("div", { class: "grow sub" }, t("forgetConfirm", { name })),
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
          await act("device-forget", { device: deviceId });
          draw();
        },
      },
      t("forget"),
    ),
  );
}

/** A paired computer in the settings: forgotten after a second click. */
function deviceRow(d: State["devices"][number]) {
  const ic = icon("desktop", "big");
  if (form.removing === d.id) return forgetConfirm(d.id, d.name);
  const shared = state.folders.filter((f) => f.copies.some((c) => c.deviceId === d.id)).map((f) => f.name);
  return h(
    "div",
    { class: "tile" },
    ic,
    h(
      "div",
      { class: "grow" },
      h("div", { class: "name" }, d.name),
      h(
        "div",
        { class: "sub" },
        shared.length ? t("sharesFolders", { names: shared.join(", ") }) : t("sharesNothing"),
      ),
    ),
    h(
      "button",
      {
        class: "small danger",
        onclick: () => {
          form.removing = d.id;
          draw();
        },
      },
      t("forget"),
    ),
  );
}

function openFolderSettings(folderId: string) {
  const f = folderOf(folderId);
  if (!f) return;
  current = folderId;
  view = "folder";
  form.ignore = f.ignore;
  form.dirty = false;
  form.removing = "";
  draw();
}

/** A folder's own settings: its place, its copies, its files left out; or stop syncing it. */
function folderView(f: FolderView): Kid[] {
  return [
    backButton(),
    h("h1", null, f.name),

    h("h2", null, t("folderSection")),
    h(
      "div",
      { class: "card tile" },
      h("div", { class: "grow mono selectable" }, ltr(f.path)),
      h(
        "button",
        {
          onclick: async () => {
            const r = await call<{ path: string | null }>("choose-folder", { kind: "folder" }).catch(
              () => null,
            );
            if (r?.path) await act("folder-path", { folder: f.id, path: r.path });
          },
        },
        t("changeFolder"),
      ),
    ),
    h("p", { class: "sub", style: "margin-top: 6px" }, t("changeFolderNote")),

    h("h2", null, t("copiesSection")),
    f.copies.length
      ? h("div", { class: "card" }, ...f.copies.map((c) => copyRow(c)))
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
            form.ignore = state.settings.defaultIgnore;
            form.dirty = true;
            draw(true);
          },
        },
        t("ignoreReset"),
      ),
    ),

    h("h2", null, t("removeFolder")),
    form.removing === f.id
      ? h(
          "div",
          { class: "card tile" },
          h("div", { class: "grow sub" }, t("removeFolderConfirm", { name: f.name })),
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
                if (await act("folder-remove", { folder: f.id })) view = "main";
                draw();
              },
            },
            t("remove"),
          ),
        )
      : h(
          "div",
          { class: "row" },
          h("p", { class: "sub grow" }, t("removeFolderHelp")),
          h(
            "button",
            {
              class: "small danger",
              onclick: () => {
                form.removing = f.id;
                draw();
              },
            },
            t("removeFolderButton"),
          ),
        ),
  ];
}

async function saveFolderSettings() {
  if (await act("folder-settings", { folder: current, ignore: form.ignore })) {
    form.dirty = false;
    toast(t("saved"));
    draw();
  }
}

/** A copy in a folder's settings: removed after a second click. */
function copyRow(c: CopyView) {
  const ic = icon("desktop", "big");
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
        class: "small danger",
        onclick: () => {
          form.removing = c.id;
          draw();
        },
      },
      t("remove"),
    ),
  );
}

function saveFooter(save: () => void): Kid[] {
  return [h("span", { class: "grow" }), h("button", { class: "go", onclick: save }, t("save"))];
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
  // a screen about a folder, or an offer, that is gone (removed here, or answered elsewhere)
  if (["add", "old", "folder"].includes(view) && !folderOf(current)) view = "main";
  if (
    view === "accept" &&
    !state.offers.some((o) => o.deviceId === accepting?.deviceId && o.folder === accepting.folder)
  ) {
    view = "main";
    accepting = null;
  }
  // the copy asked for arrived (paired from here, or from the other computer while this one showed its code)
  const copies = folderOf(current)?.copies ?? [];
  if (view === "add" && copiesBefore.folder === current && copies.length > copiesBefore.n) {
    view = "main";
    toast(t("paired", { name: copies.at(-1)!.name }));
  }
  copiesBefore = { folder: current, n: copies.length };

  const key = JSON.stringify([
    view,
    current,
    accepting,
    state,
    reviewRev,
    sections,
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
  // one folder, not shared yet, nothing offered: the next step is adding a copy
  const lonely =
    state.folders.length === 1 && !state.folders[0].copies.length && !state.offers.length && !job;
  if (view === "settings") {
    body = settingsView();
    if (form.dirty) foot = saveFooter(saveSettings);
  } else if (view === "old") body = oldView();
  else if (!state.folders.length) body = welcome();
  else if (view === "newFolder") body = welcome(true);
  else if (view === "accept" && accepting) body = acceptView(accepting);
  else if (view === "folder") {
    body = folderView(folderOf(current)!);
    if (form.dirty) foot = saveFooter(saveFolderSettings);
  } else if (view === "add") body = addCopy(folderOf(current)!);
  else if (lonely) {
    current = state.folders[0].id;
    body = addCopy(state.folders[0]);
  } else if (view === "compare") {
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
  tools.replaceChildren(...(state.folders.length ? [tool("gear", "settings", openSettings)] : []));
  const banner = document.getElementById("banner")!;
  banner.hidden = !state.update && !state.updateOut;
  if (state.update)
    banner.replaceChildren(
      h("span", { class: "grow" }, t("updateReady", { v: state.update })),
      h("button", { class: "small", onclick: () => act("install-update") }, t("restartToUpdate")),
    );
  else if (state.updateOut)
    banner.replaceChildren(
      h("span", { class: "grow" }, t("updateOut", { v: state.updateOut })),
      h("button", { class: "small", onclick: () => act("open-downloads") }, t("downloadUpdate")),
    );
}

async function refresh() {
  state = await call<State>("state");
  const job = state.job;
  if (job?.phase === "review") {
    if (job.rev !== reviewRev) {
      if (reviewRev === -1) sections = {}; // a new review: nothing of the last one stays
      await loadSections(job);
      reviewRev = job.rev;
    }
  } else if (reviewRev !== -1) {
    sections = {};
    reviewRev = -1;
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
  // back to the window: the other computers' news now, not at the next 30-second question
  window.addEventListener("focus", () => void call("focus", {}).catch(() => {}));
  const events = new EventSource("/api/events");
  events.onmessage = () => void pull();
  events.onerror = () => {
    // the app was closed under a page left open in a browser
    if (events.readyState === EventSource.CLOSED) toast(t("appClosed"), true);
  };
  await pull();
}

void start();
