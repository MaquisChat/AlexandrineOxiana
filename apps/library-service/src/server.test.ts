/**
 * The local library service (Task 30, spec 8.2, R96). Most tests use Fastify `inject`; the Host /
 * Origin / SSE tests use a real listener on 127.0.0.1, and the readiness / SIGTERM test spawns the
 * service's entry point.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KeyRing,
  OcrQueue,
  WorkerJobError,
  createLibrary,
  deviceDeps,
  destroyRaw,
  indexSource,
  setMeta,
  listBackups,
  openLibrary,
  projectWarnings,
  openRepo,
  readDestruction,
  resumeDestruction,
  type Deps,
  type JobResult,
  type WorkerClient,
  type WorkerJob,
} from "@ao/library";
import { existsSync } from "node:fs";
import { buildPdf, tinyPng } from "../../../tests/fixtures/generate.mjs";
// Test seam of the library (same module instance as @ao/library's): makes overwriting a file fail.
import { shredSeams } from "../../../packages/library/src/fs/shred.js";
import * as authModule from "./auth.js";
import { CREDENTIAL_QUERY_KEYS, IN_LIBRARY_TEXT } from "@ao/shared";
import { createService, type LibraryService, type ServiceOptions, type WorkerProvider } from "./server.js";

// The library as it is, with the destruction retry observable: a test can tell whether the service
// started it for a project at all (R3-M3), not only what it changed.
vi.mock("@ao/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ao/library")>();
  return { ...actual, resumeDestruction: vi.fn(actual.resumeDestruction) };
});

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };

/** Unencrypted, not identifying, no network lookups. */
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const HIPAA_GOV = `profiles: [hipaa]
processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService;

function testDeps(dir: string): Deps {
  return { ...deviceDeps(join(dir, "config")), settleMs: 0 };
}

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null, ...over });
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown; headers?: Record<string, string> };
async function call(r: Inject) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
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

async function newProject(gov = OPEN_GOV, encrypted = false, name = "Study"): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: gov, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

async function fixturePdf(name = "paper.pdf", title = "Coastal Fisheries and Kinship"): Promise<string> {
  const p = join(tmp, "in", name);
  await import("node:fs/promises").then((f) => f.mkdir(dirname(p), { recursive: true }));
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: ["Coastal fisheries and kinship in the delta."] }));
  return p;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-service-"));
  deps = testDeps(tmp);
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("authentication (R96)", () => {
  beforeEach(() => start());

  it("no token, a wrong token, or a token in the query string → 401", async () => {
    expect((await svc.app.inject({ method: "GET", url: "/libraries" })).statusCode).toBe(401);
    expect((await call({ url: "/libraries", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call({ url: "/libraries", headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(401);
    const q = await svc.app.inject({ method: "GET", url: `/libraries?token=${TOKEN}` });
    expect(q.statusCode).toBe(401);
    // Even with a valid header, a token in the query string is refused.
    const both = await call({ url: `/libraries?access_token=${TOKEN}` });
    expect(both.status).toBe(401);
    expect(both.json).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
    expect((await call({ url: "/libraries" })).status).toBe(200);
  });

  it("errors have exactly {error:{code,message,reason?}} and a body over 1 MB is 413", async () => {
    const big = await svc.app.inject({ method: "POST", url: "/libraries/open", headers: { ...auth, "content-type": "application/json" }, payload: JSON.stringify({ path: "x".repeat(1_100_000) }) });
    expect(big.statusCode).toBe(413);
    expect(Object.keys(big.json())).toEqual(["error"]);
    expect(big.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    const bad = await svc.app.inject({ method: "POST", url: "/libraries/open", headers: { ...auth, "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION");
  });

  it("error bodies never carry absolute paths", async () => {
    const secret = join(tmp, "private-folder", "not-a-library");
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: secret } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toContain(tmp);
    expect(r.body).not.toContain("private-folder");
    expect(Object.keys(r.json.error).every((k) => ["code", "message", "reason"].includes(k))).toBe(true);
  });

  it("no library open → 503 LIBRARY_OFFLINE", async () => {
    const r = await call({ url: "/projects" });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("LIBRARY_OFFLINE");
  });
});

describe("libraries, projects, sources", () => {
  beforeEach(() => start());

  it("create library → open → create project → attach a PDF → search finds it", async () => {
    const path = await openNewLibrary();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.status, opened.body).toBe(200);
    expect(opened.json).toMatchObject({ name: "Lib", mode: "read-write" });
    expect(opened.json.readOnlyReason).toBeUndefined();
    const listed = await call({ url: "/libraries" });
    expect(listed.json.current).toMatchObject({ name: "Lib", mode: "read-write" });

    const pid = await newProject();
    const pdf = await fixturePdf();
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [pdf] } });
    expect(att.status, att.body).toBe(200);
    const [outcome] = att.json.items;
    expect(["created", "needs-review"]).toContain(outcome.outcome);
    const sid = outcome.sourceId as string;

    const found = await call({ url: `/projects/${pid}/sources?text=fisheries&limit=10` });
    expect(found.status).toBe(200);
    expect(found.json.items.map((i: { id: string }) => i.id)).toContain(sid);
    const none = await call({ url: `/projects/${pid}/sources?text=zzzunfindable` });
    expect(none.json.total).toBe(0);
    // Task 58: a match in an annotation, and an index awaiting a rebuild, reach the interface.
    const idx = svc.state.session!.index!.db;
    const sf = await svc.state.session!.repo.getSource(pid, sid);
    indexSource(idx, { ...sf, annotations: [{ id: sid, sourceId: sid, kind: "note", anchors: [], body: "quokkaannotation", author: "t", createdAt: new Date().toISOString() }] });
    const viaAnn = await call({ url: `/projects/${pid}/sources?text=quokkaannotation` });
    expect(viaAnn.json.items).toEqual([expect.objectContaining({ id: sid, matchedIn: "annotation" })]);
    expect(viaAnn.json).not.toHaveProperty("incomplete");
    setMeta(idx, "needsRebuild", "annotations");
    expect((await call({ url: `/projects/${pid}/sources` })).json.incomplete).toBe(true);
    idx.prepare("DELETE FROM meta WHERE key = 'needsRebuild'").run();
    // A query with too many words is refused in plain words (N1).
    const many = await call({ url: `/projects/${pid}/sources?text=${encodeURIComponent(Array.from({ length: 17 }, (_, i) => `w${i}`).join(" "))}` });
    expect(many.status).toBe(400);
    expect(many.json.error).toMatchObject({ code: "VALIDATION", message: "Use at most 16 words in a search." });
    const one = await call({ url: `/projects/${pid}/sources/${sid}` });
    expect(one.json.source.id).toBe(sid);
    expect((await call({ url: `/projects/${pid}/sources/01ZZZZZZZZZZZZZZZZZZZZZZZZ` })).status).toBe(404);
  });

  it("collections, tags, membership, field confirmation, transcripts and delete", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } });
    const sid = att.json.items[0].sourceId as string;
    const col = await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "Delta" } });
    expect(col.status, col.body).toBe(200);
    const tag = await call({ method: "POST", url: `/projects/${pid}/tags`, body: { name: "kinship" } });
    expect(tag.status, tag.body).toBe(200);
    const patch = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}`, body: { collectionIds: [col.json.id], tagIds: [tag.json.id] } });
    expect(patch.status, patch.body).toBe(200);
    expect((await call({ url: `/projects/${pid}/sources?collection=${col.json.id}` })).json.total).toBe(1);
    expect((await call({ url: `/projects/${pid}/sources?tag=${tag.json.id}` })).json.total).toBe(1);
    const lists = await call({ url: `/projects/${pid}/collections` });
    expect(lists.json.collections.map((c: { name: string }) => c.name)).toEqual(["Delta"]);
    expect((await call({ url: `/projects/${pid}/tags` })).json.tags.map((t: { name: string }) => t.name)).toContain("kinship");

    const f = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}/fields`, body: { field: "/issued", value: "2001" } });
    expect(f.status, f.body).toBe(200);
    expect(f.json.verification["/issued"].status).toBe("user-confirmed");
    // The audit entry names the field and says the value was changed, then kept; never the value (R191).
    type Ev = { entity?: { id: string }; details?: Record<string, unknown> };
    const confirmations = async () =>
      ((await call({ url: `/projects/${pid}/audit?limit=1000` })).json.events as Ev[]).filter((e) => e.entity?.id === sid && e.details?.op === "source.update" && e.details.confirmed);
    expect((await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}/fields`, body: { field: "/publisher", value: "Marmot Quokka Press" } })).status).toBe(200);
    expect((await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}/fields`, body: { field: "/publisher", value: "Marmot Quokka Press" } })).status).toBe(200);
    const named = (await confirmations()).reverse(); // the route lists the newest first
    expect(named.map((e) => e.details!.confirmed)).toEqual([[{ field: "/issued", choice: "changed" }], [{ field: "/publisher", choice: "changed" }], [{ field: "/publisher", choice: "kept" }]]);
    expect(JSON.stringify(named)).not.toContain("Marmot");

    const t1 = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcripts`, body: { text: "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n", format: "vtt" } });
    expect(t1.status, t1.body).toBe(200);
    const tl = await call({ url: `/projects/${pid}/sources/${sid}/transcripts` });
    expect(tl.json.versions).toHaveLength(1);
    expect(tl.json.versions[0].tool ?? tl.json.versions[0].derivation.operation).toBeTruthy();

    expect((await call({ method: "DELETE", url: `/projects/${pid}/sources/${sid}` })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/sources/${sid}` })).status).toBe(404);
  });

  it("a read-only library refuses changes with 409 READ_ONLY", async () => {
    const path = join(tmp, "Old");
    const lib = await createLibrary(path, "Old", deps);
    await lib.close();
    const meta = JSON.parse(await readFile(join(path, "library.json"), "utf8"));
    await writeFile(join(path, "library.json"), JSON.stringify({ ...meta, formatVersion: 99 }));
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.json).toMatchObject({ mode: "read-only", readOnlyReason: "newer-format" });
    const r = await call({ method: "POST", url: "/projects", body: { name: "X", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("READ_ONLY");
    expect(r.json.error.reason).toBe("newer-format");
  });

  it("unlock with a wrong passphrase → 401; lock purges sensitive lookups", async () => {
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV.replace("atRest: optional", "atRest: required"), true);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    let purged = 0;
    const orig = svc.state.http!.purgeSensitive.bind(svc.state.http!);
    svc.state.http!.purgeSensitive = () => {
      purged++;
      orig();
    };
    const wrong = await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: "wrong passphrase" } });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe("WRONG_PASSPHRASE");
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await call({ url: "/projects" })).json.projects[0]).toMatchObject({ id: pid, encrypted: true, unlocked: true });
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect(purged).toBe(1);
    expect((await call({ url: "/projects" })).json.projects[0].unlocked).toBe(false);
  });
});

describe("governance, audit, citations", () => {
  beforeEach(() => start());

  it("PUT governance: loosening HIPAA encryption without a reason → 400 listing the violation; with one → saved and audited", async () => {
    await openNewLibrary();
    const pid = await newProject(HIPAA_GOV, true, "Clinic");
    const got = await call({ url: `/projects/${pid}/governance` });
    expect(got.json.yaml).toBe(HIPAA_GOV);
    const looser = `${HIPAA_GOV}encryption:\n  atRest: optional\n`;
    expect(got.json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(got.headers.etag).toBe(`"${got.json.sha256}"`);
    const r = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: looser, baseSha256: got.json.sha256 } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION");
    expect(r.json.error.message).toContain("encryption.atRest");
    expect(r.json.error.message).toContain("hipaa");
    const ok = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: looser, reason: "IRB amendment 7" }, headers: { "if-match": `"${got.json.sha256}"` } });
    expect(ok.status, ok.body).toBe(200);
    expect(ok.json.violations).toContainEqual(expect.objectContaining({ control: "encryption.atRest", profile: "hipaa" }));
    expect(ok.json.loosened).toEqual([]); // the effective policy still requires encryption: only the violation is new
    expect((await call({ url: `/projects/${pid}/governance` })).json.yaml).toBe(looser);
    const audit = await call({ url: `/projects/${pid}/audit?limit=5` });
    expect(audit.json.events.some((e: { details?: { reason?: string } }) => e.details?.reason === "IRB amendment 7")).toBe(true);
  });

  it("PUT governance: invalid YAML, custom tags, alias bombs and oversize text are refused", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const base = (await call({ url: `/projects/${pid}/governance` })).json.sha256;
    const put = (yaml: string) => call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml, reason: "test", baseSha256: base } });
    expect((await put("encryption: { atRest: sometimes }")).json.error.code).toBe("VALIDATION");
    expect((await put("encryption: !!js/function 'x'")).status).toBe(400);
    expect((await put("a: &a [1,1,1,1,1,1,1,1,1]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n")).status).toBe(400);
    expect((await put(`# ${"x".repeat(70_000)}\n`)).status).toBe(400);
    expect((await call({ url: `/projects/${pid}/governance` })).json.yaml).toBe(OPEN_GOV);
  });

  it("GET /audit/verify → {ok:true}", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const r = await call({ url: `/projects/${pid}/audit/verify` });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it("POST /cite returns an APA string; GET /styles searches styles", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const sid = (await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } })).json.items[0].sourceId;
    const styles = await call({ url: "/styles?q=apa" });
    expect(styles.json.styles.some((s: { id: string }) => s.id === "apa")).toBe(true);
    const r = await call({ method: "POST", url: "/cite", body: { projectId: pid, refs: [{ sourceId: sid }], style: "apa", format: "text" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.text).toMatch(/^\(.+\)$/);
    const bib = await call({ method: "POST", url: "/bibliography", body: { projectId: pid, selection: { sourceIds: [sid] }, style: "apa", format: "text" } });
    expect(bib.status, bib.body).toBe(200);
    expect(bib.json.content).toContain("Coastal");
    const rm = await call({ method: "POST", url: "/export/refman", body: { projectId: pid, sourceIds: [sid], format: "bibtex" } });
    expect(rm.status, rm.body).toBe(200);
    expect(rm.json.text).toContain("@");
  });
});

