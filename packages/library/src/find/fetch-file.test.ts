/**
 * Task F10: the bounded download of a free copy. Nothing here reaches the network: every request goes to an undici
 * MockAgent (disableNetConnect) installed as the global dispatcher, composed with a recorder (every request's
 * headers) and a "held" interceptor that lets a test drive an answer by hand (headers that never come, a body that
 * stalls). Time is fake (`setTimeout` only): no test waits in real time.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { strToU8, zipSync } from "fflate";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary } from "../library.js";
import { USER_AGENT } from "../lookup/http.js";
import { openTestRepo } from "../repo/testing.js";
import { activeTemp, isStaleWorkDir } from "../tmp-registry.js";
import { FETCH_FILE_DEADLINE_MS, FETCH_FILE_HEADERS_MS, FetchFileError, fetchFile, holdFindTemp } from "./fetch-file.js";
import { FREE_COPY_MAX_BYTES } from "./free-copy.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const EPUB = Buffer.from(zipSync({ mimetype: [strToU8("application/epub+zip"), { level: 0 }], "META-INF/container.xml": strToU8("<container/>") }));
const ZIP = Buffer.from(zipSync({ "a.txt": strToU8("hello"), mimetype: strToU8("application/epub+zip") }));
const HTML = Buffer.from("<!doctype html><html><head><title>Sign in</title></head><body>%PDF-1.4 not really</body></html>");

let tmp: string;
let root: string;
let dir: string;
let into: string;
let agent: MockAgent;
let saved: Dispatcher;
let requests: Array<{ origin: string; path: string; headers: Record<string, string> }>;

type Held = { origin: string; path: string; aborted: boolean; respond(status: number, headers: Record<string, string>, chunks: Buffer[], end: boolean): void };
let held: Held[];
let holdKeys: Set<string>;

function headersOf(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

const interceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  const origin = new URL(String(opts.origin)).origin;
  requests.push({ origin, path: opts.path, headers: headersOf(opts.headers) });
  if (!holdKeys.has(`${origin}${opts.path}`)) return dispatch(opts, handler);
  const h: Held = { origin, path: opts.path, aborted: false, respond: () => {} };
  const controller = {
    paused: false,
    aborted: false,
    reason: null,
    rawHeaders: null,
    rawTrailers: null,
    pause() {},
    resume() {},
    abort(reason: Error) {
      if (h.aborted) return;
      h.aborted = true;
      handler.onResponseError?.(controller as never, reason);
    },
  };
  handler.onRequestStart?.(controller as never, {});
  h.respond = (status, headers, chunks, end) => {
    if (h.aborted) return;
    handler.onResponseStart?.(controller as never, status, headers, "OK");
    for (const c of chunks) handler.onResponseData?.(controller as never, c);
    if (end) handler.onResponseEnd?.(controller as never, {});
  };
  held.push(h);
  return true;
};

/**
 * Lets pending I/O and promises run (never a timer: time is fake in some tests): until `cond` holds (at most 10 s of
 * real time, measured without timers), or for `rounds` turns of the event loop when no condition is given.
 */
