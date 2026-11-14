/**
 * Task F20a (R348): "Get through my library in my own browser" — the app's start, the entry's view, and the paired
 * extension's two routes (the list of works waiting for a PDF, and the PDF itself), through the service.
 *
 * Nothing here reaches the network: the global dispatcher is a MockAgent with `disableNetConnect` and NO answers,
 * composed with a recorder of every request (the service never fetches from the library or the tab's address). The
 * library's host, the work's DOI, the tab's address, the record's title and every ticket are recognisable strings that
 * are looked for in every log line (at the most verbose level), error answer, event, the audit and queue files, and
 * every request.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps, type FindEntry } from "@ao/library";
import {
  FIND_BROWSER_FILE_TEXT,
  FIND_BROWSER_LABEL_MAX,
  FIND_BROWSER_NO_TITLE,
  FIND_BROWSER_TEXT,
  FIND_LIBRARY_FILE_TEXT,
  FIND_LIBRARY_TEXT,
  FIND_ROUTE_TEXT,
  LIBRARY_FILE_MAX_BYTES,
  LIBRARY_PAUSE_MS,
  YOUR_LIBRARY_TEXT,
  type FindEntryView,
  type FindQueueResponse,
} from "@ao/shared";
import { newId, type SourceDraft } from "@ao/core";
import { appendFindEntriesIn, holdMismatchedFileIn } from "../../../packages/library/src/repo/repo.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, logUrl, type LibraryService } from "./server.js";
import type { ServiceEvent } from "./events.js";
import { inboxOf, inputLineHandler } from "./file-grants.js";
import { libraryFileHandler } from "./routes/your-library.js";
import { BROWSER_INBOX, browserInboxOf, browserLabel } from "./routes/find-browser.js";
import { onInputLines, readStartupToken } from "./startup-token.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const OTHER_EXT = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const GOV = (extra = "") => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: [crossref, openalex]
${extra}`;
/** Free copies not allowed: a resting entry stays as it is at a resume (no service is ever asked). */
const NO_FREE = GOV("acquireMethods: [reference_lookup, library_access]\n");

// Recognisable, made up: the library's host, the work's DOI, the record's title, the tab's address.
const LIB_HOST = "ezproxy.vexmoor-univ.example.edu";
const DOI = "10.5555/ao.f20a.quillbrook";
const TITLE = "Quillbrook Ledger of Habits";
const EZ = { kind: "ezproxy-login" as const, base: `https://${LIB_HOST}/login?url=` };
const TAB_HOST = "pdfs.tabhost-f20a.example.com";
const TAB = `https://${TAB_HOST}/content/quillbrook.pdf?accessToken=tabsecretf20a#page=2`;
const TAB_KEPT = `https://${TAB_HOST}/content/quillbrook.pdf`;
const SECRETS = [LIB_HOST, DOI, TITLE, TAB_HOST, "tabsecretf20a", "vexmoor-univ", "quillbrook"];

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService | undefined;
let events: ServiceEvent[];
let agent: MockAgent;
let previous: Dispatcher;
let requests: string[];
const errorBodies: string[] = [];
/** Tickets handed out in this file: looked for everywhere too. */
const tickets: string[] = [];
/** The Host header once the service listens on a port (its Host check then wants that port). */
let host: Record<string, string> = {};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-browser-"));
  host = {};
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  events = [];
  requests = [];
  agent = new MockAgent();
  agent.disableNetConnect();
  previous = getGlobalDispatcher();
  setGlobalDispatcher(
    agent.compose((dispatch) => (opts, handler) => {
      requests.push(`${String(opts.origin)}${opts.path}`);
      return dispatch(opts, handler);
    }),
  );
});
afterEach(async () => {
  await svc?.close();
  svc = undefined;
  setGlobalDispatcher(previous);
  await agent.close();
  // R348 f: nothing of the ticket, the tab's address or the title in any log line, error answer, event, audit or queue
  // file; and no request was made at all.
  const files = await everything(tmp);
  const seen = [logs, ...errorBodies, ...events.map((e) => JSON.stringify(e)), files.audit, files.queue].join("\n");
  for (const w of [...SECRETS, ...tickets]) expect(seen.includes(w), `"${w}" was logged, sent or written`).toBe(false);
  expect(requests).toEqual([]);
  errorBodies.length = 0;
  tickets.length = 0;
  await rm(tmp, { recursive: true, force: true });
});

/** The text of every audit file and every queue file under `dir`. */
async function everything(dir: string): Promise<{ audit: string; queue: string }> {
  const out = { audit: "", queue: "" };
  const walk = async (d: string): Promise<void> => {
    for (const x of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = join(d, x.name);
      if (x.isDirectory()) await walk(full);
      else if (full.split(sep).includes("audit")) out.audit += (await readFile(full)).toString("latin1");
      else if (x.name === "queue.jsonl") out.queue += (await readFile(full)).toString("latin1");
    }
  };
  await walk(dir);
  return out;
}

