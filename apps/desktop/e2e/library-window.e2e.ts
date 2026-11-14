/**
 * The sign-in window proved in the real desktop shell on Linux (Task F19; Rulings R343, R301, R340, R342).
 *
 * The built app (the debug build `build:linux` makes) runs under WebDriver on a private display, as in
 * desktop.e2e.ts, in the shell's own test mode (NODE_ENV=test: a debug build only, which lets the
 * shell's request reach the loopback address; R343 a — the one product switch used). A researcher's
 * library and a publisher are stood in for by `library-standin.ts`, over https at made-up names, which
 * this machine resolves and trusts only for the run (`system-setup.ts`, only with
 * AO_E2E_SYSTEM_SETUP=1; without it every scenario here is reported NOT RUN, with the reason, never as
 * passed). Nothing of the product is relaxed for it.
 *
 * What is real: the app's window and its interface (the Find and acquire screen's "Get through my
 * library", the waiting row, "Add the PDF showing in the sign-in window", the review queue's "Use this
 * file", the source's screen), the library service the shell starts (with its own token, which this
 * test never sees), the shell's separate sign-in window (WebKitGTK, its own ephemeral store), the
 * shell's own request for the PDF with that window's cookies, the hand-over on the service's pipe, the
 * file check and the review queue.
 *
 * What is stood in for, and how:
 *  - the library and the publishers: the stand-in (see its file);
 *  - the record of the work: the service in the shell runs as a person's does (the shell gives it no
 *    NODE_ENV, so the recorded lookups of the browser suite are not available), so the record is made
 *    from a Crossref answer for the typed line put, by this test, into the library's own lookup cache
 *    (`<library>/.cache/lookups/<sha256 of the request's cache key>.json`, the form the service itself
 *    writes) before the line is typed — a made-up work under the test DOI prefix 10.5555, so that the
 *    service answers from its cache and asks no outside server; every other record source and every
 *    free-copy service is switched off in the app's Search sources settings file of the run (the file
 *    a researcher's choices are saved in), so that nothing else is asked, and the entry rests "Record
 *    complete — Switched off in Search sources." with "Get through my library" offered;
 *  - the researcher's hands in the sign-in window: WebDriver reaches only the main window (the sign-in
 *    window is a web view of its own ephemeral context, which WebKitWebDriver does not drive), so the
 *    test types into it with xdotool on the private display, as a person types (the user name, Tab, the
 *    password, Return; Return on a focused link), only after the page has said it is shown with its
 *    first control focused (the stand-in's beacon); and closes it as its close button does.
 *
 * Waits (R173): every wait is for something the main window SHOWS (a state, a sentence, a heading), the
 * stand-in RECORDED, or a file the service WROTE, each with a generous limit. The one timed wait is
 * the review queue's: 700 ms after its card has SAID a press came inside its 600 ms quiet (as
 * e2e/find-copies.spec.ts does; the screen does not show the quiet's end).
 * Every sentence asserted is copied from the product's code (WORDS below names where). Nothing of the
 * ticket or of the library's address is printed: the stand-in records host, path and cookie NAMES only.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { startDesktop, until, type Desktop } from "./desktop.js";
import { expect, test } from "./fixtures.js";
import { HOSTS, READER, SAML_PATH, SESSION_COOKIE, STANDIN_NAMES, startStandin, type PageKind, type Standin, type StandinRequest } from "./library-standin.js";
import { SystemSetup } from "./system-setup.js";
import { elementId } from "./webdriver.js";

// ---------- the screens' words, copied from the product ----------

/** library_window.rs TITLE (R325 a). */
const SIGN_IN_TITLE = "Sign in to your library — open the PDF on this page and the app will fetch it for you to check";
const WORDS = {
  /** FindEntryRow.tsx STATE_TEXT / ACT_TEXT / FIND_TEXT; @ao/shared FIND_REASON_TEXT */
  recordComplete: "Record complete",
  switchedOff: "Switched off in Search sources.",
  waiting: "Waiting for you in the sign-in window",
  needsCheck: "Needs your check",
  inLibrary: "In your library",
  looksRight: "This looks like the right file. Check it, then use it.",
  fetching: "Fetching the PDF…",
  handedOver: "The file was fetched and is being checked.",
  windowClosed: "The sign-in window was closed.",
  /** ReviewQueue.tsx FOUND_FILES_TEXT */
  section: "Files found for records",
  right: (k: number) => `Files that look right (${k})`,
  decided: "Decided",
  attached: "File added to its record.",
  use: "Use this file",
  /** ReviewQueue.tsx PRESS_SHOWN_TEXT.quiet */
  quiet: "Not taken: the list had just changed. Look at the file, then press again.",
  /** YourLibrary.tsx, @ao/shared yourLibraryAddressSentence */
  linkLabel: "Paste any link that goes through your library",
  derive: "Work out the address",
  address: (host: string) => `Your library's address: ${host} (EZproxy)`,
  saved: "Saved.",
  stayOnlyOnMac: "Only on a Mac",
  /** SourceDetail.tsx */
  noFiles: "No files attached.",
  /** SourceDetail.tsx acquiredWords */
  fetchedThrough: (host: string) => `Fetched through your library (${host}).`,
  checkSaid: "The app's check had said it looked like the right file.",
};