describe("capture", () => {
  beforeEach(() => start());

  it("a capture the project's rules deny → 403 POLICY_DENIED with the reason", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const r = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: ["https://www.youtube.com/watch?v=aoTest00001"] } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("POLICY_DENIED");
    expect(r.json.error.reason).toMatch(/downloader/i);
  });

  it("an allowed capture is queued and reports per-item outcomes as capture.progress events", async () => {
    await start({ worker: fakeProvider({ fail: 99 }) });
    await openNewLibrary();
    const pid = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, downloader]\n`);
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const r = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: ["https://www.youtube.com/watch?v=aoTest00001"], options: {} } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.queueId).toEqual(expect.any(String));
    await svc.state.idle();
    const done = events.filter((e) => e.type === "capture.progress" && e.data.queueId === r.json.queueId);
    expect(done.at(-1)?.data).toMatchObject({ done: 1, total: 1, finished: true });
    expect(done.at(-1)?.data.outcome.status).toBe("failed");
  });
});

/** A fake media worker: OCR writes a text sidecar; other jobs fail `fail` times with TOOL_FAILED. */
function fakeProvider(opts: { fail?: number; failStarts?: number } = {}): WorkerProvider & { calls: WorkerJob[]; starts: number } {
  const calls: WorkerJob[] = [];
  const p = {
    calls,
    starts: 0,
    async start() {
      p.starts++;
      if (p.starts <= (opts.failStarts ?? 0)) throw new Error("the media helper is not set up");
      const client = {
        async submit(_pid: string, job: WorkerJob): Promise<JobResult> {
          calls.push(job);
          if (job.type === "pdf.ocr") {
            const { mkdir } = await import("node:fs/promises");
            await mkdir(dirname(job.output), { recursive: true });
            await writeFile(`${job.output}.txt`, "OCR text");
            return { id: "j", type: job.type, output: job.output, files: [`${job.output}.txt`], meta: {}, encrypted: false };
          }
          if (calls.filter((c) => c.type === job.type).length <= (opts.fail ?? 0)) throw new WorkerJobError("TOOL_FAILED", "the tool failed");
          throw new WorkerJobError("TOOL_FAILED", "the tool failed");
        },
        async resumePending() {
          return [];
        },
      } as unknown as WorkerClient;
      return { clientFor: () => client, versions: async () => ({ "yt-dlp": "2026.10.01" }), updateTools: async () => ({ ytDlp: { old: "a", new: "b", managed: true }, galleryDl: { version: "1", pinned: true } }), stop: async () => {} };
    },
  };
  return p;
}

describe("background work (R96 carry-overs)", () => {
  it("on startup, pending OCR jobs of unlocked projects are resumed once the worker is ready", async () => {
    // A library with a queued OCR job, made while no worker ran.
    const path = join(tmp, "Lib");
    const lib = await createLibrary(path, "Lib", deps);
    const ring = new KeyRing();
    const repo = await openRepo(lib, ring, {});
    const { project } = await repo.createProject({ name: "Scans", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const pdf = await fixturePdf("scan.pdf");
    const sf = await repo.createSource(
      project.id,
      { projectIds: [project.id], type: "report", title: { variants: [{ lang: "en", kind: "original", value: "Scan" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: pdf, role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    await new OcrQueue({ repo }).enqueue(project.id, sf.source.id);
    await lib.close();

    const provider = fakeProvider({ failStarts: 1 });
    await start({ worker: provider, autoStartWorker: true });
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc.state.idle();
    expect(provider.calls).toHaveLength(0); // the worker could not start yet
    // The worker becomes ready (here: a route that needs it starts it): pending work resumes.
    expect((await call({ url: "/tools/versions" })).json.versions).toEqual({ "yt-dlp": "2026.10.01" });
    await svc.state.idle();
    expect(provider.calls.map((c) => c.type)).toEqual(["pdf.ocr"]);
    const after = await call({ url: `/projects/${project.id}/sources/${sf.source.id}` });
    expect(after.json.assets.some((a: { kind: string }) => a.kind === "ocr-text")).toBe(true);
  });

  it("failed proxy and OCR jobs are listed by GET /jobs and can be retried", async () => {
    await start({ worker: fakeProvider(), autoStartWorker: true });
    await openNewLibrary();
    const pid = await newProject();
    const jobs = await call({ url: `/jobs?projectId=${pid}` });
    expect(jobs.status).toBe(200);
    expect(jobs.json).toMatchObject({ proxyFailures: [], ocrFailures: [] });
    expect((await call({ method: "POST", url: `/jobs/retry`, body: { projectId: pid } })).status).toBe(200);
  });

  it("the daily backup scheduler backs up due projects (automatic backups default on)", async () => {
    await start();
    await openNewLibrary();
    const on = await newProject(OPEN_GOV, false, "On");
    const off = await newProject(OPEN_GOV, false, "Off");
    expect((await call({ method: "PUT", url: `/projects/${off}/backup-settings`, body: { automatic: false } })).status).toBe(200);
    const first = await svc.state.runScheduledBackups();
    expect(first).toEqual([expect.objectContaining({ projectId: on, ok: true, backedUp: true })]);
    expect(await listBackups(svc.state.session!.repo, on)).toHaveLength(1);
    expect(await listBackups(svc.state.session!.repo, off)).toHaveLength(0);
    // Not due again within a day.
    expect((await svc.state.runScheduledBackups()).filter((r) => r.backedUp)).toEqual([]);
  });

  it("GET /libraries/integrity and SSE library.state carry integrityWarnings and projectWarnings", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const r = await call({ url: "/libraries/integrity?sample=full" });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ integrityWarnings: [], projectWarnings: { [pid]: [] } });
    expect(r.json.report).toMatchObject({ missing: [], mismatched: [] });
    const state = svc.state.libraryState();
    expect(state).toMatchObject({ open: true, integrityWarnings: [], projectWarnings: { [pid]: [] } });
  });

  it("closing the library cancels running work, disposes of its queues and releases the lock", async () => {
    await start();
    const path = await openNewLibrary();
    const repo = svc.state.session!.repo;
    const { proxyQueueFor } = await import("@ao/library");
    const q = proxyQueueFor(repo);
    await svc.close();
    expect(proxyQueueFor(repo)).not.toBe(q); // disposed of: a fresh queue would be made
    const again = await openLibrary(path, deps);
    expect(again.mode).toBe("read-write");
    await again.close();
  });
});

describe("appearance, fieldwork, import", () => {
  beforeEach(() => start());

  it("appearance settings are stored per device and validated", async () => {
    expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "system" });
    const put = await call({ method: "PUT", url: "/settings/appearance", body: { theme: "dark", textScale: 1.25 } });
    expect(put.status, put.body).toBe(200);
    expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "dark", textScale: 1.25 });
    expect((await call({ method: "PUT", url: "/settings/appearance", body: { theme: "neon" } })).status).toBe(400);
    expect(JSON.parse(await readFile(join(deps.appConfigDir, "appearance.json"), "utf8")).theme).toBe("dark");
  });

  it("participants, sessions and consents are created and listed", async () => {
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV.replace("atRest: optional", "atRest: required").replace("containsIdentifiable: false", "containsIdentifiable: true"), true);
    const part = await call({ method: "POST", url: `/projects/${pid}/participants`, body: { code: "P01" } });
    expect(part.status, part.body).toBe(200);
    expect((await call({ url: `/projects/${pid}/participants` })).json.participants).toHaveLength(1);
    const sess = await call({ method: "POST", url: `/projects/${pid}/sessions`, body: { date: "2026-11-01", participantIds: [part.json.id] } });
    expect(sess.status, sess.body).toBe(200);
    expect((await call({ url: `/projects/${pid}/sessions` })).json.sessions).toHaveLength(1);
  });

  it("dry run, import with progress, report, review and undo", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = join(tmp, "in");
    await fixturePdf("a.pdf", "First Paper on Rivers");
    await fixturePdf("b.pdf", "Second Paper on Lakes");
    const dry = await call({ method: "POST", url: `/projects/${pid}/import/dry-run`, body: { adapter: { kind: "folder", path: dir } } });
    expect(dry.status, dry.body).toBe(200);
    expect(dry.json.items).toBe(2);
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const start2 = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir }, options: {} } });
    expect(start2.status, start2.body).toBe(200);
    const batchId = start2.json.batchId as string;
    await svc.state.idle();
    expect(events.some((e) => e.type === "import.progress" && e.data.batchId === batchId && e.data.state === "finished")).toBe(true);
    const report = await call({ url: `/imports/${batchId}/report` });
    expect(report.status, report.body).toBe(200);
    expect((await call({ url: `/imports/${batchId}/review` })).status).toBe(200);
    const undo = await call({ method: "POST", url: `/imports/${batchId}/undo` });
    expect(undo.status, undo.body).toBe(200);
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(0);
    expect((await call({ method: "POST", url: `/projects/${pid}/import/dry-run`, body: { adapter: { kind: "nonsense" } } })).status).toBe(400);
  });

  it("R362 c: a file inside the library is not attached, a folder inside it (or holding it) is not imported — said in plain words", async () => {
    const lib = await openNewLibrary();
    const pid = await newProject();
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } });
    const sid = att.json.items[0].sourceId as string;
    const stored = (await svc.state.session!.repo.getSource(pid, sid)).assets.find((a) => a.role === "original")!.path;
    const inside = join(lib, stored);
    const other = await fixturePdf("other.pdf", "Another Paper on Deltas");
    const again = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [other, inside], toSourceId: sid } });
    expect(again.status, again.body).toBe(200);
    expect(again.json.items).toEqual([
      { path: other, outcome: "attached", sourceId: sid },
      { path: inside, outcome: "failed", reason: IN_LIBRARY_TEXT.file },
    ]);
    for (const path of [lib, join(lib, "Projects"), tmp]) {
      for (const url of [`/projects/${pid}/import/dry-run`, `/projects/${pid}/import`]) {
        const r = await call({ method: "POST", url, body: { adapter: { kind: "folder", path }, options: {} } });
        expect([r.status, r.json.error]).toEqual([400, { code: "VALIDATION", message: IN_LIBRARY_TEXT.folder }]);
      }
    }
    expect((await call({ url: `/projects/${pid}/imports` })).json).toEqual({ batches: [] });
  });
});

describe("browser extension pairing (R96)", () => {
  beforeEach(() => start({ pairing: { confirmPerMinute: 100 } }));
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

  async function pair(): Promise<string> {
    const p = await call({ method: "POST", url: "/extension/pair" });
    expect(p.status).toBe(200);
    expect(p.json.code).toMatch(/^\d{6}$/);
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
    expect(c.statusCode, c.body).toBe(200);
    return c.json().token as string;
  }

  it("the extension token works only for POST /capture/browser and GET /projects", async () => {
    await openNewLibrary();
    await newProject();
    const token = await pair();
    expect(token).not.toBe(TOKEN);
    const ext = { authorization: `Bearer ${token}`, origin: EXT };
    expect((await svc.app.inject({ method: "GET", url: "/projects", headers: ext })).statusCode).toBe(200);
    const ui = await svc.app.inject({ method: "GET", url: "/libraries", headers: ext });
    expect(ui.statusCode).toBe(403);
    expect(ui.json().error.code).toBe("FORBIDDEN");
    expect((await svc.app.inject({ method: "POST", url: "/extension/pair", headers: ext })).statusCode).toBe(403);
    // Pairing itself needs the UI token.
    expect((await svc.app.inject({ method: "POST", url: "/extension/pair" })).statusCode).toBe(401);
    // Stored as a hash only.
    const stored = await readFile(join(deps.appConfigDir, "extension-pairings.json"), "utf8");
    expect(stored).not.toContain(token);
  });

  it("POST /capture/browser stores the screenshot and HTML with page-dom evidence (extension token)", async () => {
    await openNewLibrary();
    const pid = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, browser_capture]\n`);
    const token = await pair();
    const listed = await svc.app.inject({ method: "GET", url: "/projects", headers: { authorization: `Bearer ${token}`, origin: EXT } });
    expect(listed.json().projects).toEqual([{ id: pid, name: "Study", captureMethods: expect.arrayContaining(["browser_capture"]) }]);
    const body = {
      projectId: pid,
      url: "https://www.instagram.com/p/AbCdEf12345/",
      extracted: { platform: "instagram", kind: "post", handle: "delta.fisher", caption: "Morning catch on the delta", postedAt: "2026-10-30T08:00:00Z" },
      screenshotPng: tinyPng().toString("base64"),
      html: "<html><body><p>Morning catch on the delta</p></body></html>",
      alsoDownload: false,
    };
    const r = await svc.app.inject({ method: "POST", url: "/capture/browser", headers: { authorization: `Bearer ${token}`, origin: EXT, "content-type": "application/json" }, payload: JSON.stringify(body) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe("created");
    const sf = (await call({ url: `/projects/${pid}/sources/${r.json().sourceId}` })).json;
    expect(sf.source.provenance.captureMethod).toBe("browser_capture");
    expect(sf.assets.filter((a: { role: string }) => a.role === "original").map((a: { kind: string }) => a.kind).sort()).toEqual(["html-snapshot", "screenshot"]);
    expect(sf.fieldEvidence.some((e: { source: { kind: string }; field: string }) => e.source.kind === "page-dom" && e.field === "/title")).toBe(true);
    // A project that does not allow browser capture refuses it with the reason.
    const strict = await newProject(OPEN_GOV, false, "Strict");
    const denied = await svc.app.inject({ method: "POST", url: "/capture/browser", headers: { authorization: `Bearer ${token}`, origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ ...body, projectId: strict }) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("POLICY_DENIED");
  });

  it("a pairing code is single use and invalidated after 5 wrong attempts", async () => {
    const p = await call({ method: "POST", url: "/extension/pair" });
    const code = p.json.code as string;
    const wrong = code === "000000" ? "111111" : "000000";
    const confirm = (c: string) => svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: c }) });
    for (let i = 0; i < 5; i++) expect((await confirm(wrong)).statusCode).toBe(401);
    const late = await confirm(code);
    expect(late.statusCode).toBe(401); // the right code no longer works
    const p2 = await call({ method: "POST", url: "/extension/pair" });
    expect((await confirm(p2.json.code)).statusCode).toBe(200);
    expect((await confirm(p2.json.code)).statusCode).toBe(401); // single use
  });

  it("confirm calls are rate-limited", async () => {
    await svc.close();
    await start({ pairing: { confirmPerMinute: 3 } });
    const confirm = () => svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: "123456" }) });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await confirm()).statusCode);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it("logs contain no secrets", async () => {
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV.replace("atRest: optional", "atRest: required"), true);
    await call({ method: "POST", url: `/projects/${pid}/lock` });
    await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } });
    await call({ url: `/libraries?token=${TOKEN}` });
    const token = await pair();
    await svc.app.inject({ method: "GET", url: "/projects", headers: { authorization: `Bearer ${token}`, origin: EXT } });
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, PASS, token]) expect(logs).not.toContain(secret);
    expect(logs).not.toMatch(/"code":"\d{6}"/);
  });
});

/** A raw HTTP request (fetch does not let a test set Host). */
function raw(port: number, headers: Record<string, string>, path = "/libraries"): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("network (R96): real listener", () => {
  it("listens on 127.0.0.1 only; refuses a bad Host and a foreign Origin; no CORS wildcard", async () => {
    await start();
    const port = await svc.listen(0);
    expect(svc.app.server.address()).toMatchObject({ address: "127.0.0.1", port });
    expect((await raw(port, { host: `127.0.0.1:${port}`, ...auth })).status).toBe(200);
    expect((await raw(port, { host: `localhost:${port}`, ...auth })).status).toBe(200);
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "localhost"]) {
      const r = await raw(port, { host, ...auth });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error.code).toBe("FORBIDDEN");
    }
    const foreign = await raw(port, { host: `127.0.0.1:${port}`, origin: "https://evil.example", ...auth });
    expect(foreign.status).toBe(403);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    const unpaired = await raw(port, { host: `127.0.0.1:${port}`, origin: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", ...auth });
    expect(unpaired.status).toBe(403);
    const shell = await raw(port, { host: `127.0.0.1:${port}`, origin: "tauri://localhost", ...auth });
    expect(shell.status).toBe(200);
    expect(shell.headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect((await raw(port, { host: `127.0.0.1:${port}`, origin: "http://tauri.localhost", ...auth })).status).toBe(200);
  });

  it("SSE /events: Authorization header only, library.state first, cleaned up on disconnect", async () => {
    await start();
    await openNewLibrary();
    const port = await svc.listen(0);
    expect((await fetch(`http://127.0.0.1:${port}/events?token=${TOKEN}`)).status).toBe(401);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: auth, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: library.state");
    const data = JSON.parse(/data: (.*)/.exec(text)![1]!);
    expect(data).toMatchObject({ open: true, name: "Lib", integrityWarnings: [], projectWarnings: {} });
    expect(svc.state.events.size).toBe(1);
    ac.abort();
    for (let i = 0; i < 50 && svc.state.events.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(svc.state.events.size).toBe(0);
  });
});

describe("entry point", () => {
  it("prints AO_SERVICE_READY port=<n>, serves, and on SIGTERM closes the library (lock released) and exits 0", async () => {
    const path = join(tmp, "Lib");
    await (await createLibrary(path, "Lib", deps)).close();
    const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      // The token goes on standard input (R98), never in the environment.
      env: { ...process.env, AO_SERVICE_PORT: "0", AO_CONFIG_DIR: deps.appConfigDir, AO_LIBRARY: path, AO_NO_WORKER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin!.on("error", () => {});
    child.stdin!.write(`${TOKEN}\n`);
    let out = "";
    let err = "";
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /AO_SERVICE_READY port=(\d+)/.exec(out);
        if (m) resolve(Number(m[1]));
      });
      child.on("exit", () => reject(new Error(`exited early: ${err}`)));
    });
    const r = await fetch(`http://127.0.0.1:${port}/libraries`, { headers: auth });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { current?: { name: string } }).current?.name).toBe("Lib");
    expect(out).not.toContain(TOKEN);
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    expect(code, err).toBe(0);
    const again = await openLibrary(path, deps);
    expect(again.mode).toBe("read-write");
    await again.close();
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Task 30 review round 1 (R98, R99)

