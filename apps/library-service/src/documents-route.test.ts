/**
 * The ranged PDF route (Task R5): `GET /projects/:id/sources/:sid/assets/:aid/document` with the UI
 * token and one byte range; 206 with Content-Range; an encrypted project's file decrypted for
 * exactly the range asked; each refusal in plain words with no file-system path; reading changes
 * nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { DOCUMENT_RANGE_MAX_BYTES, READER_PDF_MAX_BYTES } from "@ao/shared";
import { tinyPng } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const MiB = 1024 * 1024;
/** The encrypted format's plaintext chunk (crypto/random-access.ts). */
const CHUNK = MiB;
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let tmp: string;
let deps: Deps;
let logs: string;
let svc: LibraryService;

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null, ...over });
  return svc;
}

type Inject = { method?: "GET" | "POST" | "HEAD"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean };
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

const docUrl = (pid: string, sid: string, aid: string) => `/projects/${pid}/sources/${sid}/assets/${aid}/document`;
const get = (pid: string, sid: string, aid: string, range?: string, headers: Record<string, string> = {}) => call({ url: docUrl(pid, sid, aid), headers: { ...(range !== undefined ? { range } : {}), ...headers } });

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

/** A source with one original made from `file` (through the library, as an import would). */
async function sourceWith(projectId: string, file: string, handling: "copy" | "link" = "copy", type = "report"): Promise<{ sid: string; aid: string }> {
  const repo = svc.state.session!.repo;
  const sf = await repo.createSource(
    projectId,
    { projectIds: [projectId], type: type as never, title: { variants: [{ lang: "en", kind: "original", value: "Paper" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [{ path: file, role: "original", handling }],
    { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
  );
  return { sid: sf.source.id, aid: sf.assets[0]!.id };
}

async function scratch(name: string, data: Buffer | string): Promise<string> {
  const dir = join(tmp, "in", Math.random().toString(36).slice(2));
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

/** Bytes that start like a PDF (the type is recorded from the extension; nothing parses it here). */
const pdfBytes = (n: number): Buffer => {
  const b = randomBytes(n);
  b.write("%PDF-1.7\n", 0, "latin1");
  return b;
};

/** Every error answer: the service's shape only, no path of this test's folders, no file bytes. */
function plainError(r: Awaited<ReturnType<typeof call>>, status: number, code: string, message?: string): void {
  expect(r.status, r.body).toBe(status);
  expect(r.headers["content-type"]).toMatch(/^application\/json/);
  expect(Object.keys(r.json)).toEqual(["error"]);
  expect(r.json.error.code).toBe(code);
  if (message !== undefined) expect(r.json.error.message).toBe(message);
  expect(r.body).not.toContain(tmp);
  expect(r.headers["content-range"]).toBeUndefined();
}

/** Every file under `dir` with its content hash (the heartbeat `.lock` file aside). */
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

const ASK = "Ask for a byte range.";
const UNSAFE = "This file could not be opened safely.";
const MISSING = "The file of this source is not where it was recorded.";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-documents-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("the ranged PDF route (Task R5)", () => {
  it("the limits are the plan's: 4 MiB per answer, 512 MiB per PDF", () => {
    expect(DOCUMENT_RANGE_MAX_BYTES).toBe(4 * MiB);
    expect(READER_PDF_MAX_BYTES).toBe(512 * MiB);
  });

  it("serves the first MiB of a stored PDF with its total", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const data = pdfBytes(3 * MiB + 123);
    const { sid, aid } = await sourceWith(pid, await scratch("paper.pdf", data));
    const r = await get(pid, sid, aid, `bytes=0-${MiB - 1}`);
    expect(r.status, r.body).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes 0-${MiB - 1}/${data.length}`);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-length"]).toBe(String(MiB));
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["content-disposition"]).toBe("inline");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(r.raw.equals(data.subarray(0, MiB))).toBe(true);
    // The other forms of one range: open-ended, and the last n bytes.
    const tail = await get(pid, sid, aid, `bytes=${3 * MiB}-`);
    expect(tail.status).toBe(206);
    expect(tail.headers["content-range"]).toBe(`bytes ${3 * MiB}-${data.length - 1}/${data.length}`);
    expect(tail.raw.equals(data.subarray(3 * MiB))).toBe(true);
    const last = await get(pid, sid, aid, "bytes=-10");
    expect(last.headers["content-range"]).toBe(`bytes ${data.length - 10}-${data.length - 1}/${data.length}`);
    expect(last.raw.equals(data.subarray(data.length - 10))).toBe(true);
    // An end past the file is cut to the file.
    const over = await get(pid, sid, aid, `bytes=${data.length - 5}-${data.length + 1000}`);
    expect(over.headers["content-range"]).toBe(`bytes ${data.length - 5}-${data.length - 1}/${data.length}`);
    expect(over.raw.equals(data.subarray(data.length - 5))).toBe(true);
  });

  it("decrypts a range of an encrypted project's PDF", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    // Ends 5 bytes into a fourth chunk: ranges across a boundary, at the very end, and on a boundary.
    const data = pdfBytes(3 * CHUNK + 5);
    const { sid, aid } = await sourceWith(pid, await scratch("sealed.pdf", data));
    const stored = (await svc.state.session!.repo.getSource(pid, sid)).assets[0]!;
    expect(stored.encrypted).toBe(true);
    const ranges: Array<[number, number]> = [
      [0, 99],
      [CHUNK - 10, CHUNK + 10],
      [CHUNK - 1, CHUNK],
      [CHUNK, 2 * CHUNK - 1],
      [CHUNK - 3, 3 * CHUNK + 4],
      [3 * CHUNK - 3, 3 * CHUNK + 4],
      [3 * CHUNK, 3 * CHUNK + 4],
      [3 * CHUNK + 4, 3 * CHUNK + 4],
    ];
    for (const [a, b] of ranges) {
      const r = await get(pid, sid, aid, `bytes=${a}-${b}`);
      expect(r.status, `${a}-${b}`).toBe(206);
      expect(r.headers["content-range"]).toBe(`bytes ${a}-${b}/${data.length}`);
      expect(r.raw.equals(data.subarray(a, b + 1)), `${a}-${b}`).toBe(true);
    }
    const last = await get(pid, sid, aid, "bytes=-1");
    expect(last.raw.equals(data.subarray(data.length - 1))).toBe(true);
    // A file that ends exactly on a chunk boundary.
    const even = pdfBytes(2 * CHUNK);
    const e = await sourceWith(pid, await scratch("even.pdf", even));
    const end = await get(pid, e.sid, e.aid, `bytes=${2 * CHUNK - 7}-${2 * CHUNK - 1}`);
    expect(end.status).toBe(206);
    expect(end.headers["content-range"]).toBe(`bytes ${2 * CHUNK - 7}-${2 * CHUNK - 1}/${even.length}`);
    expect(end.raw.equals(even.subarray(2 * CHUNK - 7))).toBe(true);
    expect((await get(pid, e.sid, e.aid, `bytes=${2 * CHUNK}-`)).status).toBe(416);
  });

  it("a request without Range is refused", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("paper.pdf", pdfBytes(5000)));
    plainError(await get(pid, sid, aid), 400, "VALIDATION", ASK);
    for (const range of ["bytes=0-1,5-9", "bytes=0-1, 5-9", "items=0-9", "bytes=", "bytes=-", "bytes=9-1", "bytes=a-b", "0-9", "bytes=0-9 junk"]) {
      plainError(await get(pid, sid, aid, range), 400, "VALIDATION", ASK);
    }
    // An If-Range never opens the whole file: refused like any other range it cannot honour.
    plainError(await get(pid, sid, aid, "bytes=0-9", { "if-range": '"x"' }), 400, "VALIDATION", ASK);
    plainError(await get(pid, sid, aid, "bytes=0-9", { "if-range": new Date().toUTCString() }), 400, "VALIDATION", ASK);
    // A range starting past the end: 416 with the total.
    const past = await get(pid, sid, aid, "bytes=5000-5009");
    expect(past.status).toBe(416);
    expect(past.headers["content-range"]).toBe("bytes */5000");
    expect(past.raw.length).toBe(0);
    // Only GET: no HEAD (which would say the size without a range).
    expect((await call({ method: "HEAD", url: docUrl(pid, sid, aid), headers: { range: "bytes=0-9" } })).status).toBe(404);
  });

  it("a 10 MiB range is cut to 4 MiB", async () => {
    await start();
    await openLibrary();
    for (const encrypted of [false, true]) {
      const pid = await newProject(encrypted, encrypted ? "Sealed" : "Open");
      const data = pdfBytes(11 * MiB);
      const { sid, aid } = await sourceWith(pid, await scratch("big.pdf", data));
      const a = MiB + 17;
      const r = await get(pid, sid, aid, `bytes=${a}-${a + 10 * MiB - 1}`);
      expect(r.status).toBe(206);
      expect(r.headers["content-range"]).toBe(`bytes ${a}-${a + DOCUMENT_RANGE_MAX_BYTES - 1}/${data.length}`);
      expect(r.headers["content-length"]).toBe(String(DOCUMENT_RANGE_MAX_BYTES));
      expect(r.raw.equals(data.subarray(a, a + DOCUMENT_RANGE_MAX_BYTES))).toBe(true);
      // The suffix and open-ended forms too.
      const suffix = await get(pid, sid, aid, `bytes=-${10 * MiB}`);
      expect(suffix.headers["content-range"]).toBe(`bytes ${MiB}-${MiB + DOCUMENT_RANGE_MAX_BYTES - 1}/${data.length}`);
      expect(suffix.raw.length).toBe(DOCUMENT_RANGE_MAX_BYTES);
      const open = await get(pid, sid, aid, "bytes=0-");
      expect(open.headers["content-range"]).toBe(`bytes 0-${DOCUMENT_RANGE_MAX_BYTES - 1}/${data.length}`);
      expect(open.raw.equals(data.subarray(0, DOCUMENT_RANGE_MAX_BYTES))).toBe(true);
    }
  });

  it("a picture asset is refused", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const pic = await sourceWith(pid, await scratch("shot.png", tinyPng()), "copy", "image");
    plainError(await get(pid, pic.sid, pic.aid, "bytes=0-9"), 400, "VALIDATION", "This file cannot be shown here.");
    const audio = await sourceWith(pid, await scratch("talk.mp3", randomBytes(100)), "copy", "audio");
    plainError(await get(pid, audio.sid, audio.aid, "bytes=0-9"), 400, "VALIDATION", "This file cannot be shown here.");
    // Unknown ids: 404, nothing more.
    const { sid, aid } = await sourceWith(pid, await scratch("paper.pdf", pdfBytes(100)));
    plainError(await get(pid, sid, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "bytes=0-9"), 404, "NOT_FOUND");
    plainError(await get(pid, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", aid, "bytes=0-9"), 404, "NOT_FOUND");
    plainError(await get("01ZZZZZZZZZZZZZZZZZZZZZZZZ", sid, aid, "bytes=0-9"), 404, "NOT_FOUND");
    // Another source's asset id under this source: not found.
    const other = await sourceWith(pid, await scratch("other.pdf", pdfBytes(100)));
    plainError(await get(pid, sid, other.aid, "bytes=0-9"), 404, "NOT_FOUND");
  });

  it("a missing linked file answers 404 in plain words", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const gone = await scratch("gone.pdf", pdfBytes(1000));
    const a = await sourceWith(pid, gone, "link");
    expect((await get(pid, a.sid, a.aid, "bytes=0-9")).status).toBe(206);
    await unlink(gone);
    plainError(await get(pid, a.sid, a.aid, "bytes=0-9"), 404, "NOT_FOUND", MISSING);
    // Moved away.
    const moved = await scratch("moved.pdf", pdfBytes(1000));
    const b = await sourceWith(pid, moved, "link");
    await rename(moved, `${moved}.elsewhere`);
    plainError(await get(pid, b.sid, b.aid, "bytes=0-9"), 404, "NOT_FOUND", MISSING);
    // A stored copy that is no longer in the library.
    const c = await sourceWith(pid, await scratch("stored.pdf", pdfBytes(1000)));
    const rel = (await svc.state.session!.repo.getSource(pid, c.sid)).assets[0]!.path;
    await unlink(join(tmp, "Lib", ...rel.split("/")));
    plainError(await get(pid, c.sid, c.aid, "bytes=0-9"), 404, "NOT_FOUND", MISSING);
    expect(logs).not.toContain(tmp);
  });

  it("a symbolic link swapped in for the stored file or the linked file is never followed", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const secret = await scratch("secret.pdf", "%PDF-1.7 SECRET-BYTES-OUTSIDE");
    const inside = await sourceWith(pid, await scratch("inside.pdf", "%PDF-1.7 INSIDE-THE-LIBRARY"));
    const insideAbs = join(tmp, "Lib", ...(await svc.state.session!.repo.getSource(pid, inside.sid)).assets[0]!.path.split("/"));

    // A stored file replaced by a link to a file outside the library.
    const c = await sourceWith(pid, await scratch("stored.pdf", pdfBytes(1000)));
    const abs = join(tmp, "Lib", ...(await svc.state.session!.repo.getSource(pid, c.sid)).assets[0]!.path.split("/"));
    expect((await get(pid, c.sid, c.aid, "bytes=0-9")).status).toBe(206); // before the swap: served
    await unlink(abs);
    await symlink(secret, abs);
    const out = await get(pid, c.sid, c.aid, "bytes=0-");
    plainError(out, 400, "VALIDATION", UNSAFE);
    expect(out.body).not.toContain("SECRET-BYTES");
    // …and by a link to another file inside the library.
    await unlink(abs);
    await symlink(insideAbs, abs);
    const inLib = await get(pid, c.sid, c.aid, "bytes=0-");
    plainError(inLib, 400, "VALIDATION", UNSAFE);
    expect(inLib.body).not.toContain("INSIDE-THE-LIBRARY");

    // A linked file replaced by a link.
    const linked = await scratch("linked.pdf", pdfBytes(1000));
    const l = await sourceWith(pid, linked, "link");
    await unlink(linked);
    await symlink(secret, linked);
    const viaLink = await get(pid, l.sid, l.aid, "bytes=0-");
    plainError(viaLink, 400, "VALIDATION", UNSAFE);
    expect(viaLink.body).not.toContain("SECRET-BYTES");
  });

  it("a file over the limit answers 413, decided from the recorded size before the file is opened", async () => {
    await start({ readerPdfMaxBytes: 4000 });
    await openLibrary();
    const pid = await newProject();
    const big = await scratch("big.pdf", pdfBytes(4001));
    const { sid, aid } = await sourceWith(pid, big, "link");
    const tooBig = "This PDF is larger than 512 MB, too large to open in the app.";
    plainError(await get(pid, sid, aid, "bytes=0-9"), 413, "PAYLOAD_TOO_LARGE", tooBig);
    // Gone from disk: still 413, so the file was never needed to decide.
    await unlink(big);
    plainError(await get(pid, sid, aid, "bytes=0-9"), 413, "PAYLOAD_TOO_LARGE", tooBig);
    // At the limit: served.
    const ok = await sourceWith(pid, await scratch("ok.pdf", pdfBytes(4000)));
    expect((await get(pid, ok.sid, ok.aid, "bytes=0-9")).status).toBe(206);
  });

  it("the extension token is refused", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("paper.pdf", pdfBytes(100)));
    expect((await get(pid, sid, aid, "bytes=0-9")).status).toBe(206); // the desktop app's token: served
    // No token at all.
    expect((await call({ url: docUrl(pid, sid, aid), noAuth: true, headers: { range: "bytes=0-9" } })).status).toBe(401);
    // The token in the address: refused before anything else.
    expect((await call({ url: `${docUrl(pid, sid, aid)}?token=${TOKEN}`, noAuth: true, headers: { range: "bytes=0-9" } })).status).toBe(401);
    // The extension's token.
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const ext = c.json().token as string;
    const byExt = await call({ url: docUrl(pid, sid, aid), noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT, range: "bytes=0-9" } });
    expect(byExt.status).toBe(403);
    expect(byExt.raw.subarray(0, 4).toString("latin1")).not.toBe("%PDF");
    // Another origin with the UI token, and a host that is not ours.
    expect((await get(pid, sid, aid, "bytes=0-9", { origin: "https://evil.example" })).status).toBe(403);
    expect((await get(pid, sid, aid, "bytes=0-9", { host: "evil.example" })).status).toBe(403);
  });

  it("a read-only library can read", async () => {
    await start();
    const path = await openLibrary();
    const pid = await newProject();
    const data = pdfBytes(5000);
    const { sid, aid } = await sourceWith(pid, await scratch("paper.pdf", data));
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    const now = new Date().toISOString();
    await writeFile(join(path, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect(opened.json.mode).toBe("read-only");
    const r = await get(pid, sid, aid, "bytes=100-199");
    expect(r.status, r.body).toBe(206);
    expect(r.raw.equals(data.subarray(100, 200))).toBe(true);
  });

  it("a locked project answers 423", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("sealed.pdf", pdfBytes(5000)));
    expect((await get(pid, sid, aid, "bytes=0-9")).status).toBe(206);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const locked = "This project is locked. Its passphrase is needed.";
    plainError(await get(pid, sid, aid, "bytes=0-9"), 423, "PROJECT_LOCKED", locked);
    // Locked reveals nothing: an unknown source or asset, a missing range: the same answer.
    plainError(await get(pid, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", aid, "bytes=0-9"), 423, "PROJECT_LOCKED", locked);
    plainError(await get(pid, sid, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "bytes=0-9"), 423, "PROJECT_LOCKED", locked);
    plainError(await get(pid, sid, aid), 423, "PROJECT_LOCKED", locked);
    // Unlocked again: served.
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await get(pid, sid, aid, "bytes=0-9")).status).toBe(206);
  });

  it("a lock between opening the file and the first byte: the service's error shape, no bytes", async () => {
    let pid = "";
    await start({
      documentBeforeRead: async () => {
        svc.state.session!.repo.lockProject(pid);
      },
    });
    await openLibrary();
    pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("sealed.pdf", pdfBytes(2 * CHUNK)));
    const r = await get(pid, sid, aid, "bytes=0-99");
    plainError(r, 423, "PROJECT_LOCKED");
  });

  it("reading changes nothing on disk and audits nothing", async () => {
    await start();
    const lib = await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("sealed.pdf", pdfBytes(2 * CHUNK + 3)));
    const audit = async () => (await call({ url: `/projects/${pid}/audit` })).body;
    const auditBefore = await audit();
    const before = await snapshot(lib);
    const statuses: number[] = [];
    for (const range of ["bytes=0-99", `bytes=${CHUNK - 5}-${CHUNK + 5}`, "bytes=-3", undefined, "bytes=0-1,4-5", `bytes=${3 * CHUNK}-`]) statuses.push((await get(pid, sid, aid, range)).status);
    expect(statuses).toEqual([206, 206, 206, 400, 400, 416]);
    expect(await snapshot(lib)).toEqual(before);
    expect(await audit()).toBe(auditBefore);
  });
});