async function start(o: { stallMs?: number; takeMs?: number } = {}): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null, ...(o.stallMs !== undefined ? { browserStallMs: o.stallMs } : {}), ...(o.takeMs !== undefined ? { browserTakeMs: o.takeMs } : {}) });
  svc.state.events.subscribe((e) => events.push(e));
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string> };
type Answer = { status: number; json: any; body: string; headers: Record<string, unknown> };
const answerOf = (res: { statusCode: number; body: string; headers: Record<string, unknown>; json(): unknown }): Answer => {
  if (res.statusCode >= 400) errorBodies.push(res.body);
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
};
async function call(r: Inject): Promise<Answer> {
  return answerOf(
    await svc!.app.inject({
      method: r.method ?? "GET",
      url: r.url,
      headers: { ...auth, ...host, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
      ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
    }),
  );
}

async function openNewLibrary(name = "Lib"): Promise<string> {
  const path = join(tmp, name);
  const r = await call({ method: "POST", url: "/libraries", body: { path, name } });
  expect(r.status, r.body).toBe(200);
  return path;
}
async function newProject(o: { encrypted?: boolean; gov?: string } = {}): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name: `Study ${Math.random().toString(36).slice(2, 6)}`, governanceYaml: o.gov ?? NO_FREE, encryption: o.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}
const repo = () => svc!.state.session!.repo;
const draft = (o: { doi?: string | null; title?: string; identifiable?: boolean } = {}): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: o.title ?? TITLE }] },
  creators: [{ role: "author", family: "Mirabelle", given: "Ottoline" }],
  issued: "1999",
  identifiers: o.doi === null ? {} : { doi: o.doi ?? DOI },
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});
async function record(pid: string, o: { doi?: string | null; title?: string; identifiable?: boolean } = {}): Promise<string> {
  const sf = await repo().createSource(pid, draft(o), [], {
    provenance: { captureMethod: "reference_lookup", capturedAt: new Date().toISOString(), tool: { name: "find-and-acquire", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: o.identifiable === true },
  });
  return sf.source.id;
}
type Rest = { state: FindEntry["state"]; reason?: FindEntry["reason"] };
async function resting(pid: string, rest: Rest = { state: "no-open-copy" }, sid?: string): Promise<FindEntry> {
  const at = new Date().toISOString();
  // What was typed is not the title (the title is looked for in the queue file).
  const e: FindEntry = { id: newId(), projectId: pid, typed: "Mirabelle 1999 ledger", ...rest, createdAt: at, updatedAt: at, attempts: 0, sourceId: sid ?? (await record(pid)) };
  await appendFindEntriesIn(repo(), pid, [e], "add");
  return e;
}
const queue = async (pid: string): Promise<FindQueueResponse> => {
  const r = await call({ url: `/projects/${pid}/find` });
  expect(r.status, r.body).toBe(200);
  return r.json as FindQueueResponse;
};
const view = async (pid: string, eid: string): Promise<FindEntryView> => (await queue(pid)).entries.find((e) => e.id === eid)!;
const setLibrary = async (body: Record<string, unknown> = { name: "Vexmoor University", access: EZ }) => {
  const r = await call({ method: "PUT", url: "/settings/your-library", body });
  expect(r.status, r.body).toBe(200);
};
const browserStart = (pid: string, eid: string, headers: Record<string, string> = {}) => call({ method: "POST", url: `/projects/${pid}/find/${eid}/browser/start`, headers });
const windowStart = async (pid: string, eid: string) => {
  const r = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/library/start` });
  if (r.status === 200) tickets.push(r.json.ticket);
  return r;
};
const cancel = (pid: string, eid: string) => call({ method: "POST", url: `/projects/${pid}/find/${eid}/library/cancel` });
async function until<T>(fn: () => Promise<T | undefined | false>, what = "the condition", ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function pairExtension(origin = EXT): Promise<string> {
  const p = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
  expect(c.statusCode, c.body).toBe(200);
  return c.json().token as string;
}
let extToken = "";
/** The extension's list (its token and its paired Origin unless told otherwise). */
async function waitingList(o: { token?: string; origin?: string | null; body?: string; contentType?: string } = {}): Promise<Answer> {
  const res = await svc!.app.inject({
    method: "POST",
    url: "/find/browser/waiting",
    headers: { ...host, authorization: `Bearer ${o.token ?? extToken}`, ...(o.origin === null ? {} : { origin: o.origin ?? EXT }), "content-type": o.contentType ?? "application/json" },
    payload: o.body ?? "{}",
  });
  const a = answerOf(res);
  for (const w of (a.json?.waiting ?? []) as Array<{ ticket: string }>) tickets.push(w.ticket);
  return a;
}
/** The extension sends a PDF for a ticket. */
async function sendFile(ticket: string, payload: Buffer | Readable | string | undefined, o: { token?: string; origin?: string | null; page?: string | null; contentType?: string | null; headers?: Record<string, string> } = {}): Promise<Answer> {
  return answerOf(
    await svc!.app.inject({
      method: "POST",
      url: `/find/browser/file/${ticket}`,
      headers: {
        ...host,
        authorization: `Bearer ${o.token ?? extToken}`,
        ...(o.origin === null ? {} : { origin: o.origin ?? EXT }),
        ...(o.contentType === null ? {} : { "content-type": o.contentType ?? "application/pdf" }),
        ...(o.page === null ? {} : { "x-ao-page": o.page ?? TAB }),
        ...o.headers,
      },
      ...(payload !== undefined ? { payload } : {}),
    }),
  );
}

const GOOD_LINES = [
  TITLE,
  "Ottoline Mirabelle",
  "Abstract. A ledger of invented habits, made up for these tests, with enough words to be read as text.",
  "The study reads how people speak of their habits over many years, drawing on letters and",
  "interviews kept in family hands, and argues that the words they choose shape what they",
  "are able to remember of the places they have lived in and of the work they have done there.",
];
const goodPdf = () => buildPdf({ title: TITLE, author: "Ottoline Mirabelle", lines: GOOD_LINES });
const inboxOfService = () => browserInboxOf(svc!.state.deps.appConfigDir);
const inboxFiles = async () => readdir(inboxOfService()).catch(() => [] as string[]);
const reviewItems = async (pid: string) => ((await call({ url: `/projects/${pid}/review` })).json.items ?? []) as Array<Record<string, any>>;

/** A library open, "Your library" set, an extension paired, a project with a resting entry; optionally the browser wait started. */
async function ready(o: { gov?: string; started?: boolean; stallMs?: number; takeMs?: number; rest?: Rest } = {}): Promise<{ pid: string; e: FindEntry; url?: string; ticket?: string }> {
  await start({ ...(o.stallMs !== undefined ? { stallMs: o.stallMs } : {}), ...(o.takeMs !== undefined ? { takeMs: o.takeMs } : {}) });
  await openNewLibrary();
  const pid = await newProject(o.gov ? { gov: o.gov } : {});
  await setLibrary();
  extToken = await pairExtension();
  const e = await resting(pid, o.rest);
  if (!o.started) return { pid, e };
  const r = await browserStart(pid, e.id);
  expect(r.status, r.body).toBe(200);
  const list = await waitingList();
  return { pid, e, url: r.json.url as string, ticket: list.json.waiting[0].ticket as string };
}

/** The same ticket still serves: a good file is then held. */
async function stillServes(pid: string, e: FindEntry, ticket: string): Promise<void> {
  expect((await view(pid, e.id)).state).toBe("waiting-sign-in");
  const ok = await sendFile(ticket, await goodPdf());
  expect(ok.status, ok.body).toBe(200);
  expect(ok.json).toEqual({ outcome: "held", sentence: FIND_BROWSER_TEXT.held });
  expect((await view(pid, e.id)).state).toBe("needs-check");
  expect(await inboxFiles()).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------

describe("R348 d: the app's start — POST /projects/:id/find/:eid/browser/start", () => {
  it("answers exactly { url } (the library's address for the work), no-store; never the ticket; the entry waits in the browser", async () => {
    const { pid, e } = await ready();
    const n = events.length;
    const r = await browserStart(pid, e.id);
    expect(r.status, r.body).toBe(200);
    expect(Object.keys(r.json)).toEqual(["url"]);
    expect(r.json.url).toBe(`${EZ.base}https://doi.org/${DOI}`);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).not.toMatch(/[0-9a-f]{32}/u);
    const v = await view(pid, e.id);
    expect(v.state).toBe("waiting-sign-in");
    expect(v.waitingIn).toBe("browser");
    expect(v).not.toHaveProperty("windowStart");
    expect(v).not.toHaveProperty("browserStart");
    expect(v).not.toHaveProperty("offers");
    expect(events.slice(n).filter((x) => x.type === "find.progress").map((x) => x.data)).toEqual([{ projectId: pid, entryId: e.id, state: "waiting-sign-in" }]);
    // The audit: the library start's own (op and method), nothing of the address.
    const audit = (await everything(tmp)).audit;
    expect(audit).toContain('"op":"project.find.library-start"');
    expect(audit).toContain('"method":"library_access"');
    // The cancel is the library's: the entry back as it was, the list empty.
    const back = await cancel(pid, e.id);
    expect(back.status, back.body).toBe(200);
    expect(back.json.state).toBe("no-open-copy");
    expect(back.json).not.toHaveProperty("waitingIn");
    expect((await waitingList()).json).toEqual({ waiting: [] });
  });

  it("refused when no browser is paired: 409 browser-not-paired, no-store, nothing changed", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    const e = await resting(pid);
    const r = await browserStart(pid, e.id);
    expect([r.status, r.json.error.code, r.json.error.reason, r.json.error.message]).toEqual([409, "CONFLICT", "browser-not-paired", FIND_BROWSER_TEXT.notPaired]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect((await view(pid, e.id)).state).toBe("no-open-copy");
    expect((await everything(tmp)).audit).not.toContain("library-start");
    // Paired, then unpaired again: refused again.
    extToken = await pairExtension();
    const pairings = (await call({ url: "/extension/pairings" })).json.extensions as Array<{ id: string }>;
    expect((await call({ method: "DELETE", url: `/extension/pairings/${pairings[0]!.id}` })).status).toBe(200);
    expect((await browserStart(pid, e.id)).json.error.reason).toBe("browser-not-paired");
  });

  it("refused exactly as the library's start: the find routes' own, busy (one work waits, in the window or the browser), the pause, not offered, no library, the limit, a body, the extension's token", async () => {
    const { pid, e } = await ready();
    // A body.
    const body = await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/browser/start`, body: { url: "https://x.example.org" } });
    expect([body.status, body.json.error.message]).toEqual([400, YOUR_LIBRARY_TEXT.noBody]);
    // Ids, an unknown project or entry.
    expect((await browserStart("nope", e.id)).status).toBe(400);
    expect((await browserStart(newId(), e.id)).json.error.message).toBe("That project was not found.");
    expect((await browserStart(pid, newId())).json.error.message).toBe(FIND_ROUTE_TEXT.entryNotFound);
    // The extension's token: refused before the route.
    const viaExt = await svc!.app.inject({ method: "POST", url: `/projects/${pid}/find/${e.id}/browser/start`, headers: { authorization: `Bearer ${extToken}`, origin: EXT } });
    expect([viaExt.statusCode, viaExt.json().error.message]).toEqual([403, "The browser extension cannot use this."]);
    errorBodies.push(viaExt.body);
    // Busy: a window's ticket open → the browser's start refused, and the other way round; the sentence true of both.
    const other = await resting(pid, { state: "no-open-copy" }, await record(pid, { doi: "10.5555/ao.f20a.other" }));
    expect((await windowStart(pid, other.id)).status).toBe(200);
    const busy = await browserStart(pid, e.id);
    expect([busy.status, busy.json.error.reason, busy.json.error.message]).toEqual([409, "library-busy", "Another work is waiting for its file, in the sign-in window or in your browser. Finish or cancel it first."]);
    expect(busy.json.error.message).toBe(FIND_LIBRARY_TEXT.busy);
    await cancel(pid, other.id);
    expect((await browserStart(pid, e.id)).status).toBe(200);
    const busy2 = await windowStart(pid, other.id);
    expect([busy2.status, busy2.json.error.reason]).toEqual([409, "library-busy"]);
    await cancel(pid, e.id);
    // Not offered (no DOI), no library set.
    const bare = await resting(pid, { state: "no-open-copy" }, await record(pid, { doi: null }));
    expect((await browserStart(pid, bare.id)).json.error.reason).toBe("library-not-offered");
    await setLibrary({ name: "", access: null });
    expect((await browserStart(pid, e.id)).json.error.reason).toBe("no-library");
    expect((await view(pid, e.id)).state).toBe("no-open-copy");
  });

  it("the pause after a hand-over from the browser holds every start, and the limit of waiting files refuses it", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    expect((await sendFile(ticket!, await goodPdf())).json.outcome).toBe("held");
    const f = await resting(pid, { state: "no-open-copy" }, await record(pid, { doi: "10.5555/ao.f20a.next" }));
    const paused = await browserStart(pid, f.id);
    expect([paused.status, paused.json.error.reason, paused.json.error.message]).toEqual([409, "library-pause", "Ready in 20 seconds."]);
    expect((await windowStart(pid, f.id)).json.error.reason).toBe("library-pause");
    expect((await view(pid, e.id)).state).toBe("needs-check");
    void LIBRARY_PAUSE_MS;
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("R348 e: the view — browserStart, waitingIn, library.lastFileFrom", () => {
  it("the table: each resting state and reason, a file, one waiting for the check, at work, no library, the rules, paired or not", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    const RESTS: Rest[] = [
      { state: "no-open-copy" },
      { state: "no-open-copy", reason: { code: "copy-some-unreachable" } },
      { state: "no-open-copy", reason: { code: "not-this-file" } },
      { state: "no-open-copy", reason: { code: "library-unfinished" } },
      { state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } },
      { state: "record-complete", reason: { code: "switched-off", by: "settings" } },
    ];
    const NOT: Rest[] = [
      { state: "no-open-copy", reason: { code: "record-removed" } },
      { state: "record-complete" },
      { state: "failed", reason: { code: "unreachable" } },
      { state: "in-library" },
    ];
    const offered = [];
    for (const r of RESTS) offered.push(await resting(pid, r, await record(pid, { doi: `10.5555/ao.f20a.r${offered.length}` })));
    const not = [];
    for (const r of NOT) not.push(await resting(pid, r, await record(pid, { doi: `10.5555/ao.f20a.n${not.length}` })));
    // A record with a file; one with a file waiting for the check.
    const withFile = await resting(pid, { state: "no-open-copy" }, await record(pid, { doi: "10.5555/ao.f20a.file" }));
    const mine = join(tmp, "mine.pdf");
    await writeFile(mine, await buildPdf({ title: "Mine", lines: ["Mine"] }));
    const { addCapturedOriginal } = await import("../../../packages/library/src/repo/repo.js");
    await addCapturedOriginal(repo(), pid, withFile.sourceId!, { fromPath: mine, kind: "pdf", ext: "pdf", mime: "application/pdf", label: "mine" }, "manual_upload");
    const sid = await record(pid, { doi: "10.5555/ao.f20a.wait" });
    const waitingFor = await resting(pid, { state: "no-open-copy" }, sid);
    const holder = await resting(pid, { state: "fetching" }, sid);
    await holdMismatchedFileIn(repo(), pid, {
      entry: { ...holder, state: "needs-check", reason: { code: "file-title-absent" } },
      sourceId: sid,
      fromPath: mine,
      facts: { why: "title-absent", kind: "pdf", bytes: 1, acquired: { method: "library_access", via: "sign-in-window", address: "https://arxiv.org/pdf/1", at: new Date().toISOString(), tool: { name: "find-and-acquire", version: "0" }, access: "signed-in-session" } },
    });
    const notOffered = [...not, withFile, waitingFor];
    // Not paired: no browserStart anywhere; the library's own view as before.
    let q = await queue(pid);
    for (const x of q.entries) expect(x, x.state).not.toHaveProperty("browserStart");
    for (const o of offered) expect(q.entries.find((x) => x.id === o.id)!.library).toEqual({ canStart: true });
    // Paired: exactly the entries offered a library start.
    extToken = await pairExtension();
    q = await queue(pid);
    for (const o of offered) expect(q.entries.find((x) => x.id === o.id)!.browserStart, JSON.stringify(o.reason)).toBe(true);
    for (const o of notOffered) expect(q.entries.find((x) => x.id === o.id), o.state).not.toHaveProperty("browserStart");
    // No library set: "no-library", no browserStart.
    await setLibrary({ name: "", access: null });
    q = await queue(pid);
    for (const o of offered) {
      const v = q.entries.find((x) => x.id === o.id)!;
      expect(v.library).toEqual({ canStart: false, reason: "no-library" });
      expect(v).not.toHaveProperty("browserStart");
    }
    await setLibrary();
    // The rules forbid library_access, or keeping the file (a legal basis needed and none): none.
    const IDENT = (basis: boolean) => GOV().replace("containsIdentifiable: false", "containsIdentifiable: true\n  pseudonymizeFileNames: false").replace("requireLegalBasis: false", `requireLegalBasis: ${basis}`);
    for (const [first, then] of [
      [GOV("acquireMethods: [reference_lookup, free_copy]\n"), undefined],
      [IDENT(false), IDENT(true)],
    ] as const) {
      const p2 = await newProject({ gov: first });
      const x = await resting(p2, { state: "no-open-copy" }, await record(p2, { identifiable: then !== undefined }));
      if (then) {
        expect((await view(p2, x.id)).browserStart).toBe(true);
        const g = await call({ url: `/projects/${p2}/governance` });
        expect((await call({ method: "PUT", url: `/projects/${p2}/governance`, body: { yaml: then, reason: "test" }, headers: { "if-match": String(g.headers.etag) } })).status).toBe(200);
      }
      const v = await view(p2, x.id);
      expect(v.library?.canStart === true).toBe(false);
      expect(v).not.toHaveProperty("browserStart");
    }
    // Waiting in the window: no waitingIn; in the browser: "browser"; neither carries browserStart.
    const [a, b] = offered;
    expect((await windowStart(pid, a!.id)).status).toBe(200);
    let va = await view(pid, a!.id);
    expect([va.state, va.waitingIn, va.windowStart, va.browserStart]).toEqual(["waiting-sign-in", undefined, undefined, undefined]);
    await cancel(pid, a!.id);
    expect((await browserStart(pid, b!.id)).status).toBe(200);
    const vb = await view(pid, b!.id);
    expect([vb.state, vb.waitingIn, vb.windowStart, vb.browserStart]).toEqual(["waiting-sign-in", "browser", undefined, undefined]);
    // While one waits, the other resting entries are still offered (a press is then refused "busy", as the library's).
    va = await view(pid, a!.id);
    expect(va.browserStart).toBe(true);
  });

  it("after a file from the browser that is not kept: library.lastFile with lastFileFrom \"browser\"", async () => {
    const { pid, e, ticket } = await ready({ gov: GOV(), started: true });
    // The rules change before the file arrives: not kept.
    const g = await call({ url: `/projects/${pid}/governance` });
    const put = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: GOV("acquireMethods: [reference_lookup, free_copy]\n"), reason: "test" }, headers: { "if-match": String(g.headers.etag) } });
    expect(put.status, put.body).toBe(200);
    const r = await sendFile(ticket!, await goodPdf());
    expect(r.json).toEqual({ outcome: "not-kept", sentence: FIND_BROWSER_FILE_TEXT["rules-method"] });
    const v = await view(pid, e.id);
    expect(v.state).toBe("no-open-copy");
    expect(v.library).toMatchObject({ lastFile: "rules-method", lastFileFrom: "browser" });
    expect(v).not.toHaveProperty("waitingIn");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("R348 f, R111, R116: the extension's reach", () => {
  it("both routes answer the extension's token with its paired Origin; refused with no Origin, another extension's Origin, the desktop app's token, no token", async () => {
    const { ticket } = await ready({ started: true });
    expect((await waitingList()).status).toBe(200);
    const routes: Array<(o: { token?: string; origin?: string | null }) => Promise<Answer>> = [(o) => waitingList(o), async (o) => sendFile(ticket!, await goodPdf(), o)];
    for (const send of routes) {
      const noOrigin = await send({ origin: null });
      expect([noOrigin.status, noOrigin.json.error.message]).toEqual([403, "Requests from the browser extension must carry its origin."]);
      const other = await send({ origin: OTHER_EXT });
      expect([other.status, other.json.error.message]).toEqual([403, "Requests from this origin are not allowed."]);
      const app = await send({ token: TOKEN, origin: null });
      expect([app.status, app.json.error.message]).toEqual([403, FIND_BROWSER_TEXT.extensionOnly]);
      const none = await send({ token: "", origin: EXT });
      expect([none.status, none.json.error.message]).toEqual([401, "A valid token is needed."]);
      const unknown = await send({ token: "x".repeat(40), origin: EXT });
      expect([unknown.status, unknown.json.error.message]).toEqual([401, "A valid token is needed."]);
    }
    // The ticket is still open after all of that.
    expect((await waitingList()).json.waiting).toHaveLength(1);
  });

  it("the extension's token still reaches no other find route, the queue, the projects through find, the app's starts or the review queue", async () => {
    const { pid, e } = await ready();
    for (const [method, url] of [
      ["GET", `/projects/${pid}/find`],
      ["POST", `/projects/${pid}/find`],
      ["POST", `/projects/${pid}/find/${e.id}/browser/start`],
      ["POST", `/projects/${pid}/find/${e.id}/library/start`],
      ["POST", `/projects/${pid}/find/${e.id}/library/cancel`],
      ["GET", `/projects/${pid}/review`],
      ["GET", "/find/screen"],
      ["GET", "/settings/your-library"],
    ] as const) {
      const r = await svc!.app.inject({ method, url, headers: { authorization: `Bearer ${extToken}`, origin: EXT } });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.message).toBe("The browser extension cannot use this.");
      errorBodies.push(r.body);
    }
    // A GET of the list (Chrome sends no Origin on a GET) is no route of the extension's.
    const get = await svc!.app.inject({ method: "GET", url: "/find/browser/waiting", headers: { authorization: `Bearer ${extToken}` } });
    expect(get.statusCode).toBe(403);
    errorBodies.push(get.body);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("R348 f 1: the list — POST /find/browser/waiting", () => {
  it("exactly { waiting: [{ ticket, label }] }: nothing else of the record or the project; no-store", async () => {
    const { pid, e, url } = await ready({ started: true });
    const r = await waitingList();
    expect(r.status, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(r.json)).toEqual(["waiting"]);
    expect(r.json.waiting).toHaveLength(1);
    expect(Object.keys(r.json.waiting[0]).sort()).toEqual(["label", "ticket"]);
    expect(r.json.waiting[0].label).toBe(TITLE);
    expect(r.json.waiting[0].ticket).toMatch(/^[0-9a-f]{32}$/u);
    for (const s of [pid, e.id, e.sourceId!, DOI, LIB_HOST, url!, "Mirabelle", "1999"]) expect(r.body).not.toContain(s);
  });

  it("empty — never an error — with no library open, nothing waiting, a work waiting in the WINDOW, a locked project", async () => {
    await start();
    extToken = await pairExtension();
    expect((await waitingList()).json).toEqual({ waiting: [] });
    await openNewLibrary();
    await setLibrary();
    const pid = await newProject({ encrypted: true });
    const e = await resting(pid);
    expect((await waitingList()).json).toEqual({ waiting: [] });
    expect((await windowStart(pid, e.id)).status).toBe(200);
    expect((await waitingList()).json).toEqual({ waiting: [] });
    await cancel(pid, e.id);
    expect((await browserStart(pid, e.id)).status).toBe(200);
    const listed = (await waitingList()).json.waiting as Array<{ ticket: string }>;
    expect(listed).toHaveLength(1);
    // A lock ends the ticket at once (the library start's way back): nothing listed, the ticket refused; the entry
    // comes back at the unlock.
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect((await waitingList()).json).toEqual({ waiting: [] });
    expect((await sendFile(listed[0]!.ticket, await goodPdf())).json.error.reason).toBe("browser-not-waiting");
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await until(async () => (await view(pid, e.id)).state === "no-open-copy", "the entry to come back at the unlock");
    expect((await waitingList()).json).toEqual({ waiting: [] });
  });

  it("a body other than {} is refused (400), and so is another content type", async () => {
    await ready({ started: true });
    for (const body of ['{"x":1}', "[]", "null", '"{}"', "1"]) {
      const r = await waitingList({ body });
      expect([r.status, r.json.error.message], body).toEqual([400, FIND_BROWSER_TEXT.listBody]);
    }
    const none = answerOf(await svc!.app.inject({ method: "POST", url: "/find/browser/waiting", headers: { authorization: `Bearer ${extToken}`, origin: EXT } }));
    expect([none.status, none.json.error.message]).toEqual([400, FIND_BROWSER_TEXT.listBody]);
    expect((await waitingList({ body: "x", contentType: "text/plain" })).status).toBe(400);
  });

  it("the label: the title cut to 200 characters counted as code points (never half a surrogate pair), passed as it is — markup, control characters, right-to-left overrides; (no title) without one", () => {
    expect(browserLabel("")).toBe(FIND_BROWSER_NO_TITLE);
    expect(browserLabel("<b>Bold</b> &amp; ‮evil\u0007")).toBe("<b>Bold</b> &amp; ‮evil\u0007");
    const astral = "𝔄".repeat(300);
    const cut = browserLabel(astral);
    expect([...cut]).toHaveLength(FIND_BROWSER_LABEL_MAX);
    expect(cut).toBe("𝔄".repeat(200));
    expect(/\p{Cs}/u.test(cut)).toBe(false);
    const mixed = `${"a".repeat(199)}𝔄𝔄`;
    expect(browserLabel(mixed)).toBe(`${"a".repeat(199)}𝔄`);
    expect(browserLabel("x".repeat(1024 * 1024))).toBe("x".repeat(200));
    // A lone surrogate already in a title is passed as it is (the label is text, shown as text).
    expect(browserLabel("a\uD800b")).toBe("a\uD800b");
  });

  it("the label through the route: a hostile title of a megabyte comes back cut and as it is", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    extToken = await pairExtension();
    const hostile = `<script>alert(1)</script>‮\u0007 ${"𝔄".repeat(1024 * 256)}`;
    const e = await resting(pid, { state: "no-open-copy" }, await record(pid, { title: hostile }));
    expect((await browserStart(pid, e.id)).status).toBe(200);
    const label = (await waitingList()).json.waiting[0].label as string;
    expect([...label]).toHaveLength(200);
    expect(label.startsWith("<script>alert(1)</script>‮\u0007 𝔄")).toBe(true);
    expect(/\p{Cs}/u.test(label)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("R348 f 2: the file — POST /find/browser/file/:ticket, in the ruling's order", () => {
  it("(i) a wrong, malformed, upper-case, used or window's ticket: 404 browser-not-waiting, the same answer for each, the body not taken", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const answers = [];
    for (const t of ["0".repeat(32), ticket!.toUpperCase(), "abc", "g".repeat(32), `${ticket}0`, `${ticket}%2F`]) {
      const r = await sendFile(t, await goodPdf());
      answers.push([r.status, r.body]);
    }
    for (const a of answers) expect(a).toEqual([404, JSON.stringify({ error: { code: "NOT_FOUND", message: FIND_BROWSER_TEXT.notWaiting, reason: "browser-not-waiting" } })]);
    // An address too long to be routed at all is the framework's refusal; nothing is taken either.
    expect((await sendFile("x".repeat(5000), await goodPdf())).status).toBe(400);
    expect(await inboxFiles()).toEqual([]);
    // A window's ticket given to the extension's route: the same 404, and it stays open for the window.
    await cancel(pid, e.id);
    const w = await windowStart(pid, e.id);
    const r = await sendFile(w.json.ticket, await goodPdf());
    expect([r.status, r.json.error.reason]).toEqual([404, "browser-not-waiting"]);
    expect(svc!.state.session!.find!.waitingIn(pid, e.id)).toBe("window");
    expect(svc!.state.session!.find!.libraryHandedOver(w.json.ticket, "window")).not.toBeNull();
  });

  it("(ii) x-ao-page: absent, not https, a user name or password, over 2,048 characters, unparsable — 400 browser-page; the ticket stays open", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    for (const page of [null, "http://pdfs.example.com/a.pdf", "https://u:p@pdfs.example.com/a.pdf", "https://user@pdfs.example.com/a.pdf", `https://pdfs.example.com/${"a".repeat(2030)}`, "not an address", "file:///etc/passwd", "javascript:alert(1)"]) {
      const r = await sendFile(ticket!, await goodPdf(), { page });
      expect([r.status, r.json.error.code, r.json.error.reason, r.json.error.message], String(page).slice(0, 30)).toEqual([400, "VALIDATION", "browser-page", FIND_BROWSER_TEXT.page]);
    }
    expect(await inboxFiles()).toEqual([]);
    // Exactly 2,048 characters is taken.
    const longest = `https://${TAB_HOST}/${"a".repeat(2048 - `https://${TAB_HOST}/`.length)}`;
    expect(longest).toHaveLength(2048);
    const ok = await sendFile(ticket!, await goodPdf(), { page: longest });
    expect(ok.json.outcome).toBe("held");
    expect((await view(pid, e.id)).state).toBe("needs-check");
    // Its record keeps no address over 2,000 characters (cleanAcquiredAddress's own bound, as for the window's).
    const { projectReviewEntries } = await import("../../../packages/library/src/repo/repo.js");
    const [held] = (await projectReviewEntries(repo(), pid)).filter((x) => x.heldFile);
    expect(held!.heldFile!.acquired).toMatchObject({ via: "browser-extension", address: "" });
  });

  it("(iii) one file at a time for the whole service: a second request while the first is being taken gets 409 browser-busy and does not disturb the first", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    const slow = new PassThrough();
    const first = sendFile(ticket!, slow);
    slow.write(pdf.subarray(0, 100));
    await until(async () => (await inboxFiles()).length === 1, "the first file to be streamed in");
    const second = await sendFile(ticket!, pdf);
    expect([second.status, second.json.error.code, second.json.error.reason, second.json.error.message]).toEqual([409, "CONFLICT", "browser-busy", FIND_BROWSER_TEXT.busy]);
    // A wrong ticket meanwhile is still the 404 (checked first).
    expect((await sendFile("0".repeat(32), pdf)).status).toBe(404);
    slow.end(pdf.subarray(100));
    const done = await first;
    expect(done.json).toEqual({ outcome: "held", sentence: FIND_BROWSER_TEXT.held });
    expect((await view(pid, e.id)).state).toBe("needs-check");
    expect(await inboxFiles()).toEqual([]);
  });

  it("(iv) larger than the hand-over's limit: 413 browser-too-large — declared, and streamed without a length; the ticket stays open; nothing written about the file", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    // Declared over the limit: refused without taking the body.
    const declared = await sendFile(ticket!, Buffer.from("%PDF-1.4 small"), { headers: { "content-length": String(LIBRARY_FILE_MAX_BYTES + 1) } });
    expect([declared.status, declared.json.error.code, declared.json.error.reason, declared.json.error.message]).toEqual([413, "PAYLOAD_TOO_LARGE", "browser-too-large", FIND_BROWSER_TEXT.tooLarge]);
    // Streamed (chunked) past the limit: cut at limit + 1 byte.
    const head = Buffer.alloc(4 * 1024 * 1024, 0x20);
    head.write("%PDF-1.4", 0);
    const rest = Buffer.alloc(4 * 1024 * 1024, 0x20);
    let sent = 0;
    const big = new Readable({
      read() {
        if (sent > LIBRARY_FILE_MAX_BYTES) return void this.push(null);
        const c = sent === 0 ? head : rest;
        sent += c.length;
        this.push(c);
      },
    });
    const streamed = await sendFile(ticket!, big);
    expect([streamed.status, streamed.json.error.reason]).toEqual([413, "browser-too-large"]);
    expect(await inboxFiles()).toEqual([]);
    expect(await reviewItems(pid)).toEqual([]);
    await stillServes(pid, e, ticket!);
  }, 120_000);

  it("(iv) its first five bytes not %PDF-: 400 browser-not-pdf (an empty body too); the ticket stays open", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    for (const body of [Buffer.from("<html><body>Sign in</body></html>"), Buffer.from("%PDF"), Buffer.from(" %PDF-1.4"), Buffer.alloc(0)]) {
      const r = await sendFile(ticket!, body);
      expect([r.status, r.json.error.code, r.json.error.reason, r.json.error.message], body.toString()).toEqual([400, "VALIDATION", "browser-not-pdf", FIND_BROWSER_TEXT.notPdf]);
    }
    expect(await inboxFiles()).toEqual([]);
    await stillServes(pid, e, ticket!);
  });

  it("(iv) cut off — fewer bytes than declared, a stream that fails — 400 browser-cut-off; the ticket stays open", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    const short = await sendFile(ticket!, pdf.subarray(0, 200), { headers: { "content-length": String(pdf.length) } });
    expect([short.status, short.json.error.code, short.json.error.reason, short.json.error.message]).toEqual([400, "VALIDATION", "browser-cut-off", FIND_BROWSER_TEXT.cutOff]);
    const failing = new PassThrough();
    const p = sendFile(ticket!, failing);
    failing.write(pdf.subarray(0, 300));
    await until(async () => (await inboxFiles()).length === 1, "the file to be streamed in");
    failing.destroy(new Error("connection lost"));
    // The test's client sees its own request fail; the service ends the take as cut off.
    await p.catch(() => undefined);
    await until(async () => (await inboxFiles()).length === 0, "the inbox to be emptied");
    await until(async () => (await waitingList()).json.waiting.length === 1 && (await sendFile("0".repeat(32), Buffer.alloc(0))).status === 404, "the take to end");
    await stillServes(pid, e, ticket!);
  });

  it("(iv) stalled — no byte for the stall time (the test's switch, not a real wait) — 400 browser-cut-off; the ticket stays open", async () => {
    const { pid, e, ticket } = await ready({ started: true, stallMs: 300 });
    const pdf = await goodPdf();
    const stalled = new PassThrough();
    const p = sendFile(ticket!, stalled);
    stalled.write(pdf.subarray(0, 300));
    const r = await p;
    expect([r.status, r.json.error.reason, r.json.error.message]).toEqual([400, "browser-cut-off", FIND_BROWSER_TEXT.cutOff]);
    stalled.destroy();
    expect(await inboxFiles()).toEqual([]);
    await stillServes(pid, e, ticket!);
  });

  it("a real connection cut mid-body: nothing kept, the inbox emptied, the ticket stays open", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const port = await svc!.listen(0);
    host = { host: `127.0.0.1:${port}` };
    const pdf = await goodPdf();
    await new Promise<void>((resolve) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(
          `POST /find/browser/file/${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${extToken}\r\nOrigin: ${EXT}\r\nContent-Type: application/pdf\r\nx-ao-page: ${TAB}\r\nContent-Length: ${pdf.length}\r\n\r\n`,
        );
        sock.write(pdf.subarray(0, 400));
        setTimeout(() => {
          sock.destroy();
          resolve();
        }, 200);
      });
      sock.on("error", () => undefined);
    });
    await until(async () => (await inboxFiles()).length === 0, "the inbox to be emptied");
    expect((await view(pid, e.id)).state).toBe("waiting-sign-in");
    await stillServes(pid, e, ticket!);
  });

  it("the body is streamed: a body far past the service's JSON limit (1 MB) goes through this route's own parser in pieces", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    // The PDF followed by 6 MB of trailing spaces (still a PDF by its bytes), sent in 64 KiB pieces.
    const pad = Buffer.alloc(64 * 1024, 0x20);
    let left = 96;
    let first = true;
    const body = new Readable({
      read() {
        if (first) {
          first = false;
          return this.push(pdf);
        }
        if (left-- > 0) return this.push(pad);
        return this.push(null);
      },
    });
    const r = await sendFile(ticket!, body);
    expect(r.json.outcome, r.body).toBe("held");
    const [item] = await reviewItems(pid);
    expect(item!.heldFile.bytes).toBe(pdf.length + 96 * pad.length);
    expect((await view(pid, e.id)).state).toBe("needs-check");
  });

  it("application/pdf is taken by this route only: another route still refuses that content type as before; another content type here is refused", async () => {
    const { ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    const capture = answerOf(await svc!.app.inject({ method: "POST", url: "/capture/browser", headers: { authorization: `Bearer ${extToken}`, origin: EXT, "content-type": "application/pdf" }, payload: pdf }));
    expect([capture.status, capture.json.error.code, capture.json.error.message]).toEqual([400, "VALIDATION", "The request body is not valid JSON."]);
    const app = answerOf(await svc!.app.inject({ method: "POST", url: "/projects", headers: { ...auth, "content-type": "application/pdf" }, payload: pdf }));
    expect([app.status, app.json.error.message]).toEqual([400, "The request body is not valid JSON."]);
    const json = await sendFile(ticket!, JSON.stringify({ pdf: "x" }), { contentType: "application/json" });
    expect(json.status).toBe(400);
    expect(await inboxFiles()).toEqual([]);
    expect((await waitingList()).json.waiting).toHaveLength(1);
  });

  it("(v) cancelled while the file arrived: the seam answers null — the not-waiting answer; nothing kept", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    const slow = new PassThrough();
    const p = sendFile(ticket!, slow);
    slow.write(pdf.subarray(0, 100));
    await until(async () => (await inboxFiles()).length === 1, "the file to be streamed in");
    expect((await cancel(pid, e.id)).status).toBe(200);
    slow.end(pdf.subarray(100));
    const r = await p;
    expect([r.status, r.json.error.reason, r.json.error.message]).toEqual([404, "browser-not-waiting", FIND_BROWSER_TEXT.notWaiting]);
    expect(await inboxFiles()).toEqual([]);
    expect(await reviewItems(pid)).toEqual([]);
    expect((await view(pid, e.id)).state).toBe("no-open-copy");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("R348 f vi, g: after the seam — { outcome, sentence }", () => {
  it("held: the ticket ended, the pause started, the file waits; the inbox empty", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const r = await sendFile(ticket!, await goodPdf());
    expect([r.status, r.json, r.headers["cache-control"]]).toEqual([200, { outcome: "held", sentence: FIND_BROWSER_TEXT.held }, "no-store"]);
    expect((await view(pid, e.id)).state).toBe("needs-check");
    expect((await waitingList()).json).toEqual({ waiting: [] });
    expect((await sendFile(ticket!, await goodPdf())).json.error.reason).toBe("browser-not-waiting");
    expect(await inboxFiles()).toEqual([]);
  });

  it("not-kept: the rules came to need a legal basis the record has not — the row's sentence; the entry back at rest", async () => {
    const IDENT = (basis: boolean) => GOV().replace("containsIdentifiable: false", "containsIdentifiable: true\n  pseudonymizeFileNames: false").replace("requireLegalBasis: false", `requireLegalBasis: ${basis}`);
    await start();
    await openNewLibrary();
    const pid = await newProject({ gov: IDENT(false) });
    await setLibrary();
    extToken = await pairExtension();
    const e = await resting(pid, { state: "no-open-copy" }, await record(pid, { identifiable: true }));
    expect((await browserStart(pid, e.id)).status).toBe(200);
    const ticket = (await waitingList()).json.waiting[0].ticket as string;
    const g = await call({ url: `/projects/${pid}/governance` });
    expect((await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: IDENT(true), reason: "test" }, headers: { "if-match": String(g.headers.etag) } })).status).toBe(200);
    const r = await sendFile(ticket, await goodPdf());
    expect([r.status, r.json]).toEqual([200, { outcome: "not-kept", sentence: FIND_BROWSER_FILE_TEXT["rules-legal-basis"] }]);
    expect(r.json.sentence).toBe("The file sent from your browser was not kept: this project's rules need a legal basis to store the file for this record, and the record has none.");
    const v = await view(pid, e.id);
    expect(v.state).toBe("no-open-copy");
    expect(v.library).toMatchObject({ lastFile: "rules-legal-basis", lastFileFrom: "browser" });
    expect(await reviewItems(pid)).toEqual([]);
    expect(await inboxFiles()).toEqual([]);
  });

  it("gone: the record gained a file meanwhile; the record deleted; the entry removed", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const mine = join(tmp, "mine.pdf");
    await writeFile(mine, await buildPdf({ title: "Mine", lines: ["Mine"] }));
    const { addCapturedOriginal } = await import("../../../packages/library/src/repo/repo.js");
    await addCapturedOriginal(repo(), pid, e.sourceId!, { fromPath: mine, kind: "pdf", ext: "pdf", mime: "application/pdf", label: "mine" }, "manual_upload");
    const r = await sendFile(ticket!, await goodPdf());
    expect([r.status, r.json]).toEqual([200, { outcome: "gone", sentence: FIND_BROWSER_TEXT.gone }]);
    expect((await view(pid, e.id)).state).toBe("in-library");
    expect(await inboxFiles()).toEqual([]);
  });

  it("the shell's line with a browser's ticket: nothing happens (the file is discarded, as for a wrong ticket); then the extension's route with the same ticket succeeds", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const inbox = inboxOf(svc!.state.deps.appConfigDir);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await chmod(inbox, 0o700);
    const grant = "0123456789abcdef0123456789abcdef";
    const f = join(inbox, `${grant}.pdf`);
    await writeFile(f, await goodPdf(), { mode: 0o600 });
    const input = new PassThrough();
    const p = readStartupToken({ input, env: { PATH: "/usr/bin" }, argv: ["/usr/bin/node", "/x/main.ts"], execArgv: [], timeoutMs: 2000 });
    input.write(`${TOKEN}\n`);
    await p;
    onInputLines(input, inputLineHandler(svc!.folderGrants, libraryFileHandler(svc!.state)), () => {});
    input.write(`${JSON.stringify({ type: "file-grant", id: grant, ticket, path: f })}\n`);
    await until(async () => !(await lstat(f).then(() => true, () => false)), "the inbox file to go");
    await new Promise((r) => setTimeout(r, 100));
    const v = await view(pid, e.id);
    expect([v.state, v.waitingIn]).toEqual(["waiting-sign-in", "browser"]);
    expect(await reviewItems(pid)).toEqual([]);
    // No pause was started: the browser's own side takes the same ticket.
    await stillServes(pid, e, ticket!);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("the inbox: <AO_CONFIG_DIR>/browser-inbox", () => {
  it("made 0700 and each file 0600, named 32 hex .pdf, removed in every outcome", async () => {
    const { ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    const slow = new PassThrough();
    const p = sendFile(ticket!, slow);
    slow.write(pdf.subarray(0, 100));
    await until(async () => (await inboxFiles()).length === 1, "the file to be streamed in");
    const [name] = await inboxFiles();
    expect(name).toMatch(/^[0-9a-f]{32}\.pdf$/u);
    expect(name).not.toContain(ticket!);
    if (process.platform !== "win32") {
      expect((await lstat(inboxOfService())).mode & 0o777).toBe(0o700);
      expect((await lstat(join(inboxOfService(), name!))).mode & 0o777).toBe(0o600);
    }
    slow.end(pdf.subarray(100));
    expect((await p).json.outcome).toBe("held");
    expect(await inboxFiles()).toEqual([]);
    expect(BROWSER_INBOX).toBe("browser-inbox");
  });

  it("emptied at the service's start: regular files directly inside only — a link is not followed out of it, a subfolder and what is in it are left", async () => {
    const inbox = join(deps.appConfigDir, "browser-inbox");
    await mkdir(join(inbox, "sub"), { recursive: true, mode: 0o700 });
    await chmod(inbox, 0o700);
    await writeFile(join(inbox, `${"a".repeat(32)}.pdf`), "%PDF-1.4 leftover");
    await writeFile(join(inbox, "other.txt"), "leftover");
    await writeFile(join(inbox, "sub", "kept.pdf"), "kept");
    const outside = join(tmp, "outside.pdf");
    await writeFile(outside, "outside");
    await symlink(outside, join(inbox, `${"b".repeat(32)}.pdf`));
    await start();
    const left = (await readdir(inbox)).sort();
    expect(left).toEqual([`${"b".repeat(32)}.pdf`, "sub"]);
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readFile(join(inbox, "sub", "kept.pdf"), "utf8")).toBe("kept");
  });

  it("an inbox that is a link, or open to others, is not emptied (not the app's private folder)", async () => {
    const real = join(tmp, "elsewhere");
    await mkdir(real, { recursive: true, mode: 0o700 });
    await writeFile(join(real, "x.pdf"), "x");
    await mkdir(deps.appConfigDir, { recursive: true });
    await symlink(real, join(deps.appConfigDir, "browser-inbox"));
    await start();
    expect(await readdir(real)).toEqual(["x.pdf"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("nothing leaks: the ticket in the path is never logged", () => {
  it("logUrl redacts the file route's ticket in every spelling — plain, encoded separators, upper case, doubled slashes, over-long, malformed", () => {
    const t = "0123456789abcdef0123456789abcdef";
    for (const url of [
      `/find/browser/file/${t}`,
      `/find/browser/file/${t}?x=1`,
      `/find%2Fbrowser%2Ffile%2F${t}`,
      `/FIND/Browser/FILE/${t}`,
      `//find//browser//file//${t}`,
      `/find/browser/file/${t}${"f".repeat(5000)}`,
      `/find/browser/file/${t}%zz`,
      `/find/browser/file/${t.slice(0, 10)}%2F${t.slice(10)}`,
      `/find%252Fbrowser%252Ffile%252F${t}`,
      `/find\\browser\\file\\${t}`,
    ]) {
      const logged = logUrl(url);
      expect(logged, url.slice(0, 50)).toBe("/find/browser/file/[redacted]");
      expect(logged).not.toContain(t.slice(0, 8));
    }
    expect(logUrl("/find/browser/waiting")).toBe("/find/browser/waiting");
  });

  it("the whole way at debug level: no ticket, tab address or title in any log line, error, event, audit or queue file (the afterEach looks)", async () => {
    const { ticket } = await ready({ started: true });
    for (const t of [ticket!, "0".repeat(32)]) await sendFile(t, Buffer.from("<html>"), { page: TAB });
    await sendFile(ticket!, await goodPdf(), { page: "http://insecure.tabhost-f20a.example.com/?accessToken=tabsecretf20a" });
    expect((await sendFile(ticket!, await goodPdf())).json.outcome).toBe("held");
    expect(logs).toContain("/find/browser/file/[redacted]");
    expect(logs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("R348 j: the whole way at the service", () => {
  it("the app starts the browser wait; the extension lists it (title only), sends a PDF with a tab address; it is held; the review queue has it with its record; only \"Use this file\" attaches it", async () => {
    const { pid, e } = await ready();
    // The app's token starts the wait: the address only.
    const s = await browserStart(pid, e.id);
    expect(s.json).toEqual({ url: `${EZ.base}https://doi.org/${DOI}` });
    // The extension's token lists it: its ticket and the title, nothing else.
    const list = await waitingList();
    expect(list.json).toEqual({ waiting: [{ ticket: expect.stringMatching(/^[0-9a-f]{32}$/u), label: TITLE }] });
    const ticket = list.json.waiting[0].ticket as string;
    // The extension sends the tab's PDF.
    const sent = await sendFile(ticket, await goodPdf(), { page: TAB });
    expect(sent.json).toEqual({ outcome: "held", sentence: FIND_BROWSER_TEXT.held });
    // The review queue has the entry with the file's record; nothing was attached before the decision (R301).
    expect((await call({ url: `/projects/${pid}/sources/${e.sourceId}` })).json.assets).toEqual([]);
    const items = await reviewItems(pid);
    const item = items.find((x) => x.cause?.findEntryId === e.id)!;
    expect(item).toMatchObject({ sourceId: e.sourceId, kind: "verification", group: "found-file", heldFile: { why: "looks-right", kind: "pdf" } });
    // The review route gives the evidence only (never how the file was got); the entry as the library holds it:
    const { projectReviewEntries } = await import("../../../packages/library/src/repo/repo.js");
    const stored = (await projectReviewEntries(repo(), pid)).find((x) => x.id === item.id)!;
    expect(stored.heldFile!.acquired).toEqual({ method: "library_access", via: "browser-extension", address: TAB_KEPT, access: "signed-in-session", at: expect.any(String), tool: { name: expect.any(String), version: expect.any(String) } });
    expect((await view(pid, e.id)).state).toBe("needs-check");
    // "Use this file" attaches it; the source's file carries the record.
    const used = await call({ method: "POST", url: `/review/${item.id as string}/held-file`, body: { projectId: pid, decision: "attach" } });
    expect(used.status, used.body).toBe(200);
    const after = await repo().getSource(pid, e.sourceId!);
    expect(after.assets[0]!.acquired).toMatchObject({ method: "library_access", via: "browser-extension", address: TAB_KEPT, access: "signed-in-session" });
    expect((await view(pid, e.id)).state).toBe("in-library");
    expect(await inboxFiles()).toEqual([]);
    // A request to the network was never made (afterEach), and nothing leaked.
  });
});

// ---------------------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** One request written on a real socket; resolves with what came back (the head and whatever followed) once the server answers. */
async function rawRequest(port: number, head: string, body: Buffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let got = "";
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(head);
      sock.write(body);
    });
    sock.on("data", (d) => {
      got += d.toString("latin1");
      if (/\r\n\r\n[\s\S]*\}/u.test(got)) {
        sock.destroy();
        resolve(got);
      }
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(got));
  });
}
const pairingIds = async () => ((await call({ url: "/extension/pairings" })).json.extensions as Array<{ id: string; origin: string }>);
const unpair = (id: string) => call({ method: "DELETE", url: `/extension/pairings/${id}` });

describe("R353: F20a's round 2", () => {
  it("(a) M1: a body trickled one byte inside every stall window is ended at the overall limit, counted from the ticket's check — cut off, the connection closed, the flag released, the ticket open, the inbox emptied", async () => {
    const { pid, e, ticket } = await ready({ started: true, stallMs: 400, takeMs: 1500 });
    const pdf = await goodPdf();
    const slow = new PassThrough();
    const t0 = Date.now();
    const p = sendFile(ticket!, slow);
    slow.write(pdf.subarray(0, 100));
    let i = 100;
    const drip = setInterval(() => {
      if (i < pdf.length - 1) slow.write(pdf.subarray(i, ++i));
    }, 150);
    try {
      const r = await p;
      const took = Date.now() - t0;
      expect([r.status, r.json.error.code, r.json.error.reason, r.json.error.message]).toEqual([400, "VALIDATION", "browser-cut-off", FIND_BROWSER_TEXT.cutOff]);
      expect(r.headers.connection).toBe("close");
      expect(took).toBeGreaterThanOrEqual(1400);
      expect(took).toBeLessThan(10_000);
    } finally {
      clearInterval(drip);
      slow.destroy();
    }
    expect(await inboxFiles()).toEqual([]);
    await stillServes(pid, e, ticket!);
  });

  it("(b) M2: logUrl writes [redacted] for every path segment of exactly 32 hexadecimal digits, wherever it stands and in either case; an ordinary path with a project's id is logged as before", () => {
    const t = "0123456789abcdef0123456789abcdef";
    const T = t.toUpperCase();
    for (const [url, want] of [
      [`/find/browser/./file/${t}`, "/find/browser/./file/[redacted]"],
      // `file;` is a segment of its own, not a ticket; the ticket's own segment after it goes.
      [`/find/browser/file;/${t}`, "/find/browser/file;/[redacted]"],
      [`/x/find/browser/file/${t}`, "/x/find/browser/file/[redacted]"],
      [`/find/browser/files/${t}`, "/find/browser/files/[redacted]"],
      [`/find/browser/waiting/${t}`, "/find/browser/waiting/[redacted]"],
      [`/find/browser/waiting/${T}`, "/find/browser/waiting/[redacted]"],
      [`/${t}`, "/[redacted]"],
      [`/a/${t}/b?x=${t}`, "/a/[redacted]/b"],
      [`/find/browser/files/${t}/`, "/find/browser/files/[redacted]/"],
      // Decoded as for the media path: an encoded separator still bounds the segment.
      [`/x%2F${t}`, "/x/[redacted]"],
      [`/x%252F${t}%252Fy`, "/x/[redacted]/y"],
      // A ticket with other characters in the same segment (not exactly 32 hex digits, but bounded by them): it goes too.
      [`/find/browser/files/${t};x`, "/find/browser/files/[redacted];x"],
      [`/find/browser/files/x;${t}`, "/find/browser/files/x;[redacted]"],
    ] as const) {
      const logged = logUrl(url);
      expect(logged, url).toBe(want);
      expect(logged).not.toContain(t.slice(0, 8));
      expect(logged).not.toContain(T.slice(0, 8));
    }
    // Not a ticket: 31 or 33 hex digits within a longer run of ticket characters is left (the 40-run rule as before).
    expect(logUrl(`/x/${t.slice(1)}`)).toBe(`/x/${t.slice(1)}`);
    // Ordinary paths, as before.
    const pid = "019a4f2e-7c1d-7b3a-8e2f-0123456789ab";
    const eid = "019a4f2e-7c1d-7b3a-8e2f-ba9876543210";
    for (const url of [`/projects/${pid}/find/${eid}/browser/start`, `/projects/${pid}/sources`, "/find/browser/waiting", `/projects/${pid.replace(/-/gu, "")}x`]) expect(logUrl(url)).toBe(url.split("?")[0]);
  });

  it("(c) M3: the preflight of the file route from the paired Origin allows x-ao-page; nothing else of it changes", async () => {
    await ready({ started: true });
    const t = "0".repeat(32);
    const pre = await svc!.app.inject({ method: "OPTIONS", url: `/find/browser/file/${t}`, headers: { ...host, origin: EXT, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, x-ao-page" } });
    expect(pre.statusCode).toBe(204);
    expect(String(pre.headers["access-control-allow-headers"]).split(/,\s*/u).sort()).toEqual(["authorization", "content-type", "x-ao-page"]);
    expect([pre.headers["access-control-allow-origin"], pre.headers["access-control-allow-methods"], pre.headers["access-control-max-age"]]).toEqual([EXT, "GET, POST, PUT, PATCH, DELETE", "600"]);
    // Another Origin: refused as before.
    expect((await svc!.app.inject({ method: "OPTIONS", url: `/find/browser/file/${t}`, headers: { ...host, origin: OTHER_EXT, "access-control-request-method": "POST" } })).statusCode).toBe(403);
    // The paired extension's preflight of another route: as before (the shell's are documents-route.test.ts's).
    const list = await svc!.app.inject({ method: "OPTIONS", url: "/find/browser/waiting", headers: { ...host, origin: EXT, "access-control-request-method": "POST" } });
    expect([list.statusCode, list.headers["access-control-allow-headers"]]).toEqual([204, "authorization, content-type"]);
  });

  it("(d) M4: unpairing the LAST extension ends a browser wait — the entry back at its rest as by Cancel, nothing listed to a newly paired extension, the old ticket refused; the removal answers as before", async () => {
    const { pid, e, ticket } = await ready({ started: true, rest: { state: "no-open-copy" } });
    const [paired] = await pairingIds();
    const n = events.length;
    const r = await unpair(paired!.id);
    expect([r.status, r.json]).toEqual([200, { removed: true }]);
    await until(async () => (await view(pid, e.id)).state === "no-open-copy", "the entry to come back");
    const v = await view(pid, e.id);
    expect(v).not.toHaveProperty("waitingIn");
    expect(v).not.toHaveProperty("browserStart");
    expect(events.slice(n).filter((x) => x.type === "find.progress").map((x) => x.data)).toEqual([{ projectId: pid, entryId: e.id, state: "no-open-copy" }]);
    // The audit: as a cancel's (an update of the entry), nothing of the ticket, the title or the address (afterEach).
    extToken = await pairExtension(OTHER_EXT);
    expect((await waitingList({ origin: OTHER_EXT })).json).toEqual({ waiting: [] });
    const old = await sendFile(ticket!, await goodPdf(), { origin: OTHER_EXT });
    expect([old.status, old.json.error.reason]).toEqual([404, "browser-not-waiting"]);
    expect(await inboxFiles()).toEqual([]);
    expect(logs).not.toMatch(/could not be put back/u);
  });

  it("(d) M4: with another extension still paired, unpairing one changes nothing; a work waiting in the WINDOW is never touched", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const first = extToken;
    const second = await pairExtension(OTHER_EXT);
    const ids = await pairingIds();
    expect(ids).toHaveLength(2);
    expect((await unpair(ids.find((x) => x.origin === EXT)!.id)).status).toBe(200);
    await sleep(100);
    expect((await view(pid, e.id)).waitingIn).toBe("browser");
    extToken = second;
    expect((await waitingList({ origin: OTHER_EXT })).json.waiting).toEqual([{ ticket, label: TITLE }]);
    expect(first).not.toBe(second);
    // The window's wait: the last extension unpaired, the window still waits with its ticket.
    await cancel(pid, e.id);
    const w = await windowStart(pid, e.id);
    expect(w.status).toBe(200);
    expect((await unpair(ids.find((x) => x.origin === OTHER_EXT)!.id)).status).toBe(200);
    expect(await pairingIds()).toEqual([]);
    await sleep(100);
    expect((await view(pid, e.id)).state).toBe("waiting-sign-in");
    expect(svc!.state.session!.find!.waitingIn(pid, e.id)).toBe("window");
    expect(svc!.state.session!.find!.libraryHandedOver(w.json.ticket, "window")).toEqual({ projectId: pid, entryId: e.id });
  });

  it("R354: the settings' reset of the pairings file (no extension left paired) ends a browser wait as the removal of the last pairing does; a reset of fonts or appearance leaves it as it is", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const reset = async (file: string, name: string) => {
      await writeFile(join(deps.appConfigDir, name), "garbage{");
      const r = await call({ method: "POST", url: "/settings/reset", body: { file, confirm: true } });
      expect([r.status, r.json.reset], r.body).toEqual([200, true]);
    };
    // fonts and appearance: the browser wait as it is.
    await reset("fonts", "fonts.json");
    await reset("appearance", "appearance.json");
    await sleep(100);
    expect((await view(pid, e.id)).waitingIn).toBe("browser");
    expect((await waitingList()).json.waiting).toEqual([{ ticket, label: TITLE }]);
    // extension-pairings: no extension left paired — the entry back at its rest, the ticket ended.
    await reset("extension-pairings", "extension-pairings.json");
    expect(await pairingIds()).toEqual([]);
    await until(async () => (await view(pid, e.id)).state === "no-open-copy", "the entry to come back");
    expect(await view(pid, e.id)).not.toHaveProperty("waitingIn");
    extToken = await pairExtension(OTHER_EXT);
    expect((await waitingList({ origin: OTHER_EXT })).json).toEqual({ waiting: [] });
    const old = await sendFile(ticket!, await goodPdf(), { origin: OTHER_EXT });
    expect([old.status, old.json.error.reason]).toEqual([404, "browser-not-waiting"]);
    expect(await inboxFiles()).toEqual([]);
    expect(logs).not.toMatch(/could not be put back/u);
  });

  it("(e) M5: a window's ticket given to the file route with a slowly sent body — the 404 of a wrong ticket, and the body is NOT taken: the inbox stays empty throughout", async () => {
    const { pid, e } = await ready();
    const w = await windowStart(pid, e.id);
    expect(w.status, w.body).toBe(200);
    const pdf = await goodPdf();
    const slow = new PassThrough();
    const p = sendFile(w.json.ticket, slow);
    slow.write(pdf.subarray(0, 100));
    let answered: Answer | null = null;
    void p.then((a) => (answered = a));
    for (let k = 0; k < 15; k++) {
      await sleep(100);
      expect(await inboxFiles(), `after ${(k + 1) * 100} ms`).toEqual([]);
      if (k < 10) slow.write(pdf.subarray(100 + k, 101 + k));
    }
    expect(answered, "answered before the body ended").not.toBeNull();
    expect([answered!.status, answered!.json.error.reason]).toEqual([404, "browser-not-waiting"]);
    slow.end();
    await p;
    expect(await inboxFiles()).toEqual([]);
    expect(svc!.state.session!.find!.waitingIn(pid, e.id)).toBe("window");
  });

  it("(f) M6: x-ao-page given twice, or one value holding a comma and a space — 400 browser-page; the ticket stays open", async () => {
    const { pid, e, ticket } = await ready({ started: true });
    const pdf = await goodPdf();
    const joined = await sendFile(ticket!, pdf, { page: `${TAB}, https://other.example/y` });
    expect([joined.status, joined.json.error.code, joined.json.error.reason, joined.json.error.message]).toEqual([400, "VALIDATION", "browser-page", FIND_BROWSER_TEXT.page]);
    // Sent twice on a real connection (Node joins the two values).
    const port = await svc!.listen(0);
    host = { host: `127.0.0.1:${port}` };
    for (const second of [TAB, "https://other.example/y"]) {
      const got = await rawRequest(
        port,
        `POST /find/browser/file/${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${extToken}\r\nOrigin: ${EXT}\r\nContent-Type: application/pdf\r\nx-ao-page: ${TAB}\r\nx-ao-page: ${second}\r\nContent-Length: ${pdf.length}\r\nConnection: close\r\n\r\n`,
        pdf,
      );
      expect(got.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
      expect(got).toContain('"reason":"browser-page"');
      errorBodies.push(got);
    }
    expect(await inboxFiles()).toEqual([]);
    await stillServes(pid, e, ticket!);
  });

  for (const how of ["open to others (0755)", "a link to another folder"] as const) {
    it(`(g) M7: an inbox ${how} is not written into — 503 browser-inbox, a warning without the path, the flag released, the ticket open; put right, the same ticket succeeds`, async () => {
      const { pid, e, ticket } = await ready({ started: true });
      const inbox = inboxOfService();
      const elsewhere = join(tmp, "elsewhere-inbox");
      await mkdir(inbox, { recursive: true, mode: 0o700 });
      if (how === "open to others (0755)") await chmod(inbox, 0o755);
      else {
        await rm(inbox, { recursive: true, force: true });
        await mkdir(elsewhere, { recursive: true, mode: 0o700 });
        await symlink(elsewhere, inbox);
      }
      for (let k = 0; k < 2; k++) {
        const r = await sendFile(ticket!, await goodPdf());
        expect([r.status, r.json.error.code, r.json.error.reason, r.json.error.message]).toEqual([503, "UNAVAILABLE", "browser-inbox", FIND_BROWSER_TEXT.inbox]);
        expect(r.headers.connection).not.toBe("close");
      }
      expect(await readdir(how === "a link to another folder" ? elsewhere : inbox)).toEqual([]);
      expect(logs).toContain("The folder for files from the browser cannot be used");
      expect(logs).not.toContain(tmp);
      expect((await view(pid, e.id)).state).toBe("waiting-sign-in");
      expect((await waitingList()).json.waiting).toHaveLength(1);
      // Put right: the same ticket succeeds.
      if (how === "open to others (0755)") await chmod(inbox, 0o700);
      else await rm(inbox);
      await stillServes(pid, e, ticket!);
    });
  }
});
