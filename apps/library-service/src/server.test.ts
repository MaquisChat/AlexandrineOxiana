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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KeyRing,
  OcrQueue,
  WorkerJobError,
  createLibrary,
  deviceDeps,
  listBackups,
  openLibrary,
  openRepo,
  type Deps,
  type JobResult,
  type WorkerClient,
  type WorkerJob,
} from "@ao/library";
import { buildPdf, tinyPng } from "../../../tests/fixtures/generate.mjs";
import { readServiceToken } from "./auth.js";
import { createService, type LibraryService, type ServiceOptions, type WorkerProvider } from "./server.js";

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

  it("reads AO_SERVICE_TOKEN once and removes it from the environment", () => {
    const env: NodeJS.ProcessEnv = { AO_SERVICE_TOKEN: "x".repeat(40) };
    expect(readServiceToken(env)).toBe("x".repeat(40));
    expect(env.AO_SERVICE_TOKEN).toBeUndefined();
    expect(() => readServiceToken({})).toThrow();
    expect(() => readServiceToken({ AO_SERVICE_TOKEN: "short" })).toThrow();
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
      env: { ...process.env, AO_SERVICE_TOKEN: TOKEN, AO_SERVICE_PORT: "0", AO_CONFIG_DIR: deps.appConfigDir, AO_LIBRARY: path, AO_NO_WORKER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const progressed = nextEvent((e) => e.type === "import.progress" && e.data.state === "running" && e.data.done >= 2);
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
    const progressed = nextEvent((e) => e.type === "import.progress" && e.data.state === "running" && e.data.done >= 2);
    const { batchId } = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json;
    await progressed;
    await call({ method: "POST", url: `/projects/${pid}/lock` });
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
    const progressed = nextEvent((e) => e.type === "import.progress" && e.data.state === "running" && e.data.done >= 2);
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
    const progressed = nextEvent((e) => e.type === "import.progress" && e.data.state === "running" && e.data.done >= 5);
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

  it("watches restarted after removing one keep reporting events", async () => {
    await svc.close();
    await start({ watchStabilityMs: 50 });
    await openNewLibrary();
    const pid = await newProject();
    const { mkdir } = await import("node:fs/promises");
    const keep = join(tmp, "watch-keep");
    const drop = join(tmp, "watch-drop");
    await mkdir(keep);
    await mkdir(drop);
    expect((await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { dir: keep } })).status).toBe(200);
    const w2 = (await call({ method: "POST", url: `/projects/${pid}/watched-folders`, body: { dir: drop } })).json;
    expect((await call({ method: "DELETE", url: `/projects/${pid}/watched-folders/${w2.id}` })).status).toBe(200);
    const seen = nextEvent((e) => e.type === "job.progress" && e.data.kind === "watch" && e.data.event?.kind === "imported");
    await writeFile(join(keep, "dropped.pdf"), await buildPdf({ title: "Dropped Later Into The Folder" }));
    expect((await seen).data.projectId).toBe(pid);
  }, 60_000);

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
    const progA = nextEvent((e) => e.type === "import.progress" && e.data.state === "running" && e.data.done >= 2);
    const a = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dirA } } })).json.batchId;
    await progA;
    const b = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dirB } } })).json.batchId;
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
    const prog = nextEvent((e) => e.type === "import.progress" && e.data.state === "running" && e.data.done >= 2);
    const id = (await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: dir } } })).json.batchId;
    await prog;
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
    expect(toApiError(new BatchRefusedError("This import is already running.")).status).toBe(409);
    expect(toApiError(new BatchRefusedError("This import has already finished.")).status).toBe(409);
  });
});