async function settle(cond?: () => boolean, rounds = 200): Promise<void> {
  const start = performance.now();
  for (let i = 0; cond ? !cond() && performance.now() - start < 10_000 : i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function reply(origin: string, path: string, status: number, data: Buffer | string, headers: Record<string, string> = {}) {
  agent.get(origin).intercept({ path, method: "GET" }).reply(status, data, { headers });
}
const pdfAt = (origin: string, path: string, headers: Record<string, string> = { "content-type": "application/pdf" }) => reply(origin, path, 200, PDF, headers);

async function refusal(p: Promise<unknown>): Promise<FetchFileError> {
  const e = await p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(FetchFileError);
  return e as FetchFileError;
}

const empty = async () => expect(await readdir(dir)).toEqual([]);
const get = (url: string, extra: Partial<Parameters<typeof fetchFile>[1]> = {}) =>
  fetchFile(url, { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into, ...extra });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-fetch-file-"));
  root = join(tmp, "Lib");
  dir = join(root, ".tmp", "find-e1");
  into = join(dir, "1");
  await mkdir(join(root, ".tmp"), { recursive: true });
  agent = new MockAgent();
  agent.disableNetConnect();
  saved = getGlobalDispatcher();
  setGlobalDispatcher(agent.compose(interceptor));
  requests = [];
  held = [];
  holdKeys = new Set();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const h of held) h.respond(500, {}, [], true);
  setGlobalDispatcher(saved);
  await agent.close();
  await rm(tmp, { recursive: true, force: true });
  // No request of this file carries a key, a cookie, an e-mail or anything but our own User-Agent.
  for (const r of requests) {
    expect(r.headers.authorization).toBeUndefined();
    expect(r.headers.cookie).toBeUndefined();
    expect(r.headers["user-agent"]).toBe(USER_AGENT);
    expect(JSON.stringify(r)).not.toContain("mailto");
    expect(JSON.stringify(r)).not.toContain("test-only@example.invalid");
  }
});

describe("fetchFile: success", () => {
  it("saves a PDF under the caller's name, with its SHA-256, in a private folder", async () => {
    pdfAt("https://arxiv.org", "/pdf/2101.00001", { "content-type": "application/pdf", "content-disposition": 'attachment; filename="../../evil.sh"' });
    const got = await get("https://arxiv.org/pdf/2101.00001");
    expect(got).toEqual({ path: into, sha256: createHash("sha256").update(PDF).digest("hex"), bytes: PDF.length, mime: "application/pdf" });
    expect(await readdir(dir)).toEqual(["1"]);
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(into)).mode & 0o777).toBe(0o600);
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["accept-encoding"]).toBe("identity");
    expect(activeTemp.has("find-e1")).toBe(false);
  });

  it("the type is decided by the bytes, not by content-type", async () => {
    pdfAt("https://europepmc.org", "/articles/PMC123?pdf=render", { "content-type": "text/html; charset=utf-8" });
    expect((await get("https://europepmc.org/articles/PMC123?pdf=render")).mime).toBe("application/pdf");
  });

  it("an EPUB by its first entry; a zip that is not an EPUB is refused", async () => {
    reply("https://archive.org", "/download/item1/book.epub", 200, EPUB, { "content-type": "application/octet-stream" });
    expect((await get("https://archive.org/download/item1/book.epub")).mime).toBe("application/epub+zip");
    await rm(into);
    reply("https://archive.org", "/download/item1/other.epub", 200, ZIP, { "content-type": "application/epub+zip" });
    const e = await refusal(get("https://archive.org/download/item1/other.epub"));
    expect(e.code).toBe("not-pdf-or-epub");
    expect(e.message).toBe("The service sent something that is not a PDF or EPUB.");
    await empty();
  });

  it("the parsed address is what is fetched (the host lower-cased)", async () => {
    pdfAt("https://arxiv.org", "/pdf/2101.00001");
    await get("https://ARXIV.ORG/pdf/2101.00001");
    expect(requests.map((r) => `${r.origin}${r.path}`)).toEqual(["https://arxiv.org/pdf/2101.00001"]);
  });

  it("an Internet Archive data-node host is a file host", async () => {
    pdfAt("https://ia800000.us.archive.org", "/1/items/x/x.pdf");
    expect((await get("https://ia800000.us.archive.org/1/items/x/x.pdf")).mime).toBe("application/pdf");
  });
});

