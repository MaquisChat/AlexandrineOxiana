/**
 * HTTP client for the public metadata services (Crossref, OpenAlex, Open Library, Library of
 * Congress), spec 5.1 / 5.4 step 3.6 and R50.
 *
 *  - Cache: `<Library>/.cache/lookups/<sha256(cacheKey)>.json` (dir 0700, files 0600, written
 *    atomically; a symlinked cache directory is refused), 30-day TTL for answers, 1 day for
 *    not-found; an entry stored "in the future" is expired. Only JSON that parses is cached on
 *    getJson paths. An entry holds only the time it was stored, the status (200 or 404) and the
 *    body: never the URL, request headers or the contact email. Sensitive lookups (encrypted
 *    projects; the default unless `sensitive: false`) are cached in memory only (R30, R52).
 *  - Each attempt (redirects and body included) has an overall deadline (default 60 s).
 *  - Per-host rate limits (Crossref 5/s, OpenAlex 5/s, Open Library 1/s, LoC 1/s; others 1/s).
 *  - Per-host concurrency: Crossref one request at a time (its public pool, F2); others unlimited.
 *  - A 429's allowance headers (X-RateLimit-Remaining, X-RateLimit-Reset) are kept on the error as
 *    numbers; a caller may judge from them and the start of the body that the answer is final
 *    (OpenAlex's spent daily budget, F2), and it is then not retried. The body is never kept.
 *  - Per-host concurrency places are handed out first in, first out.
 *  - 429 / 5xx / network errors: 3 retries with exponential backoff (0.5 s, 1 s, 2 s), or the
 *    server's Retry-After, capped (default 60 s).
 *  - Redirects are followed (at most 3) only within the same origin.
 *  - User-Agent `AlexandrineOxiana/<version> (+https://github.com/maquiscatta-sys/AlexandrineOxiana)`; the default
 *    carries no e-mail. `; mailto:<email>` is added inside the parentheses only on requests to a host for which
 *    `contactEmailFor(host)` gives a well-formed address (F12, R290 e: Crossref's, to api.crossref.org only).
 *  - Keys (F12, R290 a): a key travels in the `Authorization: Bearer` header only, never in an address, and only to
 *    a host of KEYED_HOSTS reached over https on its default port, each host bound to its own key in the client itself
 *    (R298 b): `keyFor(host)` is asked for api.openalex.org only (OpenAlex's key), and elicit.com gets only a request's
 *    own key bound to it (`PostOptions.key`, Elicit's). ONE place decides it (the private `keyFor`). Before a GET to
 *    api.openalex.org the client awaits `keyReady(host)` (R297 b: the caller's lazy, bounded read of the key; a failure
 *    of it sends the request without a key). A request that
 *    carries a key is never redirected (any 3xx is refused, the same site included); its answer is cached under the
 *    caller's `cacheKey`, which holds no header, and is served from the cache whatever the key; an answer that holds
 *    the key or the e-mail sent is not cached; no error's message or property carries the key (the library's own
 *    words are not passed on for a keyed request). `keyTag(host)` gives a digest of the key in use (never the key) for
 *    the pause of OpenAlex's daily allowance, which is kept per key (A2, R290 h).
 *  - `postJson` (Elicit's search): one POST, never cached, never retried, never redirected, under its own time limit.
 *  - Under NODE_ENV=test only, AO_LOOKUP_FIXTURES replays recorded answers and fetches nothing
 *    (recorded.ts, R47/R130).
 *  - `GetOptions.query` (F10: the e-mail Unpaywall requires) is added to the address of the first request only. It is
 *    never part of the cache key (the caller's `cacheKey` names the request without it), a cached entry, an error's
 *    message or any property of an error, and a recorded answer is looked up by the address without it.
 *  - arXiv's export host: one request every 3 seconds, one at a time (its API terms; F10, R254 a).
 *  - An answer whose body holds a value of the request's private `query` (an echoed e-mail) is returned but never
 *    cached, on disk or in memory (R257 h). `GetOptions.final5xx` (R257 i) makes a 5xx final: not retried.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { libraryVersion } from "../resources.js";
import { join } from "node:path";
import { request, type Dispatcher } from "undici";
import { writeFileAtomic } from "../fs/atomic.js";
import { recordedLookupsFromEnv, type RecordedFiles, type RecordedLookups } from "./recorded.js";

const VERSION: string = libraryVersion();
const PROJECT_URL = "https://github.com/maquiscatta-sys/AlexandrineOxiana";
export const USER_AGENT = `AlexandrineOxiana/${VERSION} (+${PROJECT_URL})`;

/** Requests per second, per host. */
export const DEFAULT_RATE_LIMITS: Readonly<Record<string, number>> = {
  "api.crossref.org": 5,
  "api.openalex.org": 5,
  "openlibrary.org": 1,
  "lx2.loc.gov": 1,
  "www.loc.gov": 1,
  "lccn.loc.gov": 1,
  "export.arxiv.org": 1 / 3,
  // Elicit: one request every 2 s (docs.elicit.com; plan "Rates").
  "elicit.com": 1 / 2,
};
const DEFAULT_RATE = 1;
/** Requests open at once, per host; a host not listed is unlimited. */
export const DEFAULT_CONCURRENCY: Readonly<Record<string, number>> = {
  "api.crossref.org": 1,
  "export.arxiv.org": 1,
};
/**
 * The only hosts a key is ever sent to (R290 a): OpenAlex's key to `api.openalex.org`, Elicit's to `elicit.com`; https
 * on the default port only. A key function that answers for another host is never even asked.
 */
