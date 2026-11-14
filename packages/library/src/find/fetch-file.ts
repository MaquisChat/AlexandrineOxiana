/**
 * The bounded download of a free copy (Find and acquire, Task F10; the plan's Global Constraints "Hosts", "Limits"
 * and "A 'PDF' is a PDF").
 *
 *  - **One rule decides a host** (`fileHostAllowed`, free-copy.ts), on an address parsed once with `new URL`; the
 *    parsed address (`u.href`) is what is requested. An address that does not parse or is longer than 2,000
 *    characters is refused before anything is sent.
 *  - **Redirects are followed by hand**, at most 3: each `Location` is resolved against the address that answered,
 *    parsed once, and must pass the same rule; nothing of ours is carried but the User-Agent and the plain request
 *    headers below (no cookie, no key, no e-mail are ever sent by this module).
 *  - **Bounded in every direction:** the headers within 30 s (per request), the whole within 180 s (or the caller's
 *    shorter `deadlineMs`; a longer one is cut to 180 s) counted from the first place granted; `content-length` over
 *    the limit refuses before the body is read; the bytes are counted as they pass to the file and the transfer is
 *    cut at the limit whatever `content-length` said; `maxBytes` above `FREE_COPY_MAX_BYTES` is cut to it.
 *    `accept-encoding: identity` is asked for and an answer with any other `content-encoding` is refused: nothing
 *    is decompressed here. Only a 200 is a file.
 *  - **The file:** `<into>.part` (0600, created exclusively) in the folder of `into`, which must be
 *    `<…>/.tmp/find-<id>/` (made 0700 if missing); the SHA-256 is computed while streaming; the type is decided by
 *    the complete file's bytes alone — a PDF when its first 1,024 bytes hold `%PDF-` AND `file-type` says
 *    `application/pdf`; an EPUB when `file-type` says `application/epub+zip` AND the archive opens under the R50
 *    zip limits (`openZip`) with `mimetype` as its first entry holding exactly `application/epub+zip`. Only then is
 *    the part renamed to `into`. `content-type` and `content-disposition` are never read.
 *  - A 301, 302, 303, 307 or 308 is a redirect; any other answer that is not a 200 is "The service did not send the
 *    file." Every `content-encoding` value (several headers, or a list) must be `identity`.
 *  - **Nothing is left behind:** on every ending that is not success (a refusal, an abort through `signal`, a time
 *    limit, the size limit, the wrong type, a write error, a throw from anything) the part file this call created is
 *    removed before the promise settles. The folder's name is in `activeTemp` while any call into it runs (counted per call); `.tmp/find-*`
 *    left by a crash is swept when the library is opened (`isStaleWorkDir`, R59's sweep).
 *  - **Politeness, across every caller in the process:** at most one download at a time per host and two in all
 *    (`slots` below, module-wide: the runner works on two entries at once and each may download).
 *
 * The pattern is the one of the Zotero attachment download (`import/zotero-web.ts` `fileOnce`): a counting Transform
 * in a `pipeline` into `createWriteStream(…, { flags: "wx", mode: 0o600 })` with the abort signal, the file removed
 * on any failure. Refusals are `FetchFileError`s whose message is a plain sentence and never holds an address, a
 * host or a server's words; an abort through `signal` rejects with the signal's reason, as there.
 *
 * **Recorded answers (test mode only; Task F14, Ruling R317):** `recorded` is the lookup client's recorded FILE
 * answers (`HttpClient.recordedFiles`, made only under NODE_ENV=test with `AO_LOOKUP_FIXTURES` set; the switch is
 * read there, once, never here). When given, its dispatcher answers each request in place of the process's — and
 * that is the ONLY difference: every rule above runs as for a real download, and an address it has no answer for
 * is a 404 ("The service did not send the file."), so nothing reaches the network. Anything but the loader's own
 * object is refused (TypeError) before anything is sent. Absent (always, outside test mode), nothing changes.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileTypeFromFile } from "file-type";
import { request } from "undici";
import { openZip } from "../extract/zip.js";
import { USER_AGENT } from "../lookup/http.js";
import { RecordedFiles } from "../lookup/recorded.js";
import { activeTemp } from "../tmp-registry.js";
import { FREE_COPY_MAX_BYTES, fileHostAllowed, parseFreeCopyAddress } from "./free-copy.js";

/** The headers of each request must come within this. */
export const FETCH_FILE_HEADERS_MS = 30_000;
/** The whole download (every redirect and the body) must end within this. */
export const FETCH_FILE_DEADLINE_MS = 180_000;
export const FETCH_FILE_MAX_REDIRECTS = 3;
/** At most this many downloads at once in the process, and one per host. */
export const FETCH_FILE_CONCURRENCY = 2;
const SNIFF_BYTES = 1024;
const EPUB_MIME = "application/epub+zip";