/** n small PDFs in a fresh folder (each a distinct title). */
async function pdfFolder(n: number, name = "many"): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, `p${String(i).padStart(3, "0")}.pdf`), await buildPdf({ title: `Fieldwork Report Number ${i} on ${name} Fisheries`, author: "Ana Souza", lines: [`Report ${i}.`] }));
  return dir;
}

/** Resolves with the first event matching `pred`. */
function nextEvent(pred: (e: { type: string; data: any }) => boolean): Promise<{ type: string; data: any }> {
  return new Promise((resolve) => {
    const off = svc.state.events.subscribe((e) => {
      if (pred(e)) {
        off();
        resolve(e);
      }
    });
  });
}

/**
 * Resolves with the first `running` import.progress event matching `pred`, having paused that
 * batch inside the event's handler. Events are published synchronously from the batch's progress
 * feed before the run takes its next item, so the run then waits between items until a resume, a
 * suspend or a cancel lets it go: a gate the test holds, so the batch is still running when the
 * test acts on it, however fast the machine and however few its items.
 */
function holdBatch(pred: (d: any) => boolean): Promise<{ type: string; data: any }> {
  return nextEvent((e) => {
    if (e.type !== "import.progress" || e.data.state !== "running" || !pred(e.data)) return false;
    const h = svc.state.session?.batches.get(e.data.batchId)?.handle;
    h?.pause();
    return h !== undefined;
  });
}

const batchState = async (pid: string, batchId: string) => ((await call({ url: `/projects/${pid}/imports` })).json.batches as Array<{ batchId: string; state: string }>).find((b) => b.batchId === batchId)?.state;

describe("review round 1: governance PUT (R99 I1)", () => {
  beforeEach(() => start());

  it("requires a base hash; two concurrent PUTs from the same base: one succeeds, one gets 409 CONFLICT", async () => {
    await openNewLibrary();
    const pid = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, refman_import, downloader]\n`);
    const { sha256 } = (await call({ url: `/projects/${pid}/governance` })).json;
    const noBase = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: OPEN_GOV } });
    expect(noBase.status).toBe(400);
    const a = `${OPEN_GOV}captureMethods: [manual_upload, refman_import]\n`;
    const b = `${OPEN_GOV}captureMethods: [manual_upload, downloader]\n`;
    const [r1, r2] = await Promise.all([
      call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: a, baseSha256: sha256 } }),
      call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: b, baseSha256: sha256 } }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.json.error.code).toBe("CONFLICT");
  });

  it("a broken governance.yaml can be repaired with a reason", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const folder = (await call({ url: "/projects" })).json.projects[0].folder as string;
    await writeFile(join(tmp, "Lib", folder, "governance.yaml"), "encryption: [broken");
    const { sha256 } = (await call({ url: `/projects/${pid}/governance` })).json;
    expect((await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: OPEN_GOV, baseSha256: sha256 } })).status).toBe(400);
    const ok = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: OPEN_GOV, baseSha256: sha256, reason: "repair" } });
    expect(ok.status, ok.body).toBe(200);
  });
});

describe("review round 1: errors, query credentials, pairing (R98, R99)", () => {
  beforeEach(() => start());

  it("credential-named query keys are refused; others such as sessionId are fine", async () => {
    for (const k of ["token", "access_token", "api_key", "apikey", "password", "code", "authorization"]) {
      expect((await call({ url: `/libraries?${k}=x` })).status, k).toBe(401);
    }
    expect((await call({ url: "/libraries?sessionId=abc&keyword=x" })).status).toBe(200);
  });

  it("the UI may re-issue a code (the old one stops working); rate limits are per origin", async () => {
    await svc.close();
    await start({ pairing: { confirmPerMinute: 2 } });
    const A = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B = "moz-extension://bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const confirm = (origin: string, code: string) => svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin, "content-type": "application/json" }, payload: JSON.stringify({ code }) });
    const first = (await call({ method: "POST", url: "/extension/pair" })).json.code as string;
    const second = (await call({ method: "POST", url: "/extension/pair" })).json.code as string;
    expect((await confirm(A, "999999" === second ? "888888" : "999999")).statusCode).toBe(401);
    expect((await confirm(A, "999999" === second ? "888888" : "999999")).statusCode).toBe(401);
    expect((await confirm(A, second)).statusCode).toBe(429); // A is limited…
    if (first !== second) expect((await confirm(B, first)).statusCode).toBe(401); // …B is not, and the first code is void
    expect((await confirm(B, second)).statusCode).toBe(200);
  });

  it("the pairing preflight (OPTIONS) is allowed from an extension origin", async () => {
    const r = await svc.app.inject({ method: "OPTIONS", url: "/extension/pair/confirm", headers: { origin: "chrome-extension://cccccccccccccccccccccccccccccccc", "access-control-request-method": "POST" } });
    expect(r.statusCode).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("chrome-extension://cccccccccccccccccccccccccccccccc");
    const other = await svc.app.inject({ method: "OPTIONS", url: "/libraries", headers: { origin: "chrome-extension://cccccccccccccccccccccccccccccccc" } });
    expect(other.statusCode).toBe(403);
  });

  it("once shutting down, new requests are refused with 503", async () => {
    const closing = svc.close();
    const r = await svc.app.inject({ method: "GET", url: "/libraries", headers: auth }).catch(() => ({ statusCode: 503 }));
    expect(r.statusCode).toBe(503);
    await closing;
  });
});

describe("review round 1: batches (R99 I3, I4)", () => {
  beforeEach(() => start());

  it("cancel, then resume through resumeBatch; finished → 409; /jobs lists only live work", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(12);
    const progressed = holdBatch((d) => d.done >= 2);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json;
    await progressed;
    expect((await call({ method: "POST", url: `/imports/${batchId}/cancel` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("cancelled");
    expect((await call({ url: `/jobs?projectId=${pid}` })).json.imports).toEqual([]);
    expect((await call({ method: "POST", url: `/imports/${batchId}/pause` })).status).toBe(409);
    expect((await call({ method: "POST", url: `/imports/${batchId}/resume` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("finished");
    expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(12);
    expect((await call({ method: "POST", url: `/imports/${batchId}/resume` })).status).toBe(409);
    expect((await call({ url: `/jobs?projectId=${pid}` })).json.imports).toEqual([]);
  });

  it("lock mid-import, unlock, resume: every item imported once", async () => {
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV.replace("atRest: optional", "atRest: required"), true);
    const dir = await pdfFolder(10);
    const progressed = holdBatch((d) => d.done >= 2);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json;
    await progressed;
    await call({ method: "POST", url: `/projects/${pid}/lock` });
    svc.state.session!.batches.get(batchId)!.handle.resume(); // the held batch meets the lock at its next write
    await svc.state.idle();
    await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } });
    expect(["failed", "paused", "interrupted"]).toContain(await batchState(pid, batchId));
    expect((await call({ method: "POST", url: `/imports/${batchId}/resume` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("finished");
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(10);
  });

  it("shutdown pauses running batches (never cancels): after reopening the batch is paused and resumable", async () => {
    const path = await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(15);
    const progressed = holdBatch((d) => d.done >= 2);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json;
    await progressed;
    await svc.close();
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    expect(await batchState(pid, batchId)).toBe("paused");
    expect((await call({ method: "POST", url: `/imports/${batchId}/resume` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("finished");
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(15);
  });
});

describe("review round 1: library move during an import (R99 I5)", () => {
  it("60 PDFs importing + move: the batch continues in the new library; nothing lost or doubled; token status", async () => {
    const clock = { now: new Date("2026-11-10T10:00:00Z") };
    await start({ now: () => clock.now });
    const oldPath = await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(60);
    const progressed = holdBatch((d) => d.done >= 5);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json;
    await progressed;
    const dest = join(tmp, "Moved");
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    expect(moved.status).toBe(200);
    const lines = moved.body.trim().split("\n").map((l: string) => JSON.parse(l));
    const done = lines.at(-1);
    expect(done.done, moved.body).toBe(true);
    expect(done.result.newRoot).toBe(dest);
    expect((await call({ url: "/libraries" })).json.current.mode).toBe("read-write");
    // The batch was paused for the move and resumed in the new library.
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("finished");
    const all = (await call({ url: `/projects/${pid}/sources?limit=500` })).json;
    expect(all.total).toBe(60);
    expect(svc.state.session!.lib.root).toBe(dest);
    // The old copy's token can be fetched again, and expires after 15 minutes.
    const status = await call({ url: "/libraries/move/status" });
    expect(status.json.pending).toMatchObject({ oldRoot: oldPath, newRoot: dest, confirmToken: done.result.confirmToken });
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    expect((await call({ url: "/libraries/move/status" })).json.pending).toBeNull();
    expect((await call({ method: "POST", url: "/libraries/move/delete-old", body: { token: done.result.confirmToken } })).status).toBe(400);
  }, 180_000);
});

describe("review round 1: backups on open and unlock (R99 I7)", () => {
  it("backupIfDue runs when a library opens and when a project is unlocked", async () => {
    await start();
    const path = await openNewLibrary();
    const plain = await newProject(OPEN_GOV, false, "Plain");
    const enc = await newProject(OPEN_GOV.replace("atRest: optional", "atRest: required"), true, "Sealed");
    await call({ method: "POST", url: "/libraries/close" });
    await call({ method: "POST", url: "/libraries/open", body: { path } });
    await svc.state.idle();
    expect(await listBackups(svc.state.session!.repo, plain)).toHaveLength(1);
    expect(await listBackups(svc.state.session!.repo, enc)).toHaveLength(0); // locked: not yet
    await call({ method: "POST", url: `/projects/${enc}/unlock`, body: { secret: PASS } });
    await svc.state.idle();
    expect(await listBackups(svc.state.session!.repo, enc)).toHaveLength(1);
  });
});

describe("R125: backups are governed and audited", () => {
  /** The library sits on this computer's disk, which these rules exclude. */
  const REMOVABLE_ONLY = `${OPEN_GOV}residency:\n  allowed: [removable]\n`;
  const NOT_ALLOWED = /this project's rules do not allow its data there/u;

  it("POST /projects/:id/backups makes a backup now: file name, sha256 and size, never a path; audited", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject(OPEN_GOV, false, "Manual");
    const r = await call({ method: "POST", url: `/projects/${pid}/backups` });
    expect(r.status, r.body).toBe(200);
    expect(r.json.backup).toEqual({ file: expect.stringMatching(/^Manual - backup - modified .+\.zip$/u), sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), bytes: expect.any(Number), pruned: [], warnings: [] });
    expect(r.body).not.toContain(path);
    expect(r.body).not.toContain(tmp);
    expect(await listBackups(svc.state.session!.repo, pid)).toHaveLength(1);
    const { events } = await svc.state.session!.repo.readAudit(pid);
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["backup", "backup.create"]));
  });

  it("R138: a double request, and the scheduler at the same moment, never leave a backup that is not the file it records", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV, false, "Double");
    await svc.state.idle();
    const [a, b, sched] = await Promise.all([
      call({ method: "POST", url: `/projects/${pid}/backups` }),
      call({ method: "POST", url: `/projects/${pid}/backups` }),
      svc.state.runScheduledBackups(),
    ]);
    expect(a.status, a.body).toBe(200);
    expect(b.status, b.body).toBe(200);
    expect(a.json.backup.file).not.toBe(b.json.backup.file);
    expect(sched.every((r) => r.ok)).toBe(true);
    const repo = svc.state.session!.repo;
    const list = await listBackups(repo, pid);
    expect(new Set(list.map((x) => x.file)).size).toBe(list.length);
    const { createHash } = await import("node:crypto");
    for (const x of list) {
      const bytes = await readFile(join(svc.state.session!.lib.root, "Backups", x.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(x.sha256);
    }
  });

  it("a refused manual backup → 403 POLICY_DENIED with the engine's reason; nothing is made; the denial is audited", async () => {
    await start();
    const path = await openNewLibrary();
    const pid = await newProject(REMOVABLE_ONLY, false, "Refused");
    const r = await call({ method: "POST", url: `/projects/${pid}/backups` });
    expect(r.status, r.body).toBe(403);
    expect(r.json.error).toMatchObject({ code: "POLICY_DENIED", reason: expect.stringMatching(NOT_ALLOWED) });
    expect(r.body).not.toContain(path);
    expect(await listBackups(svc.state.session!.repo, pid)).toEqual([]);
    const { events } = await svc.state.session!.repo.readAudit(pid);
    expect(events.find((e) => e.action === "backup")?.decision).toMatchObject({ result: "deny", reason: expect.stringMatching(NOT_ALLOWED) });
  });

  it("a refused SCHEDULED backup raises `backup-failed` with the reason in the library state; a later backup clears it", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject(REMOVABLE_ONLY, false, "Scheduled");
    await svc.state.idle();
    const runs = await svc.state.runScheduledBackups();
    expect(runs).toEqual([expect.objectContaining({ projectId: pid, ok: false, backedUp: false, error: expect.stringMatching(NOT_ALLOWED) })]);
    await svc.state.projectWarnings(svc.state.session!);
    const state = svc.state.libraryState() as { projectWarnings: Record<string, string[]>; backupFailures: Record<string, { reason: string; refused?: boolean }> };
    expect(state.projectWarnings[pid]).toContain("backup-failed");
    expect(state.backupFailures[pid]).toMatchObject({ refused: true, reason: expect.stringMatching(NOT_ALLOWED) });
    expect(JSON.stringify(state)).not.toContain(tmp);
    // The rules are changed (a loosening, with a reason); a backup made by hand clears the warning.
    const g = await call({ url: `/projects/${pid}/governance` });
    expect(g.status, g.body).toBe(200);
    const put = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: OPEN_GOV, baseSha256: g.json.sha256, reason: "The library stays on this computer." } });
    expect(put.status, put.body).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/backups` })).status).toBe(200);
    await svc.state.projectWarnings(svc.state.session!);
    const after = svc.state.libraryState() as { projectWarnings: Record<string, string[]>; backupFailures: Record<string, unknown> };
    expect(after.projectWarnings[pid]).not.toContain("backup-failed");
    expect(after.backupFailures[pid]).toBeUndefined();
  });
});