// ---------- the works (made up; the DOI's last part names the publisher's page) ----------

interface Work {
  kind: PageKind;
  doi: string;
  title: string;
  given: string;
  family: string;
  year: number;
  journal: string;
  typed: string;
}
const work = (kind: PageKind, slug: string, title: string, given: string, family: string, year: number): Work => ({
  kind,
  doi: `10.5555/ao.f19.${slug}`,
  title,
  given,
  family,
  year,
  journal: "Journal of Invented Library Studies",
  typed: `${family}, ${title} ${year}`,
});
const WORKS = {
  marked: work("marked", "marked", "Harbour Rolls and the Keeping of Shore Accounts", "Wenna", "Trelissick", 2018),
  unmarked: work("unmarked", "unmarked", "Lantern Clubs and the Reading Rooms of Fishing Towns", "Morwen", "Polgrain", 2016),
  attachment: work("attachment", "attachment", "Tithe Maps and the Memory of Common Grazing", "Tamsin", "Carnsew", 2020),
  redirect: work("redirect", "redirect", "Ferry Wardens and the Ledgers of Crossing Fees", "Jowan", "Penrose", 2014),
  close: work("marked", "close", "Net Lofts and the Seasonal Work of Mending", "Lowena", "Treloar", 2012),
  restart: work("unmarked", "restart", "Chapel Registers and the Movement of Quarry Families", "Kerensa", "Bolitho", 2017),
};

const PAGE_TEXT = [
  "The study follows how the people of a few invented places kept their accounts over many years, drawing on",
  "letters and notebooks kept in family hands, and argues that the forms they used shaped what they were able",
  "to remember of the work they had done and of the places they had lived in. Every name here is made up.",
];
/** The work's PDF, by the tests' own PDF builder: its first page shows the record's title with its author below. */
const pdfOf = (w: Work) =>
  buildPdf({
    title: w.title,
    author: `${w.given} ${w.family}`,
    lines: [`${w.journal} 7 (${w.year})`, w.title, `${w.given} ${w.family}`, `doi:${w.doi}`, "Abstract. A made-up article for the tests of this application; it describes no real work.", ...PAGE_TEXT],
  });

/** Crossref's answer for the typed line, in its own shape, listing the one made-up work. */
const crossrefAnswer = (w: Work) =>
  JSON.stringify({
    status: "ok",
    "message-type": "work-list",
    "message-version": "1.0.0",
    message: {
      facets: {},
      "total-results": 1,
      items: [{ DOI: w.doi, title: [w.title], author: [{ given: w.given, family: w.family, sequence: "first", affiliation: [] }], issued: { "date-parts": [[w.year, 5]] }, type: "journal-article", "container-title": [w.journal], publisher: "Invented Press for Tests" }],
      "items-per-page": 5,
    },
  });

/** Search sources (the app's settings file, packages/library/src/find/settings.ts): Crossref alone, no copy service. */
const SEARCH_SOURCES = {
  v: 1,
  record: ["crossref", "openalex", "openlibrary", "loc", "elicit"].map((id) => ({ id, on: id === "crossref" })),
  copies: ["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"].map((id) => ({ id, on: false })),
};

/** Generous: the service, the shell and the web view share a machine that may be heavily loaded. */
const STATE_TIMEOUT = 90_000;

// ---------- the machine's set-up and the stand-in, for the whole file ----------

let notRun: string | undefined;
let setup: SystemSetup | undefined;
let standin: Standin | undefined;
const undoOnSignal = () => {
  setup?.undo();
};

test.beforeAll(async () => {
  notRun = SystemSetup.obstacle();
  if (notRun) return;
  setup = SystemSetup.apply(STANDIN_NAMES);
  // Interrupted (Ctrl+C, a stop, a closed terminal) or ended any other way: the machine is put back.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, undoOnSignal);
  process.on("exit", undoOnSignal);
  const kinds: PageKind[] = ["marked", "unmarked", "attachment", "redirect"];
  const pdfs = Object.fromEntries(await Promise.all(kinds.map(async (k) => [k, await pdfOf(WORKS[k])] as const))) as Record<PageKind, Buffer>;
  standin = await startStandin(setup.certificates, pdfs);
});