export const KEYED_HOSTS: ReadonlySet<string> = new Set(["api.openalex.org", "elicit.com"]);
/** The one host whose key `keyFor(host)` gives (OpenAlex's); every other keyed host takes only a request's own key (R298 b). */
const KEY_FOR_HOST = "api.openalex.org";
/** A key the client sends: visible ASCII without spaces, at most 4,096 characters (nothing that could change a header). */
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/u;
/** The start of a 429's body shown to the caller's decision. */
const RATE_LIMIT_BODY_BYTES = 4096;
const DAY_MS = 86_400_000;
/** Not-found answers are kept this long at most (a DOI may be registered tomorrow). */
const NEGATIVE_TTL_MS = DAY_MS;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MEMORY_ENTRIES = 2000;
// A deliberately simple shape check; anything with whitespace, control characters, brackets or
// semicolons is refused so the address can never change the header's structure.
export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * A 429 answer, shown to `GetOptions.final429` for that one decision and then dropped: the header
 * values parsed as whole numbers (absent when not digits), the raw Retry-After, and the first
 * 4 KiB of the body. The body is never kept on an error, logged or cached.
 */
export interface RateLimitAnswer {
  remaining?: number;
  reset?: number;
  retryAfter?: string;
  body: string;
}

/** What is kept of a 429 on the error: parsed numbers and the caller's decision, never text from the answer. */
export interface RateLimitInfo {
  remaining?: number;
  reset?: number;
  /** True when `final429` said retrying cannot help (the request was not retried). */
  final: boolean;
}

/** A lookup request that failed (after retries), or a response the client refused. */
export class LookupHttpError extends Error {
  override name = "LookupHttpError";
  /** Set when the last answer was a 429 (not enumerable: it stays out of serialised errors). */
  declare readonly rateLimit?: RateLimitInfo;
  /** The last answer's raw Retry-After, when it gave one (at most 100 characters; not enumerable). R411 b. */
  declare readonly retryAfter?: string;
  constructor(
    message: string,
    readonly status?: number,
    rateLimit?: RateLimitInfo,
  ) {
    super(message);
    if (rateLimit) Object.defineProperty(this, "rateLimit", { value: Object.freeze({ ...rateLimit }), enumerable: false });
  }
}

/** Keeps an answer's Retry-After on its error, not enumerable (R411 b: the free-copy runner's next try honours it). */
function withRetryAfter(e: LookupHttpError, value: string | undefined): void {
  if (value !== undefined) Object.defineProperty(e, "retryAfter", { value: value.slice(0, 100), enumerable: false });
}

/** A header value as a whole number, or undefined when it is not 1 to 12 digits. */
function wholeNumber(v: string | undefined): number | undefined {
  const t = v?.trim();
  return t && /^\d{1,12}$/u.test(t) ? Number(t) : undefined;
}

