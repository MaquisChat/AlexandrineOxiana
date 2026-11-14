/**
 * Task F15 (R324): "Your library" — the settings, the address worked out from a pasted link, the queue's "Where to get
 * it" and `library` parts, and the start and cancel of a fetch through the library — through the service.
 *
 * Nothing here reaches the network: the global dispatcher is a MockAgent with `disableNetConnect` and NO answers,
 * composed with a recorder of every request; the tests show that no request at all is made by anything F15 adds (the
 * service never fetches from the library). The library's host and the work's DOI are recognisable strings that are
 * looked for — with every ticket and every pasted link — in every log line (at the most verbose level), error answer,
 * event, the audit and queue files, and every request.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PassThrough, Writable } from "node:stream";
// The service has no undici of its own: the library's (the one its lookup client uses) sets the global dispatcher.
import { Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "../../../packages/library/node_modules/undici/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceDeps, type Deps, type FindEntry } from "@ao/library";
import {
  FIND_LIBRARY_FILE_TEXT,
  FIND_LIBRARY_TEXT,
  FIND_REASON_TEXT,
  FIND_ROUTE_TEXT,
  LIBRARY_PAUSE_MS,
  LIBRARY_TICKET_MS,
  YOUR_LIBRARY_DERIVE_TEXT,
  YOUR_LIBRARY_TEXT,
  type FindEntryView,
  type FindQueueResponse,
} from "@ao/shared";
import { newId, type SourceDraft } from "@ao/core";
import { appendFindEntriesIn, holdMismatchedFileIn } from "../../../packages/library/src/repo/repo.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";
import type { ServiceEvent } from "./events.js";
import { inboxOf, inputLineHandler } from "./file-grants.js";
import { libraryFileHandler } from "./routes/your-library.js";
import { onInputLines, readStartupToken } from "./startup-token.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
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

// Recognisable, made up: the library's host, a session ticket in a pasted link, the work's DOI.
const LIB_HOST = "ezproxy.zorblatt-univ.example.edu";
const SESSION = "SESSIONzorblatt77";
const DOI = "10.5555/ao.f15.vexmoorquill";
const EZ = { kind: "ezproxy-login" as const, base: `https://${LIB_HOST}/login?url=` };
const LINK = `https://${LIB_HOST}/login?ticket=${SESSION}&url=https://www.jstor.org/stable/42`;
const SECRETS = [LIB_HOST, SESSION, DOI, "zorblatt-univ", "vexmoorquill"];

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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-your-library-"));
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
  // Nothing of the library's address, the pasted link, the work's DOI or a ticket in any log line, error answer,
  // event, audit or queue file; and no request was made at all.
  const files = await everything(tmp);
  const seen = [logs, ...errorBodies, ...events.map((e) => JSON.stringify(e)), files.audit, files.queue].join("\n");
  for (const w of [...SECRETS, ...tickets]) expect(seen.includes(w), `"${w}" was logged, sent or written`).toBe(false);
  expect(requests).toEqual([]);
  errorBodies.length = 0;
  tickets.length = 0;
  vi.useRealTimers();
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

async function start(): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null });
  svc.state.events.subscribe((e) => events.push(e));
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string>; raw?: string };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined || r.raw !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.raw !== undefined ? { payload: r.raw } : r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  if (res.statusCode >= 400) errorBodies.push(res.body);
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body, headers: res.headers };
}

async function openNewLibrary(name = "Lib"): Promise<string> {
  const path = join(tmp, name);
  const r = await call({ method: "POST", url: "/libraries", body: { path, name } });
  expect(r.status, r.body).toBe(200);
  return path;
}
async function newProject(o: { encrypted?: boolean; gov?: string; name?: string } = {}): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name: o.name ?? `Study ${Math.random().toString(36).slice(2, 6)}`, governanceYaml: o.gov ?? NO_FREE, encryption: o.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}
const repo = () => svc!.state.session!.repo;
const draft = (o: { doi?: string | null; isbn?: string[]; type?: SourceDraft["type"] } = {}): SourceDraft => ({
  projectIds: [],
  type: o.type ?? "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: "Grammar of Invented Habits" }] },
  creators: [{ role: "author", family: "Mirabelle", given: "Ottoline" }],
  issued: "1999",
  identifiers: { ...(o.doi === null ? {} : { doi: o.doi ?? DOI }), ...(o.isbn ? { isbn: o.isbn } : {}) },
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});
async function record(pid: string, o: { doi?: string | null; isbn?: string[]; type?: SourceDraft["type"] } = {}): Promise<string> {
  const sf = await repo().createSource(pid, draft(o), [], {
    provenance: { captureMethod: "reference_lookup", capturedAt: new Date().toISOString(), tool: { name: "find-and-acquire", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
  });
  return sf.source.id;
}
type Rest = { state: FindEntry["state"]; reason?: FindEntry["reason"]; offers?: FindEntry["offers"] };
async function resting(pid: string, rest: Rest, sid?: string): Promise<FindEntry> {
  const at = new Date().toISOString();
  const e: FindEntry = { id: newId(), projectId: pid, typed: "Grammar of Invented Habits", ...rest, createdAt: at, updatedAt: at, attempts: 0, sourceId: sid ?? (await record(pid)) };
  await appendFindEntriesIn(repo(), pid, [e], "add");
  return e;
}
const queue = async (pid: string): Promise<FindQueueResponse> => {
  const r = await call({ url: `/projects/${pid}/find` });
  expect(r.status, r.body).toBe(200);
  return r.json as FindQueueResponse;
};
const view = async (pid: string, eid: string): Promise<FindEntryView> => (await queue(pid)).entries.find((e) => e.id === eid)!;
const setLibrary = async (body: Record<string, unknown> = { name: "Zorblatt University", access: EZ }) => {
  const r = await call({ method: "PUT", url: "/settings/your-library", body });
  expect(r.status, r.body).toBe(200);
  return r.json;
};
const startFetch = async (pid: string, eid: string) => {
  const r = await call({ method: "POST", url: `/projects/${pid}/find/${eid}/library/start` });
  if (r.status === 200) tickets.push(r.json.ticket);
  return r;
};
async function until<T>(fn: () => Promise<T | undefined | false>, what = "the condition", ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function pairExtension(): Promise<string> {
  const p = await call({ method: "POST", url: "/extension/pair" });
  const c = await svc!.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
  return c.json().token as string;
}

// ---------------------------------------------------------------------------------------------------------------

describe("who may call", () => {
  it("the extension token is refused on every Your library route", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const e = await resting(pid, { state: "no-open-copy" });
    const token = await pairExtension();
    for (const [method, url, body] of [
      ["GET", "/settings/your-library"],
      ["PUT", "/settings/your-library", { name: "", access: null }],
      ["POST", "/settings/your-library/derive", { link: LINK }],
      ["POST", `/projects/${pid}/find/${e.id}/library/start`],
      ["POST", `/projects/${pid}/find/${e.id}/library/cancel`],
    ] as Array<[string, string, unknown?]>) {
      const r = await svc!.app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}`, origin: EXT, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      errorBodies.push(r.body);
    }
    expect((await view(pid, e.id)).state).toBe("no-open-copy");
  });
});

describe("the settings", () => {
  it("not set at first; saved and read back; Stay signed in off unless given", async () => {
    await start();
    expect((await call({ url: "/settings/your-library" })).json).toEqual({ name: "", access: null, staySignedIn: false });
    const saved = await setLibrary({ name: "  Zorblatt University  ", access: EZ, catalogueSearch: "https://catalogue.example.edu/search?q={query}" });
    // R336 i: the answer carries the service's own sentence for the stored address (the derive's words for it).
    expect(saved).toEqual({ name: "Zorblatt University", access: EZ, catalogueSearch: "https://catalogue.example.edu/search?q={query}", staySignedIn: false, addressSentence: `Your library's address: ${LIB_HOST} (EZproxy)` });
    expect((await call({ url: "/settings/your-library" })).json).toEqual(saved);
    expect((await setLibrary({ name: "", access: null, staySignedIn: true })).staySignedIn).toBe(true);
    // The file is the app's, beside search-sources.json, 0600.
    const st = await import("node:fs/promises").then((f) => f.stat(join(deps.appConfigDir, "your-library.json")));
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
  });

  it("a PUT never trusts the page: each refusal names its field, never what was sent", async () => {
    await start();
    const refused: Array<[unknown, string]> = [
      [{ name: "", access: EZ, link: LINK }, YOUR_LIBRARY_TEXT.fields],
      [{ name: "a\u0007b", access: null }, YOUR_LIBRARY_TEXT.name],
      [{ name: "x".repeat(201), access: null }, YOUR_LIBRARY_TEXT.name],
      [{ name: 42, access: null }, YOUR_LIBRARY_TEXT.name],
      [{ name: "", access: { kind: "ezproxy-login", base: `http://${LIB_HOST}/login?url=` } }, YOUR_LIBRARY_TEXT.access],
      [{ name: "", access: { kind: "ezproxy-login", base: `https://u:p@${LIB_HOST}/login?url=` } }, YOUR_LIBRARY_TEXT.access],
      [{ name: "", access: { kind: "ezproxy-login", base: `https://${LIB_HOST}/login?ticket=${SESSION}&url=` } }, YOUR_LIBRARY_TEXT.access],
      [{ name: "", access: { kind: "openurl", base: `https://${LIB_HOST}/login?url=` } }, YOUR_LIBRARY_TEXT.access],
      [{ name: "", access: { kind: "openathens", base: `https://${LIB_HOST}/redirector/x.edu?url=` } }, YOUR_LIBRARY_TEXT.access],
      [{ name: "", access: LINK }, YOUR_LIBRARY_TEXT.access],
      // R328 b: a stored resolver's address is checked by the derive's rule (no session's key in its path).
      [{ name: "", access: { kind: "openurl", base: `https://${LIB_HOST}/(S(${SESSION}))/openurl` } }, YOUR_LIBRARY_TEXT.access],
      [{ name: "", access: null, catalogueSearch: `http://${LIB_HOST}/?q={query}` }, YOUR_LIBRARY_TEXT.catalogueSearch],
      [{ name: "", access: null, catalogueSearch: `https://{query}.${LIB_HOST}/` }, YOUR_LIBRARY_TEXT.catalogueSearch],
      [{ name: "", access: null, catalogueSearch: `https://${LIB_HOST}/?q={query}&r={query}` }, YOUR_LIBRARY_TEXT.catalogueSearch],
      [{ name: "", access: null, catalogueSearch: `https://${SESSION}@${LIB_HOST}/?q={query}` }, YOUR_LIBRARY_TEXT.catalogueSearch],
      [{ name: "", access: null, staySignedIn: "yes" }, YOUR_LIBRARY_TEXT.staySignedIn],
      [[1, 2], YOUR_LIBRARY_TEXT.fields],
    ];
    for (const [body, sentence] of refused) {
      const r = await call({ method: "PUT", url: "/settings/your-library", body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.message).toBe(sentence);
    }
    expect((await call({ url: "/settings/your-library" })).json.access).toBeNull();
  });

  it("an unreadable file is not set and says so; a newer version's file is read-only (409), unchanged", async () => {
    await start();
    const file = join(deps.appConfigDir, "your-library.json");
    await writeFile(file, "not json {");
    expect((await call({ url: "/settings/your-library" })).json).toEqual({ name: "", access: null, staySignedIn: false, problem: { code: "unreadable", text: YOUR_LIBRARY_TEXT.unreadable } });
    const newer = JSON.stringify({ v: 2, name: "x", access: null, staySignedIn: false });
    await writeFile(file, newer);
    expect((await call({ url: "/settings/your-library" })).json.problem).toEqual({ code: "newer", text: YOUR_LIBRARY_TEXT.newer });
    const r = await call({ method: "PUT", url: "/settings/your-library", body: { name: "", access: EZ } });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe(YOUR_LIBRARY_TEXT.newer);
    expect(await readFile(file, "utf8")).toBe(newer);
  });
});

describe("derive: the address from one pasted link", () => {
  it("names the host and the kind, keeps nothing of the link's query; the link is never logged or echoed", async () => {
    await start();
    const r = await call({ method: "POST", url: "/settings/your-library/derive", body: { link: LINK } });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    // The host is said (it is the address that is kept); the session's ticket in the query is not.
    expect(r.json).toEqual({ access: EZ, sentence: "Your library's address: ezproxy.zorblatt-univ.example.edu (EZproxy)" });
    expect(r.body).not.toContain(SESSION);
    expect(r.body).not.toContain("jstor");
    const ou = await call({ method: "POST", url: "/settings/your-library/derive", body: { link: "https://resolver.example.edu/openurl?url_ver=Z39.88-2004&rft_id=x" } });
    // R328 b: a resolver's address keeps its path, so the sentence names host AND path.
    expect(ou.json.sentence).toBe("Your library's address: resolver.example.edu/openurl (link resolver)");
    const oa = await call({ method: "POST", url: "/settings/your-library/derive", body: { link: "https://go.openathens.net/redirector/example.edu?url=x" } });
    expect(oa.json.sentence).toBe("Your library's address: go.openathens.net (OpenAthens)");
  });

  it("hostile links: each refused with its own sentence, none of it in any answer or log line", async () => {
    await start();
    const cases: Array<[string, keyof typeof YOUR_LIBRARY_DERIVE_TEXT]> = [
      [`javascript:alert('${SESSION}')//login?url=`, "not-https"],
      [`data:text/html,${SESSION}`, "not-https"],
      [`file:///${SESSION}/login?url=x`, "not-https"],
      [`http://${LIB_HOST}/login?url=${SESSION}`, "not-https"],
      [`https://user:${SESSION}@${LIB_HOST}/login?url=x`, "userinfo"],
      [`https://${LIB_HOST}@evil.example/login?url=${SESSION}`, "userinfo"],
      [`https://${LIB_HOST}./login?url=${SESSION}`, "bad-host"],
      [`https://[::1]/login?url=${SESSION}`, "bad-host"],
      [`https://my-library.edu/catalogue?q=${SESSION}`, "not-library"],
      [`https://www.jstor.org/action?next=%2Flogin%3Furl%3D${SESSION}`, "not-library"],
      [`https://${LIB_HOST}/log\u0000in?url=${SESSION}`, "unreadable"],
      [`https://${LIB_HOST}/login ?url=${SESSION}`, "unreadable"],
      [`https://${LIB_HOST}/login?url=${SESSION}${"a".repeat(4096)}`, "too-long"],
      // R328 b: a resolver's path holding what looks like a session's key.
      [`https://${LIB_HOST}/(S(${SESSION}))/openurl?url_ver=Z39.88-2004`, "session-key"],
      [`https://${LIB_HOST}/openurl/${SESSION}0123456789?url_ver=Z39.88-2004`, "session-key"],
    ];
    for (const [link, code] of cases) {
      const r = await call({ method: "POST", url: "/settings/your-library/derive", body: { link } });
      expect(r.status, code).toBe(200);
      expect(r.json).toEqual({ access: null, sentence: YOUR_LIBRARY_DERIVE_TEXT[code] });
      errorBodies.push(r.body);
    }
    // Upper case, an international host: their ASCII form.
    const up = await call({ method: "POST", url: "/settings/your-library/derive", body: { link: "HTTPS://BÜCHEREI.EXAMPLE.DE/login?url=x" } });
    expect(up.json.access).toEqual({ kind: "ezproxy-login", base: "https://xn--bcherei-n2a.example.de/login?url=" });
    // Not a link at all, or more than the link: 400 in this route's words, nothing repeated.
    for (const body of [{ link: 42 }, { link: LINK, extra: SESSION }, {}]) {
      const r = await call({ method: "POST", url: "/settings/your-library/derive", body });
      expect(r.status).toBe(400);
      expect(r.json.error.message).toBe(YOUR_LIBRARY_TEXT.link);
    }
    // A body that is not JSON: the service's fixed sentence (never a piece of the body).
    const bad = await call({ method: "POST", url: "/settings/your-library/derive", raw: `{"link": "${LINK}` });
    expect(bad.status).toBe(400);
    expect(bad.body).not.toContain(SESSION);
  });
});

describe("R328 h: no link makes the route work longer than its size", () => {
  it("a 16 KB body of one inner run of spaces is answered at once (the length is checked before any trim)", async () => {
    await start();
    const link = `a${" ".repeat(16_000)}a`;
    await call({ method: "POST", url: "/settings/your-library/derive", body: { link: "x" } }); // warm
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await call({ method: "POST", url: "/settings/your-library/derive", body: { link } });
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ access: null, sentence: YOUR_LIBRARY_DERIVE_TEXT["too-long"] });
    }
    // A generous bound on this shared machine (the quadratic trim took about 100 ms for this body).
    expect(Math.min(...times)).toBeLessThan(50);
  });
});

describe("the queue's view: Where to get it, and whether a start is offered (R324 a, d)", () => {
  it("a resting entry carries the joined links, and `library` says it may start — or why not (no library set)", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const free = { label: "A free copy may be at" as const, url: "https://repository.example.org/a.pdf", host: "not-this-host.example" };
    const a = await resting(pid, { state: "no-open-copy", offers: [free] });
    const b = await resting(pid, { state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } });
    const c = await resting(pid, { state: "record-complete", reason: { code: "held-full" } });
    let va = await view(pid, a.id);
    expect(va.library).toEqual({ canStart: false, reason: "no-library" });
    expect(va.offers!.map((o) => [o.label, o.host])).toEqual([
      ["A free copy may be at", "repository.example.org"],
      ["Publisher's page", "doi.org"],
    ]);
    expect((await view(pid, b.id)).library).toEqual({ canStart: false, reason: "no-library" });
    expect((await view(pid, c.id)).library).toBeUndefined();
    expect((await view(pid, c.id)).offers).toBeUndefined();
    expect(JSON.stringify(await queue(pid))).not.toContain("returnTo");
    await setLibrary({ name: "", access: EZ, catalogueSearch: "https://catalogue.example.edu/s?q={query}" });
    va = await view(pid, a.id);
    expect(va.library).toEqual({ canStart: true });
    expect(va.offers!.map((o) => o.label)).toEqual(["A free copy may be at", "Publisher's page", "Your library's catalogue"]);
    expect((await view(pid, b.id)).library).toEqual({ canStart: true });
    // The library's address is never in the view.
    errorBodies.push(JSON.stringify(await queue(pid)).replaceAll(DOI, "<doi>"));
  });
});

describe("R328 e: the queue's read reads a record only when it changed", () => {
  it("a second GET reads no record; a DOI changed is read once and shown; a locked project's entries are not served after the lock", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject({ encrypted: true });
    await setLibrary();
    const a = await resting(pid, { state: "no-open-copy" });
    const b = await resting(pid, { state: "no-open-copy" });
    const spy = vi.spyOn(repo(), "getSource");
    const reads = () => {
      const n = spy.mock.calls.filter(([p]) => p === pid).length;
      spy.mockClear();
      return n;
    };
    await queue(pid);
    expect(reads()).toBe(2);
    await queue(pid);
    expect(reads()).toBe(0);
    await repo().updateSource(pid, a.sourceId!, { identifiers: { doi: "10.5555/ao.f15.second" } });
    reads();
    const v = await view(pid, a.id);
    expect(reads()).toBe(1);
    expect(v.offers!.find((o) => o.label === "Publisher's page")!.url).toBe("https://doi.org/10.5555/ao.f15.second");
    // Locked: the queue cannot be read (as before), and nothing read before is served; at the unlock it is read anew.
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/find` })).status).toBe(423);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    reads();
    expect((await view(pid, b.id)).library).toEqual({ canStart: true });
    expect(reads()).toBe(2);
  });
});

describe("R328 g: \"no library set\" only where a library could give an address", () => {
  it("an ISBN alone carries no `library` field while no library is set; once a resolver is set it may start", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const doi = await resting(pid, { state: "no-open-copy" });
    const isbn = await resting(pid, { state: "no-open-copy" }, await record(pid, { doi: null, isbn: ["9780674212770"], type: "book" }));
    expect((await view(pid, doi.id)).library).toEqual({ canStart: false, reason: "no-library" });
    const v = await view(pid, isbn.id);
    expect(v.library).toBeUndefined();
    expect(v.offers!.map((o) => o.label)).toEqual(["Open Library", "WorldCat"]);
    await setLibrary({ name: "", access: { kind: "openurl", base: "https://resolver.example.edu/openurl" } });
    expect((await view(pid, isbn.id)).library).toEqual({ canStart: true });
    await setLibrary();
    expect((await view(pid, isbn.id)).library).toBeUndefined();
  });
});

describe("the start (R324 a–c)", () => {
  it("one ticket at a time, and the pause between hand-overs", async () => {
    await start();
    await openNewLibrary();
    const p1 = await newProject();
    const p2 = await newProject();
    await setLibrary();
    const a = await resting(p1, { state: "no-open-copy" });
    const b = await resting(p2, { state: "no-open-copy" });
    const c = await resting(p2, { state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } });
    // Two presses at the same moment, in two projects: exactly one ticket.
    const both = await Promise.all([startFetch(p1, a.id), startFetch(p2, b.id)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const ok = both.find((r) => r.status === 200)!;
    const no = both.find((r) => r.status === 409)!;
    expect(ok.json.ticket).toMatch(/^[0-9a-f]{32}$/u);
    expect(ok.json.url).toBe(`${EZ.base}https://doi.org/${DOI}`);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(ok.json).sort()).toEqual(["ticket", "url"]);
    expect(no.json.error).toMatchObject({ code: "CONFLICT", message: FIND_LIBRARY_TEXT.busy, reason: "library-busy" });
    const [startedP, startedE] = ok === both[0] ? [p1, a.id] : [p2, b.id];
    const waiting = await view(startedP, startedE);
    expect(waiting.state).toBe("waiting-sign-in");
    // A waiting entry is offered neither links nor a start (R324 a, d: "and of no other"), and says nothing of the address.
    expect(waiting.offers).toBeUndefined();
    expect(waiting.library).toBeUndefined();
    expect(waiting.reason).toBeUndefined();
    // The hand-over (Task F17's seam): the ticket ends, the pause starts.
    expect(svc!.state.session!.find!.libraryHandedOver(ok.json.ticket)).toEqual({ projectId: startedP, entryId: startedE });
    const paused = await startFetch(p2, c.id);
    expect(paused.status).toBe(409);
    expect(paused.json.error).toMatchObject({ code: "CONFLICT", message: "Ready in 20 seconds.", reason: "library-pause" });
    expect((await view(p2, c.id)).state).toBe("record-complete");
    // After the pause, allowed (only the clock is moved).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + LIBRARY_PAUSE_MS });
    const after = await startFetch(p2, c.id);
    expect(after.status, after.body).toBe(200);
    expect((await view(p2, c.id)).state).toBe("waiting-sign-in");
  });

  it("R328 d: a waiting entry whose line keeps the copy services' links carries none in its view; back, it has them again", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    const free = { label: "A free copy may be at" as const, url: "https://repository.example.org/a.pdf", host: "repository.example.org" };
    const e = await resting(pid, { state: "no-open-copy", offers: [free] });
    expect((await view(pid, e.id)).offers!.map((o) => o.url)).toContain(free.url);
    expect((await startFetch(pid, e.id)).status).toBe(200);
    const waiting = await view(pid, e.id);
    expect(waiting.state).toBe("waiting-sign-in");
    expect(waiting.offers).toBeUndefined();
    // The links are kept on the line for the return.
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/library/cancel` })).json.offers.map((o: { url: string }) => o.url)).toContain(free.url);
  });

  it("R328 f: the pause outlives the library's close and reopening (the service keeps the time of the hand-over)", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    const a = await resting(pid, { state: "no-open-copy" });
    const b = await resting(pid, { state: "no-open-copy" });
    const r = await startFetch(pid, a.id);
    expect(r.status).toBe(200);
    expect(svc!.state.session!.find!.libraryHandedOver(r.json.ticket)).toEqual({ projectId: pid, entryId: a.id });
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const paused = await startFetch(pid, b.id);
    expect(paused.status).toBe(409);
    expect(paused.json.error.reason).toBe("library-pause");
    expect(paused.json.error.message).toMatch(/^Ready in (1\d|20) seconds\.$/u);
    expect((await view(pid, b.id)).state).toBe("no-open-copy");
  });

  it("waiting entries return to what they were at start, and the ticket is gone (R324 b replaces 'No open copy')", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    // (Free copies are not allowed by this project's rules, so the copy part, which looks at a returned entry again as at
    // any resume, leaves it as it is.)
    const e = await resting(pid, { state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } });
    const old = await resting(pid, { state: "waiting-sign-in" }); // an older build's line: nothing kept to return to
    const r = await startFetch(pid, e.id);
    expect(r.status).toBe(200);
    // The service stops (a restart): the ticket was in memory only.
    await svc!.close();
    svc = undefined;
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const back = await until(async () => ((x) => (x.state !== "waiting-sign-in" ? x : undefined))(await view(pid, e.id)), "the entry to come back");
    expect(back).toMatchObject({ state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" } });
    // Once the copy part has looked at it again (as at any resume), it may start again.
    const settledBack = await until(async () => ((x) => (x.library ? x : undefined))(await view(pid, e.id)), "the start to be offered again");
    expect(settledBack).toMatchObject({ state: "record-complete", reason: { code: "copy-not-allowed", by: "rules" }, library: { canStart: true } });
    const honest = await until(async () => ((x) => (x.state !== "waiting-sign-in" ? x : undefined))(await view(pid, old.id)), "the old entry");
    expect(honest).toMatchObject({ state: "no-open-copy", reason: { code: "library-unfinished" } });
    expect(FIND_REASON_TEXT["library-unfinished"]).toBeTruthy();
    expect(svc!.state.session!.find!.libraryHandedOver(r.json.ticket)).toBeNull();
  });

  it("cancel: back to exactly what it was; a cancel of an entry not waiting is 409 in words", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary();
    const e = await resting(pid, { state: "no-open-copy", reason: { code: "copy-some-unreachable" } });
    const r = await startFetch(pid, e.id);
    expect(r.status).toBe(200);
    const c = await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/library/cancel` });
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ id: e.id, state: "no-open-copy", reason: { code: "copy-some-unreachable" }, library: { canStart: true } });
    expect(c.json.returnTo).toBeUndefined();
    expect(svc!.state.session!.find!.libraryHandedOver(r.json.ticket)).toBeNull();
    const again = await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/library/cancel` });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ message: FIND_ROUTE_TEXT.entryState, reason: "entry-state" });
    // A body is refused, never repeated.
    const withBody = await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/library/start`, body: { url: LINK } });
    expect(withBody.status).toBe(400);
    expect(withBody.json.error.message).toBe(YOUR_LIBRARY_TEXT.noBody);
  });

  it("refusals, each with its sentence and status: not offered, no library, the waiting files' limit, an unknown entry, a locked project, a read-only library", async () => {
    await start();
    const path = await openNewLibrary();
    // Free copies allowed (the files waiting for the check below are held as a free copy's would be).
    const pid = await newProject({ gov: GOV() });
    const e = await resting(pid, { state: "no-open-copy" });
    const noLib = await startFetch(pid, e.id);
    expect(noLib.status).toBe(409);
    expect(noLib.json.error).toMatchObject({ message: FIND_LIBRARY_TEXT.noLibrary, reason: "no-library" });
    await setLibrary();
    const notResting = await resting(pid, { state: "record-complete", reason: { code: "held-full" } });
    const notOffered = await startFetch(pid, notResting.id);
    expect(notOffered.status).toBe(409);
    expect(notOffered.json.error).toMatchObject({ message: FIND_LIBRARY_TEXT.notOffered, reason: "library-not-offered" });
    const bare = await resting(pid, { state: "no-open-copy" }, await record(pid, { doi: null }));
    expect((await startFetch(pid, bare.id)).json.error.reason).toBe("library-not-offered");
    expect((await startFetch(pid, newId())).status).toBe(404);
    // FIND_HELD_MAX files waiting in the project.
    const other = await record(pid, { doi: "10.5555/ao.f15.other" });
    const pdf = join(tmp, "held.pdf");
    await writeFile(pdf, await buildPdf({ title: "A Different Paper", lines: ["A Different Paper"] }));
    const at = new Date().toISOString();
    const holds: FindEntry[] = Array.from({ length: 50 }, () => ({ id: newId(), projectId: pid, typed: "x y", state: "fetching", createdAt: at, updatedAt: at, attempts: 0, sourceId: other }));
    await appendFindEntriesIn(repo(), pid, holds, "add");
    for (const h of holds) {
      await holdMismatchedFileIn(repo(), pid, {
        entry: { ...h, state: "needs-check", reason: { code: "file-title-absent" } },
        sourceId: other,
        fromPath: pdf,
        facts: { why: "title-absent", kind: "pdf", bytes: 1, acquired: { method: "free_copy", via: "service", address: "https://arxiv.org/pdf/1", at, tool: { name: "find-and-acquire", version: "0" }, access: "public" } },
      });
    }
    const full = await startFetch(pid, e.id);
    expect(full.status).toBe(409);
    expect(full.json.error).toMatchObject({ message: "50 files are already waiting for your check. Decide on some of them, then try again.", reason: "library-held-full" });
    expect((await view(pid, e.id)).state).toBe("no-open-copy");
    // A locked project: 423.
    const locked = await newProject({ encrypted: true });
    const le = await resting(locked, { state: "no-open-copy" });
    expect((await call({ method: "POST", url: `/projects/${locked}/lock` })).status).toBe(200);
    const l = await startFetch(locked, le.id);
    expect(l.status).toBe(423);
    expect(l.json.error).toMatchObject({ code: "PROJECT_LOCKED", message: FIND_ROUTE_TEXT.locked });
    // A read-only library: 409 READ_ONLY.
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-only");
    const ro = await startFetch(pid, e.id);
    expect(ro.status).toBe(409);
    expect(ro.json.error).toMatchObject({ code: "READ_ONLY", message: FIND_ROUTE_TEXT.readOnly });
  });

  it("the project locked while waiting: the ticket ends at once; at the unlock the entry is back as it was", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject({ encrypted: true });
    await setLibrary();
    const e = await resting(pid, { state: "no-open-copy", reason: { code: "not-this-file" } });
    const r = await startFetch(pid, e.id);
    expect(r.status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(svc!.state.session!.find!.libraryHandedOver(r.json.ticket)).toBeNull();
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    const back = await until(async () => ((x) => (x.state !== "waiting-sign-in" ? x : undefined))(await view(pid, e.id)), "the entry to come back");
    expect(back).toMatchObject({ state: "no-open-copy", reason: { code: "not-this-file" } });
  });

  it("nothing of the ticket or the address anywhere but the start's answer — over a start, a refused start, a cancel and the ticket's end", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary({ name: "", access: EZ });
    const e = await resting(pid, { state: "no-open-copy" });
    const f = await resting(pid, { state: "no-open-copy" });
    const s1 = await startFetch(pid, e.id);
    expect(s1.status).toBe(200);
    const refused = await startFetch(pid, f.id);
    expect(refused.status).toBe(409);
    expect((await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/library/cancel` })).status).toBe(200);
    const s2 = await startFetch(pid, f.id);
    expect(s2.status).toBe(200);
    // The ticket's end: the clock moved past it; the seam finds it ended, and the entry comes back.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + LIBRARY_TICKET_MS + 1000 });
    expect(svc!.state.session!.find!.libraryHandedOver(s2.json.ticket)).toBeNull();
    vi.useRealTimers();
    await until(async () => ((x) => (x.state === "no-open-copy" ? x : undefined))(await view(pid, f.id)), "the entry to come back");
    // The events carried three fields each; the audit says a library fetch was started, with the method.
    const progress = events.filter((x) => x.type === "find.progress").map((x) => x.data as Record<string, unknown>);
    for (const d of progress) expect(Object.keys(d).sort()).toEqual(["entryId", "projectId", "state"]);
    expect(progress.filter((d) => d.state === "waiting-sign-in")).toHaveLength(2);
    const { audit } = await everything(tmp);
    expect(audit).toContain('"op":"project.find.library-start"');
    expect(audit).toContain('"method":"library_access"');
    // (afterEach scans the log, the error answers, the events, the audit and the queue files for the host, the DOI,
    // the pasted link's session and both tickets, and checks that no request was made.)
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task F17 (R329): the file handed over — through the service's input-line callback after the token, as main.ts
// composes it, with a real file in a real temporary inbox and an open ticket made through the start route.

describe("F17 (R329): the file the shell hands over waits in the review queue", () => {
  const GRANT = "0123456789abcdef0123456789abcdef";
  /** Recognisable: the grant id and the inbox's name, looked for in every log line, error, event, audit and queue file. */
  const PATHS = [GRANT, "library-inbox", "Participant Ana Lopez"];
  const GOOD_LINES = [
    "Grammar of Invented Habits",
    "Ottoline Mirabelle",
    "Abstract. A grammar of invented habits, made up for these tests, with enough words to be read as text.",
    "The study reads how people speak of their habits over many years, drawing on letters and",
    "interviews kept in family hands, and argues that the words they choose shape what they",
    "are able to remember of the places they have lived in and of the work they have done there.",
  ];
  const goodPdf = () => buildPdf({ title: "Grammar of Invented Habits", author: "Ottoline Mirabelle", lines: GOOD_LINES });
  let inbox: string;

  /** The inbox as the shell makes it (0700), in the service's own settings folder. */
  async function inboxReady(): Promise<string> {
    inbox = inboxOf(svc!.state.deps.appConfigDir);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await chmod(inbox, 0o700);
    return inbox;
  }
  /** The service's standard input after its token, with main.ts's callback attached. */
  async function pipe(): Promise<PassThrough> {
    const input = new PassThrough();
    const p = readStartupToken({ input, env: { PATH: "/usr/bin" }, argv: ["/usr/bin/node", "/x/main.ts"], execArgv: [], timeoutMs: 2000 });
    input.write(`${TOKEN}\n`);
    await p;
    onInputLines(input, inputLineHandler(svc!.folderGrants, libraryFileHandler(svc!.state)), () => {});
    return input;
  }
  const fileLine = (ticket: string, path: string, id = GRANT) => `${JSON.stringify({ type: "file-grant", id, ticket, path })}\n`;
  const there = (p: string) =>
    lstat(p).then(
      () => true,
      () => false,
    );
  /** A project with a resting entry, a library set, and a fetch started: the ticket. */
  async function started(gov?: string): Promise<{ pid: string; e: FindEntry; ticket: string }> {
    await start();
    await openNewLibrary();
    const pid = await newProject(gov ? { gov } : {});
    await setLibrary();
    const e = await resting(pid, { state: "no-open-copy" });
    const r = await startFetch(pid, e.id);
    expect(r.status, r.body).toBe(200);
    await inboxReady();
    return { pid, e, ticket: r.json.ticket as string };
  }
  /** Nothing of the line or the path in any log line, error answer, event, audit or queue file. */
  async function nothingOfThePath(): Promise<void> {
    const files = await everything(tmp);
    const seen = [logs, ...errorBodies, ...events.map((x) => JSON.stringify(x)), files.audit, files.queue].join("\n");
    for (const w of PATHS) expect(seen.includes(w), `"${w}" was logged, sent or written`).toBe(false);
  }

  it("accepted: the entry needs your check, the file waits in the review queue, the record has no file; the ticket ended and the pause started", async () => {
    const { pid, e, ticket } = await started();
    const f = join(inbox, `${GRANT}.pdf`);
    await writeFile(f, await goodPdf(), { mode: 0o600 });
    const input = await pipe();
    input.write(fileLine(ticket, f));
    const v = await until(async () => {
      const x = await view(pid, e.id);
      return x.state !== "waiting-sign-in" && x;
    }, "the entry to leave the sign-in window");
    expect(v.state).toBe("needs-check");
    expect(v.reason?.code).toBe("file-looks-right");
    // The inbox's file is gone; the file waits only under the project's waiting files.
    expect(await readdir(inbox)).toEqual([]);
    // The review queue holds it, as a found copy's (the same kind, cause and group).
    const q = await call({ url: `/projects/${pid}/review` });
    expect(q.status, q.body).toBe(200);
    const item = (q.json.items as Array<Record<string, unknown>>).find((x) => (x.cause as { findEntryId?: string } | undefined)?.findEntryId === e.id)!;
    expect(item).toMatchObject({ sourceId: e.sourceId, kind: "verification", group: "found-file", cause: { kind: "acquired-file-mismatch", findEntryId: e.id }, heldFile: { why: "looks-right", kind: "pdf" } });
    // R301: nothing attached.
    const rec = await call({ url: `/projects/${pid}/sources/${e.sourceId}` });
    expect(rec.json.assets).toEqual([]);
    // The ticket ended at the hand-over, and the pause started.
    expect(svc!.state.session!.find!.libraryHandedOver(ticket)).toBeNull();
    const other = await resting(pid, { state: "no-open-copy" });
    expect((await startFetch(pid, other.id)).json.error.reason).toBe("library-pause");
    // The audit says the method of the hold; "Use this file" then attaches it with how it was got.
    expect((await everything(tmp)).audit).toContain('"method":"library_access"');
    const used = await call({ method: "POST", url: `/review/${item.id as string}/held-file`, body: { projectId: pid, decision: "attach" } });
    expect(used.status, used.body).toBe(200);
    const after = await repo().getSource(pid, e.sourceId!);
    expect(after.assets[0]!.acquired).toMatchObject({ method: "library_access", via: "sign-in-window", access: "signed-in-session", address: `https://${LIB_HOST}/login`, check: { result: "match", by: "title" } });
    expect((await view(pid, e.id)).state).toBe("in-library");
    await nothingOfThePath();
  });

  it("a grant without an open ticket deletes its file inside the inbox, touches nothing outside it, and changes nothing", async () => {
    const { pid, e } = await started();
    const f = join(inbox, `${GRANT}.pdf`);
    await writeFile(f, await goodPdf(), { mode: 0o600 });
    const outside = join(tmp, "Participant Ana Lopez.pdf");
    await writeFile(outside, "%PDF-1.4 kept");
    const input = await pipe();
    const wrong = "ab".repeat(16);
    input.write(fileLine(wrong, f));
    input.write(fileLine(wrong, outside));
    await until(async () => !(await there(f)), "the inbox file to go");
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(outside, "utf8")).toBe("%PDF-1.4 kept");
    expect((await view(pid, e.id)).state).toBe("waiting-sign-in");
    await nothingOfThePath();
  });

  it("a file-grant outside the inbox is discarded: the ticket ends, the file outside is untouched, the entry comes back and says the file could not be read", async () => {
    const { pid, e, ticket } = await started();
    const outside = join(tmp, `${GRANT}.pdf`);
    await writeFile(outside, await goodPdf());
    const before = await readFile(outside);
    const input = await pipe();
    input.write(fileLine(ticket, outside));
    const v = await until(async () => {
      const x = await view(pid, e.id);
      return x.state !== "waiting-sign-in" && x;
    }, "the entry to come back");
    expect(v.state).toBe("no-open-copy");
    expect(v.library).toEqual({ canStart: true, lastFile: "unreadable" });
    expect(await readFile(outside)).toEqual(before);
    expect(svc!.state.session!.find!.libraryHandedOver(ticket)).toBeNull();
    expect((await call({ url: `/projects/${pid}/review` })).json.items).toEqual([]);
    await nothingOfThePath();
  });

  it("a symlink in the inbox is refused: the link removed, its target kept and unread; the entry comes back", async () => {
    const { pid, e, ticket } = await started();
    const target = join(tmp, "target.pdf");
    await writeFile(target, await goodPdf());
    const f = join(inbox, `${GRANT}.pdf`);
    await symlink(target, f);
    const input = await pipe();
    input.write(fileLine(ticket, f));
    await until(async () => (await view(pid, e.id)).state !== "waiting-sign-in", "the entry to come back");
    expect(await there(f)).toBe(false);
    expect(await there(target)).toBe(true);
    expect((await view(pid, e.id)).library?.lastFile).toBe("unreadable");
    await nothingOfThePath();
  });

  it("not a PDF or EPUB by its bytes: not kept; the entry is back exactly as it was and its view says why — until its next start", async () => {
    const { pid, e, ticket } = await started();
    const f = join(inbox, `${GRANT}.pdf`);
    await writeFile(f, "<html><body>Your session has ended. Sign in again.</body></html>", { mode: 0o600 });
    const input = await pipe();
    input.write(fileLine(ticket, f));
    const v = await until(async () => {
      const x = await view(pid, e.id);
      return x.state !== "waiting-sign-in" && x;
    }, "the entry to come back");
    expect(v.state).toBe("no-open-copy");
    expect(v.reason).toBeUndefined();
    expect(v.library).toEqual({ canStart: true, lastFile: "not-pdf" });
    expect(FIND_LIBRARY_FILE_TEXT[v.library!.lastFile!]).toBe("The file from your library was not kept: it is not a PDF or EPUB.");
    expect(await readdir(inbox)).toEqual([]);
    expect((await call({ url: `/projects/${pid}/review` })).json.items).toEqual([]);
    // The next start drops it.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + LIBRARY_PAUSE_MS });
    expect((await startFetch(pid, e.id)).status).toBe(200);
    const cancelled = await call({ method: "POST", url: `/projects/${pid}/find/${e.id}/library/cancel` });
    expect(cancelled.json.library).toEqual({ canStart: true });
    await nothingOfThePath();
  });

  it("the rules no longer allow fetching through the library: not kept, and the view says so in the rules' words (no start offered)", async () => {
    const { pid, e, ticket } = await started();
    const g = await repo().getGovernance(pid);
    await repo().setGovernance(pid, GOV("acquireMethods: [reference_lookup]\n"), { baseSha256: g.sha256 });
    const f = join(inbox, `${GRANT}.pdf`);
    await writeFile(f, await goodPdf(), { mode: 0o600 });
    const input = await pipe();
    input.write(fileLine(ticket, f));
    const v = await until(async () => {
      const x = await view(pid, e.id);
      return x.state !== "waiting-sign-in" && x;
    }, "the entry to come back");
    expect(v.state).toBe("no-open-copy");
    expect(v.library).toEqual({ canStart: false, reason: "not-offered", lastFile: "rules-method" });
    expect(await readdir(inbox)).toEqual([]);
    await nothingOfThePath();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Task F18a (R334 b): "Test" on the Your library screen — the library's address for one fixed, well-known work.

describe("the test's address (R334 b)", () => {
  const TEST_TARGET = "https://doi.org/10.1038/171737a0";
  const testAddress = () => call({ method: "POST", url: "/settings/your-library/test" });

  it("POST /settings/your-library/test: the library's address for 10.1038/171737a0 by the stored access, no-store; no library need be open, no request is made", async () => {
    await start();
    await setLibrary({ name: "Zorblatt University", access: EZ });
    const r = await testAddress();
    expect(r.status, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json).toEqual({ url: `https://${LIB_HOST}/login?url=${TEST_TARGET}` });
    // Each kind of address, as libraryAddressFor builds it.
    await setLibrary({ name: "", access: { kind: "openathens", base: "https://go.openathens.net/redirector/zorblatt-univ.example.edu?url=" } });
    expect((await testAddress()).json).toEqual({ url: `https://go.openathens.net/redirector/zorblatt-univ.example.edu?url=${encodeURIComponent(TEST_TARGET)}` });
    await setLibrary({ name: "", access: { kind: "openurl", base: `https://${LIB_HOST}/openurl` } });
    expect((await testAddress()).json).toEqual({ url: `https://${LIB_HOST}/openurl?url_ver=Z39.88-2004&rft_id=info:doi/10.1038%2F171737a0` });
    // The address is in no log line (the method, path and status only), and nothing of the fixed work either.
    expect(logs).toContain("/settings/your-library/test");
    expect(logs).not.toContain("171737a0");
    expect(logs).not.toContain("doi.org");
    // (afterEach: the library's host in no log line, error, event or file; no request at all.)
  });

  it("refused in words: no library set; a body; an unreadable file; a newer version's file; the extension's token", async () => {
    await start();
    const none = await testAddress();
    expect(none.status).toBe(409);
    expect(none.json.error).toMatchObject({ message: FIND_LIBRARY_TEXT.noLibrary, reason: "no-library" });
    await setLibrary({ name: "", access: EZ });
    for (const body of [{ url: `https://${LIB_HOST}/` }, { doi: "10.5555/x" }, [1]]) {
      const r = await call({ method: "POST", url: "/settings/your-library/test", body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.message).toBe(YOUR_LIBRARY_TEXT.noBody);
    }
    const file = join(deps.appConfigDir, "your-library.json");
    await writeFile(file, "not json {");
    const unreadable = await testAddress();
    expect(unreadable.status).toBe(409);
    expect(unreadable.json.error.message).toBe(YOUR_LIBRARY_TEXT.unreadable);
    await writeFile(file, JSON.stringify({ v: 2, name: "x", access: EZ, staySignedIn: false }));
    const newer = await testAddress();
    expect(newer.status).toBe(409);
    expect(newer.json.error.message).toBe(YOUR_LIBRARY_TEXT.newer);
    // R336 f: every answer of the route, its refusals included, is no-store.
    for (const r of [none, unreadable, newer]) expect(r.headers["cache-control"]).toBe("no-store");
    const withBody = await call({ method: "POST", url: "/settings/your-library/test", body: { doi: "10.5555/x" } });
    expect(withBody.headers["cache-control"]).toBe("no-store");
    // The extension's token: refused before the route runs, as on every Your library route.
    await openNewLibrary();
    const token = await pairExtension();
    const ext = await svc!.app.inject({ method: "POST", url: "/settings/your-library/test", headers: { authorization: `Bearer ${token}`, origin: EXT } });
    expect(ext.statusCode).toBe(403);
    errorBodies.push(ext.body);
  });

  it("the address is in no log line, audit entry, event or error — over a test, a refused test and a start", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await setLibrary({ name: "", access: EZ });
    const ok = await testAddress();
    expect(ok.status).toBe(200);
    const body = await call({ method: "POST", url: "/settings/your-library/test", body: { link: LINK } });
    expect(body.status).toBe(400);
    expect(body.body).not.toContain(SESSION);
    const e = await resting(pid, { state: "no-open-copy" });
    expect((await startFetch(pid, e.id)).status).toBe(200);
    // A test while a ticket is open is still answered (the shell, not the service, refuses a second window).
    expect((await testAddress()).status).toBe(200);
    const { audit } = await everything(tmp);
    for (const w of [ok.json.url as string, "171737a0"]) {
      expect(logs.includes(w), `${w} logged`).toBe(false);
      expect(audit.includes(w), `${w} audited`).toBe(false);
      expect(events.some((x) => JSON.stringify(x).includes(w)), `${w} in an event`).toBe(false);
      expect(errorBodies.some((b) => b.includes(w)), `${w} in an error`).toBe(false);
    }
    // A test writes nothing: no audit entry names it.
    expect(audit).not.toContain("your-library/test");
  });
});

describe("R336 i: the answers name the stored address in the service's own words", () => {
  it("GET and PUT carry `addressSentence` — the derive's sentence for that address (a resolver: host and path) — and none when no library is set", async () => {
    await start();
    expect((await call({ url: "/settings/your-library" })).json.addressSentence).toBeUndefined();
    const derived = await call({ method: "POST", url: "/settings/your-library/derive", body: { link: LINK } });
    const put = await setLibrary({ name: "", access: derived.json.access });
    expect(put.addressSentence).toBe(derived.json.sentence);
    expect((await call({ url: "/settings/your-library" })).json.addressSentence).toBe(derived.json.sentence);
    const ou = await call({ method: "POST", url: "/settings/your-library/derive", body: { link: "https://resolver.example.edu/openurl?url_ver=Z39.88-2004&rft_id=x" } });
    expect((await setLibrary({ name: "", access: ou.json.access })).addressSentence).toBe("Your library's address: resolver.example.edu/openurl (link resolver)");
    expect((await setLibrary({ name: "", access: null })).addressSentence).toBeUndefined();
    // A file that cannot be used names no address.
    await writeFile(join(deps.appConfigDir, "your-library.json"), JSON.stringify({ v: 2, name: "x", access: EZ, staySignedIn: false }));
    expect((await call({ url: "/settings/your-library" })).json.addressSentence).toBeUndefined();
  });
});
