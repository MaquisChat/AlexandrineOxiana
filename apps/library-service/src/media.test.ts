/**
 * Pictures and audio/video from the service (Task 34a, R135): the picture content route (UI token,
 * raster types, no-store, size limit), media tickets (issued with the UI token for one audio/video
 * asset of one unlocked project; 256 bits; memory only; path only; 10 idle minutes, 8 hours at
 * most; revoked on lock, library close or move, and service stop; 16 at most) and the media route
 * (GET/HEAD with ranges, decrypting as it streams, Host and Origin and Sec-Fetch checks, nosniff,
 * no-store, inline, the ticket never in a log line or error).
 */
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import { MEDIA_TICKET_IDLE_MS, MEDIA_TICKET_LIFETIME_MS, MEDIA_TICKET_PATH, type MediaTicketResponse } from "@ao/shared";
import { tinyPng } from "../../../tests/fixtures/generate.mjs";
import { MEDIA_TICKET_MARKS_MAX } from "./media.js";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };
const CHUNK = 1024 * 1024;
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
const clock = { ms: Date.parse("2026-11-11T10:00:00.000Z") };
/** Set once a test listens on a real port: injected requests must then name it in Host. */
let hostHeader: Record<string, string> = {};

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  logs = "";
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  svc = await createService({ token: TOKEN, deps, logStream, logLevel: "trace", worker: null, now: () => new Date(clock.ms), pairing: { confirmPerMinute: 100 }, ...over });
  return svc;
}

type Inject = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"; url: string; body?: unknown; headers?: Record<string, string>; noAuth?: boolean };
async function call(r: Inject) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...hostHeader, ...(r.noAuth ? {} : auth), ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...r.headers },
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

/** A media request: no token, as a media element sends it. */
const media = (path: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") => call({ method, url: path, headers, noAuth: true });

async function openLibrary(): Promise<void> {
  const r = await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } });
  expect(r.status, r.body).toBe(200);
}

async function newProject(encrypted = false, name = "Study", governanceYaml = OPEN_GOV): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

