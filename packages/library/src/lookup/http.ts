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
 *  - 429 / 5xx / network errors: 3 retries with exponential backoff (0.5 s, 1 s, 2 s), or the
 *    server's Retry-After, capped (default 60 s).
 *  - Redirects are followed (at most 3) only within the same origin.
 *  - User-Agent `AlexandrineOxiana/<version> (+https://github.com/maquiscatta-sys/AlexandrineOxiana)`;
 *    `; mailto:<email>` is added inside the parentheses only when the user set a contact email.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { request, type Dispatcher } from "undici";
import { writeFileAtomic } from "../fs/atomic.js";

const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
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
};
const DEFAULT_RATE = 1;
const DAY_MS = 86_400_000;
/** Not-found answers are kept this long at most (a DOI may be registered tomorrow). */
const NEGATIVE_TTL_MS = DAY_MS;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MEMORY_ENTRIES = 2000;
// A deliberately simple shape check; anything with whitespace, control characters, brackets or
// semicolons is refused so the address can never change the header's structure.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** A lookup request that failed (after retries), or a response the client refused. */
export class LookupHttpError extends Error {
  override name = "LookupHttpError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HttpClientOptions {
  /** The library root; the cache lives in `<root>/.cache/lookups/`. */
  libraryRoot: string;
  /** The researcher's contact email from settings (polite-pool etiquette); omitted when unset. */
  contactEmail?: string;
  /** undici dispatcher (tests pass a MockAgent). */
  dispatcher?: Dispatcher;
  /** Milliseconds since the epoch (rate limits and cache age). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateLimits?: Record<string, number>;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Cap on a server's Retry-After (default 60 s). */
  maxRetryAfterMs?: number;
  /** First backoff step (default 500 ms; doubled per retry). */
  backoffMs?: number;
  timeoutMs?: number;
  /** Overall deadline of one attempt, redirects and body included (default 60 s). */
  attemptTimeoutMs?: number;
}

export interface GetOptions {
  /** Identifies the request in the cache; the file name is its sha256. */
  cacheKey: string;
  ttlDays?: number;
  /** Lookup made for an encrypted project: memory cache only, nothing written to disk. Default true (fail-closed). */
  sensitive?: boolean;
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
  readonly userAgent: string;
  private readonly cacheDir: string;
  private readonly dispatcher?: Dispatcher;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rates: Record<string, number>;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly nextSlot = new Map<string, number>();
  private readonly hostQueue = new Map<string, Promise<unknown>>();

  constructor(opts: HttpClientOptions) {
    const email = opts.contactEmail?.trim();
    this.userAgent = email && EMAIL_RE.test(email) ? `AlexandrineOxiana/${VERSION} (+${PROJECT_URL}; mailto:${email})` : USER_AGENT;
    this.cacheDir = join(opts.libraryRoot, ".cache", "lookups");
    this.dispatcher = opts.dispatcher;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.rates = { ...DEFAULT_RATE_LIMITS, ...opts.rateLimits };
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.backoffMs = opts.backoffMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
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

    const res = await this.fetchWithRetries(url);
    if (res.body !== null) validate?.(res.body); // throws: nothing is cached
    const entry: CacheEntry = { v: 1, storedAt: this.clock(), status: res.status, body: res.body };
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
    try {
      const parent = join(this.cacheDir, "..");
      await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
      if (!(await this.realDir(parent))) return;
      await fsp.mkdir(this.cacheDir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      // Never chmod or write through a symlink planted in place of the cache directory.
      if (!(await this.realDir(this.cacheDir))) return;
      if (process.platform !== "win32") await fsp.chmod(this.cacheDir, 0o700);
      await writeFileAtomic(join(this.cacheDir, `${name}.json`), JSON.stringify(e), { mode: 0o600 });
    } catch {
      // The cache is an optimisation: a read-only or full disk only costs a repeat lookup.
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

  private retryDelay(attempt: number, retryAfter: string | undefined): number {
    const ms = retryAfterMs(retryAfter, this.clock());
    if (ms !== undefined) return Math.min(ms, this.maxRetryAfterMs);
    return this.backoffMs * 2 ** attempt;
  }

  private async fetchWithRetries(url: string): Promise<{ status: 200 | 404; body: string | null }> {
    let lastError: LookupHttpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Awaited<ReturnType<HttpClient["fetchFollowingRedirects"]>> | undefined;
      try {
        res = await this.fetchFollowingRedirects(url);
      } catch (e) {
        if (e instanceof LookupHttpError) throw e; // refused redirect or oversized body: not retryable
        lastError = new LookupHttpError(`The metadata service could not be reached: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res) {
        if (res.status === 200) return { status: 200, body: res.body };
        if (res.status === 404 || res.status === 410) return { status: 404, body: null };
        lastError = new LookupHttpError(`The metadata service answered HTTP ${res.status}`, res.status);
        if (res.status !== 429 && res.status < 500) throw lastError;
      }
      if (attempt < this.maxRetries) await this.sleep(this.retryDelay(attempt, res?.retryAfter));
    }
    throw lastError!;
  }

  /** One attempt; its deadline starts once the first rate-limit slot is granted (queueing is not counted). */
  private async fetchFollowingRedirects(url: string): Promise<{ status: number; body: string | null; retryAfter?: string }> {
    let current = new URL(url);
    let signal: AbortSignal | undefined;
    for (let hop = 0; ; hop++) {
      await this.throttle(current.hostname);
      signal ??= AbortSignal.timeout(this.attemptTimeoutMs);
      const res = await request(current, {
        method: "GET",
        headers: { "user-agent": this.userAgent, accept: "application/json, application/xml;q=0.9, */*;q=0.1" },
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
        const loc = header("location");
        if (!loc || hop >= MAX_REDIRECTS) throw new LookupHttpError("The metadata service redirected too often", res.statusCode);
        const next = new URL(loc, current);
        if (next.origin !== current.origin) throw new LookupHttpError("The metadata service redirected to another site; not followed", res.statusCode);
        current = next;
        continue;
      }
      if (res.statusCode !== 200) {
        await res.body.dump();
        return { status: res.statusCode, body: null, retryAfter: header("retry-after") };
      }
      return { status: 200, body: await readBounded(res.body) };
    }
  }
}

/** A Retry-After (or Backoff) header — seconds or an HTTP date — in milliseconds from `now`; undefined when absent or unreadable. */
export function retryAfterMs(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,10}$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
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