describe("Task 49 round 3: the destruction retry (when it runs, where it does not)", () => {
  const RETAIN = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
  const clock = { now: new Date("2026-12-02T10:00:00.000Z") };
  const later = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const HOUR = 3_600_000;

  /** A project whose destruction left its one backup NOT removed: returns the project id, the certificate and the backup's path. */
  async function stuckDestruction(encrypted = false): Promise<{ pid: string; certificatePath: string; backup: string }> {
    const pid = await newProject(encrypted ? RETAIN.replace("atRest: optional", "atRest: required") : RETAIN, encrypted, "Retain");
    const repo = svc.state.session!.repo;
    const file = join(tmp, "in", "interview.mp3");
    await import("node:fs/promises").then((f) => f.mkdir(dirname(file), { recursive: true }));
    await writeFile(file, "RAW interview audio bytes");
    const sf = await repo.createSource(
      pid,
      { projectIds: [pid], type: "interview", title: { variants: [{ lang: "en", kind: "original", value: "Interview" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: file, role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "consented", basis: "test" }, identifiable: true } },
    );
    const b = await call({ method: "POST", url: `/projects/${pid}/backups` });
    expect(b.status, b.body).toBe(200);
    const backup = join(svc.state.session!.lib.root, "Backups", b.json.backup.file as string);
    later(60_000);
    shredSeams.failFor = (p) => p.endsWith(b.json.backup.file as string);
    try {
      const r = await destroyRaw(repo, pid, [sf.assets[0]!.id], "tester");
      return { pid, certificatePath: r.certificatePath, backup };
    } finally {
      shredSeams.failFor = undefined;
    }
  }
  // R147: the certificate file is never rewritten; the status is read with its amendments, from the audit log.
  const statusOf = async (pid: string, path: string) => (await readDestruction(svc.state.session!.repo, pid, path)).status;
  type Waiting = Record<string, Array<{ certificateFile: string; backups: string[]; reason?: string }>>;

  beforeEach(async () => {
    clock.now = new Date("2026-12-02T10:00:00.000Z");
    await start({ now: () => clock.now });
  });
  afterEach(() => {
    shredSeams.failFor = undefined;
  });

  it("runs when the library is opened", async () => {
    const path = await openNewLibrary();
    const { pid, certificatePath, backup } = await stuckDestruction();
    expect(await statusOf(pid, certificatePath)).toBe("pending");
    const written = await readFile(certificatePath);
    await call({ method: "POST", url: "/libraries/close" });
    later(HOUR);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc.state.idle();
    expect(await statusOf(pid, certificatePath)).toBe("deleted");
    expect((await readFile(certificatePath)).equals(written)).toBe(true);
    expect(existsSync(backup)).toBe(false);
    expect(await projectWarnings(svc.state.session!.repo, pid)).not.toContain("destruction-backups-pending");
  });

  it("runs when a project is unlocked, and never while it is locked", async () => {
    await openNewLibrary();
    const { pid, certificatePath, backup } = await stuckDestruction(true);
    const repo = svc.state.session!.repo;
    repo.lockProject(pid);
    later(HOUR);
    const retry = vi.mocked(resumeDestruction);
    retry.mockClear();
    await svc.state.runScheduledBackups();
    // Locked: the retry is not even started for the project (R3-M3: without the service's own
    // check it would be started, and only the library would decline).
    expect(retry).not.toHaveBeenCalled();
    expect(certificatePath.endsWith(".json.enc")).toBe(true);
    expect(existsSync(backup)).toBe(true);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    await svc.state.idle();
    expect(retry).toHaveBeenCalledWith(repo, pid);
    expect(existsSync(backup)).toBe(false);
    expect(await statusOf(pid, certificatePath)).toBe("deleted");
    expect(await projectWarnings(svc.state.session!.repo, pid)).not.toContain("destruction-backups-pending");
  });

  it("runs on the hourly pass, at most hourly", async () => {
    await openNewLibrary();
    const { pid, certificatePath, backup } = await stuckDestruction();
    later(30 * 60_000);
    // The first retry after the destruction is due at once; it still fails here.
    shredSeams.failFor = (p) => p.endsWith(backup.slice(backup.lastIndexOf("/") + 1));
    await svc.state.runScheduledBackups();
    shredSeams.failFor = undefined;
    expect(await statusOf(pid, certificatePath)).toBe("pending");
    // Half an hour later: not due yet.
    later(30 * 60_000);
    await svc.state.runScheduledBackups();
    expect(await statusOf(pid, certificatePath)).toBe("pending");
    expect(existsSync(backup)).toBe(true);
    // The library state names the backup that waits (no reason: nothing disagrees, the removal failed).
    await svc.state.projectWarnings(svc.state.session!);
    const waiting = (svc.state.libraryState() as { destructionBackupsPending: Waiting }).destructionBackupsPending;
    expect(waiting[pid]).toEqual([{ certificateFile: expect.stringMatching(/^Projects\/.+\/retention\/destruction-.+\.json$/u), backups: [`Backups/${backup.slice(backup.lastIndexOf("/") + 1)}`] }]);
    // An hour after the last attempt: retried, and done.
    later(30 * 60_000);
    await svc.state.runScheduledBackups();
    expect(await statusOf(pid, certificatePath)).toBe("deleted");
    expect(existsSync(backup)).toBe(false);
    await svc.state.projectWarnings(svc.state.session!);
    expect((svc.state.libraryState() as { destructionBackupsPending: Waiting }).destructionBackupsPending[pid]).toBeUndefined();
  });

  it("does not run while the library is being moved, nor in a read-only library", async () => {
    await openNewLibrary();
    const { pid, certificatePath, backup } = await stuckDestruction();
    later(HOUR);
    const st = svc.state as unknown as { moving: unknown };
    const before = st.moving;
    st.moving = true;
    try {
      expect(await svc.state.runScheduledBackups()).toEqual([]);
    } finally {
      st.moving = before;
    }
    expect(await statusOf(pid, certificatePath)).toBe("pending");
    // As if the library had been opened read-only (an instance property shadows the getter).
    const lib = svc.state.session!.lib;
    const own = Object.getOwnPropertyDescriptor(lib, "mode");
    Object.defineProperty(lib, "mode", { value: "read-only", configurable: true });
    try {
      expect(await svc.state.runScheduledBackups()).toEqual([]);
    } finally {
      if (own) Object.defineProperty(lib, "mode", own);
      else delete (lib as unknown as { mode?: unknown }).mode;
    }
    expect(svc.state.session!.lib.mode).toBe("read-write");
    expect(await statusOf(pid, certificatePath)).toBe("pending");
    expect(existsSync(backup)).toBe(true);
  });

  it("R147: a certificate changed on disk: the retry removes nothing, the warning stands, and the library state says which backup waits and why, in plain words", async () => {
    await openNewLibrary();
    const { pid, certificatePath, backup } = await stuckDestruction();
    const cert = JSON.parse(await readFile(certificatePath, "utf8")) as { assets: unknown[] };
    cert.assets = [];
    await writeFile(certificatePath, JSON.stringify(cert));
    later(HOUR);
    await svc.state.runScheduledBackups();
    expect(existsSync(backup)).toBe(true);
    await svc.state.projectWarnings(svc.state.session!);
    const state = svc.state.libraryState() as { projectWarnings: Record<string, string[]>; destructionBackupsPending: Waiting };
    expect(state.projectWarnings[pid]).toContain("destruction-backups-pending");
    expect(state.destructionBackupsPending[pid]).toEqual([
      { certificateFile: expect.stringMatching(/^Projects\/.+\/retention\/destruction-.+\.json$/u), backups: [`Backups/${backup.slice(backup.lastIndexOf("/") + 1)}`], reason: expect.stringMatching(/audit log/u) },
    ]);
    expect(JSON.stringify(state)).not.toContain(tmp);
    // The route that shows certificates says the same of it.
    const shown = await call({ url: `/projects/${pid}/retention/certificates` });
    expect(shown.status, shown.body).toBe(200);
    expect(shown.json.certificates).toHaveLength(1);
    expect(shown.json.certificates[0]).toMatchObject({ verified: false, status: "pending", outstanding: [`Backups/${backup.slice(backup.lastIndexOf("/") + 1)}`], problem: expect.stringMatching(/audit log/u) });
    expect(shown.body).not.toContain(tmp);
  });

  it("R147: a pass that only observes still tells the interface what changed (automatic backups off)", async () => {
    await openNewLibrary();
    const { pid, certificatePath, backup } = await stuckDestruction();
    const held = `Backups/${backup.slice(backup.lastIndexOf("/") + 1)}`;
    // No scheduled backup for this project: nothing else in the pass publishes the library state.
    expect((await call({ method: "PUT", url: `/projects/${pid}/backup-settings`, body: { automatic: false } })).status).toBe(200);
    await svc.state.idle();
    const published: Waiting[] = [];
    const off = svc.state.events.subscribe((e) => {
      if (e.type === "library.state") published.push((e.data as { destructionBackupsPending: Waiting }).destructionBackupsPending);
    });
    try {
      // The certificate is changed on disk: the pass removes nothing, and the interface is told why.
      const cert = JSON.parse(await readFile(certificatePath, "utf8")) as { assets: unknown[] };
      cert.assets = [];
      await writeFile(certificatePath, JSON.stringify(cert));
      later(HOUR);
      await svc.state.runScheduledBackups();
      await svc.state.idle();
      expect(existsSync(backup)).toBe(true);
      expect(published.at(-1)?.[pid]).toEqual([{ certificateFile: expect.stringMatching(/^Projects\/.+\/retention\/destruction-.+\.json$/u), backups: [held], reason: expect.stringMatching(/audit log/u) }]);
      // Nothing changes: nothing more is published.
      const told = published.length;
      later(HOUR);
      await svc.state.runScheduledBackups();
      await svc.state.idle();
      expect(published).toHaveLength(told);
      // The researcher removes the backup by hand: the pass records that it is gone, and the interface is told the warning has ended.
      await rm(backup);
      later(HOUR);
      await svc.state.runScheduledBackups();
      await svc.state.idle();
      expect(await statusOf(pid, certificatePath)).toBe("no-longer-present");
      expect(published.length).toBeGreaterThan(told);
      expect(published.at(-1)?.[pid]).toBeUndefined();
      expect((svc.state.libraryState() as { projectWarnings: Record<string, string[]> }).projectWarnings[pid]).not.toContain("destruction-backups-pending");
    } finally {
      off();
    }
  });

  describe("Task 46a: a reopen at start that the researcher's own choice supersedes starts nothing", () => {
    /**
     * The service stopped with a library open (so it is the one reopened at the next start) whose
     * project has a destruction retry due: any pass on it would remove `backup`.
     */
    async function remembered(): Promise<{ path: string; pid: string; backup: string }> {
      const path = await openNewLibrary("LibA");
      const { pid, backup } = await stuckDestruction();
      await svc.close();
      later(HOUR);
      vi.mocked(resumeDestruction).mockClear();
      return { path, pid, backup };
    }
    /** Nothing was started on the abandoned library, it is not the open one, and its lock is free. */
    async function expectNothingStarted(path: string, backup: string): Promise<void> {
      await svc.state.idle();
      expect(vi.mocked(resumeDestruction)).not.toHaveBeenCalled();
      expect(existsSync(backup)).toBe(true);
      expect(svc.state.session).toBeUndefined();
      expect(svc.state.workKinds()).toEqual([]);
      expect((svc.state as unknown as { backupTimer?: unknown }).backupTimer).toBeUndefined();
      expect(await svc.state.runScheduledBackups()).toEqual([]);
      const again = await openLibrary(path, deps);
      try {
        expect(again.mode).toBe("read-write");
      } finally {
        await again.close();
      }
    }
    /** The same library reopened at a start nobody supersedes: the retry runs, as it should. */
    async function expectAnOrdinaryReopenWorks(pid: string, backup: string): Promise<void> {
      await svc.close();
      await start({ now: () => clock.now });
      await svc.state.reopenLast();
      await svc.state.idle();
      expect(vi.mocked(resumeDestruction)).toHaveBeenCalledWith(svc.state.session!.repo, pid);
      expect(existsSync(backup)).toBe(false);
      expect((svc.state as unknown as { backupTimer?: unknown }).backupTimer).toBeDefined();
    }

    it("superseded while the library's folder is still being opened: the late reopen is closed; no retry pass, no backup, no scheduler", async () => {
      const { path, pid, backup } = await remembered();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      await start({
        now: () => clock.now,
        openLibrary: async (root, d, o) => {
          if (root === path) await gate;
          return openLibrary(root, d, o);
        },
      });
      const reopening = svc.state.reopenLast();
      // The researcher's own choice (here: close) comes first.
      await svc.state.closeLibrary();
      release();
      await reopening;
      await expectNothingStarted(path, backup);
      await expectAnOrdinaryReopenWorks(pid, backup);
    });

    it("superseded while the opened library is being adopted (its repository is being read): the same", async () => {
      const { path, pid, backup } = await remembered();
      let opened = false;
      let superseded = false;
      await start({
        // The service's clock is read while the repository opens: the choice lands exactly there.
        now: () => {
          if (opened && !superseded) {
            superseded = true;
            void svc.state.closeLibrary();
          }
          return clock.now;
        },
        openLibrary: async (root, d, o) => {
          const lib = await openLibrary(root, d, o);
          if (root === path) opened = true;
          return lib;
        },
      });
      await svc.state.reopenLast();
      expect(superseded).toBe(true);
      await expectNothingStarted(path, backup);
      await expectAnOrdinaryReopenWorks(pid, backup);
    });
  });
});

describe("review round 1: smaller route fixes (R99 minors)", () => {
  beforeEach(() => start());

  it("tags renamed and deleted, collections renamed", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const tag = (await call({ method: "POST", url: `/projects/${pid}/tags`, body: { name: "kin" } })).json;
    const col = (await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "A" } })).json;
    expect((await call({ method: "PATCH", url: `/projects/${pid}/tags/${tag.id}`, body: { name: "kinship" } })).json.name).toBe("kinship");
    expect((await call({ method: "PATCH", url: `/projects/${pid}/collections/${col.id}`, body: { name: "Delta" } })).json.name).toBe("Delta");
    expect((await call({ method: "DELETE", url: `/projects/${pid}/tags/${tag.id}` })).status).toBe(200);
    expect((await call({ url: `/projects/${pid}/tags` })).json.tags).toEqual([]);
  });

  it("PATCH source with fields and membership is one governed change", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const sid = (await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } })).json.items[0].sourceId;
    const tag = (await call({ method: "POST", url: `/projects/${pid}/tags`, body: { name: "kin" } })).json;
    const before = (await call({ url: `/projects/${pid}/audit?limit=1000` })).json.total as number;
    const r = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}`, body: { issued: "2002", tagIds: [tag.id] } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.source).toMatchObject({ issued: "2002", tagIds: [tag.id] });
    expect((await call({ url: `/projects/${pid}/audit?limit=1000` })).json.total).toBe(before + 1);
    expect((await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}`, body: { issued: "2003", tagIds: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"] } })).status).toBe(404);
    expect((await call({ url: `/projects/${pid}/sources/${sid}` })).json.source.issued).toBe("2002");
  });

  it("the project-wide recheck runs as a job with progress", async () => {
    await openNewLibrary();
    const pid = await newProject();
    await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } });
    const finished = nextEvent((e) => e.type === "job.progress" && e.data.kind === "recheck" && e.data.finished === true);
    const r = await call({ method: "POST", url: `/projects/${pid}/recheck` });
    expect(r.status).toBe(200);
    expect(r.json.jobId).toEqual(expect.any(String));
    expect((await finished).data).toMatchObject({ jobId: r.json.jobId, done: 1, total: 1 });
  });

  // The watched-folder routes (adding by grant, what comes in is registered, a remove leaves the other watches
  // running) are tested in watched-folders-routes.test.ts (Task W7).

  it("library errors map to their codes; a TypeError is 500 INTERNAL without its message", async () => {
    const { toApiError } = await import("./errors.js");
    const lib = await import("@ao/library");
    const t = toApiError(new TypeError("secret detail /home/x/y"));
    expect([t.status, t.code, t.message.includes("secret")]).toEqual([500, "INTERNAL", false]);
    expect(toApiError(new lib.InvalidInputError("bad")).status).toBe(400);
    expect(toApiError(new lib.GovernanceConflictError()).status).toBe(409);
    expect(toApiError(new lib.KeyNotAvailableError("k")).status).toBe(423);
    expect(toApiError(new lib.PathEscapeError("x")).status).toBe(400);
    expect(toApiError(new lib.ExportDestinationError("x")).status).toBe(400);
    expect(toApiError(new lib.RestoreError("x")).status).toBe(400);
  });

  it("a file missing from the installation is 503 UNAVAILABLE with its plain message (not INTERNAL, not the user's fault)", async () => {
    const { toApiError } = await import("./errors.js");
    const lib = await import("@ao/library");
    const t = toApiError(new lib.ResourceMissingError("the web page cleaner"));
    expect([t.status, t.code]).toEqual([503, "UNAVAILABLE"]);
    expect(t.message).toMatch(/web page cleaner is missing from the installation/);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 30 review round 2 (R101, R102)

describe("review round 2: library move (R102 N1–N3)", () => {
  it("a client that disconnects after the first line never stalls the move; the token is in move/status", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } });
    const port = await svc.listen(0);
    const dest = join(tmp, "Moved");
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/libraries/move`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ dest }), signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    let pending: any = null;
    for (let i = 0; i < 200 && !(pending && svc.state.session?.lib.root === dest); i++) {
      await new Promise((r) => setTimeout(r, 50));
      const st = await fetch(`http://127.0.0.1:${port}/libraries/move/status`, { headers: auth });
      pending = ((await st.json()) as { pending: unknown }).pending;
    }
    expect(pending).toMatchObject({ newRoot: dest, confirmToken: expect.any(String) });
    expect(svc.state.session!.lib.root).toBe(dest);
  });

  it("while a move runs: every mutating request gets 503 MOVE_IN_PROGRESS, a second move 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inMove = new Promise<void>((r) => (entered = r));
    await start({ beforeExecuteMove: async () => (entered(), gate) });
    await openNewLibrary();
    const pid = await newProject();
    const pdfs = await Promise.all([1, 2, 3, 4, 5].map((i) => fixturePdf(`m${i}.pdf`, `Moving Paper ${i}`)));
    const moving = call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    await inMove;
    const attaches = await Promise.all(pdfs.map((p) => call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [p] } })));
    expect(attaches.map((a) => a.status)).toEqual([503, 503, 503, 503, 503]);
    expect(attaches.every((a) => a.json.error.code === "MOVE_IN_PROGRESS")).toBe(true);
    const second = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Other") } });
    expect(second.status).toBe(409);
    expect((await svc.state.runScheduledBackups())).toEqual([]); // schedulers wait too
    release();
    const done = await moving;
    expect(done.body).toContain('"done":true');
    expect((await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [pdfs[0]] } })).status).toBe(200);
  });

  it("quiesce fails (an import cannot pause): what it paused resumes, the library carries on, 409", async () => {
    await start({ suspendTimeoutMs: 300 });
    await openNewLibrary();
    const pid = await newProject();
    const dirA = await pdfFolder(20, "qa");
    const dirB = await pdfFolder(20, "qb");
    // Both batches are held between items (holdBatch) so that each is still running when the move's
    // quiesce reaches it: a is paused for the move by its own suspend, b's suspend never settles.
    const progA = holdBatch((d) => d.done >= 2);
    const a = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dirA } } })).json.batchId;
    await progA;
    const progB = holdBatch((d) => d.batchId !== a);
    const b = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dirB } } })).json.batchId;
    await progB;
    expect([a, b].map((id) => svc.state.session!.batches.has(id))).toEqual([true, true]); // both still running
    // Batch b cannot reach a safe point: its suspend never settles.
    const hb = svc.state.session!.batches.get(b)!.handle;
    hb.suspend = () => new Promise(() => {});
    const r = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(r.status).toBe(409);
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Lib"));
    await svc.state.idle();
    expect(await batchState(pid, a)).toBe("finished"); // paused for the move, then resumed
    expect(await batchState(pid, b)).toBe("finished");
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(40);
  });

  it("a suspend that times out on close falls back to cancel: cancelled, still resumable, lock released", async () => {
    await start({ suspendTimeoutMs: 300 });
    const path = await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(20);
    // Held between items (holdBatch) so that it is still running when the close acts on it.
    const prog = holdBatch((d) => d.done >= 2);
    const id = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json.batchId;
    await prog;
    expect(svc.state.session!.batches.has(id)).toBe(true); // still running
    svc.state.session!.batches.get(id)!.handle.suspend = () => new Promise(() => {});
    await svc.close();
    await start();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-write");
    expect(await batchState(pid, id)).toBe("cancelled");
    expect((await call({ method: "POST", url: `/imports/${id}/resume` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, id)).toBe("finished");
  });

  it("moved but the new copy cannot be opened (twice): a clear error, the token kept, imports resumable there", async () => {
    let fails = 0;
    const { openLibrary: realOpen } = await import("@ao/library");
    const dest = join(tmp, "Moved");
    await start({
      openLibrary: async (root, d, o) => {
        if (root === dest && fails < 2) {
          fails++;
          throw Object.assign(new Error(`EIO: i/o error, open '${root}/library.json'`), { code: "EIO" });
        }
        return realOpen(root, d, o);
      },
    });
    await openNewLibrary();
    const pid = await newProject();
    const r = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    const last = JSON.parse(r.body.trim().split("\n").at(-1)!);
    expect(fails).toBe(2); // retried once
    expect(last.error.code).toBe("LIBRARY_OFFLINE");
    expect(last.error.message).toMatch(/moved/i);
    expect(r.body).not.toContain(tmp);
    expect((await call({ url: "/libraries/move/status" })).json.pending).toMatchObject({ newRoot: dest });
    // Opening the new place later works, and the project is there.
    const reopened = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect(reopened.status, reopened.body).toBe(200);
    expect((await call({ url: "/projects" })).json.projects.map((p: { id: string }) => p.id)).toEqual([pid]);
  });
});