describe("fetchFile: refusals leave the folder empty", () => {
  it("an HTML page served as application/pdf is refused as not a PDF", async () => {
    reply("https://arxiv.org", "/pdf/2101.00001", 200, HTML, { "content-type": "application/pdf" });
    const e = await refusal(get("https://arxiv.org/pdf/2101.00001"));
    expect(e.message).toBe("The service sent something that is not a PDF or EPUB.");
    await empty();
  });

  it("an address off the list, or one that does not parse or is too long, is refused before any request", async () => {
    for (const u of ["https://evil.example/x.pdf", "http://arxiv.org/x.pdf", "https://arxiv.org@evil.example/x.pdf", "not a url", `https://arxiv.org/${"a".repeat(2000)}`]) {
      const e = await refusal(get(u));
      expect(e.message).not.toContain("evil");
    }
    expect(requests).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("a redirect to an unlisted host is not followed", async () => {
    reply("https://arxiv.org", "/pdf/1", 302, "", { location: "https://evil.example/x.pdf" });
    const e = await refusal(get("https://arxiv.org/pdf/1"));
    expect(e.code).toBe("redirect-refused");
    expect(e.message).toBe("The free copy's address led to a place the app does not download from.");
    expect(inspect(e)).not.toContain("evil.example");
    expect(requests.map((r) => r.origin)).toEqual(["https://arxiv.org"]);
    await empty();
  });

  it("redirect targets are held to the same rule: userinfo, port, http, IP", async () => {
    for (const loc of ["https://arxiv.org@evil.example/x", "https://arxiv.org:8443/x", "http://arxiv.org/x", "https://127.0.0.1/x", "javascript:alert(1)"]) {
      reply("https://arxiv.org", "/pdf/r", 301, "", { location: loc });
      expect((await refusal(get("https://arxiv.org/pdf/r"))).code).toBe("redirect-refused");
    }
    expect(new Set(requests.map((r) => r.origin))).toEqual(new Set(["https://arxiv.org"]));
    await empty();
  });

  it("a redirect to an allowed host is followed, a fourth redirect is not", async () => {
    reply("https://arxiv.org", "/a", 302, "", { location: "https://export.arxiv.org/b" });
    reply("https://export.arxiv.org", "/b", 301, "", { location: "/c" }); // resolved against the address that answered
    reply("https://export.arxiv.org", "/c", 307, "", { location: "https://arxiv.org/d" });
    pdfAt("https://arxiv.org", "/d");
    expect((await get("https://arxiv.org/a")).mime).toBe("application/pdf");
    expect(requests.map((r) => `${r.origin}${r.path}`)).toEqual(["https://arxiv.org/a", "https://export.arxiv.org/b", "https://export.arxiv.org/c", "https://arxiv.org/d"]);
    await rm(into);

    requests = [];
    reply("https://arxiv.org", "/a", 302, "", { location: "/b" });
    reply("https://arxiv.org", "/b", 302, "", { location: "/c" });
    reply("https://arxiv.org", "/c", 302, "", { location: "/d" });
    reply("https://arxiv.org", "/d", 302, "", { location: "/e" });
    pdfAt("https://arxiv.org", "/e");
    const e = await refusal(get("https://arxiv.org/a"));
    expect(e.code).toBe("too-many-redirects");
    expect(requests).toHaveLength(4);
    await empty();
  });

  it("a redirect loop ends at the limit", async () => {
    agent.get("https://arxiv.org").intercept({ path: "/loop", method: "GET" }).reply(302, "", { headers: { location: "/loop" } }).persist();
    expect((await refusal(get("https://arxiv.org/loop"))).code).toBe("too-many-redirects");
    expect(requests).toHaveLength(4);
    await empty();
  });

  it("content-length 101 MB refuses before the body", async () => {
    holdKeys.add("https://arxiv.org/big");
    const p = get("https://arxiv.org/big");
    await settle(() => held.length === 1);
    // The headers come; the body never does: only a refusal that reads no byte of it can settle.
    held[0]!.respond(200, { "content-type": "application/pdf", "content-length": String(101 * 1024 * 1024) }, [], false);
    const e = await refusal(p);
    expect(e.code).toBe("too-large");
    expect(e.message).toBe("The file is larger than 100 MB, the most the app downloads.");
    await empty();
  });

  it("101 MB is refused while streaming (no content-length)", async () => {
    reply("https://arxiv.org", "/big", 200, Buffer.concat([PDF, Buffer.alloc(101 * 1024 * 1024)]));
    expect((await refusal(get("https://arxiv.org/big"))).code).toBe("too-large");
    await empty();
  });

  it("no content-length: cut at the limit and the part file removed", async () => {
    reply("https://arxiv.org", "/x", 200, Buffer.concat([PDF, Buffer.alloc(4096)]));
    expect((await refusal(get("https://arxiv.org/x", { maxBytes: 1024 }))).code).toBe("too-large");
    await empty();
  });

  it("a content-length that lies changes nothing", async () => {
    reply("https://arxiv.org", "/x", 200, Buffer.concat([PDF, Buffer.alloc(4096)]), { "content-length": "10" });
    expect((await refusal(get("https://arxiv.org/x", { maxBytes: 1024 }))).code).toBe("too-large");
    await empty();
  });

  it("a larger maxBytes than the free-copy limit does not lengthen it", async () => {
    holdKeys.add("https://arxiv.org/big");
    const p = get("https://arxiv.org/big", { maxBytes: 10 * FREE_COPY_MAX_BYTES });
    await settle(() => held.length === 1);
    held[0]!.respond(200, { "content-length": String(FREE_COPY_MAX_BYTES + 1) }, [], false);
    expect((await refusal(p)).code).toBe("too-large");
    await empty();
  });

  it("an encoded answer is refused", async () => {
    reply("https://arxiv.org", "/gz", 200, PDF, { "content-encoding": "gzip" });
    const e = await refusal(get("https://arxiv.org/gz"));
    expect(e.code).toBe("encoded");
    expect(requests[0]!.headers["accept-encoding"]).toBe("identity");
    await empty();
  });

  it("only a 200 is a file: 206, 404, 500 and a redirect without a Location are refused, no body kept", async () => {
    reply("https://arxiv.org", "/p", 206, PDF, { "content-range": "bytes 0-10/100" });
    expect((await refusal(get("https://arxiv.org/p"))).code).toBe("status");
    reply("https://arxiv.org", "/n", 404, PDF);
    expect((await refusal(get("https://arxiv.org/n"))).message).toBe("The service did not send the file.");
    reply("https://arxiv.org", "/s", 500, PDF);
    expect((await refusal(get("https://arxiv.org/s"))).code).toBe("status");
    reply("https://arxiv.org", "/r", 302, "");
    expect((await refusal(get("https://arxiv.org/r"))).code).toBe("redirect-refused");
    await empty();
  });

  it("a service that cannot be reached is a refusal in plain words", async () => {
    agent.get("https://arxiv.org").intercept({ path: "/e", method: "GET" }).replyWithError(new Error("socket hang up at https://arxiv.org/e"));
    const e = await refusal(get("https://arxiv.org/e"));
    expect(e.code).toBe("unreachable");
    expect(inspect(e)).not.toContain("arxiv.org/e");
    await empty();
  });

  it("an address with no answer in the mock is a refusal, never a request to the network", async () => {
    expect((await refusal(get("https://arxiv.org/nothing-recorded"))).code).toBe("unreachable");
    await empty();
  });
});

describe("fetchFile: time and abort", () => {
  it("a download stalled past 180 s is dropped and its .part file removed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    holdKeys.add("https://arxiv.org/slow");
    const p = get("https://arxiv.org/slow");
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    await settle(() => held.length === 1);
    held[0]!.respond(200, { "content-type": "application/pdf" }, [PDF], false);
    let parts: string[] = [];
    const start = performance.now();
    while (!parts.some((n) => n.endsWith(".part")) && performance.now() - start < 10_000) {
      await settle();
      parts = await readdir(dir);
    }
    expect(parts.some((n) => n.endsWith(".part"))).toBe(true);
    await vi.advanceTimersByTimeAsync(FETCH_FILE_DEADLINE_MS - 1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    const e = await refusal(p);
    expect(e.code).toBe("deadline");
    expect(e.message).toBe("The download took longer than 3 minutes and was stopped.");
    await empty();
  });

  it("headers that do not come within 30 s end the download", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    holdKeys.add("https://arxiv.org/mute");
    const p = get("https://arxiv.org/mute");
    p.catch(() => {});
    await settle(() => held.length === 1);
    await vi.advanceTimersByTimeAsync(FETCH_FILE_HEADERS_MS + 1);
    const e = await refusal(p);
    expect(e.code).toBe("headers-timeout");
    expect(held[0]!.aborted).toBe(true);
    await empty();
  });

  it("a deadline shorter than 180 s is honoured; a longer one is not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    holdKeys.add("https://arxiv.org/slow");
    const p = fetchFile("https://arxiv.org/slow", { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 10 * FETCH_FILE_DEADLINE_MS as 180_000, into });
    p.catch(() => {});
    await settle(() => held.length === 1);
    held[0]!.respond(200, {}, [PDF], false);
    await vi.advanceTimersByTimeAsync(FETCH_FILE_DEADLINE_MS + 1);
    expect((await refusal(p)).code).toBe("deadline");
    await empty();
  });

  it("an abort through signal removes the part file and rejects with the reason", async () => {
    holdKeys.add("https://arxiv.org/abort");
    const ac = new AbortController();
    const p = get("https://arxiv.org/abort", { signal: ac.signal });
    p.catch(() => {});
    await settle(() => held.length === 1);
    held[0]!.respond(200, {}, [PDF], false);
    await settle();
    const reason = new Error("stopped by the runner");
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    await empty();
  });

  it("an abort before the start sends nothing", async () => {
    const ac = new AbortController();
    ac.abort(new Error("no"));
    await expect(get("https://arxiv.org/pdf/1", { signal: ac.signal })).rejects.toThrow("no");
    expect(requests).toEqual([]);
  });

  it("a write that fails at the end (the final name taken meanwhile) leaves no part file", async () => {
    holdKeys.add("https://arxiv.org/late");
    const p = get("https://arxiv.org/late");
    p.catch(() => {});
    await settle(() => held.length === 1);
    await mkdir(join(into, "blocker"), { recursive: true });
    held[0]!.respond(200, {}, [PDF], true);
    const e = await refusal(p);
    expect(e.code).toBe("write-failed");
    expect(e.message).toBe("The file could not be saved in the library's temporary folder.");
    expect(await readdir(dir)).toEqual(["1"]);
  });

  it("a final name that already exists is refused before any request", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(into, "older");
    expect((await refusal(get("https://arxiv.org/pdf/1"))).code).toBe("write-failed");
    expect(requests).toEqual([]);
  });

  it("a broken EPUB (a throw from the zip reader) is refused and removed", async () => {
    const broken = Buffer.from(EPUB);
    broken.writeUInt32LE(0xdeadbeef, broken.length - 6); // the central directory's offset
    reply("https://archive.org", "/download/x/b.epub", 200, broken);
    expect((await refusal(get("https://archive.org/download/x/b.epub"))).code).toBe("not-pdf-or-epub");
    await empty();
  });
});