/** A source with one original made from `file` (through the library, as an import would). */
async function sourceWith(projectId: string, file: string, type = "audio", identifiable = false): Promise<{ sid: string; aid: string }> {
  const repo = svc.state.session!.repo;
  const sf = await repo.createSource(
    projectId,
    { projectIds: [projectId], type: type as never, title: { variants: [{ lang: "en", kind: "original", value: "Recording" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
    [{ path: file, role: "original", handling: "copy" }],
    { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable } },
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

const ticketUrl = (pid: string, sid: string, aid: string) => `/projects/${pid}/sources/${sid}/assets/${aid}/media-ticket`;
async function ticket(pid: string, sid: string, aid: string): Promise<MediaTicketResponse> {
  const r = await call({ method: "POST", url: ticketUrl(pid, sid, aid) });
  expect(r.status, r.body).toBe(200);
  return r.json as MediaTicketResponse;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-media-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  clock.ms = Date.parse("2026-11-11T10:00:00.000Z");
  hostHeader = {};
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("media tickets: issuing (R135 2)", () => {
  beforeEach(() => start());

  it("UI token only; 256 random bits in the path; one asset; a non-media asset, a locked project and an unknown asset are refused", async () => {
    await openLibrary();
    const pid = await newProject();
    const audio = randomBytes(5000);
    const { sid, aid } = await sourceWith(pid, await scratch("talk.mp3", audio));
    const t = await ticket(pid, sid, aid);
    expect(t.path).toMatch(MEDIA_TICKET_PATH);
    expect(Buffer.from(t.path.slice("/media/".length), "base64url")).toHaveLength(32);
    expect(t).toMatchObject({ mime: "audio/mpeg", size: 5000 });
    expect(Date.parse(t.idleExpiresAt) - clock.ms).toBe(10 * 60_000);
    expect(Date.parse(t.expiresAt) - clock.ms).toBe(8 * 3600_000);
    const t2 = await ticket(pid, sid, aid);
    expect(t2.path).not.toBe(t.path);

    // No token, and the extension's token: refused.
    expect((await call({ method: "POST", url: ticketUrl(pid, sid, aid), noAuth: true })).status).toBe(401);
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const ext = c.json().token as string;
    const byExt = await call({ method: "POST", url: ticketUrl(pid, sid, aid), noAuth: true, headers: { authorization: `Bearer ${ext}`, origin: EXT } });
    expect(byExt.status).toBe(403);

    // A picture is not media.
    const pic = await sourceWith(pid, await scratch("shot.png", tinyPng()), "image");
    const notMedia = await call({ method: "POST", url: ticketUrl(pid, pic.sid, pic.aid) });
    expect(notMedia.status).toBe(400);
    expect(notMedia.json.error.code).toBe("VALIDATION");
    expect((await call({ method: "POST", url: ticketUrl(pid, sid, "01ZZZZZZZZZZZZZZZZZZZZZZZZ") })).status).toBe(404);
    expect((await call({ method: "POST", url: ticketUrl(pid, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", aid) })).status).toBe(404);

    // A locked project: refused.
    const enc = await newProject(true, "Sealed");
    const e = await sourceWith(enc, await scratch("talk.mp3", randomBytes(100)));
    expect((await call({ method: "POST", url: `/projects/${enc}/lock` })).status).toBe(200);
    const locked = await call({ method: "POST", url: ticketUrl(enc, e.sid, e.aid) });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe("PROJECT_LOCKED");
  });

  it("at most 16 live: the 17th is refused until one ends (revoked or expired)", async () => {
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("talk.mp3", randomBytes(100)));
    const live: MediaTicketResponse[] = [];
    for (let i = 0; i < 16; i++) live.push(await ticket(pid, sid, aid));
    const r17 = await call({ method: "POST", url: ticketUrl(pid, sid, aid) });
    expect(r17.status).toBe(429);
    expect(r17.json.error.code).toBe("RATE_LIMITED");
    const rv = await call({ method: "POST", url: "/media-tickets/revoke", body: { path: live[0]!.path } });
    expect(rv.json).toEqual({ revoked: true });
    expect((await call({ method: "POST", url: "/media-tickets/revoke", body: { path: live[0]!.path } })).json).toEqual({ revoked: false });
    expect((await media(live[0]!.path)).status).toBe(404);
    await ticket(pid, sid, aid);
    expect((await call({ method: "POST", url: ticketUrl(pid, sid, aid) })).status).toBe(429);
    clock.ms += 10 * 60_000 + 1;
    await ticket(pid, sid, aid); // the idle ones have ended
    expect((await call({ method: "POST", url: "/media-tickets/revoke", body: { path: "/media/nope" } })).status).toBe(400);
  });
});

describe("the media route (R135 2, 3)", () => {
  beforeEach(() => start());

  it("serves the whole file and every kind of range, with the headers R135 asks for", async () => {
    await openLibrary();
    const pid = await newProject();
    const data = randomBytes(10_000);
    const { sid, aid } = await sourceWith(pid, await scratch("clip.mp4", data), "video");
    const { path } = await ticket(pid, sid, aid);

    const whole = await media(path);
    expect(whole.status).toBe(200);
    expect(whole.raw.equals(data)).toBe(true);
    expect(whole.headers).toMatchObject({
      "content-type": "video/mp4",
      "content-length": "10000",
      "accept-ranges": "bytes",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-disposition": "inline",
    });
    expect(whole.headers["access-control-allow-origin"]).toBeUndefined();

    const range = async (h: string) => media(path, { range: h });
    const first = await range("bytes=0-99");
    expect(first.status).toBe(206);
    expect(first.raw.equals(data.subarray(0, 100))).toBe(true);
    expect(first.headers).toMatchObject({ "content-range": "bytes 0-99/10000", "content-length": "100", "x-content-type-options": "nosniff", "cache-control": "no-store" });
    const middle = await range("bytes=4000-4999");
    expect(middle.raw.equals(data.subarray(4000, 5000))).toBe(true);
    const open = await range("bytes=9990-");
    expect(open.headers["content-range"]).toBe("bytes 9990-9999/10000");
    expect(open.raw.equals(data.subarray(9990))).toBe(true);
    const last = await range("bytes=9999-9999");
    expect(last.status).toBe(206);
    expect(last.raw.equals(data.subarray(9999))).toBe(true);
    const suffix = await range("bytes=-500");
    expect(suffix.headers["content-range"]).toBe("bytes 9500-9999/10000");
    expect(suffix.raw.equals(data.subarray(9500))).toBe(true);
    const past = await range("bytes=200-99999");
    expect(past.headers["content-range"]).toBe("bytes 200-9999/10000");

    for (const bad of ["bytes=10000-", "bytes=10000-10001", "bytes=-0"]) {
      const r = await range(bad);
      expect(r.status, bad).toBe(416);
      expect(r.headers["content-range"]).toBe("bytes */10000");
    }
    // Several ranges: the Range header is ignored (RFC 9110 14.2 allows it) and the whole file sent.
    const multi = await range("bytes=0-9,20-29");
    expect(multi.status).toBe(200);
    expect(multi.raw.equals(data)).toBe(true);
    // A Range that is not understood is ignored too; so is one under If-Range (we give no validators).
    expect((await range("items=0-5")).status).toBe(200);
    expect((await media(path, { range: "bytes=0-5", "if-range": '"x"' })).status).toBe(200);

    const head = await media(path, { range: "bytes=0-99" }, "HEAD");
    expect(head.status).toBe(206);
    expect(head.headers["content-length"]).toBe("100");
    expect(head.raw.length).toBe(0);

    // Other methods: no such route; the ticket still works afterwards.
    // Other methods are not the media route: the normal token check applies (401 without it).
    expect((await svc.app.inject({ method: "POST", url: path })).statusCode).toBe(401);
    expect((await svc.app.inject({ method: "DELETE", url: path })).statusCode).toBe(401);
    expect((await call({ method: "POST", url: path })).status).toBe(404);
  });

  it("an encrypted project is decrypted as it streams, across the format's chunk boundaries", async () => {
    await openLibrary();
    const pid = await newProject(true);
    const data = randomBytes(2 * CHUNK + 777);
    const { sid, aid } = await sourceWith(pid, await scratch("talk.m4a", data));
    const { path } = await ticket(pid, sid, aid);
    expect((await media(path)).raw.equals(data)).toBe(true);
    const a = CHUNK - 10;
    const b = 2 * CHUNK + 10;
    const r = await media(path, { range: `bytes=${a}-${b}` });
    expect(r.status).toBe(206);
    expect(r.raw.equals(data.subarray(a, b + 1))).toBe(true);
    expect((await media(path, { range: "bytes=-1" })).raw.equals(data.subarray(data.length - 1))).toBe(true);
  });

  it("a ticket reads only its own asset; a query string, a wrong form and an unknown ticket are refused", async () => {
    await openLibrary();
    const pid = await newProject();
    const A = randomBytes(1000);
    const B = randomBytes(1000);
    const a = await sourceWith(pid, await scratch("a.mp3", A));
    const b = await sourceWith(pid, await scratch("b.mp3", B));
    const ta = await ticket(pid, a.sid, a.aid);
    const tb = await ticket(pid, b.sid, b.aid);
    expect((await media(ta.path)).raw.equals(A)).toBe(true);
    expect((await media(tb.path)).raw.equals(B)).toBe(true);
    // Nothing in the address can name another asset: the ticket alone decides.
    expect((await media(`${ta.path}/../${b.aid}`)).status).toBe(404);
    expect((await media(`${ta.path}?asset=${b.aid}`)).status).toBe(400);
    expect((await media(`/media/${"A".repeat(43)}`)).status).toBe(404);
    expect((await media("/media/short")).status).toBe(404);
    const unknown = await media(`/media/${"B".repeat(43)}`);
    expect(Object.keys(unknown.json)).toEqual(["error"]);
    // The UI token is no substitute for a ticket, and a ticket is no substitute for the token.
    expect((await call({ url: `/media/${"C".repeat(43)}` })).status).toBe(404);
    expect((await call({ url: "/projects", noAuth: true, headers: { authorization: `Bearer ${ta.path.slice(7)}` } })).status).toBe(401);
  });

  it("expires after 10 idle minutes, and after 8 hours however much it is used", async () => {
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    const idle = await ticket(pid, sid, aid);
    clock.ms += 10 * 60_000 - 1;
    expect((await media(idle.path)).status).toBe(200); // used: the idle clock starts again
    clock.ms += 10 * 60_000 - 1;
    expect((await media(idle.path)).status).toBe(200);
    clock.ms += 10 * 60_000 + 1;
    expect((await media(idle.path)).status).toBe(404);

    const busy = await ticket(pid, sid, aid);
    const issued = clock.ms;
    while (clock.ms - issued < 8 * 3600_000 - 5 * 60_000) {
      clock.ms += 5 * 60_000;
      expect((await media(busy.path, { range: "bytes=0-0" })).status).toBe(206);
    }
    clock.ms = issued + 8 * 3600_000 + 1;
    expect((await media(busy.path)).status).toBe(404);
  });

  it("revoked when its project is locked, and refused while the project is locked", async () => {
    await openLibrary();
    const pid = await newProject(true);
    const other = await newProject(false, "Open");
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    const o = await sourceWith(other, await scratch("b.mp3", randomBytes(100)));
    const t = await ticket(pid, sid, aid);
    const keep = await ticket(other, o.sid, o.aid);
    expect((await media(t.path)).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    expect((await media(t.path)).status).toBe(404);
    expect((await media(keep.path)).status).toBe(200); // another project's ticket lives on
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await media(t.path)).status).toBe(404); // unlocking again does not bring it back
    // Locked by any other way than the route: the media route checks too.
    const t2 = await ticket(pid, sid, aid);
    svc.state.session!.repo.lockProject(pid);
    const r = await media(t2.path);
    expect(r.status).toBe(423);
    expect((await media(t2.path)).status).toBe(404); // and the ticket is gone
  });

  it("revoked when the library is closed or another is opened, and when the service stops", async () => {
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    const t = await ticket(pid, sid, aid);
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).status).toBe(200);
    expect((await media(t.path)).status).toBe(404);
    const t2 = await ticket(pid, sid, aid);
    expect(svc.state.media.live()).toBe(1);
    await svc.close();
    expect(svc.state.media.live()).toBe(0);
  });

  it("revoked when a library move starts", async () => {
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    const t = await ticket(pid, sid, aid);
    const s = svc.state.session!;
    await svc.state.quiesce(s); // what a move does before copying
    expect((await media(t.path)).status).toBe(404);
  });
});

describe("the media route: who may load it", () => {
  beforeEach(() => start());

  async function oneTicket(): Promise<string> {
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    return (await ticket(pid, sid, aid)).path;
  }

  it("a media element of the shell page (no Origin, no-cors, cross-site, dest audio/video) is served", async () => {
    const path = await oneTicket();
    for (const dest of ["audio", "video"]) {
      const r = await media(path, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": dest, referer: "http://tauri.localhost/sources/1", range: "bytes=0-" });
      expect(r.status, dest).toBe(206);
    }
    // WebKit's custom scheme as the referrer, and a CORS-mode media element (crossorigin) from the shell.
    expect((await media(path, { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "video", referer: "tauri://localhost/x" })).status).toBe(200);
    const cors = await media(path, { origin: "http://tauri.localhost", "sec-fetch-mode": "cors", "sec-fetch-dest": "video" });
    expect(cors.status).toBe(200);
    expect(cors.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
    // A client that sends no fetch metadata at all (older web views, the platform media stack).
    expect((await media(path)).status).toBe(200);
  });

  it("any other web origin, a navigation, a document or frame load, and a foreign referrer are refused", async () => {
    const path = await oneTicket();
    const refused: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { origin: EXT },
      { origin: "null" },
      { "sec-fetch-mode": "cors" }, // a CORS request always carries an Origin; without one it is not a browser's
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none", "sec-fetch-user": "?1" },
      { "sec-fetch-dest": "document" },
      { "sec-fetch-dest": "iframe" },
      { "sec-fetch-dest": "embed" },
      { "sec-fetch-dest": "object" },
      { "sec-fetch-dest": "script" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-user": "?1" },
      { referer: "https://evil.example/page" },
    ];
    for (const h of refused) {
      const r = await media(path, h);
      expect(r.status, JSON.stringify(h)).toBe(403);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect((await media(path)).status).toBe(200); // still usable by the shell
  });
});

describe("the media route: real listener", () => {
  /** A GET on the real socket; `onFirst` may abort after the first chunk. */
  function get(port: number, path: string, headers: Record<string, string>, opts: { abortAfterFirst?: boolean; sink?: (chunk: Buffer) => void | Promise<void> } = {}): Promise<{ status: number; headers: Record<string, unknown>; bytes: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let bytes = 0;
        res.on("data", (d: Buffer) => {
          bytes += d.length;
          const wait = opts.sink?.(d);
          if (wait) {
            // The response waits (paused) while the test measures.
            res.pause();
            void wait.then(() => res.resume());
          }
          if (opts.abortAfterFirst) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes }));
      });
      req.on("error", (e) => (opts.abortAfterFirst ? undefined : reject(e)));
      req.end();
    });
  }

  const openFds = async (): Promise<number> => (process.platform === "linux" ? (await readdir("/proc/self/fd")).length : 0);

  it("the Host check is kept: a foreign Host is refused even with a valid ticket", async () => {
    await start();
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    const { path } = await ticket(pid, sid, aid);
    expect((await get(port, path, {})).status).toBe(200);
    // Path only: even an empty query string is refused (inject would drop it; a socket keeps it).
    expect((await get(port, `${path}?`, {})).status).toBe(400);
    // A dot segment survives on a real socket (inject normalises it away): refused too (R140 4).
    expect([401, 404]).toContain((await get(port, `/media/./${path.slice(7)}`, {})).status);
    expect((await get(port, `/media/${path.slice(7)}/.`, {})).status).not.toBe(200);
    expect((await get(port, path, { host: `evil.example:${port}` })).status).toBe(403);
    expect((await get(port, path, { host: `127.0.0.1:${port + 1}` })).status).toBe(403);
  });

  it("an aborted request releases its file handle", async () => {
    await start();
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("big.mp4", randomBytes(8 * CHUNK)), "video");
    const { path } = await ticket(pid, sid, aid);
    const before = await openFds();
    const r = await get(port, path, {}, { abortAfterFirst: true });
    expect(r.status).toBe(200);
    for (let i = 0; i < 100 && (svc.state.media.activeStreams() > 0 || (await openFds()) > before); i++) await new Promise((res) => setTimeout(res, 20));
    expect(svc.state.media.activeStreams()).toBe(0);
    if (process.platform === "linux") expect(await openFds()).toBeLessThanOrEqual(before);
    // The ticket still works after an aborted read (a seek aborts the previous request).
    expect((await get(port, path, { range: "bytes=0-9" })).bytes).toBe(10);
  });

  it("revoking a ticket ends a stream in progress (lock)", async () => {
    await start();
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("big.mp4", randomBytes(16 * CHUNK)), "video");
    const { path } = await ticket(pid, sid, aid);
    let got = 0;
    let locked = false;
    const done = new Promise<number>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.on("data", (d: Buffer) => {
          got += d.length;
          if (!locked) {
            locked = true;
            res.pause();
            void call({ method: "POST", url: `/projects/${pid}/lock` }).then(() => res.resume());
          }
        });
        res.on("end", () => resolve(got));
        res.on("error", () => resolve(got));
        res.on("aborted", () => resolve(got));
      });
      req.on("error", () => resolve(got));
      req.end();
    });
    const total = await done;
    expect(total).toBeLessThan(16 * CHUNK);
    for (let i = 0; i < 100 && svc.state.media.activeStreams() > 0; i++) await new Promise((res) => setTimeout(res, 20));
    expect(svc.state.media.activeStreams()).toBe(0);
  });

  it("a 50 MB encrypted recording read by ranges and whole, with a ceiling on memory growth", async () => {
    await start();
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    await openLibrary();
    const pid = await newProject(true);
    // Written in pieces so the test itself never holds 50 MB.
    const file = join(tmp, "in", "long.mp4");
    await mkdir(join(tmp, "in"), { recursive: true });
    const want = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const w = createWriteStream(file);
      w.on("error", reject);
      let i = 0;
      const more = () => {
        while (i < 50) {
          const piece = randomBytes(CHUNK);
          want.update(piece);
          i++;
          if (!w.write(piece)) return void w.once("drain", more);
        }
        w.end(resolve);
      };
      more();
    });
    const expected = want.digest("hex");
    const { sid, aid } = await sourceWith(pid, file, "video");
    const { path, size } = await ticket(pid, sid, aid);
    expect(size).toBe(50 * CHUNK);

    // A collector we can run on demand, so "held in memory" is measured, not GC timing.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const used = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    /** Runs the collector until its deferred frees have happened too. */
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        gc();
        await new Promise((r) => setImmediate(r));
      }
    };
    // Warm up first (code compiled, pools made), so the baseline is the steady state.
    for (const r of ["bytes=0-1048575", "bytes=-1048576"]) await get(port, path, { range: r });
    await settle();
    const base = used();
    const retained: number[] = [];
    /** What is live now beyond the baseline. */
    const measure = async () => {
      await settle();
      retained.push(used() - base);
    };
    // By ranges, as a player seeking through it would; halfway through each, what is still held
    // after a collection.
    const h = createHash("sha256");
    const step = 7 * CHUNK + 12345; // not aligned to the format's chunks
    for (let at = 0; at < size; at += step) {
      const end = Math.min(size, at + step) - 1;
      let seen = 0;
      let measured = false;
      const r = await get(port, path, { range: `bytes=${at}-${end}` }, {
        sink: (c) => {
          h.update(c);
          seen += c.length;
          if (!measured && seen >= (end - at + 1) / 2) {
            measured = true;
            return measure();
          }
          return undefined;
        },
      });
      expect(r.status).toBe(206);
      expect(r.bytes).toBe(end - at + 1);
    }
    expect(h.digest("hex")).toBe(expected);
    // And whole, in one response, measured halfway too.
    const h2 = createHash("sha256");
    let seen = 0;
    let measured = false;
    const all = await get(port, path, {}, {
      sink: (c) => {
        h2.update(c);
        seen += c.length;
        if (!measured && seen >= 25 * CHUNK) {
          measured = true;
          return measure();
        }
        return undefined;
      },
    });
    expect(all.bytes).toBe(size);
    expect(h2.digest("hex")).toBe(expected);
    // The file never sits in memory: in the middle of every response (paused there while measured),
    // under 16 MB more is live than before (measured about 8: the decrypted-chunk cache of the open
    // file, stream and socket buffers), against a 50 MB file read whole. Measured after collections:
    // the peak of uncollected garbage depends on when the collector runs, not on what is held.
    expect(retained).toHaveLength(9);
    for (const r of retained) expect(r).toBeLessThan(16 * CHUNK);
  });
});

