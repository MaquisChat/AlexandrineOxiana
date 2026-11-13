/**
 * FakeZotero: an in-memory Zotero account that answers the Zotero Web API v3 requests this app makes.
 * TEST CODE ONLY (nothing under src/ may import it).
 *
 * How it is used
 *   - Unit tests pass `fake.agent` (an undici MockAgent with disableNetConnect) as the `dispatcher` of the
 *     code under test. It answers for https://api.zotero.org and for the file host (`redirectHost`); any
 *     other host cannot be reached.
 *   - End-to-end tests (task Z11) put `fakeZoteroHandler(fake)` behind a loopback HTTP server. The handler is
 *     pure: it takes a request and returns a response. Storage paths (`/zoterofilestorage/...`) are told
 *     apart from API paths by their path alone, so one origin can serve both.
 *
 * Where each behaviour comes from (see the report for the full table). Documentation pages:
 *   [basics]  https://www.zotero.org/support/dev/web_api/v3/basics
 *   [syncing] https://www.zotero.org/support/dev/web_api/v3/syncing
 *   [upload]  https://www.zotero.org/support/dev/web_api/v3/file_upload  (the part on downloading)
 * Where the documents are silent the comment says "INFERRED" (what the existing client in
 * src/import/zotero-web.ts expects, or what the live service is known to do) or "UNCONFIRMED".
 *
 * Safety: every request is recorded in `requests` with the key's value replaced by KEY_MARKER; any
 * method but GET answers 405 and changes nothing; a path the model does not serve answers 501 with a
 * plain message, never a 200 ("not modelled by the stand-in": the real API may well accept it).
 *
 * EVERY TEST FILE THAT USES THE STAND-IN MUST CALL `guardNetwork()` (in beforeAll, restoring in afterAll):
 * it makes the global dispatcher refuse every connection, so a request made without `fake.agent` fails
 * instead of reaching the real network.
 *
 * The key's value is redacted (KEY_MARKER) in the recorded path and headers, in every answer body, and in
 * the message and stack of an error that comes out of this agent (an unmounted host, a dropped connection).
 * What it cannot prevent: an error raised by undici outside this agent (another dispatcher, the global one
 * when guardNetwork is not used) puts the full request path in its own message; and only the configured key
 * is known to the redactor, so a different key value in a path is redacted only where it was sent as a
 * credential (header, `key=`).
 *
 * Known disagreements between the documents (kept as the documents leave them):
 *   - single-object `If-Modified-Since-Version`: [basics] says it is not supported, [syncing] says the object's
 *     own 304 applies. The stand-in ignores it (follows [basics]).
 *   - `If-Unmodified-Since-Version` is documented for WRITES only ([syncing]); applying it to reads is
 *     INFERRED from the client. `honourIfUnmodifiedSince = false` ignores it on reads (the client must stay
 *     correct through Last-Modified-Version either way).
 * NOT MODELLED (unconfirmed or out of scope): collections in the bin, `links.enclosure` on attachments,
 * `meta.numItems` on collections, the 60-second expiry of the file URL, `rel="alternate"` links, sort/q/tag
 * and other documented query parameters, `/collections/<k>`, `/searches`, `/tags`, `/keys/<key>`.
 */
import { createHash } from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { buildZip } from "../../../../tests/fixtures/generate.mjs";

/** Makes the global dispatcher refuse every connection; the returned function restores the old one. */
export function guardNetwork(): () => void {
  const previous = getGlobalDispatcher();
  const guard = new MockAgent();
  guard.disableNetConnect();
  setGlobalDispatcher(guard);
  return () => {
    setGlobalDispatcher(previous);
    void guard.close();
  };
}

export const KEY_MARKER = "[key]";
const API_ORIGIN = "https://api.zotero.org";
const DEFAULT_REDIRECT_HOST = "zoterofilestorage.s3.amazonaws.com";
const STORAGE_PREFIX = "/zoterofilestorage/";
const DEFAULT_KEY = "FakeZoteroKeyAbCd0123456";
/** Zotero's item/collection key alphabet (no 0, 1, O, I-lookalikes: this is the set the real service uses). */
const KEY_ALPHABET = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const DEFAULT_LIMIT = 25; // [basics] limit: default 25
const MAX_LIMIT = 100; // [basics] limit: 1-100

/** The fields of an item's `data` that tests commonly set; any other field passes through. */
export interface ZoteroItemData {
  itemType: string;
  title?: string;
  creators?: Array<Record<string, unknown>>;
  tags?: Array<{ tag: string; type?: number }>;
  collections?: string[];
  relations?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
  /** Extension for servers: break the connection instead of answering (see dropConnectionOnPage). */
  drop?: true;
  /** Extension for servers: send the status, headers and the first half of the body, then break the connection. */
  cut?: true;
}

/** How a file or the file host fails: an HTTP status, a connection dropped before any answer, or cut in mid-body. */
export type StorageFailure = 403 | 404 | 500 | "drop" | "cut";
export type FileFailure = { api?: 403 | 404 | 500; storage?: StorageFailure; times?: number };

type Host = "api" | "storage" | undefined;

interface StoredFile {
  bytes: Uint8Array;
  compressed: boolean;
  storage: "zotero" | "webdav";
  /** An older copy that /file serves although it does not match the item's md5. */
  stale?: Uint8Array;
  /** A redirect base for this file alone (absolute URL ending in "/"). */
  redirect?: string;
  fail?: FileFailure & { left: number };
}
interface Item {
  key: string;
  version: number;
  data: Record<string, unknown>;
  file?: StoredFile;
}
interface Collection {
  key: string;
  version: number;
  data: Record<string, unknown>;
}
interface Library {
  ref: string;
  type: "user" | "group";
  id: number;
  name?: string;
  /** Group only: the group's own version (moves when it is renamed) and its type. */
  groupVersion: number;
  groupType: "Private" | "PublicClosed" | "PublicOpen";
  /** Group only: anyone may read the library, key or no key. */
  publicRead?: boolean;
  version: number;
  items: Map<string, Item>;
  collections: Map<string, Collection>;
  deletions: Array<{ kind: "items" | "collections"; key: string; version: number }>;
  tagColors?: Array<{ name: string; color: string }>;
}
interface Row {
  key: string;
  version: number;
  obj: unknown;
}

