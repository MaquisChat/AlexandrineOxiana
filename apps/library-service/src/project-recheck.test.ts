/**
 * FR-717 (R503 n): the service says which project rechecks are running (`GET /projects/:id/recheck`), so a screen that
 * comes back to the library while one runs shows it at once (and keeps its button off), not only from the job's next
 * event. A recheck is held part-way by holding one source's recheck.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { deviceDeps } from "@ao/library";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let svc: LibraryService;

async function call(method: "GET" | "POST", url: string, body?: unknown) {
  const res = await svc.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, json: res.json() as any, body: res.body };
}

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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-recheck-"));
  svc = await createService({ token: TOKEN, deps: { ...deviceDeps(join(tmp, "config")), settleMs: 0 }, worker: null });
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

async function projectWithTwoSources(): Promise<string> {
  expect((await call("POST", "/libraries", { path: join(tmp, "Lib"), name: "Lib" })).status).toBe(200);
  const p = await call("POST", "/projects", { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
  expect(p.status, p.body).toBe(200);
  const pid = p.json.project.id as string;
  await mkdir(join(tmp, "in"), { recursive: true });
  const paths: string[] = [];
  for (const n of [1, 2]) {
    const f = join(tmp, "in", `p${n}.pdf`);
    await writeFile(f, await buildPdf({ title: `Fieldwork Report ${n}`, author: "Ana Souza", lines: [`Report ${n}.`] }));
    paths.push(f);
  }
  expect((await call("POST", `/projects/${pid}/attach`, { paths })).status).toBe(200);
  return pid;
}

describe("FR-717: the rechecks that are running", () => {
  it("names a running recheck with its progress, and none once it has finished", async () => {
    const pid = await projectWithTwoSources();
    expect(await call("GET", `/projects/${pid}/recheck`)).toMatchObject({ status: 200, json: { running: null } });

    // The second source's recheck is held: the job has done one of two.
    const repo = svc.state.session!.repo;
    const real = repo.recheckSource.bind(repo);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let calls = 0;
    vi.spyOn(repo, "recheckSource").mockImplementation(async (...a: Parameters<typeof real>) => {
      if (++calls === 2) await held;
      return real(...a);
    });
    const first = nextEvent((e) => e.type === "job.progress" && e.data.kind === "recheck" && e.data.done === 1);
    const started = await call("POST", `/projects/${pid}/recheck`);
    expect(started.status).toBe(200);
    await first;

    expect(await call("GET", `/projects/${pid}/recheck`)).toMatchObject({ status: 200, json: { running: { jobId: started.json.jobId, done: 1, total: 2 } } });

    const finished = nextEvent((e) => e.type === "job.progress" && e.data.kind === "recheck" && e.data.finished === true);
    release();
    await finished;
    expect(await call("GET", `/projects/${pid}/recheck`)).toMatchObject({ status: 200, json: { running: null } });
  });

  it("an unknown project is 404", async () => {
    await projectWithTwoSources();
    expect((await call("GET", "/projects/01234567-89ab-7def-8123-456789abcdef/recheck")).status).toBe(404);
  });
});