describe("the ticket never reaches a log line or an error (R135 3)", () => {
  it("issuing, using, ranges, refusals, unknown tickets and revocation, at trace level", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(3000)));
    const t = await ticket(pid, sid, aid);
    const secret = t.path.slice("/media/".length);
    const bodies: string[] = [];
    for (const r of [
      await media(t.path),
      await media(t.path, { range: "bytes=0-9" }),
      await media(t.path, { range: "bytes=99999-" }),
      await media(t.path, { origin: "https://evil.example" }),
      await media(`${t.path}?x=1`),
      await media(`${t.path}/x`),
      await media(`${t.path}%zz`),
      await media(t.path, {}, "HEAD"),
      await call({ method: "POST", url: t.path }),
      await call({ method: "POST", url: "/media-tickets/revoke", body: { path: t.path } }),
      await media(t.path),
    ]) bodies.push(r.body);
    // The same address spelled any other way is refused before any ticket lookup (R140 4), and
    // still never reaches a log line or an error body.
    const t2 = await ticket(pid, sid, aid);
    const s2 = t2.path.slice("/media/".length);
    const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
    for (const spelling of [
      `/%6Dedia/${s2}`,
      `/media/${hex(s2[0]!)}${s2.slice(1)}`,
      `/media/${hex(s2[0]!).toLowerCase()}${s2.slice(1)}`,
      `/media/${s2.slice(0, 42)}${hex(s2[42]!)}`,
      `//media/${s2}`,
      `/MEDIA/${s2}`,
      `/media/${s2}/`,
      `/media/${s2}.`,
      `/media/${s2}%2F`,
    ]) {
      const r = await media(spelling);
      expect([400, 401, 404], spelling).toContain(r.status);
      bodies.push(r.body);
    }
    expect((await media(t2.path)).status).toBe(200); // the exact form still works
    // Sent to another route split by an encoded slash (review M4): neither half is logged.
    bodies.push((await call({ url: `/projects/${s2.slice(0, 20)}%2F${s2.slice(20)}` })).body);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).toContain("/media/[redacted]");
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(secret.slice(0, 16));
    expect(logs).not.toContain(s2);
    expect(logs).not.toContain(s2.slice(1, 17));
    expect(logs).not.toContain(s2.slice(0, 20));
    expect(logs).not.toContain(s2.slice(20));
    for (const b of bodies) {
      expect(b).not.toContain(secret);
      expect(b).not.toContain(s2.slice(1));
    }
  });
});