describe("review round 2: shutdown race (R101 M7)", () => {
  it("open racing shutdown (0–30 ms): the lock is always released", async () => {
    const path = join(tmp, "Lib");
    await (await createLibrary(path, "Lib", deps)).close();
    for (const delay of [0, 2, 5, 10, 15, 20, 30]) {
      await start();
      const opening = call({ method: "POST", url: "/libraries/open", body: { path } });
      await new Promise((r) => setTimeout(r, delay));
      await svc.close();
      await opening.catch(() => undefined);
      const again = await openLibrary(path, deps);
      expect(again.mode, `delay ${delay}`).toBe("read-write");
      await again.close();
    }
  });
});

describe("review round 2: minors", () => {
  beforeEach(() => start());

  it("If-Match: hex compared case-insensitively; a list of ETags matches any", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const sha = (await call({ url: `/projects/${pid}/governance` })).json.sha256 as string;
    const stricter = `${OPEN_GOV}audit:\n  enabled: true\n`;
    const r1 = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: stricter }, headers: { "if-match": `"${sha.toUpperCase()}"` } });
    expect(r1.status, r1.body).toBe(200);
    const sha2 = r1.json.sha256 as string;
    const r2 = await call({ method: "PUT", url: `/projects/${pid}/governance`, body: { yaml: OPEN_GOV }, headers: { "if-match": `"${"0".repeat(64)}", W/"${sha2}"` } });
    expect(r2.status, r2.body).toBe(200);
  });

  it("PATCH collection with name and parent is one governed change", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const parent = (await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "P" } })).json;
    const child = (await call({ method: "POST", url: `/projects/${pid}/collections`, body: { name: "C" } })).json;
    const before = (await call({ url: `/projects/${pid}/audit` })).json.total as number;
    const r = await call({ method: "PATCH", url: `/projects/${pid}/collections/${child.id}`, body: { name: "Child", parentId: parent.id } });
    expect(r.json).toMatchObject({ name: "Child", parentId: parent.id });
    expect((await call({ url: `/projects/${pid}/audit` })).json.total).toBe(before + 1);
    // A bad parent changes nothing (not even the name).
    expect((await call({ method: "PATCH", url: `/projects/${pid}/collections/${child.id}`, body: { name: "X", parentId: child.id } })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ url: `/projects/${pid}/collections` })).json.collections.find((c: { id: string }) => c.id === child.id).name).toBe("Child");
  });

  it("a BatchRefusedError while a batch is being suspended is 409", async () => {
    const { toApiError } = await import("./errors.js");
    const { BatchRefusedError } = await import("@ao/library");
    expect(toApiError(new BatchRefusedError("This import is already running.", false, "running")).status).toBe(409);
    expect(toApiError(new BatchRefusedError("This import has already finished.", false, "finished")).status).toBe(409);
    // By kind, never by the English text (R106).
    expect(toApiError(new BatchRefusedError("This import is already running.")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 30 review round 3 (R104–R106)

/** A worker whose downloads take `ms` and then fail (each capture is audited, nothing stored). */
function slowProvider(ms: number): WorkerProvider {
  const client = {
    async submit(): Promise<JobResult> {
      await new Promise((r) => setTimeout(r, ms));
      throw new WorkerJobError("TOOL_FAILED", "the tool failed");
    },
    async resumePending() {
      return [];
    },
  } as unknown as WorkerClient;
  return { start: async () => ({ clientFor: () => client, versions: async () => ({}), updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }), stop: async () => {} }) };
}

const auditOps = async (pid: string) => ((await call({ url: `/projects/${pid}/audit?limit=1000` })).json.events as Array<{ details?: { op?: string } }>).map((e) => e.details?.op);

describe("review round 3: move and background work (R106)", () => {
  it("a 15-link capture queue + move: stops between links, audit verifies, every capture audited, the rest resumes", async () => {
    await start({ worker: slowProvider(40), autoStartWorker: true });
    await openNewLibrary();
    const pid = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, downloader]\n`);
    const urls = Array.from({ length: 15 }, (_, i) => `https://www.youtube.com/watch?v=aoTest${String(i).padStart(5, "0")}`);
    const third = nextEvent((e) => e.type === "capture.progress" && e.data.done === 3);
    const { queueId } = (await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls } })).json;
    await third;
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    expect(svc.state.session!.lib.root).toBe(join(tmp, "Moved"));
    const finished = (await svc.state.idle(), true);
    expect(finished).toBe(true);
    expect((await call({ url: `/projects/${pid}/audit/verify` })).json.ok).toBe(true);
    // Every link captured exactly once across the move (each capture's decision audited once).
    expect((await auditOps(pid)).filter((o) => o === "capture.link")).toHaveLength(15);
    const last = svc.state.captureQueue(queueId);
    expect(last).toMatchObject({ done: 15, total: 15, finished: true });
  });

  it("an attach in flight when a move starts: the move waits for it, then succeeds", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(15, "att");
    const { readdir } = await import("node:fs/promises");
    const paths = (await readdir(dir)).map((f) => join(dir, f));
    const attaching = call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths } });
    await new Promise((r) => setTimeout(r, 30));
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    const att = await attaching;
    expect(att.status).toBe(200);
    expect(moved.body).toContain('"done":true');
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(15);
    expect((await call({ url: `/projects/${pid}/audit/verify` })).json.ok).toBe(true);
  });

  it("M1: a suspend that lands after the timeout is counted: the batch is resumed, not left paused", async () => {
    await start({ suspendTimeoutMs: 200 });
    await openNewLibrary();
    const pid = await newProject();
    const dirA = await pdfFolder(20, "ma");
    const dirB = await pdfFolder(20, "mb");
    const pa = holdBatch((d) => d.done >= 2);
    const a = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dirA } } })).json.batchId;
    await pa;
    const pb = holdBatch((d) => d.batchId !== a);
    const b = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dirB } } })).json.batchId;
    await pb;
    const ha = svc.state.session!.batches.get(a)!.handle;
    const realA = ha.suspend.bind(ha);
    ha.suspend = () => new Promise((r) => setTimeout(r, 300)).then(realA); // lands late
    const hb = svc.state.session!.batches.get(b)!.handle;
    hb.suspend = () => new Promise(() => {}); // never lands: the move is refused
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } })).status).toBe(409);
    await svc.state.idle();
    expect(await batchState(pid, a)).toBe("finished");
    expect(await batchState(pid, b)).toBe("finished");
  });

  it("undo while the import runs → 409 (BatchRefusedError kind, not text)", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(20, "undo");
    const p = holdBatch((d) => d.done >= 1);
    const id = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json.batchId;
    await p;
    const r = await call({ method: "POST", url: `/imports/${id}/undo` });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("CONFLICT");
    svc.state.session!.batches.get(id)!.handle.resume(); // let the held batch run to its end
    await svc.state.idle();
  });

  it("pending writes found by the move are 409 CONFLICT with a plain message, never POLICY_DENIED", async () => {
    const { toApiError } = await import("./errors.js");
    const { MoveNotAllowedError, PendingWriteIncompleteError } = await import("@ao/library");
    const inc = toApiError(new PendingWriteIncompleteError("019a7000-0000-7000-8000-0000000000c1", "The change could not be undone completely: a step failed."));
    expect([inc.status, inc.code, inc.message]).toEqual([409, "CONFLICT", "The change could not be undone completely: a step failed."]);
    const e = toApiError(new MoveNotAllowedError("pending-writes" as never, "Some changes were interrupted"));
    expect([e.status, e.code]).toEqual([409, "CONFLICT"]);
  });

  it("after a failed open of the moved copy, paused imports resume once it is opened", async () => {
    let fails = 0;
    const { openLibrary: realOpen } = await import("@ao/library");
    const dest = join(tmp, "Moved");
    await start({
      openLibrary: async (root, d, o) => {
        if (root === dest && fails < 2) {
          fails++;
          throw new Error("EIO");
        }
        return realOpen(root, d, o);
      },
    });
    await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(20, "fo");
    const p = holdBatch((d) => d.done >= 2);
    const id = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json.batchId;
    await p;
    const r = await call({ method: "POST", url: "/libraries/move", body: { dest } });
    expect(r.body).toContain("LIBRARY_OFFLINE");
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, id)).toBe("finished");
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(20);
  });
});

