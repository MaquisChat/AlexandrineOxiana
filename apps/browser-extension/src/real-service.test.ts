// @vitest-environment node
/**
 * The extension's own client (api.ts) against the real library service (apps/library-service) on
 * a real 127.0.0.1 listener (R111): pairing, GET /projects without an Origin header (as Chrome sends
 * it for a host-permitted GET), POST /capture/browser/links with the paired Origin, and the error
 * codes the extension branches on (POLICY_DENIED with the reason; FORBIDDEN).
 *
 * Chrome's behaviour is reproduced by the fetch handed to the client: GETs go without Origin, other
 * methods carry the extension's origin.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerJobError, deviceDeps, type FindEntry, type JobResult, type WorkerClient, type WorkerJob } from "@ao/library";
// The real service (dev dependency), not the e2e stub: this test is the integration check.
import { createService, type LibraryService, type WorkerProvider } from "@ao/library-service";
// For the browser's fallback: a resting queue entry written as the runner writes it, a made-up PDF, the service's sentences.
import { newId } from "../../../packages/core/src/ids.js";
import { appendFindEntriesIn } from "../../../packages/library/src/repo/repo.js";
import { FIND_BROWSER_TEXT } from "../../../packages/shared/src/index.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { ApiError, createApi, type LocalStorageArea } from "./api.js";
import { parseFileAnswer, parseWaiting } from "./find.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const GOV = (methods: string) => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
captureMethods: [${methods}]
`;

/** A media worker whose downloads all fail (the queue still reports per-item outcomes). */
function failingWorker(): WorkerProvider {
  return {
    async start() {
      const client = {
        async submit(_pid: string, _job: WorkerJob): Promise<JobResult> {
          throw new WorkerJobError("TOOL_FAILED", "the tool failed");
        },
        async resumePending() {
          return [];
        },
      } as unknown as WorkerClient;
      return { clientFor: () => client, versions: async () => ({}), updateTools: async () => ({}) as never, stop: async () => {} };
    },
  };
}

/** What Chrome does for the extension: no Origin on a host-permitted GET, the extension's origin otherwise. */
function chromeLikeFetch(sent: Array<{ method: string; path: string; origin: string | undefined }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (method !== "GET") headers.set("origin", EXT);
    sent.push({ method, path: new URL(String(input)).pathname, origin: headers.get("origin") ?? undefined });
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

function memoryStorage(): LocalStorageArea {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => (m.has(k) ? { [k]: m.get(k) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) m.set(k, v);
    },
    remove: async (k) => {
      m.delete(k);
    },
  };
}

let tmp: string;
let svc: LibraryService;
let port: number;