const text = (status: number, body: string, headers: Record<string, string> = {}): FakeResponse => ({
  status,
  headers: { "content-type": "text/plain", ...headers },
  body,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse => ({
  status,
  headers: { "content-type": "application/json", "zotero-api-version": "3", ...headers },
  body: JSON.stringify(body),
});
const notServed = (what: string): FakeResponse => text(501, `FakeZotero: ${what} is not modelled by the stand-in (the real API may serve it).`);

/** Deterministic timestamps: one second per library version from 2024-01-01. */
const stamp = (version: number): string => new Date(Date.UTC(2024, 0, 1) + version * 1000).toISOString().replace(".000Z", "Z");

const lower = (h: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]));

/** The path with the value of a `key` query parameter replaced, for the request log. */
const redactPath = (path: string): string => path.replace(/([?&]key=)[^&#]*/giu, `$1${KEY_MARKER}`);
const redactHeaders = (h: Record<string, string>): Record<string, string> => {
  const out = { ...h };
  if (out["zotero-api-key"] !== undefined) out["zotero-api-key"] = KEY_MARKER;
  if (out["authorization"] !== undefined) out["authorization"] = /^bearer\s/iu.test(out["authorization"]) ? `Bearer ${KEY_MARKER}` : KEY_MARKER;
  return out;
};

const keyAt = (n: number): string => {
  // A bijection on 0 .. 33^8 - 1 (7919 is coprime to 33), so keys look scattered but never repeat.
  let v = (n * 7919 + 12345) % 33 ** 8;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = KEY_ALPHABET[v % 33]! + out;
    v = Math.floor(v / 33);
  }
  return out;
};

const md5Hex = (b: Uint8Array | string): string => createHash("md5").update(b).digest("hex");

/** A MockAgent that can cut a response in mid-body (the reply callback calls `markCut`) and scrubs secrets from its errors. */
class StandInAgent extends MockAgent {
  private current: { cut: boolean } | undefined;
  constructor(private readonly scrub: (s: string) => string) {
    super();
  }
  markCut(): void {
    if (this.current) this.current.cut = true;
  }
  /**
   * An error that holds the key in its message or stack is replaced by a new error of the same name and
   * code (no `cause`, which could hold the key too). Any other error is passed on untouched: an error we did
   * not create is never mutated (an AbortError's message is read-only, and undici relies on its identity).
   */
  private clean<T>(e: T): T {
    if (!(e instanceof Error)) return e;
    const has = (s: string | undefined) => s !== undefined && this.scrub(s) !== s;
    if (!has(e.message) && !has(e.stack)) return e;
    const w = new Error(this.scrub(e.message));
    Object.defineProperty(w, "name", { value: e.name, configurable: true, writable: true });
    const code = (e as { code?: unknown }).code;
    if (code !== undefined) Object.defineProperty(w, "code", { value: code, configurable: true, writable: true });
    w.stack = this.scrub(e.stack ?? `${e.name}: ${w.message}`);
    return w as unknown as T;
  }
  override dispatch(opts: any, handler: any): boolean {
    const ctx = { cut: false };
    this.current = ctx;
    let sent = 0;
    const wrapped = {
      onRequestStart: (...a: unknown[]) => handler.onRequestStart?.(...a),
      onRequestUpgrade: (...a: unknown[]) => handler.onRequestUpgrade?.(...a),
      onResponseStart: (...a: unknown[]) => handler.onResponseStart?.(...a),
      onResponseData: (c: unknown, d: Buffer) => {
        if (!ctx.cut) return handler.onResponseData?.(c, d);
        handler.onResponseData?.(c, d.subarray(0, Math.max(1, Math.floor(d.length / 2))));
        sent++;
        // Like a real broken connection, the error comes after the headers and the first bytes have been
        // handed over (undici's fetch loses an error that arrives in the same tick as its response). KNOWN
        // LIMIT: undici's `fetch` with redirect "follow", cut on the hop AFTER a redirect, never settles under
        // a mock (reproduced with a plain wrapper, so not specific to this code): fetch the file URL itself,
        // or use `request`.
        setImmediate(() => handler.onResponseError?.(c, new Error("FakeZotero: the connection was cut in the middle of the body")));
        return undefined;
      },
      onResponseEnd: (...a: unknown[]) => (ctx.cut && sent ? undefined : handler.onResponseEnd?.(...a)),
      onResponseError: (c: unknown, e: unknown) => handler.onResponseError?.(c, this.clean(e)),
    };
    try {
      return super.dispatch(opts, wrapped as never);
    } catch (e) {
      throw this.clean(e);
    } finally {
      this.current = undefined;
    }
  }
}

export class FakeZotero {
  /** The API key this account accepts. */
  readonly key: string;
  readonly userId: number;
  readonly agent: MockAgent;
  /**
   * Whether a GET honours If-Unmodified-Since-Version (412 when the library moved on). Default true. The
   * documents give the header for writes only, so a test can switch it off to prove the client still
   * notices a change through Last-Modified-Version.
   */
  honourIfUnmodifiedSince = true;
  /** Every request seen (API and storage), key values replaced by KEY_MARKER. */
  readonly requests: Array<{ method: string; path: string; headers: Record<string, string> }> = [];

  private readonly libs = new Map<string, Library>();
  private counter = 0;
  private revoked = false;
  private access: { library: boolean; files: boolean; notes: boolean; write: boolean; groups: Record<string, { library: boolean; write: boolean }> | "all" } = {
    library: true,
    files: true,
    notes: true,
    write: false,
    groups: "all",
  };
  private pendingBackoff: number | undefined;
  private failing: { left: number; status: 429 | 500 | 503; retryAfter?: number } | undefined;
  private dropPage: { n: number; path?: string; mode: "before" | "midBody" } | undefined;
  private storageFailure: { mode: StorageFailure; left: number } | undefined;
  /** The redirect base of the account: scheme, host and path prefix, ending in "/". */
  private base = `https://${DEFAULT_REDIRECT_HOST}${STORAGE_PREFIX}`;
  private readonly mounted = new Set<string>();
  /** Path prefixes that mean "file storage" on a server that serves API and storage on one origin. */
  private readonly prefixes = new Set<string>([STORAGE_PREFIX]);
  private readonly tokens = new Map<string, { ref: string; key: string }>();

  constructor(o: { userId?: number; key?: string; honourIfUnmodifiedSince?: boolean } = {}) {
    this.userId = o.userId ?? 42;
    this.key = o.key ?? DEFAULT_KEY;
    this.honourIfUnmodifiedSince = o.honourIfUnmodifiedSince ?? true;
    const agent = new StandInAgent((s) => this.scrub(s));
    this.agent = agent;
    this.agent.disableNetConnect();
    this.libs.set(`user:${this.userId}`, this.newLib("user", this.userId));
    this.mount(API_ORIGIN, "api");
    this.mountBase(this.base);
  }

  /** The host (and port) the 302 from `/items/<key>/file` points at; the scheme and path stay as they were (https and "/zoterofilestorage/" by default). */
  get redirectHost(): string {
    return new URL(this.base).host;
  }
  set redirectHost(h: string) {
    const u = new URL(this.base);
    this.redirectBase = `${u.protocol}//${h}${u.pathname}`;
  }

  /**
   * Where the 302 points: scheme, host, port and path prefix; the file's token and `?sig=x` follow it.
   * Default `https://zoterofilestorage.s3.amazonaws.com/zoterofilestorage/`. Setting it mounts that origin on
   * the agent and teaches the handler the path prefix (a prefix of "/" is served by the agent only, because a
   * single-origin server could not tell it from the API). A file can override it (addItem `file.redirect`).
   */
  get redirectBase(): string {
    return this.base;
  }
  set redirectBase(b: string) {
    this.base = this.mountBase(b);
  }

  private mountBase(b: string): string {
    const u = new URL(b);
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    u.search = "";
    u.hash = "";
    if (/^\/(users|groups|keys)\//u.test(u.pathname)) throw new Error("FakeZotero: a storage path may not overlap the API's paths");
    if (u.origin === API_ORIGIN) throw new Error("FakeZotero: storage cannot share the API origin (the agent and the handler would disagree)");
    this.mount(u.origin, "storage");
    this.prefixes.add(u.pathname);
    return u.href;
  }

  /** Redacts the key's value from any text (never the marker itself). */
  private scrub(s: string): string {
    const plain = s.split(this.key).join(KEY_MARKER);
    // A key written with percent-escapes is redacted too (the text then comes back decoded).
    try {
      const decoded = decodeURIComponent(plain);
      if (decoded !== plain && decoded.includes(this.key)) return decoded.split(this.key).join(KEY_MARKER);
    } catch {
      // not valid percent-encoding: nothing more to do
    }
    return plain;
  }

  private mount(origin: string, host: "api" | "storage"): void {
    if (this.mounted.has(origin)) return;
    this.mounted.add(origin);
    this.agent
      .get(origin)
      .intercept({ path: () => true, method: () => true })
      .reply((opts) => {
        const h: Record<string, string> = {};
        const raw = opts.headers as Record<string, unknown> | unknown[] | undefined;
        if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) h[String(raw[i])] = String(raw[i + 1]);
        else if (raw) for (const [k, v] of Object.entries(raw)) h[k] = Array.isArray(v) ? String(v[0]) : String(v);
        const r = this.serve({ method: String(opts.method), path: opts.path, headers: h }, host);
        if (r.drop) throw new Error("FakeZotero: the connection was dropped on purpose");
        if (r.cut) (this.agent as StandInAgent).markCut();
        return { statusCode: r.status, data: typeof r.body === "string" ? r.body : Buffer.from(r.body), responseOptions: { headers: r.headers } };
      })
      .persist();
  }

  // ---- the model: what a test sets up -------------------------------------------------------------

  libraryVersion(ref: string): number {
    return this.lib(ref).version;
  }

  /** Adds an item (a child when `opts.parent` is given). Every write bumps the library version; the new object takes it. */
  addItem(
    ref: string,
    item: Partial<ZoteroItemData> & { itemType: string },
    opts: {
      parent?: string;
      file?: {
        bytes: Uint8Array;
        md5?: string;
        compressed?: boolean;
        storage?: "zotero" | "webdav";
        /** /file serves these older bytes (ETag of them) although the item's md5 is that of `bytes`. */
        stale?: Uint8Array;
        /** A redirect base for this file alone, as for `redirectBase`. */
        redirect?: string;
      };
    } = {},
  ): string {
    const lib = this.lib(ref);
    if (opts.parent && !lib.items.has(opts.parent)) throw new Error(`FakeZotero: no parent item ${opts.parent} in ${ref}`);
    if (opts.file && item.itemType !== "attachment") throw new Error("FakeZotero: only an attachment can have a file");
    const v = ++lib.version;
    const key = this.nextKey();
    const defaults: Record<string, unknown> = opts.file ? { linkMode: "imported_file", filename: `${key}.bin`, contentType: "application/octet-stream" } : {};
    const data: Record<string, unknown> = {
      collections: [],
      tags: [],
      relations: {},
      ...defaults,
      ...Object.fromEntries(Object.entries(item).filter(([, x]) => x !== undefined)),
      key,
      version: v,
      ...(opts.parent ? { parentItem: opts.parent } : {}),
    };
    data.dateAdded ??= stamp(v);
    data.dateModified = stamp(v);
    const stored: Item = { key, version: v, data };
    if (opts.file) {
      const storage = opts.file.storage ?? "zotero";
      stored.file = {
        bytes: opts.file.bytes,
        compressed: opts.file.compressed ?? false,
        storage,
        ...(opts.file.stale ? { stale: opts.file.stale } : {}),
        ...(opts.file.redirect ? { redirect: this.mountBase(opts.file.redirect) } : {}),
      };
      data.mtime = Date.UTC(2024, 0, 1) + v * 1000;
      // [upload] "md5 and mtime can be edited directly in personal libraries for WebDAV-based file syncing":
      // a WebDAV attachment carries md5 and mtime too. Its /file answers 404 (INFERRED), or, with `stale`,
      // an older copy in Zotero storage whose checksum differs ([upload]: "the latest version of the file
      // may be available only via WebDAV").
      data.md5 = opts.file.md5 ?? md5Hex(opts.file.bytes);
    }
    lib.items.set(key, stored);
    return key;
  }

  /** Changes fields of an item (a value of undefined removes the field). */
  editItem(ref: string, key: string, patch: Record<string, unknown>): void {
    const lib = this.lib(ref);
    const it = this.item(lib, key);
    const v = ++lib.version;
    for (const [k, x] of Object.entries(patch)) {
      if (x === undefined) delete it.data[k];
      else it.data[k] = x;
    }
    this.touch(it, v);
  }

  /** Moves an item to the bin: `data.deleted = 1`, new version. */
  trash(ref: string, key: string): void {
    const lib = this.lib(ref);
    const it = this.item(lib, key);
    if (it.data.deleted) return;
    const v = ++lib.version;
    it.data.deleted = 1;
    this.touch(it, v);
  }

  restore(ref: string, key: string): void {
    const lib = this.lib(ref);
    const it = this.item(lib, key);
    if (!it.data.deleted) return;
    const v = ++lib.version;
    delete it.data.deleted;
    this.touch(it, v);
  }

  /** Deletes an item for good (emptying the bin) with everything under it; they are listed in `/deleted`. */
  remove(ref: string, key: string): void {
    const lib = this.lib(ref);
    this.item(lib, key);
    const v = ++lib.version;
    const doomed = new Set([key]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const it of lib.items.values()) {
        const p = it.data.parentItem;
        if (typeof p === "string" && doomed.has(p) && !doomed.has(it.key)) {
          doomed.add(it.key);
          grew = true;
        }
      }
    }
    for (const k of doomed) {
      lib.items.delete(k);
      lib.deletions.push({ kind: "items", key: k, version: v });
    }
  }

  addCollection(ref: string, name: string, parent?: string): string {
    const lib = this.lib(ref);
    if (parent && !lib.collections.has(parent)) throw new Error(`FakeZotero: no collection ${parent} in ${ref}`);
    const v = ++lib.version;
    const key = this.nextKey();
    lib.collections.set(key, { key, version: v, data: { key, version: v, name, parentCollection: parent ?? false, relations: {} } });
    return key;
  }

  /** Deletes a collection and its subcollections; items lose the membership (and take the new version). */
  removeCollection(ref: string, key: string): void {
    const lib = this.lib(ref);
    if (!lib.collections.has(key)) throw new Error(`FakeZotero: no collection ${key} in ${ref}`);
    const v = ++lib.version;
    const doomed = new Set([key]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of lib.collections.values()) {
        const p = c.data.parentCollection;
        if (typeof p === "string" && doomed.has(p) && !doomed.has(c.key)) {
          doomed.add(c.key);
          grew = true;
        }
      }
    }
    for (const k of doomed) {
      lib.collections.delete(k);
      lib.deletions.push({ kind: "collections", key: k, version: v });
    }
    for (const it of lib.items.values()) {
      const cs = it.data.collections;
      if (Array.isArray(cs) && cs.some((c) => doomed.has(String(c)))) {
        it.data.collections = cs.filter((c) => !doomed.has(String(c)));
        this.touch(it, v);
      }
    }
  }

  setTagColors(ref: string, colors: Array<{ name: string; color: string }>): void {
    const lib = this.lib(ref);
    lib.version++;
    lib.tagColors = colors;
  }

  /**
   * Adds a group library the account belongs to. A public group (`type` PublicClosed or PublicOpen) is listed
   * by /users/<id>/groups even when the key has no permission for it ([basics]); whether its /items then
   * answers without that permission is a point the pages leave open for a key without permission: by default
   * the stand-in answers 403; with `publicRead: true` anyone may read the library with no key at all ([basics]:
   * "Authentication is not required for read access to public libraries"). Which of the two the real service
   * does for a key WITHOUT permission is on the real-account list.
   */
  addGroup(id: number, name: string, opts: { type?: "Private" | "PublicClosed" | "PublicOpen"; publicRead?: boolean } = {}): void {
    const ref = `group:${id}`;
    if (this.libs.has(ref)) throw new Error(`FakeZotero: ${ref} exists`);
    const lib = this.newLib("group", id, name);
    lib.groupType = opts.type ?? "Private";
    if (opts.publicRead) lib.publicRead = true;
    this.libs.set(ref, lib);
  }

  /** Renames a group; the group's own version moves (it is not the library version). */
  renameGroup(id: number, name: string): void {
    const lib = this.lib(`group:${id}`);
    lib.name = name;
    lib.groupVersion++;
  }

  /** The group is gone: its library answers 404 (UNCONFIRMED; the documents do not say) and it is no longer listed. */
  removeGroup(id: number): void {
    this.lib(`group:${id}`);
    this.libs.delete(`group:${id}`);
  }

  /**
   * One file (an attachment) fails by itself, until cleared with `null` or after `times` answers (default
   * for ever). `api`: the answer on `/items/<key>/file` (403, 404, 500). `storage`: what the file host answers
   * for it (403, 404, 500, "drop" the connection, "cut" in mid-body). Everything else keeps working.
   */
  failFile(ref: string, key: string, f: FileFailure | null): void {
    const it = this.item(this.lib(ref), key);
    if (!it.file) throw new Error(`FakeZotero: ${key} has no file`);
    if (f === null) delete it.file.fail;
    else it.file.fail = { ...f, left: f.times ?? Infinity };
  }

  /** The file host fails for every file (see failFile for the modes), `times` answers or until `null`. */
  failStorage(mode: StorageFailure | null, times?: number): void {
    this.storageFailure = mode === null ? undefined : { mode, left: times ?? Infinity };
  }

  /** What the key may do (merged into what it could do before). Defaults: read everything, no write, all groups. */
  setKeyAccess(a: { library?: boolean; files?: boolean; notes?: boolean; write?: boolean; groups?: Record<string, { library: boolean; write: boolean }> | "all" }): void {
    this.access = { ...this.access, ...Object.fromEntries(Object.entries(a).filter(([, x]) => x !== undefined)) };
  }

  /** From now on the key is refused with 403 everywhere. */
  revokeKey(): void {
    this.revoked = true;
  }

  /** The next API response carries `Backoff: <seconds>` ([basics]: it can appear on any response); later ones do not. */
  backoffOnce(seconds: number): void {
    this.pendingBackoff = seconds;
  }

  /** The next `n` API requests answer `status`, with `Retry-After` when given ([basics]: 429 and 503 may carry it). */
  failNext(n: number, status: 429 | 500 | 503, retryAfter?: number): void {
    this.failing = { left: n, status, ...(retryAfter !== undefined ? { retryAfter } : {}) };
  }

  /**
   * The connection breaks, once, on the request for page `n` of a JSON item listing. A "page" is
   * start / limit + 1 of any item list request (/items, /items/top, /items/trash, .../children) with
   * format=json; `o.path` restricts it to listings whose path (without the query) equals it; `o.mode`
   * "before" (default) breaks before any answer, "midBody" sends the headers and half the JSON, then breaks.
   */
  dropConnectionOnPage(n: number, o: { path?: string; mode?: "before" | "midBody" } = {}): void {
    this.dropPage = { n, ...(o.path ? { path: o.path } : {}), mode: o.mode ?? "before" };
  }

  // ---- serving -------------------------------------------------------------------------------------

  /** Answers one request. `host` says which host the request reached; undefined (a loopback server) serves both. */
  serve(req: FakeRequest, host: Host): FakeResponse {
    const headers = lower(req.headers);
    this.requests.push({ method: req.method, path: this.scrub(redactPath(req.path)), headers: this.scrubHeaders(redactHeaders(headers)) });
    let url: URL;
    try {
      url = new URL(req.path, "https://fake.invalid");
    } catch {
      return text(400, "FakeZotero: the path could not be read.");
    }
    // Storage is told apart by host when the agent says so, otherwise by the configured path prefixes.
    const onStorage = host === "storage" || (host === undefined && [...this.prefixes].some((p) => p !== "/" && url.pathname.startsWith(p)));
    const apiHostStoragePath = host === "api" && [...this.prefixes].some((p) => p !== "/" && url.pathname.startsWith(p));
    let res: FakeResponse;
    if (req.method !== "GET") res = text(405, "FakeZotero: only GET is served; the app must never write to Zotero.", { allow: "GET" });
    else if (apiHostStoragePath) res = notServed(`${url.pathname} on the API host`);
    else if (onStorage) res = this.storage(url);
    else res = this.api(url, headers);
    if (!onStorage && this.pendingBackoff !== undefined && !res.drop) {
      res.headers["backoff"] = String(this.pendingBackoff);
      this.pendingBackoff = undefined;
    }
    // The key's value never leaves in a body or a header (an unknown path is echoed in the 501 message).
    if (typeof res.body === "string") res.body = this.scrub(res.body);
    return res;
  }

  private scrubHeaders(h: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, this.scrub(v)]));
  }

  private api(url: URL, h: Record<string, string>): FakeResponse {
    if (this.failing && this.failing.left > 0) {
      this.failing.left--;
      const { status, retryAfter } = this.failing;
      return text(status, `FakeZotero: failing on purpose (${status}).`, retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {});
    }
    // [basics] Invalid keys or insufficient privileges return 403. The key may come in a header or `key=`.
    const bearer = /^bearer\s+(.+)$/iu.exec(h["authorization"] ?? "")?.[1];
    const given = h["zotero-api-key"] ?? bearer ?? url.searchParams.get("key") ?? undefined;
    const seg = url.pathname.split("/").filter(Boolean);
    // [basics] "Authentication is not required for read access to public libraries": a group added with
    // `publicRead` answers a request that carries no key at all. (A key that is given but wrong or revoked is
    // still 403: UNCONFIRMED.)
    const anonymous = given === undefined && seg[0] === "groups" && this.libs.get(`group:${seg[1]}`)?.publicRead === true;
    if (!anonymous && (this.revoked || given === undefined || given !== this.key)) return text(403, "Forbidden");
    if (seg[0] === "keys" && seg[1] === "current" && seg.length === 2) return this.keyInfo(url);
    if (seg[0] === "users" && seg[2] === "groups" && seg.length === 3) return this.groups(url, seg[1]!);
    if ((seg[0] === "users" || seg[0] === "groups") && /^\d+$/u.test(seg[1] ?? "")) {
      const type = seg[0] === "users" ? "user" : "group";
      const lib = this.libs.get(`${type}:${seg[1]}`);
      if (!lib) return type === "group" ? text(404, "Not Found") : text(403, "Forbidden");
      if (!this.mayRead(lib)) return text(403, "Forbidden");
      return this.library(url, h, lib, seg.slice(2));
    }
    return notServed(url.pathname);
  }

  private mayRead(lib: Library): boolean {
    if (lib.publicRead) return true;
    if (lib.type === "user") return lib.id === this.userId && this.access.library;
    return this.access.groups === "all" || this.access.groups[String(lib.id)]?.library === true;
  }

  private keyInfo(url: URL): FakeResponse {
    const bad = this.badParams(url, ["key", "v"]);
    if (bad) return bad;
    const a = this.access;
    // [syncing] documents /keys/current with an example (userID, username, access.user.{library,files,notes,write},
    // access.groups.all.{library,write}). UNCONFIRMED: the per-group shape ({ "<id>": {library, write} }) and the
    // shape of a key with no group access (here `groups: {}`).
    const groups = a.groups === "all" ? { all: { library: true, write: a.write } } : a.groups;
    return json(200, { key: this.key, userID: this.userId, username: "fake-user", access: { user: { library: a.library, files: a.files, notes: a.notes, write: a.write }, groups } });
  }

  private groups(url: URL, userId: string): FakeResponse {
    if (Number(userId) !== this.userId) return text(403, "Forbidden");
    const rows: Row[] = [];
    for (const lib of this.libs.values()) {
      if (lib.type !== "group") continue;
      // [basics] /users/<id>/groups: "the set of groups the current API key has access to, including public
      // groups the key owner belongs to even if the key doesn't have explicit permissions for them".
      const isPublic = lib.groupType !== "Private";
      if (!isPublic && !this.mayRead(lib)) continue;
      const v = lib.groupVersion;
      rows.push({
        key: String(lib.id),
        version: v,
        obj: {
          id: lib.id,
          version: v,
          links: {},
          meta: {},
          data: {
            id: lib.id,
            version: v,
            name: lib.name ?? `Group ${lib.id}`,
            owner: this.userId,
            type: lib.groupType,
            description: "",
            url: "",
            hasImage: 0,
            libraryEditing: "members",
            libraryReading: lib.groupType === "PublicOpen" ? "all" : "members",
            fileEditing: "members",
            members: [],
          },
        },
      });
    }
    rows.sort((x, y) => Number(x.key) - Number(y.key));
    return this.list(url, rows, ["limit", "start", "format", "key", "v"], {});
  }

  private library(url: URL, h: Record<string, string>, lib: Library, rest: string[]): FakeResponse {
    const stamped = (r: FakeResponse, v = lib.version): FakeResponse => {
      r.headers["last-modified-version"] = String(v);
      return r;
    };
    const base = ["key", "v"];
    const multi = ["since", "format", "include", "limit", "start", ...base];
    const itemQ = [...multi, "includeTrashed", "itemKey"];

    // [syncing] If-Unmodified-Since-Version: 412 when the library has been modified since the passed version.
    // INFERRED from the client (which pins every read with it); the page documents it for writes.
    const unmod = this.intHeader(h, "if-unmodified-since-version");
    if (unmod instanceof Object) return unmod;
    if (this.honourIfUnmodifiedSince && unmod !== undefined && lib.version > unmod) return stamped(text(412, "Precondition Failed"));
    // [basics][syncing] If-Modified-Since-Version: 304 when "data has not changed in the library since the
    // specified version". Library-wide, whatever the query; multi-object requests only (single-object
    // conditional requests are "not supported", so a single object ignores it).
    const mod = this.intHeader(h, "if-modified-since-version");
    if (mod instanceof Object) return mod;
    const multiObject = !(rest[0] === "items" && rest.length >= 2 && rest[1] !== "top" && rest[1] !== "trash" && rest[2] !== "children");
    const notModified = (): FakeResponse | undefined => (multiObject && mod !== undefined && lib.version <= mod ? stamped({ status: 304, headers: {}, body: "" }) : undefined);

    const [a, b, c] = rest;
    if (a === "items" && rest.length === 1) return notModified() ?? this.itemsList(url, lib, itemQ, "all");
    if (a === "items" && b === "top" && rest.length === 2) return notModified() ?? this.itemsList(url, lib, itemQ, "top");
    if (a === "items" && b === "trash" && rest.length === 2) return notModified() ?? this.itemsList(url, lib, itemQ, "trash");
    if (a === "items" && b && rest.length === 2) {
      const bad = this.badParams(url, ["format", "include", ...base]);
      if (bad) return bad;
      if ((url.searchParams.get("format") ?? "json") !== "json") return notServed("a single item in that format");
      const it = lib.items.get(b);
      if (!it) return text(404, "Not Found");
      if (this.hidden(lib, it)) return text(403, "Forbidden");
      return stamped(json(200, this.itemJson(lib, it)), it.version);
    }
    if (a === "items" && b && c === "children" && rest.length === 3) {
      if (!lib.items.has(b)) return text(404, "Not Found");
      return notModified() ?? this.itemsList(url, lib, itemQ, b);
    }
    if (a === "items" && b && c === "file" && rest.length === 3) {
      const bad = this.badParams(url, base);
      if (bad) return bad;
      return this.file(lib, b);
    }
    if (a === "collections" && (rest.length === 1 || (b === "top" && rest.length === 2))) {
      const pre = notModified();
      if (pre) return pre;
      const rows = [...lib.collections.values()]
        .filter((x) => b !== "top" || x.data.parentCollection === false)
        .map((x) => ({ key: x.key, version: x.version, obj: this.collJson(lib, x) }));
      return stamped(this.list(url, rows, multi, { sinceFilter: true }));
    }
    if (a === "deleted" && rest.length === 1) {
      const pre = notModified();
      if (pre) return pre;
      const bad = this.badParams(url, ["since", ...base]);
      if (bad) return bad;
      const since = this.intParam(url, "since") ?? 0;
      if (since instanceof Object) return since;
      // [syncing] GET /deleted?since=<version> -> { collections, searches, items, tags } of keys (tag names).
      const pick = (kind: "items" | "collections") => lib.deletions.filter((d) => d.kind === kind && d.version > since).map((d) => d.key);
      return stamped(json(200, { collections: pick("collections"), searches: [], items: pick("items"), tags: [] }));
    }
    if (a === "settings" && b === "tagColors" && rest.length === 2) {
      const bad = this.badParams(url, base);
      if (bad) return bad;
      // INFERRED from the client: 404 when no tag colours are set; otherwise { value, version }.
      if (!lib.tagColors) return stamped(text(404, "Not Found"));
      return stamped(json(200, { value: lib.tagColors, version: lib.version }));
    }
    return notServed(url.pathname);
  }

  /** Whether a note is hidden from this key (user library, key without notes access). UNCONFIRMED for annotations: they stay visible. */
  private hidden(lib: Library, it: Item): boolean {
    return lib.type === "user" && !this.access.notes && it.data.itemType === "note";
  }

  private itemsList(url: URL, lib: Library, allowed: string[], scope: "all" | "top" | "trash" | string): FakeResponse {
    const bad = this.badParams(url, allowed);
    if (bad) return bad;
    const trashed = url.searchParams.get("includeTrashed");
    if (trashed !== null && trashed !== "0" && trashed !== "1") return text(400, "FakeZotero: includeTrashed must be 0 or 1.");
    const include = url.searchParams.get("include");
    if (include !== null && include !== "data") return notServed(`include=${include.slice(0, 30)}`);
    const keys = url.searchParams.get("itemKey");
    const wanted = keys === null ? undefined : keys.split(",");
    if (wanted && wanted.length > 50) return text(400, "FakeZotero: at most 50 itemKey values.");
    let items = [...lib.items.values()].filter((it) => !this.hidden(lib, it));
    if (scope === "top") items = items.filter((it) => it.data.parentItem === undefined);
    else if (scope !== "all" && scope !== "trash") items = items.filter((it) => it.data.parentItem === scope);
    // [basics] includeTrashed: 0 or 1, default 0, except in /trash.
    if (scope === "trash") items = items.filter((it) => it.data.deleted);
    else if (trashed !== "1") items = items.filter((it) => !it.data.deleted);
    if (wanted) items = items.filter((it) => wanted.includes(it.key));
    // The JSON of an item is built only if the page holds it (a getter), with the child counts taken once per
    // request: building every item's JSON, each counting its children over the whole library, made a page cost
    // O(n²) (Task Z4's 24,000-object scale test). The answers are the same.
    let counts: Map<string, number> | undefined;
    const countsOf = () => (counts ??= this.childCounts(lib));
    const self = this;
    const rows: Row[] = items.map((it) => ({
      key: it.key,
      version: it.version,
      get obj() {
        return self.itemJson(lib, it, countsOf());
      },
    }));
    const format = url.searchParams.get("format") ?? "json";
    let cut = false;
    const dp = this.dropPage;
    if (format === "json" && dp !== undefined && (dp.path === undefined || dp.path === url.pathname)) {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
      const page = Math.floor(Number(url.searchParams.get("start") ?? 0) / limit) + 1;
      if (page === dp.n) {
        this.dropPage = undefined;
        if (dp.mode === "before") return { status: 0, headers: {}, body: "", drop: true };
        cut = true;
      }
    }
    const res = this.list(url, rows, allowed, { sinceFilter: true });
    res.headers["last-modified-version"] = String(lib.version);
    if (cut) res.cut = true;
    return res;
  }

  /**
   * The shared tail of every multi-object answer: `since`, `format` (json | versions | keys), paging and the
   * headers. [basics] limit 1-100 (default 25) and start; Total-Results is the number matched; a Link header
   * is added when results exceed the limit. [syncing] `format=versions` is "not limited by a maximum number of
   * results and returns all matching objects by default"; [basics] `format=keys` has no limit. UNCONFIRMED:
   * a limit above 100 is clamped to 100 (the page says only 1-100), and an explicit limit on versions/keys
   * is honoured.
   */
  private list(url: URL, all: Row[], allowed: string[], o: { sinceFilter?: boolean }): FakeResponse {
    const bad = this.badParams(url, allowed);
    if (bad) return bad;
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "versions" && format !== "keys") return notServed(`format=${format.slice(0, 30)}`);
    const since = this.intParam(url, "since");
    if (since instanceof Object) return since;
    const startP = this.intParam(url, "start");
    if (startP instanceof Object) return startP;
    const limitP = this.intParam(url, "limit");
    if (limitP instanceof Object) return limitP;
    if (limitP !== undefined && limitP < 1) return text(400, "FakeZotero: limit must be 1 to 100.");
    let rows = all;
    if (o.sinceFilter && since !== undefined) rows = rows.filter((r) => r.version > since);
    // INFERRED: newest first (the documented default sort is dateModified; here a version is its stand-in).
    rows = [...rows].sort((x, y) => y.version - x.version || (/^\d+$/u.test(x.key) && /^\d+$/u.test(y.key) ? Number(x.key) - Number(y.key) : x.key < y.key ? -1 : 1));
    const total = rows.length;
    const start = startP ?? 0;
    const unlimited = format !== "json" && limitP === undefined;
    const limit = unlimited ? Math.max(total, 1) : Math.min(limitP ?? DEFAULT_LIMIT, MAX_LIMIT);
    const page = rows.slice(start, start + limit);
    const headers: Record<string, string> = { "total-results": String(total) };
    if (!unlimited && total > limit) {
      const to = (s: number) => {
        const p = new URLSearchParams(url.searchParams);
        p.delete("key");
        p.set("limit", String(limit));
        p.set("start", String(s));
        return `<${API_ORIGIN}${url.pathname}?${p.toString()}>`;
      };
      const links = [`${to(0)}; rel="first"`, `${to(Math.floor((total - 1) / limit) * limit)}; rel="last"`];
      if (start + limit < total) links.push(`${to(start + limit)}; rel="next"`);
      if (start > 0) links.push(`${to(Math.max(0, start - limit))}; rel="prev"`);
      headers["link"] = links.join(", ");
    }
    if (format === "keys") return text(200, page.map((r) => r.key).join("\n"), headers);
    if (format === "versions") return json(200, Object.fromEntries(page.map((r) => [r.key, r.version])), headers);
    return json(200, page.map((r) => r.obj), headers);
  }

  private file(lib: Library, key: string): FakeResponse {
    const it = lib.items.get(key);
    if (!it || !it.file) return text(404, "Not Found");
    // UNCONFIRMED (a key's privileges for files): the key's `files` flag is enforced for the user library only.
    if (lib.type === "user" && !this.access.files) return text(403, "Forbidden");
    const f = it.file;
    if (f.fail?.api !== undefined && this.spend(f.fail)) return text(f.fail.api, `FakeZotero: this file fails on purpose (${f.fail.api}).`);
    // INFERRED (plan: what only a real account proves): a WebDAV-stored attachment answers 404, unless an
    // older copy is set (`stale`), which is then served from Zotero storage.
    if (f.storage === "webdav" && !f.stale) return text(404, "Not Found");
    const token = md5Hex(`${lib.ref}/${key}/${it.version}`);
    this.tokens.set(token, { ref: lib.ref, key });
    const location = `${f.redirect ?? this.base}${token}?sig=x`;
    // INFERRED: the live service answers 302 with a signed storage URL. The compressed marker is put on the
    // 302 (where the client reads it) and again on the file answer.
    return { status: 302, headers: { location, "last-modified-version": String(it.version), ...(it.file.compressed ? { "zotero-file-compressed": "Yes" } : {}) }, body: "" };
  }

  /** The file host: no key needed (and none expected). The ETag is the md5 the item states ([upload]: compare ETag with the item's md5). */
  private storage(url: URL): FakeResponse {
    const ref = this.tokens.get(url.pathname.split("/").filter(Boolean).pop() ?? "");
    const it = ref ? this.libs.get(ref.ref)?.items.get(ref.key) : undefined;
    if (!it || !it.file) return text(404, "Not Found");
    const f = it.file;
    // A failure of this file, then of the whole host.
    const mode = f.fail?.storage !== undefined && this.spend(f.fail) ? f.fail.storage : this.storageFailure && this.spend(this.storageFailure) ? this.storageFailure.mode : undefined;
    if (mode === "drop") return { status: 0, headers: {}, body: "", drop: true };
    if (typeof mode === "number") return text(mode, `FakeZotero: the file host fails on purpose (${mode}).`);
    const served = f.stale ?? f.bytes;
    const body = f.compressed ? buildZip([{ name: String(it.data.filename ?? it.key), data: Buffer.from(served) }]) : served;
    // The ETag is the md5 the item states ([upload]), unless an older copy is served: then that copy's own.
    const md5 = f.stale ? md5Hex(f.stale) : typeof it.data.md5 === "string" ? it.data.md5 : "";
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream", etag: `"${md5}"`, ...(f.compressed ? { "zotero-file-compressed": "Yes" } : {}) },
      body,
      ...(mode === "cut" ? { cut: true as const } : {}),
    };
  }

  private spend(f: { left: number }): boolean {
    if (f.left <= 0) return false;
    f.left--;
    return true;
  }

  // ---- helpers -----------------------------------------------------------------------------------

  /** Children per parent key, notes this key cannot see left out (as itemJson counts them). */
  private childCounts(lib: Library): Map<string, number> {
    const m = new Map<string, number>();
    for (const x of lib.items.values()) {
      const p = x.data.parentItem;
      if (p === undefined || this.hidden(lib, x)) continue;
      const k = p as string;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }

  private itemJson(lib: Library, it: Item, counts?: Map<string, number>): unknown {
    // UNCONFIRMED: notes this key cannot see are not counted.
    const children = counts ? (counts.get(it.key) ?? 0) : [...lib.items.values()].filter((x) => x.data.parentItem === it.key && !this.hidden(lib, x)).length;
    return {
      key: it.key,
      version: it.version,
      library: { type: lib.type, id: lib.id, ...(lib.name ? { name: lib.name } : {}) },
      links: {},
      meta: it.data.parentItem === undefined && children ? { numChildren: children } : {},
      data: { ...it.data },
    };
  }

  private collJson(lib: Library, c: Collection): unknown {
    return { key: c.key, version: c.version, library: { type: lib.type, id: lib.id }, links: {}, meta: {}, data: { ...c.data } };
  }

  private touch(it: Item, v: number): void {
    it.version = v;
    it.data.version = v;
    it.data.dateModified = stamp(v);
  }

  private badParams(url: URL, allowed: string[]): FakeResponse | undefined {
    for (const k of url.searchParams.keys()) if (!allowed.includes(k)) return text(400, `FakeZotero: the parameter "${k.slice(0, 30)}" is not modelled by the stand-in (the real API may accept it).`);
    return undefined;
  }

  private intParam(url: URL, name: string): number | FakeResponse | undefined {
    const v = url.searchParams.get(name);
    if (v === null) return undefined;
    return /^\d{1,12}$/u.test(v) ? Number(v) : text(400, `FakeZotero: ${name} must be a whole number.`);
  }

  private intHeader(h: Record<string, string>, name: string): number | FakeResponse | undefined {
    const v = h[name];
    if (v === undefined) return undefined;
    return /^\d{1,12}$/u.test(v) ? Number(v) : text(400, `FakeZotero: ${name} must be a whole number.`);
  }

  private nextKey(): string {
    return keyAt(this.counter++);
  }

  private newLib(type: "user" | "group", id: number, name?: string): Library {
    return { ref: `${type}:${id}`, type, id, ...(name ? { name } : {}), groupVersion: 1, groupType: "Private", version: 0, items: new Map(), collections: new Map(), deletions: [] };
  }

  private lib(ref: string): Library {
    const l = this.libs.get(ref);
    if (!l) throw new Error(`FakeZotero: no library ${ref} (add a group with addGroup first)`);
    return l;
  }

  private item(lib: Library, key: string): Item {
    const it = lib.items.get(key);
    if (!it) throw new Error(`FakeZotero: no item ${key} in ${lib.ref}`);
    return it;
  }
}

/** The pure handler: the same answers as the MockAgent gives, for a loopback server (task Z11). Serves API and storage paths. */
export function fakeZoteroHandler(z: FakeZotero): (req: FakeRequest) => FakeResponse {
  return (req) => z.serve(req, undefined);
}