export interface HttpClientOptions {
  /** The library root; the cache lives in `<root>/.cache/lookups/`. */
  libraryRoot: string;
  /**
   * The contact e-mail for a host's User-Agent (polite-pool etiquette; F12: Crossref's e-mail for api.crossref.org
   * only), or undefined. Asked for every request's host; an address that is not well formed is never sent.
   */
  contactEmailFor?: (host: string) => string | undefined;
  /**
   * The key for a host (F12: OpenAlex's for api.openalex.org), or undefined. Asked only for a host of KEYED_HOSTS,
   * at each request (a key added or changed is used by the next request). Never stored by the client.
   */
  keyFor?: (host: string) => string | undefined;
  /**
   * F12 (R297 b): awaited before each GET to api.openalex.org, before `keyFor` is asked: the caller's chance to read
   * the key lazily (one read shared by every request) within its own short bound. Never asked for another host. A
   * rejection is ignored: the request goes, without a key if none is held.
   */
  keyReady?: (host: string) => Promise<void>;
  /** undici dispatcher (tests pass a MockAgent). */
  dispatcher?: Dispatcher;
  /** Milliseconds since the epoch (rate limits and cache age). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateLimits?: Record<string, number>;
  /** Requests open at once per host (merged over DEFAULT_CONCURRENCY). */
  concurrency?: Record<string, number>;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Cap on a server's Retry-After (default 60 s). */
  maxRetryAfterMs?: number;
  /** First backoff step (default 500 ms; doubled per retry). */
  backoffMs?: number;
  timeoutMs?: number;
  /** Overall deadline of one attempt, redirects and body included (default 60 s). */
  attemptTimeoutMs?: number;
  /**
   * TESTS ONLY: where the recorded-answers switch is read (default process.env; honoured only under
   * NODE_ENV=test). Application code never passes it. Note that vitest sets NODE_ENV=test, so an
   * AO_LOOKUP_FIXTURES exported in a developer's shell also reaches the library's own tests.
   */
  env?: NodeJS.ProcessEnv;
}

export interface GetOptions {
  /** Identifies the request in the cache; the file name is its sha256. */
  cacheKey: string;
  ttlDays?: number;
  /** Lookup made for an encrypted project: memory cache only, nothing written to disk. Default true (fail-closed). */
  sensitive?: boolean;
  /** Consulted on a 429: true means retrying cannot help (e.g. a daily budget spent), so it is not retried. */
  final429?: (answer: RateLimitAnswer) => boolean;
  /** True: a 5xx answer is final for this request (not retried). Free-copy lookups set it (R257 i). */
  final5xx?: boolean;
  /**
   * Parameters added to the address when it is requested (F10: Unpaywall's `email`), percent-encoded. Never part of
   * the cache key, a cached entry, a log line, an error's message or any property of an error: the same answer is
   * served from the cache whatever their values. Not sent again after a redirect.
   */
  query?: Readonly<Record<string, string>>;
}

/** One POST (F12: Elicit's search). */
export interface PostOptions {
  /** The request's own key, sent only when the address's host is `host` (and that host is keyed). */
  key?: { host: string; value: string };
  /** Limit of the whole call, the wait for a place included (default: the client's attempt deadline). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Shown a refusal (a status other than 200) with the first 4 KiB of its body, for that one decision; the body is
   * then dropped (never kept on the error, logged or cached).
   */
  onRefusal?: (status: number, bodyStart: string) => void;
}

interface CacheEntry {
  v: 1;
  storedAt: number;
  status: 200 | 404;
  body: string | null;
}

interface MemoryEntry extends CacheEntry {
  sensitive: boolean;
}