describe("fetchFile: where the file may go", () => {
  it("into must be a file directly in a .tmp/find-<id> folder", async () => {
    for (const bad of [join(root, "Projects", "x"), join(root, ".tmp", "batch-1", "1"), join(root, ".tmp", "find-e1", "1.part"), join(root, ".tmp", "find-e1", ".hidden"), "relative/find-1/1"]) {
      await expect(fetchFile("https://arxiv.org/pdf/1", { maxBytes: 10, deadlineMs: 180_000, into: bad })).rejects.toThrow(TypeError);
    }
    expect(requests).toEqual([]);
  });
});

describe("fetchFile: one download at a time per host, two in all, across callers", () => {
  it("holds a third download until one ends", async () => {
    for (const k of ["https://arxiv.org/1", "https://arxiv.org/2", "https://archive.org/3", "https://europepmc.org/4"]) holdKeys.add(k);
    const target = (n: string) => join(root, ".tmp", `find-c${n}`, "f");
    const run = (u: string, n: string) => fetchFile(u, { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into: target(n) });
    const ps = [run("https://arxiv.org/1", "1"), run("https://arxiv.org/2", "2"), run("https://archive.org/3", "3"), run("https://europepmc.org/4", "4")];
    ps.forEach((p) => p.catch(() => {}));
    const keys = () => held.map((h) => `${h.origin}${h.path}`).sort();
    const of = (key: string) => held.find((h) => `${h.origin}${h.path}` === key)!;
    await settle(() => held.length >= 2);
    await settle();
    // arxiv.org/2 waits for its host; europepmc waits for an overall place.
    expect(keys()).toEqual(["https://archive.org/3", "https://arxiv.org/1"]);
    of("https://arxiv.org/1").respond(200, {}, [PDF], true);
    await ps[0];
    await settle(() => held.length >= 3);
    await settle();
    // The freed place goes to the first waiter that can start: arxiv.org/2 (its host is free now), not europepmc.
    expect(keys()).toEqual(["https://archive.org/3", "https://arxiv.org/1", "https://arxiv.org/2"]);
    of("https://archive.org/3").respond(404, {}, [], true);
    await refusal(ps[2]!);
    await settle(() => held.length >= 4);
    expect(keys()).toContain("https://europepmc.org/4");
    of("https://arxiv.org/2").respond(200, {}, [PDF], true);
    of("https://europepmc.org/4").respond(200, {}, [PDF], true);
    await Promise.all([ps[1], ps[3]]);
  });

  it("an abort while waiting for a place gives the place to no one and sends nothing", async () => {
    holdKeys.add("https://arxiv.org/1");
    const first = fetchFile("https://arxiv.org/1", { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into: join(root, ".tmp", "find-a", "f") });
    first.catch(() => {});
    await settle(() => held.length === 1);
    const ac = new AbortController();
    const second = fetchFile("https://arxiv.org/2", { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into: join(root, ".tmp", "find-b", "f"), signal: ac.signal });
    ac.abort(new Error("gone"));
    await expect(second).rejects.toThrow("gone");
    held[0]!.respond(200, {}, [PDF], true);
    await first;
    expect(requests.map((r) => r.path)).toEqual(["/1"]);
  });
});

