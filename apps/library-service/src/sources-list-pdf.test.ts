/**
 * The sources list's `hasReadablePdf` (R222 b): one boolean on each unlocked row, from the assets the
 * light read of source.json already parsed (R186) by the reader's own rule; never an extra read per
 * row. In a plain project, an encrypted one, a locked one and a read-only library.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { rowAvailability } from "./routes/sources.js";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
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
let deps: Deps;
let svc: LibraryService;

async function start(): Promise<void> {
  svc = await createService({ token: TOKEN, deps, logStream: new Writable({ write: (_c, _e, cb) => cb() }), logLevel: "error", worker: null });
}

async function call(method: "GET" | "POST", url: string, body?: unknown) {
  const res = await svc.app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: res.statusCode, json: res.json() as any };
}

async function newProject(encrypted: boolean): Promise<string> {
  const r = await call("POST", "/projects", { name: encrypted ? "Sealed" : "Open", governanceYaml: OPEN_GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.project.id as string;
}

/** A source titled `title` with the given files (name -> bytes), through the library as an import would. */
async function source(pid: string, title: string, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmp, "in-"));
  await mkdir(dir, { recursive: true });
  const inputs = [];
  for (const [name, data] of Object.entries(files)) {
    await writeFile(join(dir, name), data);
    inputs.push({ path: join(dir, name), role: "original" as const, handling: "copy" as const });
  }
  const sf = await svc.state.session!.repo.createSource(
    pid,
    { projectIds: [pid], type: "report", title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    inputs,
    { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
  );
  return sf.source.id;
}

const rows = async (pid: string) => {
  const r = await call("GET", `/projects/${pid}/sources?limit=100`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return Object.fromEntries((r.json.items as Array<{ title: string; hasReadablePdf?: boolean; locked: boolean; availability?: unknown }>).map((i) => [i.title, i]));
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-list-pdf-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  await start();
  expect((await call("POST", "/libraries", { path: join(tmp, "Lib"), name: "Lib" })).status).toBe(200);
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("the sources list says whether a source has a readable PDF (R222 b)", () => {
  it("a plain project: true for a PDF, false for a source with other files or none", async () => {
    const pid = await newProject(false);
    await source(pid, "With a PDF", { "a.pdf": "%PDF-1.7\nx" });
    await source(pid, "With a picture", { "a.png": "png" });
    await source(pid, "With nothing", {});
    const r = await rows(pid);
    expect(r["With a PDF"]!.hasReadablePdf).toBe(true);
    expect(r["With a picture"]!.hasReadablePdf).toBe(false);
    expect(r["With nothing"]!.hasReadablePdf).toBe(false);
  });

  it("an encrypted project: the same, decrypted by the light read; locked: no row claims anything", async () => {
    const pid = await newProject(true);
    await source(pid, "Sealed PDF", { "a.pdf": "%PDF-1.7\nx" });
    await source(pid, "Sealed picture", { "a.png": "png" });
    const open = await rows(pid);
    expect(open["Sealed PDF"]!.hasReadablePdf).toBe(true);
    expect(open["Sealed picture"]!.hasReadablePdf).toBe(false);
    expect((await call("POST", `/projects/${pid}/lock`)).status).toBe(200);
    const r = await call("GET", `/projects/${pid}/sources?limit=100`);
    for (const i of r.json.items ?? []) {
      expect(i.locked).toBe(true);
      expect("hasReadablePdf" in i).toBe(false);
    }
  });

  it("a read-only library lists the same, from the files", async () => {
    const pid = await newProject(false);
    await source(pid, "With a PDF", { "a.pdf": "%PDF-1.7\nx" });
    await source(pid, "With a picture", { "a.png": "png" });
    expect((await call("POST", "/libraries/close")).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(tmp, "Lib", ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    const opened = await call("POST", "/libraries/open", { path: join(tmp, "Lib") });
    expect(opened.json.mode).toBe("read-only");
    const r = await rows(pid);
    expect(r["With a PDF"]!.hasReadablePdf).toBe(true);
    expect(r["With a picture"]!.hasReadablePdf).toBe(false);
  });

  it("reads each row's record once and nothing else: 100 rows, 100 light reads, no full source read", async () => {
    const pid = await newProject(false);
    for (let i = 0; i < 100; i++) await source(pid, `Source ${i}`, { "a.pdf": "%PDF-1.7\nx" });
    const repo = svc.state.session!.repo as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const calls: Record<string, number> = {};
    for (const name of ["getSourceRecord", "getSourceRecordWithAssets", "getSource"]) {
      const real = repo[name]!.bind(repo);
      repo[name] = (...a: unknown[]) => ((calls[name] = (calls[name] ?? 0) + 1), real(...a));
    }
    const r = await rows(pid);
    expect(Object.keys(r)).toHaveLength(100);
    expect((calls.getSourceRecord ?? 0) + (calls.getSourceRecordWithAssets ?? 0)).toBe(100);
    expect(calls.getSource ?? 0).toBe(0);
    expect(Object.values(r).every((i) => i.hasReadablePdf === true)).toBe(true);
  });

  it("the row's availability is exactly what rowAvailability() returns for the record, on the ordinary and on the read-only path (a field added later is covered)", async () => {
    const pid = await newProject(false);
    const sid = await source(pid, "Gone from its platform", { "a.pdf": "%PDF-1.7\nx" });
    await svc.state.session!.repo.updateSource(pid, sid, { availability: { status: "unavailable-on-platform", firstNoticedAt: "2026-11-03T09:15:00.000Z" } });
    const expected = rowAvailability(await svc.state.session!.repo.getSourceRecord(pid, sid));
    expect(expected).toEqual({ status: "unavailable-on-platform", firstNoticedAt: "2026-11-03T09:15:00.000Z" });
    expect((await rows(pid))["Gone from its platform"]!.availability).toEqual(expected);
    expect((await call("POST", "/libraries/close")).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(tmp, "Lib", ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    expect((await call("POST", "/libraries/open", { path: join(tmp, "Lib") })).json.mode).toBe("read-only");
    expect((await rows(pid))["Gone from its platform"]!.availability).toEqual(expected);
  });
});