describe("review round 3: appearance (R105, service side)", () => {
  beforeEach(() => start());
  it("two concurrent PUTs both apply; font names refuse control characters and backslash", async () => {
    const [a, b] = await Promise.all([
      call({ method: "PUT", url: "/settings/appearance", body: { theme: "dark" } }),
      call({ method: "PUT", url: "/settings/appearance", body: { textScale: 1.25 } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await call({ url: "/settings/appearance" })).json).toMatchObject({ theme: "dark", textScale: 1.25 });
    for (const family of ["Bad\u0007Font", "Bad\\\\Font", "Bad\nFont"]) {
      expect((await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { interface: { family, source: "system" } } } })).status, JSON.stringify(family)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Task 30 review round 4 (R108)

describe("review round 4: stopped work, in-flight changes, refusals, resumes (R108)", () => {
  it("T8: a capture queue stopped by a move whose new copy cannot be opened never runs against another library; it resumes on its own", async () => {
    let fails = 0;
    const { openLibrary: realOpen } = await import("@ao/library");
    const dest = join(tmp, "Moved");
    let failMove = false;
    await start({
      worker: slowProvider(40),
      autoStartWorker: true,
      openLibrary: async (root, d, o) => {
        if (root === dest && fails < 2) {
          fails++;
          throw new Error("EIO");
        }
        return realOpen(root, d, o);
      },
      beforeExecuteMove: async () => {
        if (failMove) throw new Error("the copy failed");
      },
    });
    await openNewLibrary();
    const pid = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, downloader]\n`);
    const urls = Array.from({ length: 15 }, (_, i) => `https://www.youtube.com/watch?v=aoT8${String(i).padStart(7, "0")}`);
    const third = nextEvent((e) => e.type === "capture.progress" && e.data.done === 3);
    const { queueId } = (await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls } })).json;
    await third;
    // The move finishes, but the moved copy cannot be opened (twice): the queue is stopped part-way.
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest } })).body).toContain("LIBRARY_OFFLINE");
    expect(fails).toBe(2);
    const stoppedAt = svc.state.captureQueue(queueId)!.done;
    expect(stoppedAt).toBeLessThan(15);
    // Another library is opened, and a move of it is rolled back.
    const other = await openNewLibrary("Other");
    const otherPid = await newProject(OPEN_GOV, false, "Elsewhere");
    failMove = true;
    expect((await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "OtherMoved") } })).body).toContain("error");
    failMove = false;
    await svc.state.idle();
    // Nothing ran against the other library.
    expect(svc.state.session!.lib.root).toBe(other);
    expect(svc.state.workKinds()).not.toContain("capture");
    expect(svc.state.captureQueue(queueId)).toMatchObject({ done: stoppedAt, finished: false });
    expect((await auditOps(otherPid)).filter((o) => o === "capture.link")).toHaveLength(0);
    // Opening the moved copy resumes the queue there.
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).status).toBe(200);
    await svc.state.idle();
    expect(svc.state.captureQueue(queueId)).toMatchObject({ done: 15, total: 15, finished: true });
    expect((await auditOps(pid)).filter((o) => o === "capture.link")).toHaveLength(15);
  }, 60_000);

  it("a request whose body is still arriving does not hold up a move (counted only once its body is read)", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const port = await svc.listen();
    // A change whose upload has started but not finished.
    const body = JSON.stringify({ paths: [await fixturePdf()] });
    const slow = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/projects/${pid}/attach`,
      headers: { ...auth, host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    });
    const slowDone = new Promise<number>((resolve) => {
      slow.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      slow.on("error", () => resolve(0));
    });
    slow.write(body.slice(0, 5));
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const moved = await fetch(`http://127.0.0.1:${port}/libraries/move`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ dest: join(tmp, "Moved") }),
    });
    expect(await moved.text()).toContain('"done":true');
    expect(Date.now() - t0).toBeLessThan(15_000);
    slow.end(body.slice(5));
    expect(await slowDone).toBe(200); // read after the move: it applies to the moved library
    const listed = (await (await fetch(`http://127.0.0.1:${port}/projects/${pid}/sources`, { headers: auth })).json()) as { total: number };
    expect(listed.total).toBe(1);
  }, 30_000);

  it("an import refused because the project is locked is 423 PROJECT_LOCKED", async () => {
    const { toApiError } = await import("./errors.js");
    const { BatchRefusedError } = await import("@ao/library");
    expect([toApiError(new BatchRefusedError("locked", false, "locked")).status, toApiError(new BatchRefusedError("locked", false, "locked")).code]).toEqual([423, "PROJECT_LOCKED"]);
    await start();
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV.replace("atRest: optional", "atRest: required"), true);
    const dir = await pdfFolder(3, "locked");
    await call({ method: "POST", url: `/projects/${pid}/lock` });
    const r = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } });
    expect([r.status, r.json.error.code]).toEqual([423, "PROJECT_LOCKED"]);
  });

  it("batches being resumed are in the work registry: a move's quiesce waits for them and pauses them", async () => {
    await start();
    await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(20, "rs");
    const p = holdBatch((d) => d.done >= 2);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json;
    await p;
    expect((await call({ method: "POST", url: `/imports/${batchId}/cancel` })).status).toBe(200);
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("cancelled"); // stopped, resumable from its record
    // Resuming takes a while to reach the point where the batch is running.
    const s = svc.state.session!;
    const bulk = s.bulk!;
    const realResume = bulk.resumeBatch.bind(bulk);
    bulk.resumeBatch = async (...args) => {
      await new Promise((r) => setTimeout(r, 300));
      return realResume(...args);
    };
    svc.state.resumeBatches([{ projectId: pid, batchId }]);
    expect(svc.state.workKinds()).toContain("resume-import");
    expect(await svc.state.drainWork(10_000)).toBe(true);
    expect(s.batches.has(batchId)).toBe(true); // drained only once it was running (and so can be paused)
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    await svc.state.idle();
    expect(await batchState(pid, batchId)).toBe("finished");
    expect((await call({ url: `/projects/${pid}/sources?limit=100` })).json.total).toBe(20);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Integration after the Task 31/32 merge: shared rules (R109) and the extension's routes (R111)
describe("integration: shared rules from @ao/shared (R105, R108, R109)", () => {
  beforeEach(() => start());

  it("credential query keys come from @ao/shared (no copy in auth.ts); every one of them is refused", async () => {
    expect("CREDENTIAL_QUERY_KEYS" in authModule).toBe(false);
    for (const key of CREDENTIAL_QUERY_KEYS) {
      for (const k of [key, key.toUpperCase()]) expect((await call({ url: `/libraries?${k}=x` })).status, k).toBe(401);
    }
    expect((await call({ url: "/libraries?sessionId=x" })).status).not.toBe(401);
  });

  it("font family names follow isUsableFontFamily: C1, bidi, zero-width and separator characters are refused", async () => {
    for (const cp of [0x85, 0x202e, 0x2066, 0x200b, 0x200e, 0xfeff, 0x2028, 0x2029]) {
      const family = `Font${String.fromCodePoint(cp)}Name`;
      const r = await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { reading: { family, source: "system" } } } });
      expect(r.status, cp.toString(16)).toBe(400);
    }
    expect((await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { reading: { family: "Noto Sans العربية", source: "system" } } } })).status).toBe(200);
  });

  it("fonts.*.generic is stored and returned: a typed monospace font comes back as monospace", async () => {
    const put = await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { mono: { family: "Fira Code", source: "system", generic: "monospace" } } } });
    expect(put.status, put.body).toBe(200);
    expect(put.json.fonts.mono).toEqual({ family: "Fira Code", source: "system", generic: "monospace" });
    const got = (await call({ url: "/settings/appearance" })).json;
    expect(got.fonts.mono).toEqual({ family: "Fira Code", source: "system", generic: "monospace" });
    // The defaults carry theirs.
    expect(got.fonts.reading.generic).toBe("serif");
  });

  it("generic must be serif, sans-serif or monospace; when absent it is inferred as the UI does, or left out", async () => {
    for (const generic of ["cursive", "Monospace", 3, null]) {
      const r = await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { notes: { family: "Inter", source: "system", generic } } } });
      expect(r.status, JSON.stringify(generic)).toBe(400);
    }
    const inter = await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { notes: { family: "Inter", source: "system" } } } });
    expect(inter.json.fonts.notes).toEqual({ family: "Inter", source: "system", generic: "sans-serif" });
    const unknown = await call({ method: "PUT", url: "/settings/appearance", body: { fonts: { notes: { family: "Some Unknown Face", source: "system" } } } });
    expect(unknown.json.fonts.notes).toEqual({ family: "Some Unknown Face", source: "system" });
    // A stored file written before generic existed: inferred on read.
    await writeFile(join(deps.appConfigDir, "appearance.json"), JSON.stringify({ fonts: { transcript: { family: "Menlo, monospace", source: "system" } } }));
    expect((await call({ url: "/settings/appearance" })).json.fonts.transcript).toEqual({ family: "Menlo, monospace", source: "system", generic: "monospace" });
  });
});

describe("integration: the extension's routes (R111)", () => {
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const OTHER = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
  const LINKS_GOV = `${OPEN_GOV}captureMethods: [manual_upload, browser_capture, downloader]\n`;

  async function pair(origin = EXT): Promise<string> {
    const p = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin, "content-type": "application/json" }, payload: JSON.stringify({ code: p.json.code }) });
    expect(c.statusCode, c.body).toBe(200);
    return c.json().token as string;
  }
  async function ext(token: string, method: "GET" | "POST", url: string, body?: unknown, origin: string | null = EXT) {
    const res = await svc.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(origin !== null ? { origin } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    return { status: res.statusCode, json: res.json(), body: res.body };
  }

  it("R111(1): with the extension token, no Origin is accepted on GET /projects only; a different Origin stays 403", async () => {
    await start({ pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    await pair(OTHER); // another extension is paired too: its origin is still not this token's
    const listed = await ext(token, "GET", "/projects", undefined, null);
    expect(listed.status, listed.body).toBe(200);
    expect(listed.json.projects.map((p: { id: string }) => p.id)).toEqual([pid]);
    // Every extension POST needs the paired Origin.
    const page = { projectId: pid, url: "https://example.org/a", extracted: { platform: "web", kind: "page" }, alsoDownload: false };
    for (const [url, body] of [["/capture/browser", page], ["/capture/browser/links", { projectId: pid, urls: ["https://example.org/a"] }]] as const) {
      const r = await ext(token, "POST", url, body, null);
      expect(r.status, url).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN");
    }
    for (const origin of [OTHER, "https://evil.example", "null"]) {
      const r = await ext(token, "GET", "/projects", undefined, origin);
      expect(r.status, origin).toBe(403);
    }
    // Other routes stay out of reach without an Origin as well.
    expect((await ext(token, "GET", "/libraries", undefined, null)).status).toBe(403);
    // The UI token: unchanged (no Origin fine; the shell's fine; a foreign one 403).
    expect((await call({ url: "/projects" })).status).toBe(200);
    expect((await call({ url: "/projects", headers: { origin: "tauri://localhost" } })).status).toBe(200);
    expect((await call({ url: "/projects", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("R111(2): POST /capture/browser/links queues the links (work registry, capture.progress) for the extension token", async () => {
    await start({ worker: fakeProvider({ fail: 99 }), pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    const events: Array<{ type: string; data: any }> = [];
    svc.state.events.subscribe((e) => events.push(e));
    const urls = ["https://www.youtube.com/watch?v=aoTest00001", "https://www.youtube.com/watch?v=aoTest00002"];
    const r = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toEqual({ queueId: expect.any(String) });
    expect(svc.state.captureQueue(r.json.queueId)).toMatchObject({ projectId: pid, total: 2 });
    await svc.state.idle();
    const progress = events.filter((e) => e.type === "capture.progress" && e.data.queueId === r.json.queueId);
    expect(progress.at(-1)?.data).toMatchObject({ projectId: pid, done: 2, total: 2, finished: true });
  });

  it("R111(2): refusals — over 500 links, non-web schemes, long links, unknown project, policy, the UI token", async () => {
    await start({ worker: fakeProvider({ fail: 99 }), pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    const many = Array.from({ length: 501 }, (_, i) => `https://www.youtube.com/watch?v=ao${String(i).padStart(9, "0")}`);
    expect((await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: many })).status).toBe(400);
    expect((await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: many.slice(0, 500) })).status).toBe(200);
    await svc.state.idle(); // that queue has finished: the caller limit (R116) is free again
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.org/x", "data:text/html,x", "//example.org/x", `https://example.org/${"a".repeat(2048)}`]) {
      const r = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: ["https://example.org/ok", bad] });
      expect(r.status, bad.slice(0, 30)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
    }
    for (const body of [{ projectId: pid, urls: [] }, { projectId: pid }, { urls: ["https://example.org/x"] }, { projectId: pid, urls: "https://example.org/x" }]) {
      expect((await ext(token, "POST", "/capture/browser/links", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await ext(token, "POST", "/capture/browser/links", { projectId: "nope", urls: ["https://example.org/x"] })).status).toBe(404);
    // The project's rules: no downloader → 403 POLICY_DENIED with the reason.
    const strict = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, browser_capture]\n`, false, "Strict");
    const denied = await ext(token, "POST", "/capture/browser/links", { projectId: strict, urls: ["https://www.youtube.com/watch?v=aoTest00001"] });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("POLICY_DENIED");
    expect(denied.json.error.reason).toMatch(/downloader/i);
    // The desktop UI keeps /projects/:id/capture: this route is the extension's only.
    const ui = await call({ method: "POST", url: "/capture/browser/links", body: { projectId: pid, urls: ["https://example.org/x"] } });
    expect(ui.status).toBe(403);
    expect(ui.json.error.code).toBe("FORBIDDEN");
  });

  /** A media worker whose downloads take `ms`, recording how many run at once per platform. */
  function slowProvider(ms: number): WorkerProvider & { downloads: string[]; overlaps: string[] } {
    const inFlight = new Map<string, number>();
    const p = {
      downloads: [] as string[],
      overlaps: [] as string[],
      async start() {
        const client = {
          async submit(_pid: string, job: WorkerJob): Promise<JobResult> {
            const platform = new URL(job.input).hostname;
            const n = (inFlight.get(platform) ?? 0) + 1;
            inFlight.set(platform, n);
            if (n > 1) p.overlaps.push(platform);
            p.downloads.push(job.input);
            await new Promise((r) => setTimeout(r, ms));
            inFlight.set(platform, (inFlight.get(platform) ?? 1) - 1);
            throw new WorkerJobError("TOOL_FAILED", "the tool failed");
          },
          async resumePending() {
            return [];
          },
        } as unknown as WorkerClient;
        return { clientFor: () => client, versions: async () => ({}), updateTools: async () => ({}) as never, stop: async () => {} };
      },
    };
    return p;
  }
  // Distinct links for distinct keys (Task 63: the same link still running in a project is not queued again).
  const yt = (k: string, i: number) => `https://www.youtube.com/watch?v=${k}${String(i).padStart(10, "0")}`;

  it("R116: the project must allow browser capture as well as the downloader (403 POLICY_DENIED with the reason)", async () => {
    await start({ worker: fakeProvider({ fail: 99 }), pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(`${OPEN_GOV}captureMethods: [manual_upload, downloader]\n`);
    const token = await pair();
    const r = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("a", 1)] });
    expect(r.status, r.body).toBe(403);
    expect(r.json.error.code).toBe("POLICY_DENIED");
    expect(r.json.error.reason).toMatch(/browser/i);
  });

  it("R116: the same link many times is queued once", async () => {
    const provider = slowProvider(1);
    await start({ worker: provider, pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    const r = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: Array.from({ length: 500 }, () => yt("a", 1)) });
    expect(r.status, r.body).toBe(200);
    expect(svc.state.captureQueue(r.json.queueId)).toMatchObject({ total: 1 });
    await svc.state.idle();
    expect(provider.downloads).toHaveLength(1);
  });

  it("R116: one extension token has at most one active links queue and one waiting; more is 429 RATE_LIMITED", async () => {
    const provider = slowProvider(40);
    await start({ worker: provider, pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("b", i)] })));
    const ok = results.filter((r) => r.status === 200);
    const limited = results.filter((r) => r.status === 429);
    expect(ok).toHaveLength(2);
    expect(limited).toHaveLength(48);
    for (const r of limited) expect(r.json.error.code).toBe("RATE_LIMITED");
    // Another paired extension has its own allowance.
    const other = await pair(OTHER);
    expect((await ext(other, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("c", 1)] }, OTHER)).status).toBe(200);
    // Once the queues have finished, the token may queue again.
    await svc.state.idle();
    expect((await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("d", 1)] })).status).toBe(200);
    await svc.state.idle();
  });

  it("41a I3: closing the library while a links queue runs and another waits releases both slots (no 429 after reopening)", async () => {
    const provider = slowProvider(40);
    await start({ worker: provider, pairing: { confirmPerMinute: 100 } });
    const path = await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    const a = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [0, 1, 2].map((i) => yt("i", i)) });
    const b = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("j", 1)] });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    await svc.state.idle();
    // Both queues ended (one way or another) and say so.
    expect(svc.state.captureQueue(b.json.queueId)?.finished).toBe(true);
    const c = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("k", 1)] });
    const d = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("l", 1)] });
    expect([c.status, d.status], d.body).toEqual([200, 200]);
    await svc.state.idle();
  });

  it("41a N4: a links queue carried across a library move keeps its slot (one running and one waiting, still)", async () => {
    const provider = slowProvider(30);
    await start({ worker: provider, pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    const second = nextEvent((e) => e.type === "capture.progress" && e.data.done === 2);
    const a = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: Array.from({ length: 12 }, (_, i) => yt("m", i)) });
    expect(a.status, a.body).toBe(200);
    await second;
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    expect(svc.state.captureQueue(a.json.queueId)?.finished).toBe(false);
    const c = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("n", 1)] });
    const d = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("o", 1)] });
    expect([c.status, d.status]).toEqual([200, 429]);
    await svc.state.idle();
  });

  it("R116: queues from different callers share one per-platform lane (no two downloads from one platform at once)", async () => {
    const provider = slowProvider(10);
    await start({ worker: provider, pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const a = await pair();
    const b = await pair(OTHER);
    const ra = await ext(a, "POST", "/capture/browser/links", { projectId: pid, urls: [0, 1, 2].map((i) => yt("e", i)) });
    const rb = await ext(b, "POST", "/capture/browser/links", { projectId: pid, urls: [0, 1, 2].map((i) => yt("f", i)) }, OTHER);
    const ui = await call({ method: "POST", url: `/projects/${pid}/capture`, body: { urls: [0, 1, 2].map((i) => yt("g", i)), options: {} } });
    expect([ra.status, rb.status, ui.status]).toEqual([200, 200, 200]);
    await svc.state.idle();
    expect(provider.downloads).toHaveLength(9);
    expect(provider.overlaps).toEqual([]);
  });

  it("R116: only post and video links; a profile or channel is refused with 400 and a plain message", async () => {
    await start({ worker: fakeProvider({ fail: 99 }), pairing: { confirmPerMinute: 100 } });
    await openNewLibrary();
    const pid = await newProject(LINKS_GOV);
    const token = await pair();
    for (const url of ["https://www.instagram.com/someone/", "https://www.youtube.com/@channel"]) {
      const r = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: [yt("h", 1), url] });
      expect(r.status, url).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
      expect(r.json.error.message).toMatch(/profile|channel/i);
      expect(r.json.error.message).not.toMatch(/someone|channel"|@/);
    }
    // Posts, reels and videos are taken.
    const r = await ext(token, "POST", "/capture/browser/links", { projectId: pid, urls: ["https://www.instagram.com/p/CfAkEcArO01/", "https://www.instagram.com/reel/CfAkEcArO02/", "https://www.tiktok.com/@a.b/video/7000000000000000001", yt("h", 2)] });
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
  });
});