test.afterAll(async () => {
  await standin?.close();
  const problems = setup?.undo() ?? [];
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, undoOnSignal);
  process.off("exit", undoOnSignal);
  expect(problems, "the hosts file and the certificate store are exactly as they were before the run").toEqual([]);
});

test.beforeEach(() => {
  test.skip(notRun !== undefined, notRun);
  test.setTimeout(600_000); // a hang detector, not a budget (R150): the app is started, a library made, a window signed in
});

// ---------- the main window ----------

/** The row of a typed line, as the screen shows it (FindEntryRow.tsx), or null when there is none. */
const ROW_SCRIPT = `
const [typed] = arguments;
const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const li = Array.from(document.querySelectorAll("li.ao-find__entry")).find((l) => { const t = l.querySelector("[data-entry-text]"); return t && norm(t.textContent) === typed; });
if (!li) return null;
const txt = (sel) => { const e = li.querySelector(sel); return e ? norm(e.innerText) : null; };
return { state: txt(".ao-find__state"), reason: txt(".ao-find__reason"), note: txt(".ao-find__library-note"), library: txt(".ao-find__library-text"), alert: txt("[role=alert]"), acts: Array.from(li.querySelectorAll("[data-act]")).map((b) => b.getAttribute("data-act")) };
`;
/** One control of a typed line's row, by its act (FindEntryRow.tsx `data-act`). */
const ACT_SCRIPT = `
const [typed, act] = arguments;
const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const li = Array.from(document.querySelectorAll("li.ao-find__entry")).find((l) => { const t = l.querySelector("[data-entry-text]"); return t && norm(t.textContent) === typed; });
return li ? li.querySelector('[data-act="' + act + '"]') : null;
`;
/**
 * Keeps, in the page, every change of a row's state and library note, with the time (the page's own
 * clock, the machine's): what the row says in order, also what it says only for a moment.
 */
const WATCH_SCRIPT = `
const [typed] = arguments;
window.__aoSeen = window.__aoSeen || {};
const seen = (window.__aoSeen[typed] = []);
const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
const look = () => {
  const li = Array.from(document.querySelectorAll("li.ao-find__entry")).find((l) => { const t = l.querySelector("[data-entry-text]"); return t && norm(t.textContent) === typed; });
  const txt = (sel) => { const e = li && li.querySelector(sel); return e ? norm(e.innerText) : null; };
  const now = { state: txt(".ao-find__state"), note: txt(".ao-find__library-note") };
  const last = seen[seen.length - 1];
  if (!last || last.state !== now.state || last.note !== now.note) seen.push({ at: Date.now(), state: now.state, note: now.note });
};
look();
new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
`;

interface Row {
  state: string | null;
  reason: string | null;
  note: string | null;
  library: string | null;
  alert: string | null;
  acts: string[];
}

const rowOf = (d: Desktop, w: Work) => d.session.execute<Row | null>(ROW_SCRIPT, [w.typed]);
async function rowUntil(d: Desktop, w: Work, what: string, ok: (r: Row) => boolean, ms = STATE_TIMEOUT): Promise<Row> {
  let last: Row | null = null;
  return until(`the row of “${w.typed}” to ${what}`, ms, async () => {
    last = await rowOf(d, w);
    return last && ok(last) ? last : undefined;
  }).catch((err: Error) => {
    throw new Error(`${err.message}; it shows ${JSON.stringify(last)}`);
  });
}
async function pressAct(d: Desktop, w: Work, act: string): Promise<number> {
  const el = await until(`the control “${act}” on the row of “${w.typed}”`, STATE_TIMEOUT, async () => {
    const e = await d.session.execute<unknown>(ACT_SCRIPT, [w.typed, act]);
    return e ?? undefined;
  });
  const at = Date.now();
  await d.session.click(elementId(el));
  return at;
}
const seenOf = async (d: Desktop, w: Work) => (await d.session.execute<Array<{ at: number; state: string | null; note: string | null }>>("return (window.__aoSeen || {})[arguments[0]] || []", [w.typed])) ?? [];
const pageHas = (d: Desktop, text: string) => d.session.execute<boolean>("return document.body.innerText.replace(/\\s+/g, ' ').includes(arguments[0])", [text]);

