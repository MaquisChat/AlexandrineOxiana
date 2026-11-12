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
import { WorkerJobError, deviceDeps, type JobResult, type WorkerClient, type WorkerJob } from "@ao/library";
// The real service (dev dependency), not the e2e stub: this test is the integration check.
import { createService, type LibraryService, type WorkerProvider } from "@ao/library-service";
import { ApiError, createApi, type LocalStorageArea } from "./api.js";

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
    const after = await ui("GET", "/extension/pairings");
    expect(after.extensions[0].port).toBe(port);
  });
});