describe("pictures (R135 1)", () => {
  const contentUrl = (pid: string, sid: string, aid: string) => `/projects/${pid}/sources/${sid}/assets/${aid}/content`;

  it("UI token only; raster pictures only; nosniff, no-store; decrypted in encrypted projects", async () => {
    await start();
    await openLibrary();
    for (const encrypted of [false, true]) {
      const pid = await newProject(encrypted, encrypted ? "Sealed" : "Open");
      const png = tinyPng();
      const { sid, aid } = await sourceWith(pid, await scratch("shot.png", png), "image");
      const r = await call({ url: contentUrl(pid, sid, aid) });
      expect(r.status, r.body).toBe(200);
      expect(r.raw.equals(png)).toBe(true);
      expect(r.headers).toMatchObject({ "content-type": "image/png", "content-length": String(png.length), "x-content-type-options": "nosniff", "cache-control": "no-store" });
      expect((await call({ url: contentUrl(pid, sid, aid), noAuth: true })).status).toBe(401);
      const audio = await sourceWith(pid, await scratch("a.mp3", randomBytes(10)));
      expect((await call({ url: contentUrl(pid, audio.sid, audio.aid) })).status).toBe(400);
      const svg = await sourceWith(pid, await scratch("x.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image");
      expect((await call({ url: contentUrl(pid, svg.sid, svg.aid) })).status).toBe(400);
      if (encrypted) {
        await call({ method: "POST", url: `/projects/${pid}/lock` });
        expect((await call({ url: contentUrl(pid, sid, aid) })).status).toBe(423);
      }
    }
    // The extension's token: refused.
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const pid = await newProject(false, "Third");
    const { sid, aid } = await sourceWith(pid, await scratch("shot.png", tinyPng()), "image");
    expect((await call({ url: contentUrl(pid, sid, aid), noAuth: true, headers: { authorization: `Bearer ${c.json().token}`, origin: EXT } })).status).toBe(403);
  });

  it("a picture over the size limit is refused before anything is read", async () => {
    await start({ pictureMaxBytes: 1000 });
    await openLibrary();
    const pid = await newProject();
    const big = Buffer.concat([tinyPng(), randomBytes(2000)]);
    const { sid, aid } = await sourceWith(pid, await scratch("big.png", big), "image");
    const r = await call({ url: contentUrl(pid, sid, aid) });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("fix round 1 (R140): the token exemption belongs to the media route only", () => {
  it("an unknown path under /media/, and another method on a ticket address, get the normal token check", async () => {
    await start();
    await openLibrary();
    const pid = await newProject();
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp3", randomBytes(100)));
    const { path } = await ticket(pid, sid, aid);
    for (const [method, url] of [
      ["GET", "/media/abc/def"],
      ["GET", `${path}/extra`],
      ["POST", path],
      ["PUT", path],
      ["DELETE", path],
      ["PATCH", path],
    ] as const) {
      const r = await svc.app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
      expect(r.json().error.code).toBe("UNAUTHORIZED");
      // With the token they are simply not routes.
      expect((await svc.app.inject({ method, url, headers: auth })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await media(path)).status).toBe(200);
  });
});

/** A streaming GET over a real socket that the test can pause, resume and watch. */
function streamingGet(port: number, path: string) {
  let received = 0;
  let ended: (how: string) => void = () => {};
  const done = new Promise<string>((r) => (ended = r));
  let firstChunk: () => void = () => {};
  const first = new Promise<void>((r) => (firstChunk = r));
  let res: import("node:http").IncomingMessage | undefined;
  let status = 0;
  const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (r) => {
    res = r;
    status = r.statusCode ?? 0;
    r.on("data", (d: Buffer) => {
      received += d.length;
      if (received === d.length) {
        r.pause();
        firstChunk();
      }
    });
    r.on("end", () => ended("end"));
    r.on("aborted", () => ended("aborted"));
    r.on("error", () => ended("aborted"));
    r.on("close", () => ended(r.complete ? "end" : "aborted"));
  });
  req.on("error", () => ended("aborted"));
  req.end();
  return {
    first,
    done,
    get received() {
      return received;
    },
    get status() {
      return status;
    },
    resume: () => res?.resume(),
    pause: () => res?.pause(),
  };
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("fix round 1 (R140): idle means no bytes sent; in-flight streams end promptly", () => {
  async function bigEncrypted(mb = 24): Promise<{ pid: string; sid: string; aid: string; path: string; port: number }> {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("big.mp4", randomBytes(mb * CHUNK)), "video");
    const { path } = await ticket(pid, sid, aid);
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    return { pid, sid, aid, path, port };
  }

  it("a reader that stalls for 10 minutes loses its connection and its ticket (bytes, not an open request, keep it alive)", async () => {
    const { path, port } = await bigEncrypted();
    const s = streamingGet(port, path);
    await s.first;
    await settle(200); // the socket buffers fill; nothing more is sent
    clock.ms += 10 * 60_000 - 1000;
    expect(svc.state.media.live()).toBe(1); // not yet
    clock.ms += 1001;
    expect(svc.state.media.live()).toBe(0);
    s.resume();
    expect(await s.done).toBe("aborted");
    expect(s.received).toBeLessThan(24 * CHUNK);
    expect((await media(path)).status).toBe(404);
    for (let i = 0; i < 100 && svc.state.media.activeStreams() > 0; i++) await settle(20);
    expect(svc.state.media.activeStreams()).toBe(0);
  });

  it("the 8-hour limit ends a stream in flight", async () => {
    const { path, port } = await bigEncrypted();
    const issued = clock.ms;
    const s = streamingGet(port, path);
    await s.first;
    // Kept from going idle by bytes sent on other requests every 5 minutes.
    while (clock.ms - issued < 8 * 3600_000 - 5 * 60_000) {
      clock.ms += 5 * 60_000;
      expect((await media(path, { range: "bytes=0-0" })).status).toBe(206);
    }
    expect(svc.state.media.live()).toBe(1);
    clock.ms = issued + 8 * 3600_000;
    expect(svc.state.media.live()).toBe(0);
    s.resume();
    expect(await s.done).toBe("aborted");
  });

  for (const event of ["lock", "close", "stop"] as const) {
    it(`${event === "lock" ? "a project lock" : event === "close" ? "closing the library" : "stopping the service"} ends a stream in flight: no bytes sent after it`, async () => {
      const { pid, path, port } = await bigEncrypted();
      const s = streamingGet(port, path);
      await s.first;
      await settle(100);
      const before = svc.state.media.bytesSent();
      if (event === "lock") expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
      else if (event === "close") expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
      else await svc.close();
      const atEvent = svc.state.media.bytesSent();
      s.resume();
      expect(await s.done).toBe("aborted");
      await settle(100);
      // Nothing more was handed to the socket after the event, and the client got no more than that.
      expect(svc.state.media.bytesSent()).toBe(atEvent);
      expect(atEvent).toBeLessThan(before + 128 * 1024); // at most a slice in progress
      expect(s.received).toBeLessThanOrEqual(atEvent);
      expect(s.received).toBeLessThan(24 * CHUNK);
      expect(svc.state.media.activeStreams()).toBe(0);
    });
  }
});

describe("fix round 1 (R140): an error before the first byte", () => {
  /** Damages the stored file's first encrypted chunk (after its 38-byte header). */
  async function tamper(pid: string, sid: string, aid: string): Promise<void> {
    const sf = await svc.state.session!.repo.getSource(pid, sid);
    const abs = join(tmp, "Lib", ...sf.assets.find((a) => a.id === aid)!.path.split("/"));
    const raw = await readFile(abs);
    raw[38 + 10] = raw[38 + 10]! ^ 0xff;
    await writeFile(abs, raw);
  }

  const quietLogs = () => {
    for (const line of logs.split("\n").filter(Boolean)) {
      const o = JSON.parse(line) as { level: number; err?: { stack?: string } };
      expect(o.level, line).toBeLessThan(50);
      expect(line).not.toContain('"stack"');
      expect(line).not.toContain(tmp);
    }
  };

  it("a damaged recording: the service's error shape, 409, logged without a stack below error level; no path or ticket", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(3 * CHUNK)), "video");
    const t = await ticket(pid, sid, aid);
    await tamper(pid, sid, aid);
    for (const range of [undefined, "bytes=10-20", "bytes=-5"]) {
      const r = await media(t.path, range ? { range } : {});
      const expectedStatus = range === "bytes=-5" ? 206 : 409; // the last chunk is intact
      expect(r.status, String(range)).toBe(expectedStatus);
      if (expectedStatus === 409) {
        expect(r.headers["content-type"]).toMatch(/^application\/json/);
        expect(r.json).toEqual({ error: { code: "CONFLICT", message: expect.any(String) } });
        expect(r.body).not.toContain(t.path.slice(7));
        expect(r.body).not.toContain(tmp);
      }
    }
    expect(logs).toContain("could not be read");
    expect(logs).not.toContain(t.path.slice(7));
    quietLogs();
  });

  it("a damaged picture: the same", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const png = Buffer.concat([tinyPng(), randomBytes(5000)]);
    const { sid, aid } = await sourceWith(pid, await scratch("shot.png", png), "image");
    await tamper(pid, sid, aid);
    const r = await call({ url: `/projects/${pid}/sources/${sid}/assets/${aid}/content` });
    expect(r.status).toBe(409);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(r.json.error.code).toBe("CONFLICT");
    quietLogs();
  });

  it("a lock racing the start of a request: the service's error shape, no bytes", async () => {
    let pid = "";
    await start({
      mediaBeforeSend: async () => {
        svc.state.session!.repo.lockProject(pid);
        svc.state.media.revokeProject(pid);
      },
    });
    await openLibrary();
    pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(2 * CHUNK)), "video");
    const t = await ticket(pid, sid, aid);
    const r = await media(t.path, { range: "bytes=0-99" });
    expect([404, 423]).toContain(r.status);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(Object.keys(r.json)).toEqual(["error"]);
    expect(r.headers["content-range"]).toBeUndefined();
    expect(r.body).not.toContain(t.path.slice(7));
    quietLogs();
  });
});

