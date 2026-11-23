/**
 * R470 b (FR-490): the read-only route of the app's own for a held file — `GET /projects/:id/review/:itemId/held-file/document`
 * — the file Find and acquire holds for one pending entry of one project, served by ranges for the reader to LOOK at
 * before "Use this file" / "Not this file". The app's token only (never the extension's), the service's Host and Origin
 * checks; one byte range, 206 with Content-Range; an encrypted project's file decrypted through the same reading code
 * as a stored PDF's; a locked project refused as locked (and a lock in mid-read ends the read as locked); no held file
 * (an unknown entry, one of another project, one that holds none, one decided, a file gone) one plain 404; an EPUB
 * "cannot be shown here"; and a look writes nothing, audits nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@ao/core";
import { deviceDeps, type Deps, type FindEntry } from "@ao/library";
import { DOCUMENT_RANGE_MAX_BYTES } from "@ao/shared";
import { appendFindEntriesIn, holdMismatchedFileIn } from "../../../packages/library/src/repo/repo.js";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const MiB = 1024 * 1024;
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const SHELL = ["tauri://localhost", "http://tauri.localhost"];
const LOCKED = "This project is locked. Its passphrase is needed.";
const NO_FILE = "That file was not found.";

let tmp: string;
let deps: Deps;
let svc: LibraryService;

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  svc = await createService({ token: TOKEN, deps, worker: null, ...over });
  return svc;
}

type Inject = { method?: "GET" | "POST" | "OPTIONS"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean };
async function call(r: Inject) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...(r.noAuth ? {} : auth), ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body, raw: res.rawPayload, headers: res.headers };
}

const lookUrl = (pid: string, rid: string) => `/projects/${pid}/review/${rid}/held-file/document`;
const look = (pid: string, rid: string, range?: string, headers: Record<string, string> = {}) => call({ url: lookUrl(pid, rid), headers: { ...(range !== undefined ? { range } : {}), ...headers } });

async function openLibrary(): Promise<string> {
  const path = join(tmp, "Lib");
  const r = await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } });
  expect(r.status, r.body).toBe(200);
  return path;
}

async function newProject(encrypted = false, name = "Study"): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: OPEN_GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

const pdfBytes = (n: number): Buffer => {
  const b = randomBytes(n);
  b.write("%PDF-1.7\n", 0, "latin1");
  return b;
};

/** A record, its queue entry, and a file held for it (as the runner holds one): the review entry's id and the file's bytes. */
async function heldFor(pid: string, data: Buffer = pdfBytes(3 * MiB + 17), kind: "pdf" | "epub" = "pdf"): Promise<{ rid: string; sid: string; held: string; data: Buffer }> {
  const repo = svc.state.session!.repo;
  const sf = await repo.createSource(
    pid,
    { projectIds: [pid], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "Rivers and Memory" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [],
    { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
  );
  const at = new Date().toISOString();
  const entry: FindEntry = { id: newId(), projectId: pid, typed: "Rivers and Memory", state: "fetching", createdAt: at, updatedAt: at, attempts: 0, sourceId: sf.source.id };
  await appendFindEntriesIn(repo, pid, [entry], "add");
  const dir = join(tmp, "in", Math.random().toString(36).slice(2));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `found.${kind}`);
  await writeFile(file, data);
  const r = await holdMismatchedFileIn(repo, pid, {
    entry: { ...entry, state: "needs-check", reason: { code: "file-other-doi" } },
    sourceId: sf.source.id,
    fromPath: file,
    facts: { why: "other-doi", kind, bytes: data.length, acquired: { method: "free_copy", via: "service", service: "arxiv", address: "https://arxiv.org/pdf/2101.00001", at, tool: { name: "find-and-acquire", version: "0" }, access: "public" } },
  });
  return { rid: r.reviewId, sid: sf.source.id, held: r.held, data };
}

/** Every error answer: the service's shape only, no path of this test's folders, nothing of the file. */
function plainError(r: Awaited<ReturnType<typeof call>>, status: number, code: string, message?: string): void {
  expect(r.status, r.body).toBe(status);
  expect(r.headers["content-type"]).toMatch(/^application\/json/);
  expect(Object.keys(r.json)).toEqual(["error"]);
  expect(r.json.error.code).toBe(code);
  if (message !== undefined) expect(r.json.error.message).toBe(message);
  expect(r.body).not.toContain(tmp);
  expect(r.body).not.toMatch(/find\/held|\.pdf|\.epub/u);
  expect(r.headers["content-range"]).toBeUndefined();
}

/** Every file under `dir` with its content hash and time (the heartbeat `.lock` aside). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else if (e.name !== ".lock") out[r] = `${(await stat(p)).mtimeMs}:${createHash("sha256").update(await readFile(p)).digest("hex")}`;
    }
  };
  await walk(dir, "");
  return out;
}

/** A GET over a real socket, paused after its first data. */
function socketGet(port: number, path: string, headers: Record<string, string>) {
  let res: IncomingMessage | undefined;
  let received = 0;
  let firstData: () => void = () => {};
  const first = new Promise<void>((r) => (firstData = r));
  let ended: (how: string) => void = () => {};
  const done = new Promise<string>((r) => (ended = r));
  const req: ClientRequest = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}`, ...auth, ...headers } }, (r) => {
    res = r;
    r.on("data", (d: Buffer) => {
      received += d.length;
      if (received === d.length) {
        r.pause();
        firstData();
      }
    });
    r.on("close", () => ended(r.complete ? "end" : "aborted"));
  });
  req.on("error", () => ended("aborted"));
  req.end();
  return { first, done, status: () => res?.statusCode ?? 0, received: () => received, resume: () => res?.resume() };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-held-look-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("R470 b: the held file, looked at by ranges", () => {
  for (const encrypted of [false, true]) {
    it(`${encrypted ? "an encrypted" : "a plain"} project: a range of the held PDF, with its total, and nothing written or audited`, async () => {
      await start();
      const lib = await openLibrary();
      const pid = await newProject(encrypted);
      const h = await heldFor(pid);
      expect(h.held.endsWith(".enc")).toBe(encrypted);
      const audit = async () => (await call({ url: `/projects/${pid}/audit` })).body;
      const auditBefore = await audit();
      const before = await snapshot(lib);
      const r = await look(pid, h.rid, `bytes=0-${MiB - 1}`);
      expect(r.status, r.body).toBe(206);
      expect(r.headers["content-range"]).toBe(`bytes 0-${MiB - 1}/${h.data.length}`);
      expect(r.headers["content-type"]).toBe("application/pdf");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.raw.equals(h.data.subarray(0, MiB))).toBe(true);
      // Across the format's chunk boundary, and the last bytes.
      const mid = await look(pid, h.rid, `bytes=${MiB - 5}-${MiB + 4}`);
      expect(mid.raw.equals(h.data.subarray(MiB - 5, MiB + 5))).toBe(true);
      const last = await look(pid, h.rid, "bytes=-10");
      expect(last.raw.equals(h.data.subarray(h.data.length - 10))).toBe(true);
      // An answer is cut to the route's limit, as the reader's own route.
      const big = await look(pid, h.rid, "bytes=0-");
      expect(big.headers["content-range"]).toBe(`bytes 0-${Math.min(DOCUMENT_RANGE_MAX_BYTES, h.data.length) - 1}/${h.data.length}`);
      expect(await snapshot(lib)).toEqual(before);
      expect(await audit()).toBe(auditBefore);
      // The entry still waits for the researcher's decision, its file still held.
      const q = await call({ url: `/projects/${pid}/review` });
      expect((q.json.items as Array<{ id: string }>).map((e) => e.id)).toContain(h.rid);
    });
  }

  it("one byte range is required", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const h = await heldFor(pid, pdfBytes(5000));
    plainError(await look(pid, h.rid), 400, "VALIDATION", "Ask for a byte range.");
    plainError(await look(pid, h.rid, "bytes=0-1,5-9"), 400, "VALIDATION", "Ask for a byte range.");
    const past = await look(pid, h.rid, "bytes=6000-");
    expect([past.status, past.headers["content-range"]]).toEqual([416, "bytes */5000"]);
  });

  it("an EPUB held: this file cannot be shown here", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const h = await heldFor(pid, Buffer.from("PK\u0003\u0004 an epub"), "epub");
    plainError(await look(pid, h.rid, "bytes=0-9"), 400, "VALIDATION", "This file cannot be shown here.");
  });

  it("no held file: an unknown entry, one of another project, one that holds none, a decided one, a file gone — the same plain 404", async () => {
    await start();
    const lib = await openLibrary();
    const pid = await newProject();
    const other = await newProject(false, "Other");
    const h = await heldFor(pid, pdfBytes(5000));
    plainError(await look(pid, newId(), "bytes=0-9"), 404, "NOT_FOUND", NO_FILE);
    plainError(await look(other, h.rid, "bytes=0-9"), 404, "NOT_FOUND", NO_FILE);
    plainError(await look(newId(), h.rid, "bytes=0-9"), 404, "NOT_FOUND");
    // An entry that holds no file (a record to check).
    const repo = svc.state.session!.repo;
    await repo.createSource(
      pid,
      { projectIds: [pid], type: "webpage", title: { variants: [{ lang: "en", kind: "original", value: "A page" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false }, reviewItem: { kind: "verification", fields: {}, reasons: ["Check the date."] } },
    );
    const items = (await call({ url: `/projects/${pid}/review` })).json.items as Array<{ id: string; group: string }>;
    const plain = items.find((e) => e.group !== "found-file")!;
    plainError(await look(pid, plain.id, "bytes=0-9"), 404, "NOT_FOUND", NO_FILE);
    // The held file gone from its place.
    const h2 = await heldFor(pid, pdfBytes(5000));
    await rm(join(lib, repo.getProject(pid).folder, h2.held));
    plainError(await look(pid, h2.rid, "bytes=0-9"), 404, "NOT_FOUND", NO_FILE);
    // Decided: "Not this file".
    expect((await call({ method: "POST", url: `/review/${h.rid}/held-file`, body: { projectId: pid, decision: "discard" } })).status).toBe(200);
    plainError(await look(pid, h.rid, "bytes=0-9"), 404, "NOT_FOUND", NO_FILE);
  });

  it("a locked project answers 423, and says nothing of its entries", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const h = await heldFor(pid, pdfBytes(5000));
    expect((await look(pid, h.rid, "bytes=0-9")).status).toBe(206);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    plainError(await look(pid, h.rid, "bytes=0-9"), 423, "PROJECT_LOCKED", LOCKED);
    plainError(await look(pid, newId(), "bytes=0-9"), 423, "PROJECT_LOCKED", LOCKED);
    plainError(await look(pid, h.rid), 423, "PROJECT_LOCKED", LOCKED);
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await look(pid, h.rid, "bytes=0-9")).status).toBe(206);
  });

  it("a lock between opening the file and the first byte: locked, never damaged, no bytes", async () => {
    let pid = "";
    await start({
      documentBeforeRead: async () => {
        svc.state.session!.repo.lockProject(pid);
      },
    });
    await openLibrary();
    pid = await newProject(true);
    const h = await heldFor(pid, pdfBytes(2 * MiB));
    plainError(await look(pid, h.rid, "bytes=0-99"), 423, "PROJECT_LOCKED", LOCKED);
  });

  it("a lock in the middle of a read: the read ends, the next range answers as locked", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const h = await heldFor(pid, pdfBytes(6 * MiB));
    const port = await svc.listen(0);
    const s = socketGet(port, lookUrl(pid, h.rid), { range: `bytes=0-${DOCUMENT_RANGE_MAX_BYTES - 1}` });
    await s.first;
    expect(s.status()).toBe(206);
    svc.state.session!.repo.lockProject(pid);
    s.resume();
    expect(["end", "aborted"]).toContain(await s.done);
    expect(s.received()).toBeLessThanOrEqual(DOCUMENT_RANGE_MAX_BYTES);
    plainError(await call({ url: lookUrl(pid, h.rid), headers: { host: `127.0.0.1:${port}`, range: `bytes=${MiB}-${MiB + 99}` } }), 423, "PROJECT_LOCKED", LOCKED);
  });
});

describe("R470 b: the app's own route", () => {
  it("no token, another host, a foreign origin: refused as every route refuses them", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const h = await heldFor(pid, pdfBytes(3000));
    plainError(await call({ url: lookUrl(pid, h.rid), noAuth: true, headers: { range: "bytes=0-9" } }), 401, "UNAUTHORIZED");
    plainError(await look(pid, h.rid, "bytes=0-9", { host: "evil.example:80" }), 403, "FORBIDDEN");
    plainError(await look(pid, h.rid, "bytes=0-9", { origin: "https://evil.example" }), 403, "FORBIDDEN");
  });

  it("the shell's preflight allows Range on it, and its answers expose Content-Range", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const h = await heldFor(pid, pdfBytes(3000));
    for (const origin of SHELL) {
      const pre = await call({ method: "OPTIONS", url: lookUrl(pid, h.rid), noAuth: true, headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization,range" } });
      expect(pre.status, pre.body).toBe(204);
      expect(String(pre.headers["access-control-allow-headers"]).split(/,\s*/).sort()).toEqual(["authorization", "content-type", "range"]);
      const r = await look(pid, h.rid, "bytes=0-9", { origin });
      expect(r.status).toBe(206);
      expect(r.headers["access-control-expose-headers"]).toBe("Content-Range");
      expect(r.raw.equals(h.data.subarray(0, 10))).toBe(true);
    }
  });
});