describe("screens integration (R118)", () => {
  beforeEach(() => start());

  it("(a) GET /projects sends each project's compliance profiles; unreadable rules give none", async () => {
    await openNewLibrary();
    const open = await newProject(OPEN_GOV, false, "Open");
    const hipaa = await newProject(HIPAA_GOV, true, "Clinic");
    // Rules are plain text: a locked project still shows its badges.
    expect((await call({ method: "POST", url: `/projects/${hipaa}/lock` })).status).toBe(200);
    const projects = (await call({ url: "/projects" })).json.projects as Array<{ id: string; profiles: string[] }>;
    expect(projects.find((p) => p.id === open)?.profiles).toEqual([]);
    expect(projects.find((p) => p.id === hipaa)?.profiles).toEqual(["hipaa"]);
    const folder = (projects.find((p) => p.id === open) as unknown as { folder: string }).folder;
    const lib = join(tmp, "Lib");
    await writeFile(join(lib, folder, "governance.yaml"), "profiles: [not-a-profile\n");
    const again = (await call({ url: "/projects" })).json.projects as Array<{ id: string; profiles: string[] }>;
    expect(again.find((p) => p.id === open)?.profiles).toEqual([]);
  });
});

describe("screens integration (R118): lock holder", () => {
  beforeEach(() => start());

  it("(c) a library locked by another device names that device (only its name) in GET /libraries, open and library.state", async () => {
    const path = await openNewLibrary();
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.status, opened.body).toBe(200);
    expect(opened.json).toMatchObject({ mode: "read-only", readOnlyReason: "locked-by-other-device", lockedBy: "field-laptop" });
    expect((await call({ url: "/libraries" })).json.current.lockedBy).toBe("field-laptop");
    const libState = svc.state.libraryState();
    expect(libState.lockedBy).toBe("field-laptop");
    for (const body of [opened.body, JSON.stringify(libState)]) {
      expect(body).not.toContain("dev-other");
      expect(body).not.toContain("4242");
      expect(body).not.toContain("ana");
    }
  });

  it("Task 58 M6: a read-only library's source list says its search is limited to titles", async () => {
    const path = await openNewLibrary();
    const pid = await newProject();
    expect((await call({ url: `/projects/${pid}/sources?text=anything` })).json).not.toHaveProperty("limited");
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).json.mode).toBe("read-only");
    const r = await call({ url: `/projects/${pid}/sources?text=anything` });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ total: 0, items: [], limited: true });
  });

  it("(c) a writable library sends no lockedBy", async () => {
    await openNewLibrary();
    expect((await call({ url: "/libraries" })).json.current.lockedBy).toBeUndefined();
    expect(svc.state.libraryState().lockedBy).toBeUndefined();
  });
});

describe("screens integration (R118): workspace tags", () => {
  beforeEach(() => start());

  it("(b) PATCH and DELETE /workspace-tags/:tid rename and delete a workspace tag, audited in each project", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const tag = (await call({ method: "POST", url: `/projects/${pid}/tags`, body: { name: "to-read", scope: "workspace" } })).json;
    const renamed = await call({ method: "PATCH", url: `/workspace-tags/${tag.id}`, body: { name: "reading list", color: "#336699" } });
    expect(renamed.status, renamed.body).toBe(200);
    expect(renamed.json).toMatchObject({ id: tag.id, name: "reading list", color: "#336699", scope: "workspace" });
    expect((await call({ url: `/projects/${pid}/tags` })).json.workspaceTags.map((t: { name: string }) => t.name)).toEqual(["reading list"]);
    const audit = await call({ url: `/projects/${pid}/audit` });
    expect(audit.status, audit.body).toBe(200);
    expect(JSON.stringify(audit.json)).toContain("workspace-tag.rename");
    expect((await call({ method: "PATCH", url: `/workspace-tags/${tag.id}`, body: {} })).status).toBe(400);
    expect((await call({ method: "DELETE", url: `/workspace-tags/${tag.id}` })).json).toEqual({ deleted: true });
    expect((await call({ url: `/projects/${pid}/tags` })).json.workspaceTags).toEqual([]);
    expect((await call({ method: "DELETE", url: `/workspace-tags/${tag.id}` })).status).toBe(404);
  });

  it("(b) a locked encrypted project blocks the change with a plain 409 (not PROJECT_LOCKED for the open project)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const enc = await newProject(HIPAA_GOV, true, "Clinic");
    await call({ method: "POST", url: `/projects/${enc}/lock` });
    const tag = (await call({ method: "POST", url: `/projects/${pid}/tags`, body: { name: "to-read", scope: "workspace" } })).json;
    const r = await call({ method: "DELETE", url: `/workspace-tags/${tag.id}` });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("CONFLICT");
    expect(r.json.error.message).toMatch(/Unlock/);
    expect(r.json.error.message).toContain("Clinic");
  });
});

describe("screens integration (R118): import routes", () => {
  beforeEach(() => start());

  it("(d, e, f) dry-run outside files carry their real path; report and batch list name what the batch created; review items carry titles", async () => {
    const { mkdir, realpath, symlink } = await import("node:fs/promises");
    await openNewLibrary();
    const pid = await newProject();
    const dir = await pdfFolder(2, "scan");
    await mkdir(join(dir, "Chapter"), { recursive: true });
    await writeFile(join(dir, "Chapter", "c.pdf"), await buildPdf({ title: "Chapter Notes on Delta Kinship", author: "Ana Souza", lines: ["c"] }));
    const outside = await fixturePdf("elsewhere.pdf", "Elsewhere Paper on River Trade");
    if (process.platform !== "win32") await symlink(outside, join(dir, "link.pdf"));

    const dry = await call({ method: "POST", url: `/projects/${pid}/import/dry-run`, body: { adapter: { kind: "folder", path: dir } } });
    expect(dry.status, dry.body).toBe(200);
    if (process.platform !== "win32") expect(dry.json.outsideFiles).toEqual([{ item: "link.pdf", folder: await realpath(dirname(outside)), file: await realpath(outside) }]);

    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir }, options: { structure: "collections" } } })).json;
    await svc.state.idle();
    const collections = (await call({ url: `/projects/${pid}/collections` })).json.collections as Array<{ id: string; name: string }>;
    const chapter = collections.find((c) => c.name === "Chapter")!;
    const report = await call({ url: `/imports/${batchId}/report` });
    expect(report.status, report.body).toBe(200);
    expect(report.json.created).toEqual({ collectionIds: [chapter.id], tagIds: [] });
    expect((await call({ url: `/projects/${pid}/imports` })).json.batches[0].created).toEqual({ collectionIds: [chapter.id], tagIds: [] });

    const review = (await call({ url: `/imports/${batchId}/review` })).json.items as Array<{ sourceId?: string; title?: string }>;
    expect(review.length).toBeGreaterThan(0);
    for (const item of review) {
      const sf = (await call({ url: `/projects/${pid}/sources/${item.sourceId}` })).json;
      expect(item.title).toBe(sf.source.title.variants[0].value);
    }
  });
});

describe("screens integration (R118): resolve a pending write (R27)", () => {
  beforeEach(() => start());

  it("(g) lists unresolved interrupted changes and resolves one by the researcher's choice; refused choices are 409", async () => {
    const { mkdir } = await import("node:fs/promises");
    const path = await openNewLibrary();
    const pid = await newProject();
    expect((await call({ url: "/libraries/pending-writes" })).json).toEqual({ pendingWrites: [] });
    // An unreadable marker (invalid) and a valid-looking one for a change that never happened.
    await mkdir(join(path, ".tmp"), { recursive: true });
    const bad = "019a7000-0000-7000-8000-00000000bad1";
    await writeFile(join(path, ".tmp", `txn-${bad}.json`), "{ torn");
    const folder = (await call({ url: "/projects" })).json.projects[0].folder as string;
    const good = "019a7000-0000-7000-8000-0000000000c1";
    const auditLines = (await readFile(join(path, folder, "audit", "0001.jsonl"), "utf8")).trim().split("\n").length;
    await writeFile(
      join(path, ".tmp", `txn-${good}.json`),
      JSON.stringify({ formatVersion: 1, txn: good, projectId: pid, projectFolder: folder, auditEvents: 1, auditSeqBefore: auditLines + 5, entries: [{ kind: "created", path: `${folder}/half-written.txt` }] }),
    );
    await writeFile(join(path, folder, "half-written.txt"), "half");
    // Reopen: recovery leaves both (the second's audit counters do not match the log).
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path } })).status).toBe(200);
    const list = (await call({ url: "/libraries/pending-writes" })).json.pendingWrites as Array<{ txn: string; status: string; canKeep: boolean; canRollBack: boolean; project: string }>;
    expect(list.find((p) => p.txn === bad)).toMatchObject({ status: "invalid", canKeep: false, canRollBack: false, project: "library" });
    const g = list.find((p) => p.txn === good)!;
    // R131 a: an unverifiable marker offers no choice, and says why in plain words.
    expect(g).toMatchObject({ status: "unverifiable", canKeep: false, canRollBack: false, project: "Study" });
    expect((g as { detail?: string }).detail).toMatch(/backup/);
    expect(JSON.stringify(list)).not.toContain(path);

    const keep = await call({ method: "POST", url: `/libraries/pending-writes/${good}/resolve`, body: { choice: "keep" } });
    expect(keep.status).toBe(409);
    expect(keep.json.error.code).toBe("CONFLICT");
    const back = await call({ method: "POST", url: `/libraries/pending-writes/${good}/resolve`, body: { choice: "roll-back" } });
    expect(back.status).toBe(409);
    expect(back.json.error.reason).toBe("allowed: none");
    expect(await readFile(join(path, folder, "half-written.txt"), "utf8")).toBe("half");
    expect((await call({ method: "POST", url: `/libraries/pending-writes/${bad}/resolve`, body: { choice: "roll-back" } })).status).toBe(409);
    expect((await call({ method: "POST", url: `/libraries/pending-writes/${good}/resolve`, body: { choice: "maybe" } })).status).toBe(400);
    // A plainly uncommitted change (its marker matches the audit log) can be rolled back.
    const fine = "019a7000-0000-7000-8000-0000000000c2";
    const nowLines = (await readFile(join(path, folder, "audit", "0001.jsonl"), "utf8")).trim().split("\n").length;
    await writeFile(
      join(path, ".tmp", `txn-${fine}.json`),
      JSON.stringify({ formatVersion: 1, txn: fine, projectId: pid, projectFolder: folder, auditEvents: 1, auditSeqBefore: nowLines, entries: [{ kind: "created", path: `${folder}/half-written-2.txt` }] }),
    );
    await writeFile(join(path, folder, "half-written-2.txt"), "half");
    const listed = (await call({ url: "/libraries/pending-writes" })).json.pendingWrites as Array<{ txn: string }>;
    expect(listed.find((p) => p.txn === fine)).toMatchObject({ status: "uncommitted", canKeep: false, canRollBack: true });
    const r = await call({ method: "POST", url: `/libraries/pending-writes/${fine}/resolve`, body: { choice: "roll-back" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json).toMatchObject({ txn: fine, choice: "roll-back" });
    await expect(readFile(join(path, folder, "half-written-2.txt"))).rejects.toThrow();
    expect((await call({ url: "/libraries/pending-writes" })).json.pendingWrites.map((p: { txn: string }) => p.txn).sort()).toEqual([bad, good].sort());
    const audit = JSON.stringify((await call({ url: `/projects/${pid}/audit` })).json);
    expect(audit).toContain("txn.resolve");
    expect((await call({ method: "POST", url: `/libraries/pending-writes/${"019a7000-0000-7000-8000-0000000000ff"}/resolve`, body: { choice: "keep" } })).status).toBe(404);
  });
});