describe("a stored file found changed while it is played (FR-217, FR-219)", () => {
  /** Flips a byte `fromEnd` bytes before the end of the stored (encrypted) file. */
  async function tamperAt(pid: string, sid: string, aid: string, at: (size: number) => number): Promise<void> {
    const sf = await svc.state.session!.repo.getSource(pid, sid);
    const abs = join(tmp, "Lib", ...sf.assets.find((a) => a.id === aid)!.path.split("/"));
    const raw = await readFile(abs);
    const i = at(raw.length);
    raw[i] = raw[i]! ^ 0xff;
    await writeFile(abs, raw);
  }
  /** A whole-file GET on the real socket; resolves with the bytes received, however it ends. */
  function getAll(port: number, path: string): Promise<number> {
    return new Promise((resolve) => {
      let got = 0;
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.on("data", (d: Buffer) => (got += d.length));
        res.on("end", () => resolve(got));
        res.on("error", () => resolve(got));
        res.on("aborted", () => resolve(got));
      });
      req.on("error", () => resolve(got));
      req.end();
    });
  }
  const revoke = (path: string) => call({ method: "POST", url: "/media-tickets/revoke", body: { path } });

  it("a change found part-way through a stream: the cut ticket's revoke says FILE_CHANGED (a code, no sentence, no path)", async () => {
    await start();
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(3 * CHUNK)), "video");
    const t = await ticket(pid, sid, aid);
    await tamperAt(pid, sid, aid, (n) => n - 100); // in the last chunk: found after the first bytes were sent
    const got = await getAll(port, t.path);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(3 * CHUNK);
    // No wait (R467 M9): the ticket is marked before its stream is cut, and the cut is what ended `getAll`.
    const r = await revoke(t.path);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revoked: true, ended: "FILE_CHANGED" });
    expect(r.body).not.toContain(tmp);
  });

  it("a change found before the first byte: the same code; a ticket that ended normally carries none", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(3 * CHUNK)), "video");
    const good = await ticket(pid, sid, aid);
    expect((await media(good.path, { range: "bytes=0-9" })).status).toBe(206);
    expect((await revoke(good.path)).json).toEqual({ revoked: true });
    const t = await ticket(pid, sid, aid);
    await tamperAt(pid, sid, aid, () => 38 + 10);
    expect((await media(t.path, { range: "bytes=10-20" })).status).toBe(409);
    expect((await revoke(t.path)).json).toEqual({ revoked: true, ended: "FILE_CHANGED" });
  });

  it("a change in the file's header (its first bytes) is marked like a change in its body (M1, R467)", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(3 * CHUNK)), "video");
    const t = await ticket(pid, sid, aid);
    await tamperAt(pid, sid, aid, () => 0);
    const r = await media(t.path, { range: "bytes=0-9" });
    expect(r.status).toBe(409);
    const v = await revoke(t.path);
    expect(v.json).toEqual({ revoked: false, ended: "FILE_CHANGED" });
    expect(v.body).not.toContain(tmp);
  });
  it("a recording the app destroys while it streams is not 'changed outside the app': its stream ends and the revoke says FILE_DESTROYED (M3, R467)", async () => {
    await start();
    const port = await svc.listen(0);
    hostHeader = { host: `127.0.0.1:${port}` };
    await openLibrary();
    // An interview due for destruction under the project's retention rule.
    const gov = `${OPEN_GOV.replace("containsIdentifiable: false", "containsIdentifiable: true\n  pseudonymizeFileNames: false")}retention:\n  rawDataDestroyAfter: 2020-01-01\n`;
    const pid = await newProject(true, "Study", gov);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(16 * CHUNK)), "video", true);
    const t = await ticket(pid, sid, aid);
    let destroyed: { status: number; body: string } | undefined;
    const got = await new Promise<number>((resolve) => {
      let n = 0;
      const req = httpRequest({ host: "127.0.0.1", port, path: t.path, method: "GET", headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.on("data", (d: Buffer) => {
          n += d.length;
          if (!destroyed) {
            destroyed = { status: 0, body: "" };
            // The raw data is destroyed (on the researcher's order) while the recording streams.
            res.pause();
            void call({ method: "POST", url: `/projects/${pid}/retention/destroy`, body: { assetIds: [aid], confirm: true } }).then((r) => {
              destroyed = { status: r.status, body: r.body };
              res.resume();
            });
          }
        });
        res.on("end", () => resolve(n));
        res.on("error", () => resolve(n));
        res.on("aborted", () => resolve(n));
      });
      req.on("error", () => resolve(n));
      req.end();
    });
    expect(destroyed?.status, destroyed?.body).toBe(200);
    expect(got).toBeLessThan(16 * CHUNK);
    const v = await revoke(t.path);
    expect(v.json).toEqual({ revoked: false, ended: "FILE_DESTROYED" });
    expect(v.body).not.toContain(tmp);
  });

  it("the mark outlives the ticket's idle sweep long enough to be read once; it is bounded in time and in number (M2, R467)", async () => {
    await start();
    await openLibrary();
    const pid = await newProject(true);
    const { sid, aid } = await sourceWith(pid, await scratch("a.mp4", randomBytes(3 * CHUNK)), "video");
    const t = await ticket(pid, sid, aid);
    await tamperAt(pid, sid, aid, () => 38 + 10);
    expect((await media(t.path, { range: "bytes=10-20" })).status).toBe(409);
    clock.ms += MEDIA_TICKET_IDLE_MS + 60_000;
    expect(svc.state.media.live()).toBe(0);
    expect((await revoke(t.path)).json).toEqual({ revoked: false, ended: "FILE_CHANGED" });
    // Read once.
    expect((await revoke(t.path)).json).toEqual({ revoked: false });
    // In time: no ticket lives longer than its lifetime, so neither does its mark.
    const late = await ticket(pid, sid, aid);
    expect((await media(late.path, { range: "bytes=10-20" })).status).toBe(409);
    clock.ms += MEDIA_TICKET_LIFETIME_MS + 60_000;
    expect(svc.state.media.live()).toBe(0);
    expect((await revoke(late.path)).json).toEqual({ revoked: false });
    // In number: the oldest marks give way.
    // (Each is swept as idle before the next, so no more than one is live at once.)
    const first = await ticket(pid, sid, aid);
    expect((await media(first.path, { range: "bytes=10-20" })).status).toBe(409);
    let last = first;
    for (let i = 0; i < MEDIA_TICKET_MARKS_MAX; i++) {
      clock.ms += MEDIA_TICKET_IDLE_MS + 1000;
      last = await ticket(pid, sid, aid);
      expect((await media(last.path, { range: "bytes=10-20" })).status).toBe(409);
    }
    clock.ms += MEDIA_TICKET_IDLE_MS + 1000;
    expect(svc.state.media.live()).toBe(0);
    expect((await revoke(first.path)).json).toEqual({ revoked: false });
    expect((await revoke(last.path)).json).toEqual({ revoked: false, ended: "FILE_CHANGED" });
  });
});