export class HttpClient {
  /** The default User-Agent: no e-mail (R290 e). */
  readonly userAgent: string = USER_AGENT;
  private readonly contactEmailFor?: (host: string) => string | undefined;
  private readonly keyForHost?: (host: string) => string | undefined;
  private readonly keyReady?: (host: string) => Promise<void>;
  private readonly cacheDir: string;
  /**
   * R247 (c): whether the library's root folder existed when the client was made. If it did, a cache write never
   * creates it again (a library closed, moved or deleted meanwhile gets nothing written into a folder of that name).
   * A client made for a folder that does not exist yet creates it as before.
   */
  private readonly rootExisted: boolean;
  /** R247 (c): false once the service has said the library is closing or moving: nothing more is written to disk. */
  private diskCache = true;
  private readonly dispatcher?: Dispatcher;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rates: Record<string, number>;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly attemptTimeoutMs: number;
  /** Test mode only: recorded answers replace every request (and a lookup without one fails). */
  private readonly recorded: RecordedLookups | undefined;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly nextSlot = new Map<string, number>();
  private readonly hostQueue = new Map<string, Promise<unknown>>();
  private readonly concurrency: Record<string, number>;
  private readonly open = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();

  constructor(opts: HttpClientOptions) {
    this.contactEmailFor = opts.contactEmailFor;
    this.keyForHost = opts.keyFor;
    this.keyReady = opts.keyReady;
    this.cacheDir = join(opts.libraryRoot, ".cache", "lookups");
    this.rootExisted = existsSync(opts.libraryRoot);
    this.dispatcher = opts.dispatcher;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rates = { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits };
    this.concurrency = { ...DEFAULT_CONCURRENCY, ...opts.concurrency };
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.backoffMs = opts.backoffMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.recorded = recordedLookupsFromEnv(opts.env ?? process.env);
  }

  /**
   * Task F14 (R317): the recorded FILE answers when the switch above is on (test mode only), else undefined. Read
   * with the switch, once, here; the find runner hands it to `fetchFile`, which then never reaches the network.
   */
  get recordedFiles(): RecordedFiles | undefined {
    return this.recorded?.files;
  }

  /** Parsed JSON, or null when the resource does not exist (404). A 200 that is not JSON is never cached. */
  async getJson<T = unknown>(url: string, opts: GetOptions): Promise<T | null> {
    let parsed: unknown;
    const body = await this.get(url, opts, (b) => {
      try {
        parsed = JSON.parse(b);
      } catch {
        throw new LookupHttpError("The metadata service returned a response that is not JSON");
      }
    });
    if (body === null) return null;
    return (parsed !== undefined ? parsed : JSON.parse(body)) as T;
  }

  /** The response body, or null when the resource does not exist (404). */
  getText(url: string, opts: GetOptions & { validate?: (body: string) => void }): Promise<string | null> {
    return this.get(url, opts, opts.validate);
  }

  private async get(url: string, opts: GetOptions, validate?: (body: string) => void): Promise<string | null> {
    const sensitive = opts.sensitive !== false;
    const name = createHash("sha256").update(opts.cacheKey).digest("hex");
    const ttl = (opts.ttlDays ?? 30) * DAY_MS;
    const fresh = (e: CacheEntry | undefined): e is CacheEntry => {
      if (!e) return false;
      const age = this.clock() - e.storedAt;
      return age >= 0 && age < (e.status === 404 ? Math.min(ttl, NEGATIVE_TTL_MS) : ttl);
    };

    const mem = this.memory.get(name);
    if (fresh(mem)) return mem.body;
    if (!sensitive) {
      const disk = await this.readCache(name);
      if (fresh(disk) && (disk.body === null || this.valid(disk.body, validate))) {
        this.remember(name, disk, false);
        return disk.body;
      }
    }

    const res = await this.fetchWithRetries(url, opts.final429, opts.query, opts.final5xx === true);
    if (res.body !== null) validate?.(res.body); // throws: nothing is cached
    const entry: CacheEntry = { v: 1, storedAt: this.clock(), status: res.status, body: res.body };
    // Never cached (R257 h; R290 a, e): an answer that holds the private query, or the key or the e-mail sent with it.
    if (res.body !== null && (echoesQuery(res.body, opts.query) || echoesQuery(res.body, res.sent))) return entry.body;
    this.remember(name, entry, sensitive);
    if (!sensitive) await this.writeCache(name, entry);
    return entry.body;
  }