export type FetchFileErrorCode =
  | "address"
  | "redirect-refused"
  | "too-many-redirects"
  | "status"
  | "encoded"
  | "too-large"
  | "headers-timeout"
  | "deadline"
  | "unreachable"
  | "not-pdf-or-epub"
  | "write-failed";

/** A download refused or failed; `message` is a plain sentence for the researcher (no address, no host). */
export class FetchFileError extends Error {
  override name = "FetchFileError";
  constructor(
    readonly code: FetchFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const SENTENCES = {
  address: "The free copy's address is not one the app downloads from.",
  redirectRefused: "The free copy's address led to a place the app does not download from.",
  tooManyRedirects: "The free copy's address sent the app on too many times.",
  encoded: "The service sent the file in a compressed form the app does not accept.",
  headers: "The service did not start sending the file within 30 seconds.",
  deadline: "The download took longer than 3 minutes and was stopped.",
  unreachable: "The service could not be reached.",
  notPdf: "The service sent something that is not a PDF or EPUB.",
  write: "The file could not be saved in the library's temporary folder.",
  status: "The service did not send the file.",
} as const;

const refuse = (code: FetchFileErrorCode, message: string) => new FetchFileError(code, message);
const tooLarge = (max: number) => refuse("too-large", `The file is larger than ${Math.round(max / (1024 * 1024))} MB, the most the app downloads.`);

// ---------------------------------------------------------------------------------------------------------------
// Places: one per host, two in all, first come first served among those that can start (process-wide).

type Waiter = { host: string; grant: () => void };
const busyHosts = new Set<string>();
let running = 0;
const queue: Waiter[] = [];

function pump(): void {
  for (let i = 0; i < queue.length && running < FETCH_FILE_CONCURRENCY; ) {
    const w = queue[i]!;
    if (busyHosts.has(w.host)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    busyHosts.add(w.host);
    running++;
    w.grant();
  }
}

/** Waits for a place for `host`; the function returned gives it back (once). An abort while waiting takes nothing. */
function place(host: string, signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    let given = false;
    const release = () => {
      if (given) return;
      given = true;
      busyHosts.delete(host);
      running--;
      pump();
    };
    const onAbort = () => {
      const i = queue.indexOf(w);
      if (i >= 0) queue.splice(i, 1);
      reject(signal.reason);
    };
    const w: Waiter = {
      host,
      grant: () => {
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      },
    };
    signal.addEventListener("abort", onAbort, { once: true });
    queue.push(w);
    pump();
  });
}

// ---------------------------------------------------------------------------------------------------------------

/** The folder of `into` must be `<…>/.tmp/find-<id>` and its name a plain file name (so a crash's leftover is swept). */
function checkTarget(into: string): void {
  const folder = dirname(into);
  const name = basename(into);
  const ok =
    typeof into === "string" &&
    isAbsolute(into) &&
    basename(dirname(folder)) === ".tmp" &&
    /^find-[A-Za-z0-9_-]{1,100}$/u.test(basename(folder)) &&
    /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/u.test(name) &&
    !name.endsWith(".part");
  if (!ok) throw new TypeError("fetchFile: `into` must be a plain file name directly inside a <library>/.tmp/find-<id> folder");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Makes the folder (0700) unless it is there; refuses one that is not a real folder (a symbolic link planted in its place). */
async function privateFolder(folder: string): Promise<void> {
  await fsp.mkdir(folder, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  const st = await fsp.lstat(folder);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("not a folder");
  if (process.platform !== "win32") await fsp.chmod(folder, 0o700);
}

/** Every value of a header, split at commas, trimmed and lower-cased (a header may come several times). */
const headerValues = (h: Record<string, string | string[] | undefined>, n: string): string[] => {
  const v = h[n];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((x) => String(x).split(",")).map((x) => x.trim().toLowerCase()).filter((x) => x !== "");
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The "in use" mark of a `find-<id>` folder (`activeTemp`), counted per call (R257 b): the folder stays marked while
 * any download into it runs. A mark already held by someone else (F11) when the first call starts is left in place.
 */
const tempUsers = new Map<string, { calls: number; external: boolean }>();
function markInUse(name: string): void {
  const u = tempUsers.get(name);
  if (u) u.calls++;
  else {
    tempUsers.set(name, { calls: 1, external: activeTemp.has(name) });
    activeTemp.add(name);
  }
}
function unmarkInUse(name: string): void {
  const u = tempUsers.get(name);
  if (!u) return;
  if (--u.calls > 0) return;
  tempUsers.delete(name);
  if (!u.external) activeTemp.delete(name);
}

/**
 * For other callers (F11) (R261): takes a counted hold on a `find-<id>` folder's name, through the same counter the
 * downloads use. The folder counts as in use while any hold or download remains. Returns the function that gives the
 * hold up; giving it up a second time does nothing.
 */
export function holdFindTemp(name: string): () => void {
  markInUse(name);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    unmarkInUse(name);
  };
}

const header = (h: Record<string, string | string[] | undefined>, n: string): string | undefined => {
  const v = h[n];
  return Array.isArray(v) ? v[0] : v;
};

/** The complete file's type, by its bytes alone; undefined when it is neither a PDF nor an EPUB. */
async function typeOf(path: string): Promise<"application/pdf" | "application/epub+zip" | undefined> {
  const fh = await fsp.open(path, "r");
  let head: Buffer;
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const sniffed = (await fileTypeFromFile(path))?.mime;
  if (head.includes("%PDF-") && sniffed === "application/pdf") return "application/pdf";
  if (sniffed !== EPUB_MIME) return undefined;
  const zip = await openZip(path); // R50 limits: throws UnsafeFileError beyond them
  try {
    const first = zip.names()[0];
    if (first !== "mimetype") return undefined;
    const body = await zip.read("mimetype", 64);
    return body?.toString("latin1") === EPUB_MIME ? EPUB_MIME : undefined;
  } finally {
    zip.close();
  }
}

/**
 * Downloads one free copy to `into` under the limits above. Resolves only with a complete PDF or EPUB at `into`;
 * otherwise rejects with a FetchFileError (or the signal's reason when aborted) and leaves no part file.
 * Throws TypeError (before anything is sent) when `into` is not a file name directly inside `<…>/.tmp/find-<id>/`.
 */
export async function fetchFile(
  url: string,
  opts: { maxBytes: number; deadlineMs: 180_000; into: string; signal?: AbortSignal; recorded?: RecordedFiles },
): Promise<{ path: string; sha256: string; bytes: number; mime: "application/pdf" | "application/epub+zip" }> {
  checkTarget(opts.into);
  if (opts.recorded !== undefined && !(opts.recorded instanceof RecordedFiles)) throw new TypeError("fetchFile: `recorded` must be the lookup client's recorded file answers");
  // Test mode only (R317): the recorded answers' dispatcher in place of the process's; nothing else differs.
  const via = opts.recorded ? { dispatcher: opts.recorded.dispatcher } : {};
  opts.signal?.throwIfAborted();
  const max = Math.min(Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : 0, FREE_COPY_MAX_BYTES);
  const deadlineMs = Math.min(Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? opts.deadlineMs : FETCH_FILE_DEADLINE_MS, FETCH_FILE_DEADLINE_MS);
  const first = parseFreeCopyAddress(url);
  if (!first || !fileHostAllowed(first)) throw refuse("address", SENTENCES.address);

  const into = opts.into;
  const folder = dirname(into);
  const part = `${into}.part`;
  const folderName = basename(folder);
  markInUse(folderName);

  // One controller ends everything: the caller's abort, the deadline and each request's header limit.
  const ac = new AbortController();
  const onCallerAbort = () => ac.abort(opts.signal!.reason);
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let headersTimer: ReturnType<typeof setTimeout> | undefined;
  let createdPart = false;
  let release: (() => void) | undefined;

  try {
    // The first place is asked for before anything else waits, so callers are served in the order they called.
    release = await place(first.hostname, ac.signal);
    deadline = setTimeout(() => ac.abort(refuse("deadline", SENTENCES.deadline)), deadlineMs);
    if (await exists(into)) throw refuse("write-failed", SENTENCES.write);
    try {
      await privateFolder(folder);
    } catch {
      throw refuse("write-failed", SENTENCES.write);
    }
    let current = first;
    for (let hop = 0; ; hop++) {
      release ??= await place(current.hostname, ac.signal);
      headersTimer = setTimeout(() => ac.abort(refuse("headers-timeout", SENTENCES.headers)), FETCH_FILE_HEADERS_MS);
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(current.href, {
          ...via,
          method: "GET",
          headers: { "user-agent": USER_AGENT, accept: "application/pdf, application/epub+zip;q=0.9, */*;q=0.1", "accept-encoding": "identity" },
          signal: ac.signal,
          headersTimeout: FETCH_FILE_HEADERS_MS,
          bodyTimeout: FETCH_FILE_HEADERS_MS,
        });
      } catch {
        // The library's own words (which may hold the address) are never passed on.
        if (ac.signal.aborted) throw ac.signal.reason;
        throw refuse("unreachable", SENTENCES.unreachable);
      } finally {
        clearTimeout(headersTimer);
      }
      const status = res.statusCode;
      if (REDIRECTS.has(status)) {
        res.body.destroy();
        const loc = header(res.headers, "location");
        if (!loc) throw refuse("redirect-refused", SENTENCES.redirectRefused);
        if (hop >= FETCH_FILE_MAX_REDIRECTS) throw refuse("too-many-redirects", SENTENCES.tooManyRedirects);
        const next = parseFreeCopyAddress(loc, current);
        if (!next || !fileHostAllowed(next)) throw refuse("redirect-refused", SENTENCES.redirectRefused);
        current = next;
        release();
        release = undefined;
        continue;
      }
      if (status !== 200) {
        res.body.destroy();
        throw refuse("status", SENTENCES.status);
      }
      if (headerValues(res.headers, "content-encoding").some((v) => v !== "identity")) {
        res.body.destroy();
        throw refuse("encoded", SENTENCES.encoded);
      }
      const declared = header(res.headers, "content-length");
      if (declared !== undefined && /^\d{1,20}$/u.test(declared.trim()) && Number(declared.trim()) > max) {
        res.body.destroy();
        throw tooLarge(max);
      }

      const hash = createHash("sha256");
      let bytes = 0;
      let over = false;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > max) {
            over = true;
            cb(new Error("too large"));
            return;
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      let fh: fsp.FileHandle;
      try {
        fh = await fsp.open(part, "wx", 0o600); // never another call's part file, never through a planted link
      } catch {
        res.body.destroy();
        throw refuse("write-failed", SENTENCES.write);
      }
      createdPart = true;
      const out = createWriteStream("", { fd: fh });
      try {
        await pipeline(res.body, meter, out, { signal: ac.signal });
      } catch {
        if (ac.signal.aborted) throw ac.signal.reason;
        if (over) throw tooLarge(max);
        throw out.errored ? refuse("write-failed", SENTENCES.write) : refuse("unreachable", SENTENCES.unreachable);
      }
      let mime: Awaited<ReturnType<typeof typeOf>>;
      try {
        mime = await typeOf(part);
      } catch {
        mime = undefined;
      }
      if (ac.signal.aborted) throw ac.signal.reason;
      if (!mime) throw refuse("not-pdf-or-epub", SENTENCES.notPdf);
      try {
        if (await exists(into)) throw new Error("taken");
        await fsp.rename(part, into);
      } catch {
        throw refuse("write-failed", SENTENCES.write);
      }
      createdPart = false;
      return { path: into, sha256: hash.digest("hex"), bytes, mime };
    }
  } catch (err) {
    if (createdPart) await fsp.rm(part, { force: true }).catch(() => {});
    if (err instanceof FetchFileError || err === opts.signal?.reason) throw err;
    if (opts.signal?.aborted) throw opts.signal.reason;
    throw refuse("write-failed", SENTENCES.write);
  } finally {
    clearTimeout(deadline);
    clearTimeout(headersTimer);
    release?.();
    opts.signal?.removeEventListener("abort", onCallerAbort);
    unmarkInUse(folderName);
  }
}