async function ui(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await r.json();
  expect(r.status, JSON.stringify(json)).toBe(200);
  return json;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-ext-client-"));
  svc = await createService({ token: TOKEN, deps: { ...deviceDeps(join(tmp, "config")), settleMs: 0 }, logStream: { write: () => true } as unknown as NodeJS.WritableStream, worker: failingWorker(), autoStartWorker: false });
  port = await svc.listen(0);
});
afterEach(async () => {
  await svc.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("the extension's api.ts against the real service (R111)", () => {
  it("pairs, lists projects without an Origin, queues links, and gets the codes it branches on", async () => {
    await ui("POST", "/libraries", { path: join(tmp, "Lib"), name: "Lib" });
    const open = (await ui("POST", "/projects", { name: "Profiles", governanceYaml: GOV("manual_upload, browser_capture, downloader"), encryption: { enabled: false } })).project.id as string;
    const strict = (await ui("POST", "/projects", { name: "Strict", governanceYaml: GOV("manual_upload, browser_capture"), encryption: { enabled: false } })).project.id as string;

    const sent: Array<{ method: string; path: string; origin: string | undefined }> = [];
    const api = createApi({ fetch: chromeLikeFetch(sent), storage: memoryStorage() });
    const { code } = await ui("POST", "/extension/pair");
    const pairing = await api.pair(port, code);
    expect(pairing.port).toBe(port);

    // GET /projects goes without an Origin (as from Chrome) and is answered.
    const projects = await api.listProjects();
    expect(projects.map((p) => p.name).sort()).toEqual(["Profiles", "Strict"]);
    expect(sent.find((s) => s.path === "/projects")).toEqual({ method: "GET", path: "/projects", origin: undefined });

    // Finish: the noted links go to POST /capture/browser/links and are queued.
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const { queueId } = await api.queueLinks(open, ["https://www.youtube.com/watch?v=aoTest00001"]);
    expect(queueId).toEqual(expect.any(String));
    await svc.state.idle();
    expect(events.filter((e) => e.type === "capture.progress" && e.data.queueId === queueId).at(-1)?.data).toMatchObject({ done: 1, total: 1, finished: true });

    // A project whose rules do not allow the downloader: POLICY_DENIED with the reason.
    const denied = await api.queueLinks(strict, ["https://www.youtube.com/watch?v=aoTest00002"]).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiError);
    expect(denied).toMatchObject({ code: "POLICY_DENIED", status: 403 });
    expect((denied as ApiError).reason).toMatch(/downloader/i);

    // A bad link list: VALIDATION (never confused with FORBIDDEN or POLICY_DENIED).
    expect(await api.queueLinks(open, ["file:///etc/passwd"]).catch((e: unknown) => e)).toMatchObject({ code: "VALIDATION", status: 400 });
    // Every POST carried the paired origin.
    expect(sent.filter((s) => s.method === "POST").every((s) => s.origin === EXT)).toBe(true);
  });
});

// Find and acquire, the browser's fallback (R348 f, i): the extension's two routes on the real service, called by the
// extension's own client (api.ts) and read by its own parsers (find.ts). The work is made to wait by the desktop app's
// token (`POST …/browser/start`), as the app does.
describe("the browser's fallback against the real service (R348 f): the list and the PDF", () => {
  const NO_FREE = `${GOV("manual_upload, browser_capture")}acquireMethods: [reference_lookup, library_access]\n`;
  const TITLE = "Quillbrook Ledger of Habits";
  const PAGE = "https://pdfs.publisher.example/content/quillbrook.pdf?accessToken=secret#page=2";

  /** A library, "Your library" set, the extension paired, a project with a resting entry, the browser's wait started. */
  async function waitingWork(): Promise<{ api: ReturnType<typeof createApi>; pid: string; eid: string; sent: Array<{ method: string; path: string; origin: string | undefined }> }> {
    await ui("POST", "/libraries", { path: join(tmp, "Lib"), name: "Lib" });
    const pid = (await ui("POST", "/projects", { name: "Habits", governanceYaml: NO_FREE, encryption: { enabled: false } })).project.id as string;
    await ui("PUT", "/settings/your-library", { name: "Vexmoor University", access: { kind: "ezproxy-login", base: "https://ezproxy.vexmoor-univ.example.edu/login?url=" } });
    const sent: Array<{ method: string; path: string; origin: string | undefined }> = [];
    const api = createApi({ fetch: chromeLikeFetch(sent), storage: memoryStorage() });
    const { code } = await ui("POST", "/extension/pair");
    await api.pair(port, code);
    // A record and a resting queue entry, written as the find runner writes them.
    const repo = svc.state.session!.repo;
    const sf = await repo.createSource(
      pid,
      {
        projectIds: [],
        type: "article-journal",
        title: { variants: [{ lang: "en", kind: "original", value: TITLE }] },
        creators: [{ role: "author", family: "Mirabelle", given: "Ottoline" }],
        issued: "1999",
        identifiers: { doi: "10.5555/ao.f20b.quillbrook" },
        caseAttributes: {},
        availability: { status: "available" },
        collectionIds: [],
        tagIds: [],
        participantIds: [],
      },
      [],
      { provenance: { captureMethod: "reference_lookup", capturedAt: new Date().toISOString(), tool: { name: "find-and-acquire", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false } },
    );
    const at = new Date().toISOString();
    const entry: FindEntry = { id: newId(), projectId: pid, typed: "Mirabelle 1999 ledger", state: "no-open-copy", createdAt: at, updatedAt: at, attempts: 0, sourceId: sf.source.id };
    await appendFindEntriesIn(repo, pid, [entry], "add");
    // The desktop app's press: the work now waits in the browser.
    const started = await ui("POST", `/projects/${pid}/find/${entry.id}/browser/start`);
    expect(Object.keys(started)).toEqual(["url"]);
    return { api, pid, eid: entry.id, sent };
  }

  it("nothing waiting: the list is { waiting: [] }, read as nothing", async () => {
    const api = createApi({ fetch: chromeLikeFetch([]), storage: memoryStorage() });
    const { code } = await ui("POST", "/extension/pair");
    await api.pair(port, code);
    const raw = await api.findWaiting();
    expect(raw).toEqual({ waiting: [] });
    expect(parseWaiting(raw)).toEqual([]);
  });

  it("paired: the list holds the waiting work (its ticket and label, nothing else); its PDF is sent and HELD for the researcher's check; then nothing waits", async () => {
    const { api, pid, eid, sent } = await waitingWork();
    const raw = await api.findWaiting();
    const waiting = parseWaiting(raw);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.label).toBe(TITLE);
    expect(waiting[0]!.ticket).toMatch(/^[0-9a-f]{32}$/);
    expect(raw).toEqual({ waiting });

    // A file that is not a PDF: the service's refusal, in its shape; the work still waits.
    const notPdf = await api.sendFindPdf(waiting[0]!.ticket, PAGE, new Blob([new TextEncoder().encode("<html>not a pdf</html>")], { type: "application/pdf" })).catch((e: unknown) => e);
    expect(notPdf).toBeInstanceOf(ApiError);
    expect(notPdf).toMatchObject({ status: 400, reason: "browser-not-pdf", message: FIND_BROWSER_TEXT.notPdf, serviceShaped: true });
    expect(parseWaiting(await api.findWaiting())).toEqual(waiting);

    // A wrong ticket: the service's 404, its sentence.
    expect(await api.sendFindPdf("f".repeat(32), PAGE, new Blob([new Uint8Array(await buildPdf({ title: TITLE }))])).catch((e: unknown) => e)).toMatchObject({ status: 404, reason: "browser-not-waiting", message: FIND_BROWSER_TEXT.notWaiting });

    // The PDF: held, with the service's sentence; the work no longer waits in the browser.
    const pdf = await buildPdf({ title: TITLE, author: "Ottoline Mirabelle", lines: [TITLE, "Ottoline Mirabelle", "Abstract. A ledger of invented habits, made up for these tests, with enough words to be read as text."] });
    const answer = parseFileAnswer(await api.sendFindPdf(waiting[0]!.ticket, PAGE, new Blob([new Uint8Array(pdf)], { type: "application/pdf" })));
    expect(answer).toEqual({ outcome: "held", sentence: FIND_BROWSER_TEXT.held });
    expect(parseWaiting(await api.findWaiting())).toEqual([]);
    const entry = (await ui("GET", `/projects/${pid}/find`)).entries.find((e: { id: string }) => e.id === eid);
    expect(entry.state).toBe("needs-check");
    // Every request carried the paired Origin (both routes need it); the token never in an address.
    expect(sent.filter((s) => s.path.startsWith("/find/")).every((s) => s.method === "POST" && s.origin === EXT)).toBe(true);
  });
});

describe("a paired browser across a relaunch of the real service (R171, defect D13)", () => {
  const relaunch = async (onPort: number): Promise<number> => {
    await svc.close();
    svc = await createService({ token: TOKEN, deps: { ...deviceDeps(join(tmp, "config")), settleMs: 0 }, logStream: { write: () => true } as unknown as NodeJS.WritableStream, worker: failingWorker(), autoStartWorker: false });
    port = await svc.listen(onPort);
    return port;
  };

  it("on the same port it works with nothing to do; on a new port, the typed port is checked and saved, the token unchanged", async () => {
    const storage = memoryStorage();
    const api = createApi({ fetch: chromeLikeFetch([]), storage });
    const { code } = await ui("POST", "/extension/pair");
    const first = port;
    const paired = await api.pair(first, code);

    // Same port (the service listened again on its last port): the pairing works as it is.
    await relaunch(first);
    await ui("POST", "/libraries", { path: join(tmp, "Lib"), name: "Lib" });
    await ui("POST", "/projects", { name: "Profiles", governanceYaml: GOV("manual_upload, browser_capture"), encryption: { enabled: false } });
    expect((await api.listProjects()).map((p) => p.name)).toEqual(["Profiles"]);

    // Another port (the old one was taken): the old port does not answer; the app's list says the browser holds it.
    // The system may hand the just-freed port back once in a while: ask again until it differs (review M7).
    for (let i = 0; i < 5 && (await relaunch(0)) === first; i++);
    expect(port).not.toBe(first);
    expect(await api.listProjects().catch((e: unknown) => e)).toMatchObject({ code: "UNREACHABLE" });
    const before = await ui("GET", "/extension/pairings");
    expect(before.port).toBe(port);
    expect(before.extensions[0].port).toBe(first);

    // The researcher types the new port: one authorised request, then saved; the token is the same.
    const r = await api.changePort(String(port));
    expect(r.pairing).toEqual({ ...paired, port });
    expect((await api.getPairing())?.token).toBe(paired.token);
    // The service records the port without making the request wait: let that write finish.
    await svc.pairing.idle();
    const after = await ui("GET", "/extension/pairings");
    expect(after.extensions[0].port).toBe(port);
  });
});