describe("a crash's leftovers", () => {
  it("a crash's .tmp/find-* is swept at open", async () => {
    const deps: Deps = {
      clock: () => new Date(),
      deviceId: "dev-A",
      hostname: "host-A",
      pid: process.pid,
      isPidAlive: () => true,
      appConfigDir: join(tmp, "config"),
      settleMs: 0,
      setInterval: () => ({}),
      clearInterval: () => {},
    };
    const lib = await createLibrary(join(tmp, "Swept"), "Swept", deps);
    const stale = join(lib.root, ".tmp", "find-crashed");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "1.part"), PDF);
    expect(isStaleWorkDir("find-crashed")).toBe(true);
    activeTemp.add("find-in-use");
    expect(isStaleWorkDir("find-in-use")).toBe(false);
    activeTemp.delete("find-in-use");
    await openTestRepo(lib, new KeyRing(), { scryptN: 2 ** 10, actor: "tester" });
    expect(existsSync(stale)).toBe(false);
  });
});

describe("round 2 (R257)", () => {
  it("the folder's in-use mark is counted per call: the first of two downloads to finish leaves it marked", async () => {
    holdKeys.add("https://arxiv.org/a");
    holdKeys.add("https://archive.org/b");
    const a = get("https://arxiv.org/a");
    const b = fetchFile("https://archive.org/b", { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into: join(dir, "2") });
    await settle(() => held.length === 2);
    expect(isStaleWorkDir("find-e1")).toBe(false);
    held.find((h) => h.path === "/a")!.respond(200, {}, [PDF], true);
    await a;
    expect(isStaleWorkDir("find-e1")).toBe(false); // b still writes there
    held.find((h) => h.path === "/b")!.respond(200, {}, [PDF], true);
    await b;
    expect(isStaleWorkDir("find-e1")).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(["1", "2"]);
  });

  it("a mark someone else holds is left in place", async () => {
    activeTemp.add("find-e1");
    try {
      pdfAt("https://arxiv.org", "/held");
      await get("https://arxiv.org/held");
      expect(activeTemp.has("find-e1")).toBe(true);
    } finally {
      activeTemp.delete("find-e1");
    }
  });

  it("a hold taken while a download runs survives the download's end and keeps the folder in use until released (R261)", async () => {
    holdKeys.add("https://arxiv.org/a");
    const a = get("https://arxiv.org/a");
    await settle(() => held.length === 1);
    const release = holdFindTemp("find-e1");
    held[0]!.respond(200, {}, [PDF], true);
    await a;
    expect(activeTemp.has("find-e1")).toBe(true);
    expect(isStaleWorkDir("find-e1")).toBe(false);
    release();
    expect(activeTemp.has("find-e1")).toBe(false);
    expect(isStaleWorkDir("find-e1")).toBe(true);
  });

  it("a hold taken before and released during a download does not make the folder stale while it still writes (R261)", async () => {
    const release = holdFindTemp("find-e1");
    holdKeys.add("https://arxiv.org/a");
    const a = get("https://arxiv.org/a");
    await settle(() => held.length === 1);
    release();
    expect(isStaleWorkDir("find-e1")).toBe(false);
    held[0]!.respond(200, {}, [PDF], true);
    await a;
    expect(isStaleWorkDir("find-e1")).toBe(true);
  });

  it("giving up a hold twice does nothing the second time (R261)", () => {
    const one = holdFindTemp("find-e1");
    const two = holdFindTemp("find-e1");
    one();
    one();
    expect(activeTemp.has("find-e1")).toBe(true); // the other hold stands
    two();
    expect(activeTemp.has("find-e1")).toBe(false);
    two();
    expect(activeTemp.has("find-e1")).toBe(false);
  });

  it("an abort while a download waits for its place ends the call with the abort's reason and leaves nothing on disk", async () => {
    holdKeys.add("https://arxiv.org/1");
    const first = get("https://arxiv.org/1");
    first.catch(() => {});
    await settle(() => held.length === 1);
    const ac = new AbortController();
    const otherFolder = join(root, ".tmp", "find-waiting");
    const reason = new Error("The download was stopped.");
    const same = fetchFile("https://arxiv.org/2", { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into: join(dir, "2"), signal: ac.signal });
    const other = fetchFile("https://arxiv.org/3", { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into: join(otherFolder, "f"), signal: ac.signal });
    ac.abort(reason);
    await expect(same).rejects.toBe(reason);
    await expect(other).rejects.toBe(reason);
    expect(existsSync(otherFolder)).toBe(false);
    held[0]!.respond(200, {}, [PDF], true);
    await first;
    expect(await readdir(dir)).toEqual(["1"]);
    expect(requests.map((r) => r.path)).toEqual(["/1"]);
  });

  it("any content-encoding other than identity refuses, also among several values", async () => {
    for (const [path, enc] of [
      ["/e1", "identity, gzip"],
      ["/e2", "br"],
      ["/e3", ["identity", "gzip"]],
    ] as const) {
      agent.get("https://arxiv.org").intercept({ path, method: "GET" }).reply(200, PDF, { headers: { "content-encoding": enc as string | string[] } as never });
      expect((await refusal(get(`https://arxiv.org${path}`))).code).toBe("encoded");
    }
    pdfAt("https://arxiv.org", "/ok", { "content-encoding": "identity" });
    expect((await get("https://arxiv.org/ok")).mime).toBe("application/pdf");
  });

  it("a non-200 answer that is not a redirect is said as 'The service did not send the file.' (a 304 included)", async () => {
    for (const [path, status] of [
      ["/n", 404],
      ["/s", 503],
      ["/nm", 304],
      ["/p", 206],
    ] as const) {
      reply("https://arxiv.org", path, status, status === 304 ? "" : PDF, status === 304 ? { location: "/elsewhere" } : {});
      const e = await refusal(get(`https://arxiv.org${path}`));
      expect(e.code).toBe("status");
      expect(e.message).toBe("The service did not send the file.");
    }
    await empty();
  });
});