// ---------- the library on disk (what the service wrote) ----------

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (p: string) => {
    for (const n of readdirSync(p)) {
      const f = join(p, n);
      if (statSync(f).isDirectory()) walk(f);
      else out.push(relative(dir, f).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface StoredAsset {
  role?: string;
  status?: string;
  sha256?: string;
  acquired?: { method?: string; via?: string; access?: string; address?: string; check?: { result?: string } };
}
/** The source record of `w` as the service stored it (source.json, by its DOI), with its files. */
function recordOf(libraryPath: string, w: Work): { files: StoredAsset[]; path: string } | undefined {
  for (const f of filesUnder(libraryPath).filter((x) => x.endsWith("/source.json"))) {
    const j = JSON.parse(readFileSync(join(libraryPath, f), "utf8")) as { identifiers?: { doi?: string }; assets?: StoredAsset[]; source?: { identifiers?: { doi?: string }; assets?: StoredAsset[] } };
    const src = j.source ?? j;
    if (src.identifiers?.doi?.toLowerCase() !== w.doi) continue;
    const assets = j.assets ?? j.source?.assets ?? [];
    return { path: f, files: assets.filter((a) => (a.role ?? "original") === "original" && a.status !== "destroyed") };
  }
  return undefined;
}
/** Where under the library a file with these bytes is kept. */
const placesOf = (libraryPath: string, bytes: Buffer) => filesUnder(libraryPath).filter((f) => !f.startsWith(".cache/") && statSync(join(libraryPath, f)).size === bytes.length && sha256(readFileSync(join(libraryPath, f))) === sha256(bytes));

// ---------- the steps every scenario shares ----------

interface Ready {
  d: Desktop;
  libraryPath: string;
  /** The library's address as the screen names it: the proxy's host and port. */
  proxyHost: string;
}

/**
 * The app started (test mode; the run's Search sources settings written first), a library and a project
 * made, Your library set on its screen from a pasted link, the Crossref answer for each typed line put in
 * the library's lookup cache, each line typed on Find and acquire, and each row resting "Record
 * complete — Switched off in Search sources." with "Get through my library" offered.
 */
async function readyApp(run: Parameters<typeof startDesktop>[0], works: Work[]): Promise<Ready> {
  const st = standin!;
  const d = await startDesktop(run, {
    testMode: true,
    prepare: (appData) => {
      const settings = join(appData, "settings");
      mkdirSync(settings, { recursive: true, mode: 0o700 });
      writeFileSync(join(settings, "search-sources.json"), JSON.stringify(SEARCH_SOURCES), { mode: 0o600 });
    },
  });
  const s = d.session;
  const libraryPath = join(d.librariesDir, "Invented University library");
  await d.byRole("heading", "Choose a library", { level: 1, timeoutMs: 60_000 });
  await s.sendKeys(await d.byRole("textbox", "Library folder"), libraryPath);
  await s.sendKeys(await d.byRole("textbox", "New library name"), "Invented University library");
  await s.click(await d.byRole("button", "Create a new library in that folder"));
  await d.byRole("heading", "Invented University library", { level: 1, timeoutMs: 60_000 });
  await s.click(await d.byRole("button", "New project"));
  const dialog = await d.byRole("dialog", "New project");
  await s.sendKeys(await d.byRole("textbox", "Project name", { within: dialog }), "Coastal records");
  await s.click(await d.byRole("checkbox", "This project holds identifiable information about people", { within: dialog }));
  const encrypt = await d.byRole("checkbox", "Encrypt this project", { within: dialog });
  await until("encryption to become a choice", 10_000, async () => (await s.property(encrypt, "disabled")) === false);
  await s.click(encrypt);
  await s.click(await d.byRole("button", "Create project", { within: dialog }));
  await until("the dialog to close", 30_000, async () => (await d.countByRole("dialog", "New project")) === 0);
  // The new project selected (the screen settles on it before anything else is pressed).
  const listed = await d.byRole("button", "Coastal records", { within: await d.byRole("navigation", "Projects"), timeoutMs: 30_000 });
  await until("the new project to be selected", 30_000, async () => (await s.execute<string | null>("return arguments[0].getAttribute('aria-current')", [s.element(listed)])) === "true");

  // Your library, on its screen: a link pasted, the address worked out, saved.
  const proxyHost = `${HOSTS.proxy}:${st.port}`;
  await s.click(await d.byRole("link", "Your library"));
  await d.byRole("heading", "Your library", { level: 1, timeoutMs: 30_000 });
  await s.sendKeys(await d.byRole("textbox", WORDS.linkLabel, { timeoutMs: 30_000 }), `${st.origin(HOSTS.proxy)}/login?url=https://doi.org/10.5555/ao.f19.any`);
  await s.click(await d.byRole("button", WORDS.derive));
  await until("the address worked out", STATE_TIMEOUT, () => pageHas(d, WORDS.address(proxyHost)));
  expect(await pageHas(d, WORDS.stayOnlyOnMac), "“Stay signed in” is a Mac's alone (off here)").toBe(true);
  await s.click(await d.byRole("button", "Save"));
  await until("the settings saved", STATE_TIMEOUT, () => pageHas(d, WORDS.saved));
  await s.click(await d.byRole("link", "Back to library"));
  await d.byRole("heading", "Invented University library", { level: 1, timeoutMs: 30_000 });

  // The record's lookup, answered from the library's own cache (see the file comment).
  const cache = join(libraryPath, ".cache", "lookups");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  chmodSync(join(libraryPath, ".cache"), 0o700);
  for (const w of works) {
    const name = createHash("sha256").update(`find:crossref:works:${w.typed}`).digest("hex");
    writeFileSync(join(cache, `${name}.json`), JSON.stringify({ v: 1, storedAt: Date.now(), status: 200, body: crossrefAnswer(w) }), { mode: 0o600 });
  }

  await s.click(await d.byRole("link", "Find and acquire"));
  await d.byRole("heading", "Find and acquire", { level: 1, timeoutMs: 30_000 });
  const box = await d.byRole("textbox", "References");
  await until("the References box to be enabled", STATE_TIMEOUT, async () => (await s.property(box, "disabled")) === false);
  await s.sendKeys(box, works.map((w) => w.typed).join("\n"));
  await s.click(await d.byRole("button", "Add"));
  for (const w of works) {
    const r = await rowUntil(d, w, `rest “${WORDS.recordComplete}” with “Get through my library”`, (x) => x.state === WORDS.recordComplete && x.acts.includes("library"));
    expect(r.reason).toBe(WORDS.switchedOff);
  }
  return { d, libraryPath, proxyHost };
}

/** The stand-in's requests from `from` on (a scenario's own), by host. */
const since = (from: number, host?: string) => standin!.requests().filter((r) => r.at >= from && (host === undefined || r.host === host));
async function recorded(what: string, from: number, ok: (r: StandinRequest) => boolean, ms = STATE_TIMEOUT): Promise<StandinRequest> {
  return until(`the stand-in to record ${what}`, ms, () => since(from).find(ok));
}

/** "Get through my library" pressed: the row waits and the sign-in window opens at the proxy's sign-in for the work, with no cookie. */
async function startThroughLibrary(r: Ready, w: Work): Promise<number> {
  await r.d.session.execute(WATCH_SCRIPT, [w.typed]);
  const pressed = await pressAct(r.d, w, "library");
  await rowUntil(r.d, w, `say “${WORDS.waiting}”`, (x) => x.state === WORDS.waiting);
  const first = await recorded("the sign-in window's first request", pressed, (q) => q.by === "window");
  expect(first, "the window is opened at the proxy's sign-in for this work").toMatchObject({ host: HOSTS.proxy, method: "GET", path: "/login", cookies: [] });
  await until("the sign-in window on the display", 30_000, () => r.d.windowId(SIGN_IN_TITLE));
  return pressed;
}

/** The researcher signs in with the stand-in's form, typing into the sign-in window. */
async function signIn(r: Ready, from: number): Promise<void> {
  await recorded("the sign-in form shown with its first field focused", from, (q) => q.path === "/ready" && q.host === HOSTS.proxy);
  await r.d.typeInto(SIGN_IN_TITLE, [READER.user, { key: "Tab" }, READER.password, { key: "Return" }]);
  await recorded("the sign-in (the SAML-like path)", from, (q) => q.host === HOSTS.proxy && q.path === SAML_PATH && q.method === "POST");
}

/** What a scenario's stand-in record must never hold, whatever else it checks. */
function expectNoViolation(from: number): void {
  expect(standin!.violations()).toEqual([]);
  const shellAtSignIn = since(from).filter((q) => q.by === "shell" && (q.host === HOSTS.proxy || q.path.startsWith("/saml") || q.path === "/login"));
  expect(shellAtSignIn, "the shell never asks the sign-in host, the login or the SAML-like path").toEqual([]);
  expect(since(from).filter((q) => q.path === SAML_PATH).length, "the SAML-like path is asked once, by the window").toBeLessThanOrEqual(1);
}

/** The row after the hand-over: "Needs your check", the check's sentence, and "Check the file". */
async function expectWaitingFile(r: Ready, w: Work): Promise<void> {
  const row = await rowUntil(r.d, w, `say “${WORDS.needsCheck}”`, (x) => x.state === WORDS.needsCheck);
  expect(row.reason).toBe(WORDS.looksRight);
  expect(row.acts).toContain("check");
  // Through what the service wrote: the record holds NO file; the file waits, held in the project.
  const rec = recordOf(r.libraryPath, w);
  expect(rec, `the record of ${w.doi} is stored`).toBeTruthy();
  expect(rec!.files, "the record has no file until the researcher uses it").toEqual([]);
  const held = placesOf(r.libraryPath, standin!.pdf(w.kind));
  expect(held.length, `the file is kept once, held for the check: ${held.join(", ")}`).toBe(1);
  expect(held[0]).toMatch(/(^|\/)find\/held\/[^/]+\.pdf$/);
}

/** The row says, in this order, what the shell reported for the fetch and the hand-over (F18b's sentences). */
async function expectSaidInOrder(r: Ready, w: Work, notBefore: number): Promise<void> {
  const seen = await seenOf(r.d, w);
  const notes = seen.filter((x) => x.note).map((x) => ({ at: x.at, note: x.note }));
  const iFetch = notes.findIndex((x) => x.note === WORDS.fetching);
  const iHanded = notes.findIndex((x) => x.note === WORDS.handedOver);
  expect(iFetch, `the row said “${WORDS.fetching}” (${JSON.stringify(seen)})`).toBeGreaterThanOrEqual(0);
  expect(iHanded, `then “${WORDS.handedOver}” (${JSON.stringify(seen)})`).toBeGreaterThan(iFetch);
  expect(notes[iFetch]!.at).toBeGreaterThanOrEqual(notBefore);
  const states = seen.map((x) => x.state);
  expect(states.indexOf(WORDS.waiting)).toBeGreaterThanOrEqual(0);
  expect(states.lastIndexOf(WORDS.needsCheck)).toBeGreaterThan(states.indexOf(WORDS.waiting));
}

/** The review queue: the file under "Files that look right (1)"; "Use this file" (by key); the record then has it. */
async function useTheFile(r: Ready, w: Work): Promise<void> {
  const { d } = r;
  const s = d.session;
  const link = await until("“Check the file” on the row", STATE_TIMEOUT, async () => (await s.execute<unknown>(ACT_SCRIPT, [w.typed, "check"])) ?? undefined);
  await s.click(elementId(link));
  await d.byRole("heading", "Review queue", { level: 1, timeoutMs: 30_000 });
  const section = await d.byRole("region", WORDS.section, { timeoutMs: STATE_TIMEOUT });
  await d.byRole("heading", WORDS.right(1), { level: 3, within: section, timeoutMs: STATE_TIMEOUT });
  const name = `${WORDS.use} for ${w.title} (${w.family}, ${w.year})`;
  // By key, as a researcher may (Enter on the focused control). For 600 ms after the list is laid out
  // (and after any press not taken) the product takes no decision and says so on the card (R313 c,
  // R318 b: "Not taken: the list had just changed. Look at the file, then press again."). The screen
  // shows nothing when that quiet ends, so \u2014 as e2e/find-copies.spec.ts does, and only after the card
  // has SAID a press was not taken \u2014 the scenario waits 700 ms ("look at the file") and presses again.
  for (let tries = 0; ; tries++) {
    const use = await d.byRole("button", name, { within: section, timeoutMs: STATE_TIMEOUT });
    await s.sendKeys(use, "\uE007");
    const decided = await until("the card to say the file was used", 10_000, () => pageHas(d, `${WORDS.decided} ${WORDS.attached}`)).then(
      () => true,
      () => false,
    );
    if (decided) break;
    expect(await pageHas(d, WORDS.quiet), "a press not taken says why").toBe(true);
    expect(tries, "a press is taken once the list has rested").toBeLessThan(4);
    await new Promise((done) => setTimeout(done, 700)); // the product's 600 ms quiet, said on the card (above)
  }
  // Through what the service wrote: the record has the file, the same bytes, got through the library.
  const rec = await until("the record to hold the file", STATE_TIMEOUT, () => {
    const x = recordOf(r.libraryPath, w);
    return x && x.files.length === 1 ? x : undefined;
  });
  expect(rec.files[0]).toMatchObject({ sha256: sha256(standin!.pdf(w.kind)), acquired: { method: "library_access", via: "sign-in-window", access: "signed-in-session", address: `https://${r.proxyHost}/login`, check: { result: "match" } } });
  expect(placesOf(r.libraryPath, standin!.pdf(w.kind)).some((p) => /(^|\/)find\/held\//.test(p)), "nothing is held any more").toBe(false);
}

// ---------- the scenarios ----------

test("signed in, marked page, file handed over: it waits for the researcher's check, then “Use this file” adds it", async ({ run }) => {
  const w = WORKS.marked;
  const r = await readyApp(run, [w]);
  let pressed = 0;
  await test.step("“Get through my library”: the sign-in window opens at the proxy's sign-in for the work, with no cookie", async () => {
    pressed = await startThroughLibrary(r, w);
  });
  await test.step("the researcher signs in by the stand-in's form; the window goes on to the publisher's marked page", async () => {
    await signIn(r, pressed);
    const login = await recorded("the window back at the proxy's /login, signed in", pressed, (q) => q.host === HOSTS.proxy && q.path === "/login" && q.cookies.includes(SESSION_COOKIE));
    expect(login.by).toBe("window");
    await recorded("the publisher's marked page", pressed, (q) => q.host === HOSTS.publisher && q.path === "/article/marked" && q.cookies.includes(SESSION_COOKIE));
  });
  await test.step("the shell fetches the PDF by itself: ONE request of its own, with the session cookie, and none to the sign-in", async () => {
    const shellPdf = await recorded("the shell's request for the PDF", pressed, (q) => q.by === "shell");
    expect(shellPdf).toMatchObject({ host: HOSTS.publisher, method: "GET", path: "/pdf/marked.pdf", cookies: [SESSION_COOKIE] });
    await rowUntil(r.d, w, `say “${WORDS.needsCheck}”`, (x) => x.state === WORDS.needsCheck);
    expect(since(pressed).filter((q) => q.by === "shell"), "one request of the shell's own").toHaveLength(1);
    expectNoViolation(pressed);
  });
  await test.step("the row said, in order, the fetch and the hand-over; the entry needs the researcher's check and the record has NO file", async () => {
    await expectSaidInOrder(r, w, pressed);
    await expectWaitingFile(r, w);
    // On the screen too: the record opened from its row shows no file.
    await pressAct(r.d, w, "open");
    const record = await r.d.byRole("region", "Record", { timeoutMs: STATE_TIMEOUT });
    const detail = await r.d.byRole("region", "Source details", { within: record, timeoutMs: STATE_TIMEOUT });
    await r.d.byRole("heading", w.title, { level: 2, within: detail, timeoutMs: STATE_TIMEOUT });
    expect(await r.d.session.execute<string>("return arguments[0].innerText", [r.d.session.element(detail)])).toContain(WORDS.noFiles);
  });
  await test.step("the review queue holds it under “Files that look right (1)”; “Use this file” adds it, got through the library", async () => {
    await useTheFile(r, w);
  });
  await test.step("the source's screen says how the file was got", async () => {
    const { d } = r;
    await d.session.click(await d.byRole("link", "Back to library"));
    const table = await d.byRole("table", "Sources", { timeoutMs: 30_000 });
    await d.session.click(await d.byRole("button", w.title, { within: table, timeoutMs: 30_000 }));
    const said = await until("the source's file line", STATE_TIMEOUT, async () => {
      const t = await d.session.execute<string | null>("const e = document.querySelector('.ao-source__acquired'); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null");
      return t ?? undefined;
    });
    expect(said.startsWith(`${WORDS.fetchedThrough(r.proxyHost)} Fetched on `), said).toBe(true);
    expect(said.endsWith(WORDS.checkSaid), said).toBe(true);
  });
});

test("a page without the mark needs “Add the PDF showing in the sign-in window”: nothing is fetched before the press, one fetch after", async ({ run }) => {
  const w = WORKS.unmarked;
  const r = await readyApp(run, [w]);
  const pressed = await startThroughLibrary(r, w);
  await signIn(r, pressed);
  await recorded("the publisher's page without the mark, its link focused", pressed, (q) => q.path === "/ready" && q.host === HOSTS.publisher);
  // The researcher opens the PDF in the window (Return on its link); the window shows it.
  await r.d.typeInto(SIGN_IN_TITLE, [{ key: "Return" }]);
  const shown = await recorded("the window's own request for the PDF", pressed, (q) => q.by === "window" && q.path === "/content/unmarked/fulltext");
  expect(shown.cookies).toEqual([SESSION_COOKIE]);
  const row = await rowOf(r.d, w);
  expect(row?.state).toBe(WORDS.waiting);
  expect(since(pressed).filter((q) => q.by === "shell"), "nothing fetched by the shell before the press").toEqual([]);
  const take = await pressAct(r.d, w, "library-take");
  const shellPdf = await recorded("the shell's request for the PDF showing", pressed, (q) => q.by === "shell");
  expect(shellPdf).toMatchObject({ host: HOSTS.publisher, path: "/content/unmarked/fulltext", cookies: [SESSION_COOKIE] });
  expect(shellPdf.at, "the shell's request came after the press").toBeGreaterThanOrEqual(take);
  await expectWaitingFile(r, w);
  await expectSaidInOrder(r, w, take);
  expect(since(pressed).filter((q) => q.by === "shell"), "one fetch after the press").toHaveLength(1);
  expectNoViolation(pressed);
});

test("a PDF sent as a download is fetched by the shell", async ({ run }) => {
  const w = WORKS.attachment;
  const r = await readyApp(run, [w]);
  const pressed = await startThroughLibrary(r, w);
  await signIn(r, pressed);
  // The page's mark leads the window to an address that does not look like a PDF, answered as a download.
  const own = await recorded("the window's request for the download", pressed, (q) => q.by === "window" && q.path === "/files/attachment");
  expect(own.cookies).toEqual([SESSION_COOKIE]);
  const shellPdf = await recorded("the shell's request for the download's address", pressed, (q) => q.by === "shell");
  expect(shellPdf).toMatchObject({ host: HOSTS.publisher, path: "/files/attachment", cookies: [SESSION_COOKIE] });
  await expectWaitingFile(r, w);
  await expectSaidInOrder(r, w, pressed);
  expect(since(pressed).filter((q) => q.by === "shell")).toHaveLength(1);
  expectNoViolation(pressed);
});

test("a publisher redirecting to another host hands over no file without the check: the third host is sent no cookie of the proxy", async ({ run }) => {
  const w = WORKS.redirect;
  const r = await readyApp(run, [w]);
  const pressed = await startThroughLibrary(r, w);
  await signIn(r, pressed);
  await recorded("the publisher's redirect to the third host", pressed, (q) => q.host === HOSTS.publisher && q.path === "/pdf/redirect.pdf");
  await recorded("the shell's request for the PDF", pressed, (q) => q.by === "shell");
  await expectWaitingFile(r, w);
  const third = since(pressed, HOSTS.third);
  expect(third.length, "the third host was asked").toBeGreaterThan(0);
  expect(third.filter((q) => q.cookies.length > 0), "no cookie of the proxy (nor any) reached the third host").toEqual([]);
  expect(third.some((q) => q.by === "shell"), "the shell's request reached the third host").toBe(true);
  expect(since(pressed).filter((q) => q.by === "shell" && q.host !== HOSTS.third && q.host !== HOSTS.publisher)).toEqual([]);
  expectNoViolation(pressed);
});

test("closing the sign-in window while the entry waits returns the entry, and a new “Get through my library” works", async ({ run }) => {
  const w = WORKS.close;
  const r = await readyApp(run, [w]);
  const first = await startThroughLibrary(r, w);
  await r.d.closeWindowTitled(SIGN_IN_TITLE);
  await until("the sign-in window to be gone", 30_000, () => r.d.windowId(SIGN_IN_TITLE) === undefined);
  const back = await rowUntil(r.d, w, `rest “${WORDS.recordComplete}” again with “${WORDS.windowClosed}”`, (x) => x.state === WORDS.recordComplete && x.acts.includes("library") && x.note === WORDS.windowClosed);
  expect(back.reason).toBe(WORDS.switchedOff);
  const again = await startThroughLibrary(r, w);
  expect(since(first).filter((q) => q.by === "shell"), "nothing was fetched").toEqual([]);
  expect(since(again).filter((q) => q.by === "window").length).toBeGreaterThan(0);
  expectNoViolation(first);
});

test("after quit the stand-in sees no cookie: a new start with “Stay signed in” off opens the sign-in afresh", async ({ run }) => {
  const w = WORKS.restart;
  const r = await readyApp(run, [w]);
  const pressed = await startThroughLibrary(r, w);
  await signIn(r, pressed);
  await recorded("the publisher's page, signed in", pressed, (q) => q.path === "/ready" && q.host === HOSTS.publisher);
  // Quit (the main window's close button) while the entry waits, and start the app again.
  const { shellPid } = r.d.shell;
  await r.d.closeWithCloseButton();
  await until("the app to exit", 120_000, () => {
    try {
      process.kill(shellPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  await r.d.relaunch();
  await r.d.byRole("heading", "Invented University library", { level: 1, timeoutMs: 60_000 });
  await r.d.session.click(await r.d.byRole("button", "Coastal records", { within: await r.d.byRole("navigation", "Projects"), timeoutMs: 30_000 }));
  await r.d.session.click(await r.d.byRole("link", "Find and acquire", { timeoutMs: 30_000 }));
  // The service returns the entry that waited (its ticket died with the old app).
  await rowUntil(r.d, w, `rest “${WORDS.recordComplete}” with “Get through my library”`, (x) => x.state === WORDS.recordComplete && x.acts.includes("library"));
  const restarted = Date.now();
  await startThroughLibrary(r, w);
  const firstAfter = since(restarted).filter((q) => q.by === "window")[0]!;
  expect(firstAfter, "the first request after the new start carries no cookie").toMatchObject({ host: HOSTS.proxy, path: "/login", cookies: [] });
  expect(since(pressed).filter((q) => q.by === "shell")).toEqual([]);
  expectNoViolation(pressed);
});