  private valid(body: string, validate?: (body: string) => void): boolean {
    try {
      validate?.(body);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drops every response cached for a sensitive (encrypted-project) lookup. Call when an
   * encrypted project is locked, so nothing looked up for it stays in memory (R30).
   */
  purgeSensitive(): void {
    for (const [k, e] of this.memory) if (e.sensitive) this.memory.delete(k);
  }

  /**
   * R247 (c): `false` when the library is being closed, switched or moved: from then on no answer, however late, is
   * written to the disk cache (reads go on, and the memory cache still serves). `true` again when it is in use.
   */
  setDiskCache(on: boolean): void {
    this.diskCache = on;
  }

  private remember(name: string, e: CacheEntry, sensitive: boolean): void {
    const prior = this.memory.get(name);
    this.memory.delete(name);
    this.memory.set(name, { ...e, sensitive: sensitive || !!prior?.sensitive });
    if (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
  }

  /** True when `dir` exists as a real directory (not a symlink or anything else). */
  private async realDir(dir: string): Promise<boolean> {
    try {
      const st = await fsp.lstat(dir);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private async readCache(name: string): Promise<CacheEntry | undefined> {
    try {
      // Same rule as writing: never through a symlinked .cache or .cache/lookups.
      if (!(await this.realDir(join(this.cacheDir, ".."))) || !(await this.realDir(this.cacheDir))) return undefined;
      const e = JSON.parse(await fsp.readFile(join(this.cacheDir, `${name}.json`), "utf8")) as CacheEntry;
      if (e?.v !== 1 || typeof e.storedAt !== "number" || (e.status !== 200 && e.status !== 404)) return undefined;
      if (e.body !== null && typeof e.body !== "string") return undefined;
      return e;
    } catch {
      return undefined;
    }
  }

  private async writeCache(name: string, e: CacheEntry): Promise<void> {
    if (!this.diskCache) return;
    try {
      const parent = join(this.cacheDir, "..");
      if (this.rootExisted) {
        // Never above `.cache`: a library folder that is gone is not made again (R247 c).
        await fsp.mkdir(parent, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "EEXIST") throw err;
        });
      } else {
        // Reached only by a client made for a folder that did not exist yet: in practice the library's own tests (and
        // tools that make a client before its folder). The service always makes its client for an open library, whose
        // folder exists, so it takes the branch above (R247 c, m4).
        await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
      }
      if (!(await this.realDir(parent))) return;
      await fsp.mkdir(this.cacheDir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      // Never chmod or write through a symlink planted in place of the cache directory.
      if (!(await this.realDir(this.cacheDir))) return;
      if (process.platform !== "win32") await fsp.chmod(this.cacheDir, 0o700);
      if (!this.diskCache) return;
      await writeFileAtomic(join(this.cacheDir, `${name}.json`), JSON.stringify(e), { mode: 0o600 });
    } catch {
      // The cache is an optimisation: a read-only or full disk only costs a repeat lookup.
    }
  }

  /**
   * THE one place that decides a key (R290 a): for an https address on its default port, with no user name, whose
   * host is in KEYED_HOSTS, the request's own key when one is given and bound to that host (a key given for another
   * host gives none), else `keyFor(host)` — asked for api.openalex.org only (R298 b: elicit.com takes only a request's
   * own key); a key that is not of KEY_SHAPE is never sent. Undefined for every other address.
   */
  private keyFor(u: URL, own?: { host: string; value: string }): string | undefined {
    if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "" || !KEYED_HOSTS.has(u.hostname)) return undefined;
    let key: string | undefined;
    if (own) key = own.host === u.hostname ? own.value : undefined;
    else if (u.hostname !== KEY_FOR_HOST) key = undefined;
    else {
      try {
        key = this.keyForHost?.(u.hostname);
      } catch {
        key = undefined;
      }
    }
    return typeof key === "string" && KEY_SHAPE.test(key) ? key : undefined;
  }

  /**
   * A digest of the key the next request to `host` would carry ("" without one): it tells keys apart for the pause of
   * OpenAlex's daily allowance (A2, R290 h) and is never the key. Held in memory only, by whoever asks.
   */
  keyTag(host: string): string {
    let u: URL;
    try {
      u = new URL(`https://${host}/`);
    } catch {
      return "";
    }
    const key = this.keyFor(u);
    return key ? createHash("sha256").update(`ao-key-tag\u0000${key}`).digest("hex").slice(0, 32) : "";
  }

  /** The User-Agent of a request to `host`: the default, or with `mailto:` when that host has a well-formed e-mail. */
  private userAgentFor(host: string): { ua: string; email?: string } {
    let email: string | undefined;
    try {
      email = this.contactEmailFor?.(host)?.trim();
    } catch {
      email = undefined;
    }
    return email && email.length <= 254 && EMAIL_RE.test(email) ? { ua: `AlexandrineOxiana/${VERSION} (+${PROJECT_URL}; mailto:${email})`, email } : { ua: USER_AGENT };
  }

  /**
   * One POST of a JSON body (F12: Elicit's search), its answer parsed: `{ status: 200, json }`. Never cached, never
   * retried, never redirected (any 3xx is refused), bounded as every answer (5 MB) and in time (`timeoutMs`, the wait
   * for a place included). Any other status is a LookupHttpError with that status (a 429's allowance numbers on it as
   * for a GET, `final`); `onRefusal` sees the start of its body first. In test mode with recorded answers nothing is
   * fetched: the call fails (there are no recorded POST answers).
   */
  async postJson(url: string, body: unknown, opts: PostOptions = {}): Promise<{ status: 200; json: unknown }> {
    if (this.recorded) throw new LookupHttpError("No recorded answer for this lookup (test mode: nothing is fetched)");
    const u = new URL(url);
    // A POST carries only its own key: `keyFor(host)` is never asked for it.
    const key = this.keyFor(u, opts.key ?? { host: "", value: "" });
    const limit = AbortSignal.timeout(opts.timeoutMs ?? this.attemptTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, limit]) : limit;
    const payload = JSON.stringify(body);
    let giveBack: (() => void) | undefined;
    let given = false;
    try {
      const waited = (async () => {
        const g = await this.hold(u.hostname);
        if (given) g(); // the call was given up while it waited: the place goes straight back
        else giveBack = g;
        await this.throttle(u.hostname);
      })();
      await Promise.race([
        waited,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      ]);
      const res = await request(u, {
        method: "POST",
        headers: {
          // A POST carries no contact e-mail, whatever `contactEmailFor` says (Elicit receives the typed words only).
          "user-agent": USER_AGENT,
          accept: "application/json",
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: payload,
        dispatcher: this.dispatcher,
        signal,
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
      const header = (n: string) => {
        const v = res.headers[n];
        return Array.isArray(v) ? v[0] : v;
      };
      if (res.statusCode !== 200) {
        const start = await readStart(res.body, RATE_LIMIT_BODY_BYTES);
        try {
          opts.onRefusal?.(res.statusCode, start);
        } catch {
          // the caller's decision never breaks the call
        }
        if (res.statusCode >= 300 && res.statusCode < 400) throw new LookupHttpError("The service redirected; a request to it is never redirected", res.statusCode);
        if (res.statusCode === 429) {
          const remaining = wholeNumber(header("x-ratelimit-remaining"));
          const reset = wholeNumber(header("x-ratelimit-reset"));
          throw new LookupHttpError("The service answered HTTP 429", 429, { ...(remaining !== undefined ? { remaining } : {}), ...(reset !== undefined ? { reset } : {}), final: true });
        }
        throw new LookupHttpError(`The service answered HTTP ${res.statusCode}`, res.statusCode);
      }
      const text = await readBounded(res.body);
      try {
        return { status: 200, json: JSON.parse(text) as unknown };
      } catch {
        throw new LookupHttpError("The service returned a response that is not JSON");
      }
    } catch (e) {
      if (e instanceof LookupHttpError) throw e;
      // Nothing of the library's own words: they could hold the address or the request.
      throw new LookupHttpError(signal.aborted ? "The service did not answer in time" : "The service could not be reached");
    } finally {
      given = true;
      giveBack?.();
    }
  }

  /** Waits for the host's next free slot; slots are handed out in call order. */
  private async throttle(host: string): Promise<void> {
    const prev = this.hostQueue.get(host) ?? Promise.resolve();
    const turn = prev.then(async () => {
      const gap = 1000 / (this.rates[host] ?? DEFAULT_RATE);
      const wait = (this.nextSlot.get(host) ?? 0) - this.clock();
      if (wait > 0) await this.sleep(wait);
      this.nextSlot.set(host, this.clock() + gap);
    });
    this.hostQueue.set(host, turn.catch(() => {}));
    await turn;
  }

  /**
   * Holds one of the host's places, waiting first in, first out when all are taken; the returned
   * function gives it back. A place given back goes straight to the longest waiter (the count of
   * open places does not drop in between), so a newcomer can never overtake a waiter.
   */
  private async hold(host: string): Promise<() => void> {
    const limit = this.concurrency[host];
    if (limit === undefined || !(limit >= 1)) return () => {};
    const queue = this.waiting.get(host) ?? [];
    this.waiting.set(host, queue);
    if ((this.open.get(host) ?? 0) < limit && queue.length === 0) this.open.set(host, (this.open.get(host) ?? 0) + 1);
    else await new Promise<void>((r) => queue.push(r)); // resolved with the place already counted as ours
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = queue.shift();
      if (next) next();
      else this.open.set(host, (this.open.get(host) ?? 1) - 1);
    };
  }

  private retryDelay(attempt: number, retryAfter: string | undefined): number {
    const ms = retryAfterMs(retryAfter, this.clock());
    if (ms !== undefined) return Math.min(ms, this.maxRetryAfterMs);
    return this.backoffMs * 2 ** attempt;
  }

  private async fetchWithRetries(
    url: string,
    final429?: (a: RateLimitAnswer) => boolean,
    query?: Readonly<Record<string, string>>,
    final5xx = false,
  ): Promise<{ status: 200 | 404; body: string | null; sent?: Record<string, string> }> {
    if (this.recorded) return this.recorded.answer(url);
    const first = new URL(url);
    if (this.keyReady && first.hostname === KEY_FOR_HOST && this.keyForHost) {
      try {
        await this.keyReady(first.hostname);
      } catch {
        // The key could not be read: the request goes without it (never failing because of the key).
      }
    }
    const key = this.keyFor(first);
    const { ua, email } = this.userAgentFor(first.hostname);
    /** What was sent that an answer must not be cached with (an answer that echoes it is not kept). */
    const sent: Record<string, string> = { ...(key ? { key } : {}), ...(email ? { email } : {}) };
    const params = query ? Object.entries(query) : [];
    const target = params.length ? `${url}${url.includes("?") ? "&" : "?"}${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : url;
    let lastError: LookupHttpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Awaited<ReturnType<HttpClient["fetchFollowingRedirects"]>> | undefined;
      try {
        res = await this.fetchFollowingRedirects(target, { ua, ...(key ? { key } : {}) });
      } catch (e) {
        if (e instanceof LookupHttpError) throw e; // refused redirect or oversized body: not retryable
        // The library's own words can hold the address it was asked; with a query (an e-mail), a key or a contact
        // e-mail they are not passed on.
        const why = params.length || key || email ? "" : `: ${e instanceof Error ? e.message : String(e)}`;
        lastError = new LookupHttpError(`The metadata service could not be reached${why}`);
      }
      if (res) {
        if (res.status === 200) return { status: 200, body: res.body, sent };
        if (res.status === 404 || res.status === 410) return { status: 404, body: null, sent };
        if (res.status === 429 && res.rateLimit) {
          // The answer (body included) is shown to the caller's decision and then dropped: only
          // the parsed numbers and the decision stay on the error.
          const { remaining, reset } = res.rateLimit;
          const final = final429?.(res.rateLimit) === true;
          lastError = new LookupHttpError(`The metadata service answered HTTP 429`, 429, {
            ...(remaining !== undefined ? { remaining } : {}),
            ...(reset !== undefined ? { reset } : {}),
            final,
          });
          withRetryAfter(lastError, res.retryAfter);
          if (final) throw lastError;
        } else {
          lastError = new LookupHttpError(`The metadata service answered HTTP ${res.status}`, res.status);
          withRetryAfter(lastError, res.retryAfter);
          if (res.status < 500 || final5xx) throw lastError;
        }
      }
      if (attempt < this.maxRetries) await this.sleep(this.retryDelay(attempt, res?.retryAfter));
    }
    throw lastError!;
  }

  /**
   * One attempt; its deadline starts once the first rate-limit slot is granted (queueing is not
   * counted). Each hop holds one of its host's concurrency places until its body has been read.
   */
  private async fetchFollowingRedirects(
    url: string,
    send: { ua: string; key?: string },
  ): Promise<{ status: number; body: string | null; retryAfter?: string; rateLimit?: RateLimitAnswer }> {
    let current = new URL(url);
    let signal: AbortSignal | undefined;
    for (let hop = 0; ; hop++) {
      const giveBack = await this.hold(current.hostname);
      try {
        await this.throttle(current.hostname);
        signal ??= AbortSignal.timeout(this.attemptTimeoutMs);
        const res = await request(current, {
          method: "GET",
          headers: {
            "user-agent": send.ua,
            accept: "application/json, application/xml;q=0.9, */*;q=0.1",
            ...(send.key ? { authorization: `Bearer ${send.key}` } : {}),
          },
          dispatcher: this.dispatcher,
          signal,
          headersTimeout: this.timeoutMs,
          bodyTimeout: this.timeoutMs,
        });
        const header = (n: string) => {
          const v = res.headers[n];
          return Array.isArray(v) ? v[0] : v;
        };
        if (res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304) {
          await res.body.dump();
          // A request that carries a key is never redirected, the same site included (R290 a).
          if (send.key) throw new LookupHttpError("The metadata service redirected a request that carries a key; not followed", res.statusCode);
          const loc = header("location");
          if (!loc || hop >= MAX_REDIRECTS) throw new LookupHttpError("The metadata service redirected too often", res.statusCode);
          const next = new URL(loc, current);
          if (next.origin !== current.origin) throw new LookupHttpError("The metadata service redirected to another site; not followed", res.statusCode);
          current = next;
          continue;
        }
        if (res.statusCode === 429) {
          const remaining = wholeNumber(header("x-ratelimit-remaining"));
          const reset = wholeNumber(header("x-ratelimit-reset"));
          const retryAfter = header("retry-after")?.slice(0, 100);
          const body = await readStart(res.body, RATE_LIMIT_BODY_BYTES);
          const rateLimit: RateLimitAnswer = {
            ...(remaining !== undefined ? { remaining } : {}),
            ...(reset !== undefined ? { reset } : {}),
            ...(retryAfter !== undefined ? { retryAfter } : {}),
            body,
          };
          return { status: 429, body: null, retryAfter, rateLimit };
        }
        if (res.statusCode !== 200) {
          await res.body.dump();
          return { status: res.statusCode, body: null, retryAfter: header("retry-after") };
        }
        return { status: 200, body: await readBounded(res.body) };
      } finally {
        giveBack();
      }
    }
  }
}

/**
 * True when `body` holds a value of the private query, as sent or percent-encoded, in any letter case, in the body as
 * received or with its `\uXXXX` escapes decoded (R261).
 */
function echoesQuery(body: string, query: Readonly<Record<string, string>> | undefined): boolean {
  if (!query) return false;
  const lower = body.toLowerCase();
  const decoded = body.replace(/\\u([0-9a-fA-F]{4})/gu, (_m, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase();
  return Object.values(query).some((v) => {
    if (v.length === 0) return false;
    const want = v.toLowerCase();
    const enc = encodeURIComponent(v).toLowerCase();
    return lower.includes(want) || lower.includes(enc) || decoded.includes(want) || decoded.includes(enc);
  });
}

/** A Retry-After (or Backoff) header — seconds or an HTTP date — in milliseconds from `now`; undefined when absent or unreadable. */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

/** The first `max` bytes of a body (as text); the rest is not read. Never throws. */
async function readStart(body: AsyncIterable<Buffer | Uint8Array> & { destroy?: (e?: Error) => void }, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const c of body) {
      chunks.push(Buffer.from(c));
      size += c.length;
      if (size >= max) {
        body.destroy?.();
        break;
      }
    }
  } catch {
    // A body that breaks off is read as far as it came.
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

async function readBounded(body: AsyncIterable<Buffer | Uint8Array> & { destroy?: (e?: Error) => void }): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      body.destroy?.();
      throw new LookupHttpError("The metadata service's response is too large");
    }
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks).toString("utf8");
}