describe("Task 46b D2 (R137): a library row's needsReview means an item waits in the import review queue", () => {
  beforeEach(() => start());

  it("is true while the source's review item is pending and false once it is decided, whatever the fields' verification", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const dir = join(tmp, "in");
    await fixturePdf("a.pdf", "First Paper on Rivers");
    await fixturePdf("b.pdf", "Second Paper on Lakes");
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir }, options: {} } })).json;
    await svc.state.idle();
    const pending = (await call({ url: `/imports/${batchId}/review` })).json.items as Array<{ id: string; sourceId: string }>;
    expect(pending.length, "the fixture's items wait for review (no lookups)").toBeGreaterThan(1);
    const rows = async () => (await call({ url: `/projects/${pid}/sources?limit=100` })).json.items as Array<{ id: string; needsReview: boolean }>;
    const waiting = new Set(pending.map((p) => p.sourceId));
    for (const r of await rows()) expect(r.needsReview, r.id).toBe(waiting.has(r.id));

    const [first, ...rest] = pending;
    const statuses = async (sid: string) => ((await call({ url: `/projects/${pid}/sources/${sid}` })).json as { fields: Array<{ field: string; status: string }> }).fields.map((f) => `${f.field}:${f.status}`);
    const before = await statuses(first!.sourceId);
    const decided = await call({ method: "POST", url: `/review/${first!.id}/decide`, body: { projectId: pid, decision: { action: "accept" } } });
    expect(decided.status, decided.body).toBe(200);
    const after = await rows();
    expect(after.find((r) => r.id === first!.sourceId)?.needsReview).toBe(false);
    for (const p of rest) expect(after.find((r) => r.id === p.sourceId)?.needsReview).toBe(true);
    // Accepting does not confirm the fields (R137): the source's verification is unchanged.
    expect(await statuses(first!.sourceId)).toEqual(before);

    // Every other decision clears it too (keep-both here), and a text search reports the same.
    for (const p of rest) expect((await call({ method: "POST", url: `/review/${p.id}/decide`, body: { projectId: pid, decision: { action: "keep-both" } } })).status).toBe(200);
    expect((await rows()).every((r) => !r.needsReview)).toBe(true);
    const found = (await call({ url: `/projects/${pid}/sources?text=Rivers` })).json.items as Array<{ needsReview: boolean }>;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => !r.needsReview)).toBe(true);
  });
});

describe("Task 46b fix round 1 (R172): needsReview means the source has a pending entry of any kind in the project's review queue", () => {
  beforeEach(() => start());

  const rows = async (pid: string) => (await call({ url: `/projects/${pid}/sources?limit=500` })).json.items as Array<{ id: string; needsReview: boolean; locked: boolean }>;
  const badge = async (pid: string, sid: string) => (await rows(pid)).find((r) => r.id === sid)?.needsReview;
  /** The project's pending review entries, read from the index (no route lists entries outside a batch). */
  const pendingEntries = (pid: string) =>
    svc.state.session!.index!.db.prepare("SELECT id, kind, batch_id AS batchId, source_id AS sourceId FROM review_items WHERE project_id = ? AND status = 'pending'").all(pid) as Array<{
      id: string;
      kind: string;
      batchId: string | null;
      sourceId: string | null;
    }>;
  const decide = (pid: string, itemId: string, decision: Record<string, unknown>) => call({ method: "POST", url: `/review/${itemId}/decide`, body: { projectId: pid, decision } });
  const importFolder = async (pid: string, titles: string[], folder: string) => {
    for (const [i, t] of titles.entries()) await fixturePdf(join("..", folder, `p${i}.pdf`), t);
    const r = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: join(tmp, folder) }, options: {} } });
    expect(r.status, r.body).toBe(200);
    await svc.state.idle();
    const items = (await call({ url: `/imports/${r.json.batchId}/review` })).json.items as Array<{ id: string; sourceId: string }>;
    expect(items.length, "every fixture item waits for review (no lookups)").toBe(titles.length);
    return { batchId: r.json.batchId as string, items };
  };

  it("a source attached by drag and drop whose outcome is needs-review carries the badge (an import entry with no batch), and deciding it clears it", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } });
    expect(att.status, att.body).toBe(200);
    const [o] = att.json.items as Array<{ outcome: string; sourceId: string }>;
    expect(o!.outcome).toBe("needs-review");
    const [entry] = pendingEntries(pid);
    expect(entry).toMatchObject({ kind: "import", batchId: null, sourceId: o!.sourceId });
    expect(await badge(pid, o!.sourceId)).toBe(true);
    expect((await decide(pid, entry!.id, { action: "accept" })).status).toBe(200);
    expect(await badge(pid, o!.sourceId)).toBe(false);
  });

  it("a captured source saved with conflicting fields carries the badge (a verification entry, as link and profile capture queue it)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const repo = svc.state.session!.repo;
    // createSource's reviewItem is how link-capture.ts and profile-capture.ts queue a capture with conflicts.
    const sf = await repo.createSource(
      pid,
      { projectIds: [pid], type: "webpage", title: { variants: [{ lang: "en", kind: "original", value: "A captured page" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: await fixturePdf("page.pdf"), role: "original", handling: "copy" }],
      {
        provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
        reviewItem: { fields: { "/title": "conflict" }, reasons: ["The page and its metadata disagree on the title."] },
      },
    );
    expect(pendingEntries(pid)).toEqual([expect.objectContaining({ kind: "verification", sourceId: sf.source.id })]);
    expect(await badge(pid, sf.source.id)).toBe(true);
  });

  it("an import batch item: on while pending, off after each kind of decision (accept, edit and accept, skip, merge, keep-both)", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const { items } = await importFolder(pid, ["Rivers of the North", "Lakes of the South", "Deltas of the East", "Estuaries of the West", "Marshes Everywhere"], "batch");
    for (const it of items) expect(await badge(pid, it.sourceId), it.sourceId).toBe(true);
    const [a, b, c, d, e] = items as [(typeof items)[0], (typeof items)[0], (typeof items)[0], (typeof items)[0], (typeof items)[0]];
    const sf = await svc.state.session!.repo.getSource(pid, b.sourceId);
    const draft = { ...sf.source, title: { variants: [{ lang: "en", kind: "original", value: "Lakes of the South, edited" }] } };
    expect((await decide(pid, a.id, { action: "accept" })).status).toBe(200);
    expect((await decide(pid, b.id, { action: "accept", draft })).status).toBe(200);
    expect((await decide(pid, c.id, { action: "skip" })).status).toBe(200);
    expect((await decide(pid, d.id, { action: "merge", sourceId: a.sourceId })).status).toBe(200);
    const left = await rows(pid);
    for (const s of [a, b]) expect(left.find((r) => r.id === s.sourceId)?.needsReview, s.sourceId).toBe(false);
    for (const s of [c, d]) expect(left.find((r) => r.id === s.sourceId), "skipped or merged away: no row").toBeUndefined();
    expect(left.find((r) => r.id === e.sourceId)?.needsReview).toBe(true);
    expect((await decide(pid, e.id, { action: "keep-both" })).status).toBe(200);
    expect((await rows(pid)).every((r) => !r.needsReview)).toBe(true);
    expect(pendingEntries(pid)).toEqual([]);
  });

  it("off after the import is undone: no entry of the batch is left pending, and an older source merged into stays as it was", async () => {
    await openNewLibrary();
    const pid = await newProject();
    const kept = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf("kept.pdf", "An Older Attached Paper")] } });
    const keptId = kept.json.items[0].sourceId as string;
    const [keptEntry] = pendingEntries(pid);
    expect((await decide(pid, keptEntry!.id, { action: "accept" })).status).toBe(200);
    const { batchId, items } = await importFolder(pid, ["Rivers of the North", "Lakes of the South"], "undo");
    expect((await decide(pid, items[0]!.id, { action: "merge", sourceId: keptId })).status).toBe(200);
    expect(await badge(pid, items[1]!.sourceId)).toBe(true);
    const undo = await call({ method: "POST", url: `/imports/${batchId}/undo` });
    expect(undo.status, undo.body).toBe(200);
    expect(pendingEntries(pid)).toEqual([]);
    expect((await rows(pid)).map((r) => [r.id, r.needsReview])).toEqual([[keptId, false]]);
  });

  it("a locked project's rows do not claim needsReview: its queue cannot be read while locked", async () => {
    await openNewLibrary();
    const pid = await newProject(OPEN_GOV, true);
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf()] } });
    const sid = att.json.items[0].sourceId as string;
    expect(await badge(pid, sid)).toBe(true);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const locked = (await rows(pid)).find((r) => r.id === sid);
    expect(locked).toMatchObject({ locked: true, needsReview: false });
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect(await badge(pid, sid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 51 fix round 1 (R142 item 3): the worker client follows the live index after a rebuild

describe("worker client and the index (Task 51)", () => {
  it("a job's status change after rebuild-index reaches the rebuilt database's row", async () => {
    const { createServer } = await import("node:http");
    const { mkdir } = await import("node:fs/promises");
    const { WorkerClient } = await import("@ao/library");
    const { workerClientFor } = await import("./state.js");
    let n = 0;
    const outputs = new Map<string, string>();
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(req.method === "POST" ? 202 : 200, { "Content-Type": "application/json" });
      if (req.method === "POST" && req.url === "/jobs") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { output: string };
        await mkdir(dirname(body.output), { recursive: true });
        await writeFile(body.output, "jpeg");
        const id = `w${++n}`;
        outputs.set(id, body.output);
        return res.end(JSON.stringify({ id }));
      }
      const id = /^\/jobs\/([^/]+)$/.exec(req.url ?? "")?.[1] ?? "";
      res.end(JSON.stringify({ id, status: "done", progress: 1, result: { output: outputs.get(id), meta: {} } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" };
    try {
      const provider: WorkerProvider = {
        start: async () => ({
          clientFor: (repo, index) => workerClientFor(WorkerClient, endpoint, repo, index),
          versions: async () => ({}),
          updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }),
          stop: async () => {},
        }),
      };
      await start({ worker: provider, autoStartWorker: true });
      await openNewLibrary();
      const pid = await newProject();
      const client = await svc.state.workerClient();
      const input = join(tmp, "a.png");
      await writeFile(input, "png");
      expect((await call({ method: "POST", url: "/libraries/rebuild-index" })).status).toBe(200);
      const r = await client.submit(pid, { type: "image.proxy", input, output: join(tmp, "out", "a.jpg"), params: {} });
      const db = svc.state.session!.index!.db;
      expect(db.prepare("SELECT status FROM jobs WHERE id = ?").get(r.id)).toEqual({ status: "done" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Task 51 fix round 2 (N-2, R106 C1 + R142): the rerun at an unlock is registered work

describe("worker jobs rerun at an unlock (Task 51 N-2)", () => {
  let stub: { close(): Promise<void>; runs: Array<{ n: number; cancelled: boolean }> } | undefined;
  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  /**
   * A service whose worker is a stand-in; an encrypted project whose first job is cancelled by a
   * lock that lands while the worker accepts it (R142). The project is left locked. Reruns take `ms`.
   */
  async function lockCancelledJob(ms: number) {
    const { createServer } = await import("node:http");
    const { mkdir } = await import("node:fs/promises");
    const { WorkerClient } = await import("@ao/library");
    const { workerClientFor } = await import("./state.js");
    const runs: Array<{ n: number; cancelled: boolean }> = [];
    const outputs = new Map<string, string>();
    let onFirst: (() => void) | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.setHeader("Content-Type", "application/json");
      const m = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(req.url ?? "");
      if (req.method === "POST" && req.url === "/jobs") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { output: string };
        const run = { n: runs.length + 1, cancelled: false };
        runs.push(run);
        if (run.n === 1) onFirst?.();
        else await new Promise((r) => setTimeout(r, ms));
        await mkdir(dirname(body.output), { recursive: true });
        await writeFile(body.output, "jpeg");
        outputs.set(`w${run.n}`, body.output);
        res.statusCode = 202;
        return res.end(JSON.stringify({ id: `w${run.n}` }));
      }
      const run = runs[Number((m?.[1] ?? "w0").slice(1)) - 1];
      if (m?.[2] && run) run.cancelled = true;
      res.end(JSON.stringify({ id: m?.[1], status: run?.cancelled ? "cancelled" : "done", progress: 1, result: { output: outputs.get(m?.[1] ?? ""), meta: {} } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    stub = { runs, close: () => new Promise<void>((r) => server.close(() => r())) };
    const endpoint = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t" };
    const provider: WorkerProvider = {
      start: async () => ({
        clientFor: (repo, index) => workerClientFor(WorkerClient, endpoint, repo, index),
        versions: async () => ({}),
        updateTools: async () => ({ ytDlp: { old: null, new: null, managed: false }, galleryDl: { version: null, pinned: true } }),
        stop: async () => {},
      }),
    };
    await start({ worker: provider, autoStartWorker: true });
    const root = await openNewLibrary();
    const pid = await newProject(OPEN_GOV, true);
    const client = await svc.state.workerClient();
    await svc.state.idle();
    onFirst = () => svc.state.session!.repo.lockProject(pid);
    const input = join(tmp, "a.png");
    await writeFile(input, "png");
    const err = await client.submit(pid, { type: "image.proxy", input, output: join(tmp, "out", "a.jpg"), params: {} }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("ProjectLockedError");
    const folder = (await call({ url: "/projects" })).json.projects.find((p: { id: string }) => p.id === pid).folder as string;
    const journalLines = async (libRoot: string) =>
      (await readFile(join(libRoot, ...folder.split("/"), "jobs", "journal.jsonl"), "utf8")).split("\n").filter(Boolean).length;
    expect(await journalLines(root)).toBe(2); // queued, cancelled (PROJECT_LOCKED)
    return { pid, root, journalLines };
  }

  const unlock = async (pid: string) => expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);

  it("the unlock resubmits the job once, as registered work", async () => {
    const { pid, root, journalLines } = await lockCancelledJob(50);
    await unlock(pid);
    expect(svc.state.workKinds()).toContain("worker-resume");
    await svc.state.idle();
    expect(stub!.runs).toEqual([
      { n: 1, cancelled: true },
      { n: 2, cancelled: false },
    ]);
    expect(await journalLines(root)).toBe(5); // + claim (queued), running, done
  });

  it("a move started while the rerun is writing waits for it", async () => {
    const { pid, journalLines } = await lockCancelledJob(400);
    await unlock(pid);
    while (stub!.runs.length < 2) await new Promise((r) => setTimeout(r, 5)); // the rerun is in the worker
    const moved = await call({ method: "POST", url: "/libraries/move", body: { dest: join(tmp, "Moved") } });
    expect(moved.body).toContain('"done":true');
    await svc.state.idle();
    expect(stub!.runs.filter((r) => !r.cancelled)).toHaveLength(1);
    expect(await journalLines(join(tmp, "Moved"))).toBe(5); // the rerun finished in the library that was copied
    // and the moved copy does not run it again once the project is unlocked there
    await unlock(pid);
    await svc.state.idle();
    expect(stub!.runs.filter((r) => !r.cancelled)).toHaveLength(1);
  });

  it("a close started while the rerun is writing waits for it", async () => {
    const { pid, root, journalLines } = await lockCancelledJob(400);
    await unlock(pid);
    while (stub!.runs.length < 2) await new Promise((r) => setTimeout(r, 5)); // the rerun is in the worker
    await svc.state.closeLibrary();
    expect(stub!.runs.filter((r) => !r.cancelled)).toHaveLength(1);
    expect(await journalLines(root)).toBe(5);
  });

  it("nothing is resubmitted while a move holds the library", async () => {
    const { pid } = await lockCancelledJob(0);
    await svc.state.session!.repo.unlockProject(pid, PASS);
    svc.state.moving = true;
    try {
      svc.state.resumeProject(svc.state.session!, pid, { workerJobs: true });
      expect(svc.state.workKinds()).not.toContain("worker-resume");
    } finally {
      svc.state.moving = false;
    }
    await svc.state.idle();
    expect(stub!.runs).toHaveLength(1);
  });
});
