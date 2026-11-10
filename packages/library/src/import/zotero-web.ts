/**
 * Zotero Web API import for Bulk Import (spec 5.4 "Zotero specifics"; Task 26, R78). Provenance
 * `zotero_import` (tool "zotero-web-import"); legal-basis category 'zotero-import'.
 *
 * Talking to Zotero:
 *   - only `https://api.zotero.org` (API v3: `Zotero-API-Version: 3`), with the user's key in the
 *     `Zotero-API-Key` header. The key is read from the OS keyring (secrets.ts) when the scan starts
 *     and is never written anywhere, put in a URL, an error, a report or a log;
 *   - API responses are never redirected; a JSON page is at most 10 MB; pages of `limit=100`;
 *   - `Backoff: <s>` makes the next request wait (capped, default 2 min); 429 and 5xx are retried
 *     (5 times) after `Retry-After` (capped) or 1 s, 2 s, 4 s …; 403 and 404 stop with a plain reason;
 *   - files: `GET /items/<key>/file` answers 302 to a signed URL on Zotero's storage. The redirect is
 *     followed only over https to ZOTERO_STORAGE_HOSTS, and without the key. Each file is streamed
 *     into the batch's private (0700) work folder, at most 2 GB, checked against Zotero's MD5,
 *     unpacked when Zotero stored it compressed, and sniffed (`file-type`). A refused redirect, a
 *     missing file (e.g. a library that syncs files over WebDAV), an oversize or damaged file leaves
 *     the item with a file note instead (R66). A dry run downloads nothing.
 *
 * Items: the same mapping as the local import (zotero-common.ts): item types, creators, collections
 * (folderPath), tags (+ colours from /settings/tagColors), child notes (note-html.ts → Markdown),
 * stored attachments (downloaded), linked files (linked in place, R67/R24 as for the local import)
 * and reader annotations (`itemType: annotation`, anchored in their attachment). Standalone notes,
 * attachment notes, linked URLs, embedded images, web-page snapshots (HTML) and linked files
 * relative to Zotero's base folder are not imported and are counted in one scan note.
 *
 * Incremental (R72, R73): items carry `version` (`<user|group>:<id>/<key>`, a token over the
 * versions of the item and everything under it). `since` asks Zotero only for what changed after
 * that library version (`/items?since=`), then fetches each changed item's parent and children so
 * the whole item is compared; `/deleted?since=` is only counted ("deleted in Zotero, not deleted
 * here"). startZoteroWebImport reads `since` from the project's import settings and, when the batch
 * finished, records the library version Zotero reported (a governed, audited write). Sources deleted
 * here stay deleted (R73 tombstones, as for the local import).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileTypeFromFile } from "file-type";
import { request, type Dispatcher } from "undici";
import type { ImportOptionsInput } from "@ao/core";
import { extractArchive } from "../extract/zip.js";
import { USER_AGENT, retryAfterMs } from "../lookup/http.js";
import { statfsFree } from "./sqlite-copy.js";
import { recordZoteroWebLibraryVersion, type Repo } from "../repo/repo.js";
import { SecretStoreUnavailableError, getSecret, type SecretName } from "../secrets.js";
import type { ImportSourceAdapter, ScanAnnotation, ScanContext, ScanFile, ScanItem } from "./bulk/scan.js";
import { MAX_NOTE_CHARS, noteToMarkdown } from "./note-html.js";
import { checkFiles, referenceMetadata, text } from "./refman.js";
import { extraCitationKey, ownValue, recordFields, zoteroAnnotation, zoteroCreator, zoteroTimestamp } from "./zotero-common.js";
import { ZOTERO_NOTES, type NotImported } from "./zotero-local.js";
import type { BatchHandle, BulkImportDeps } from "./bulk/run.js";

const VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export const ZOTERO_API_ORIGIN = "https://api.zotero.org";

/**
 * Hosts a file download may be redirected to (https only). Zotero's file endpoint answers 302 with
 * a pre-signed URL on its Amazon S3 storage (zotero/dataserver `Zotero_Storage::getDownloadURL`;
 * the client's zfs.js reads the `Location`). UNVERIFIED: the bucket host could not be observed
 * without a key (public libraries do not serve files); these are the documented S3 forms plus
 * Zotero's file host. If downloads report "redirected elsewhere", add the host shown by Zotero here.
 */
export const ZOTERO_STORAGE_HOSTS: readonly string[] = ["files.zotero.net", "zoterofilestorage.s3.amazonaws.com", "s3.amazonaws.com"];

export const MAX_ZOTERO_PAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ZOTERO_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ITEMS = 500_000;
const MAX_COLLECTIONS = 100_000;
const PAGE = 100;
const MAX_WAIT_MS = 120_000;
const MAX_RETRIES = 5;
const MAX_REDIRECTS = 2;
const MAX_COLLECTION_DEPTH = 64;
const MAX_FOLDER_PATHS = 20;
const MAX_RELATED = 100;
const KEY = /^[A-Za-z0-9]{1,32}$/u;
/** Restarts of a scan whose library changed while it was read (R80 I2). */
const MAX_RESTARTS = 3;
/** Free space kept beyond a download (as for the local copy, sqlite-copy.ts). */
const SPACE_MARGIN = 64 * 1024 * 1024;

export const ZOTERO_WEB_REASONS = {
  noKey: "No Zotero API key is saved on this computer, so nothing was imported from Zotero online. Save your key first.",
  keyRefused: "Zotero refused the API key for this library (it may be wrong, revoked, or lack read access), so nothing was imported.",
  notFound: "Zotero has no library with that ID (or the key cannot see it), so nothing was imported.",
  unavailable: "Zotero's online service could not be reached or answered with an error, so nothing was imported. Try again later.",
  tooLarge: "Zotero sent a response that is too large or too many items, so nothing was imported.",
  noStore:
    "No secure key store (the system keychain or credential manager) is available on this computer, so the Zotero API key cannot be read and nothing was imported from Zotero online.",
  changing: "The Zotero library kept changing while it was being read, so nothing was imported. Try again when it is not syncing.",
} as const;

export const ZOTERO_WEB_FILE_NOTES = {
  notInStorage: "attached file is not in Zotero's online storage",
  redirectRefused: "attached file download was redirected elsewhere and was not followed",
  tooLarge: "attached file is larger than 2 GB and was not downloaded",
  failed: "attached file could not be downloaded",
  checksum: "attached file did not match Zotero's checksum and was not imported",
  noSpace: "attached file was not downloaded: not enough free disk space",
} as const;

/** File notes that a later run may not get again (worth retrying): the item's version token is marked (R80). */
const RETRYABLE: ReadonlySet<string> = new Set([ZOTERO_WEB_FILE_NOTES.failed, ZOTERO_WEB_FILE_NOTES.checksum, ZOTERO_WEB_FILE_NOTES.noSpace, ZOTERO_WEB_FILE_NOTES.redirectRefused]);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const ZOTERO_WEB_NOTES = {
  snapshots: (n: number) => `Not imported from Zotero: ${plural(n, "web page snapshot", "web page snapshots")}.`,
  pendingDownloads: (n: number) => `${plural(n, "file is", "files are")} downloaded from Zotero when the import runs (not in this preview).`,
  groupLinked: (n: number) =>
    `Not imported from Zotero: ${plural(n, "linked file in a group library", "linked files in a group library")} (linked files live on the computer of the member who added them).`,
  deleted: (n: number) =>
    `${plural(n, "item was", "items were")} deleted in Zotero since the last import; ${n === 1 ? "it was" : "they were"} not deleted here.`,
} as const;

class ZoteroWebError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The library changed while the scan read it (412, or a different Last-Modified-Version). */
class LibraryChanged extends Error {}

export interface ZoteroWebOptions {
  libraryType: "user" | "group";
  /** The numeric user or group ID (Zotero → Settings → Security / the group's URL). */
  libraryId: string;
  /** The keyring entry holding the API key (default "zotero-api-key"). */
  apiKeySecretName?: SecretName;
  /** Ask only for items changed after this library version (incremental). */
  since?: number;
  /** Test seams. */
  dispatcher?: Dispatcher;
  sleep?: (ms: number) => Promise<void>;
  storageHosts?: readonly string[];
  maxRetries?: number;
  /** Cap on Backoff / Retry-After waits (default 2 min). */
  maxWaitMs?: number;
  maxPageBytes?: number;
  maxFileBytes?: number;
  /** Free bytes in a folder (default: statfs), checked before each download. */
  freeSpace?: (dir: string) => Promise<number>;
}

export interface ZoteroWebScanResult {
  /** The library version Zotero reported when the scan began. */
  libraryVersion?: number;
  /** Items deleted in Zotero since `since` (incremental runs). */
  deletedInZotero: number;
  /** The scan read the whole library (or every change) without stopping. */
  completed: boolean;
  /** Downloads that failed in a way a later run may fix (network, checksum, disk space, redirect). */
  downloadsFailed: number;
}

export interface ZoteroWebAdapter extends ImportSourceAdapter {
  /** "user:<id>" or "group:<id>". */
  readonly ref: string;
  scanResult(): ZoteroWebScanResult;
}

interface WebItem {
  key: string;
  version: number;
  data: Record<string, unknown>;
}

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, n: string): string | undefined => {
  const v = h[n];
  return Array.isArray(v) ? v[0] : v;
};

/** The Web API, with the key, Backoff and retries. Errors are ZoteroWebError with a fixed reason (never the key or the server's text). */
class ZoteroApi {
  private nextAt = 0;
  /**
   * The library version the scan is reading (from the first page). Later item and collection
   * requests send it as If-Unmodified-Since-Version; a 412 or another Last-Modified-Version means the
   * library changed under the scan (LibraryChanged).
   */
  scanVersion: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxWait: number;
  private readonly hosts: Set<string>;

  constructor(
    private readonly apiKey: string,
    private readonly o: ZoteroWebOptions,
    private readonly signal: AbortSignal,
  ) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = o.maxRetries ?? MAX_RETRIES;
    this.maxWait = o.maxWaitMs ?? MAX_WAIT_MS;
    this.hosts = new Set((o.storageHosts ?? ZOTERO_STORAGE_HOSTS).map((h) => h.toLowerCase()));
  }

  private async waitTurn(): Promise<void> {
    const wait = this.nextAt - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.signal.throwIfAborted();
  }

  private noteBackoff(h: Headers): void {
    const ms = retryAfterMs(header(h, "backoff"), Date.now());
    if (ms !== undefined) this.nextAt = Math.max(this.nextAt, Date.now() + Math.min(ms, this.maxWait));
  }

  private retryWait(attempt: number, h: Headers | undefined): number {
    const ms = h ? retryAfterMs(header(h, "retry-after"), Date.now()) : undefined;
    return Math.min(ms ?? 1000 * 2 ** attempt, this.maxWait);
  }

  private headers(withKey: boolean): Record<string, string> {
    return { "user-agent": USER_AGENT, "zotero-api-version": "3", ...(withKey ? { "zotero-api-key": this.apiKey } : {}) };
  }

  /** One GET with retries on 429/5xx/network errors. `accept(status)` decides which answers are final. */
  private async get(url: URL, withKey: boolean, accept: (s: number) => boolean, extra: Record<string, string> = {}): Promise<Dispatcher.ResponseData> {
    for (let attempt = 0; ; attempt++) {
      if (withKey) await this.waitTurn();
      let res: Dispatcher.ResponseData | undefined;
      try {
        res = await request(url, {
          method: "GET",
          headers: { ...this.headers(withKey), ...extra },
          dispatcher: this.o.dispatcher,
          signal: this.signal,
          headersTimeout: 60_000,
          bodyTimeout: 120_000,
        });
      } catch (err) {
        if (this.signal.aborted) throw this.signal.reason ?? err;
        if (attempt >= this.maxRetries) throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
        await this.sleep(this.retryWait(attempt, undefined));
        continue;
      }
      if (withKey) this.noteBackoff(res.headers);
      if (accept(res.statusCode)) return res;
      await res.body.dump().catch(() => {});
      const s = res.statusCode;
      if ((s === 429 || s >= 500) && attempt < this.maxRetries) {
        await this.sleep(this.retryWait(attempt, res.headers));
        continue;
      }
      if (s === 412) throw new LibraryChanged();
      if (s === 403 || s === 401) throw new ZoteroWebError(ZOTERO_WEB_REASONS.keyRefused);
      if (s === 404) throw new ZoteroWebError(ZOTERO_WEB_REASONS.notFound);
      throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
    }
  }

  /** A JSON document from the API, with its headers. */
  async json(path: string, query: Record<string, string | number> = {}, versioned = false): Promise<{ body: unknown; headers: Headers }> {
    const url = new URL(path, ZOTERO_API_ORIGIN);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const pinned: Record<string, string> = versioned && this.scanVersion !== undefined ? { "if-unmodified-since-version": String(this.scanVersion) } : {};
    const res = await this.get(url, true, (s) => s === 200, pinned);
    if (versioned) {
      const v = libraryVersionOf(res.headers);
      if (v !== undefined) {
        if (this.scanVersion === undefined) this.scanVersion = v;
        else if (v !== this.scanVersion) {
          await res.body.dump().catch(() => {});
          throw new LibraryChanged();
        }
      }
    }
    const max = this.o.maxPageBytes ?? MAX_ZOTERO_PAGE_BYTES;
    const len = Number(header(res.headers, "content-length"));
    if (Number.isFinite(len) && len > max) {
      res.body.destroy();
      throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of res.body as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > max) {
        res.body.destroy();
        throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
      }
      chunks.push(c);
    }
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, headers: res.headers };
    } catch {
      throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
    }
  }

  /** Whether a redirect target is Zotero's storage over https (no credentials, default port). */
  private allowed(u: URL): boolean {
    return u.protocol === "https:" && this.hosts.has(u.hostname.toLowerCase()) && !u.username && !u.password && (u.port === "" || u.port === "443");
  }

  /**
   * Downloads an attachment's file into `dest` (streamed, capped, MD5-checked). Returns the
   * file's path, or a file note. Never throws for a file-level problem; aborts and refused keys do.
   */
  async file(prefix: string, attKey: string, dest: string, md5: string | undefined): Promise<{ path: string } | { note: string }> {
    const max = this.o.maxFileBytes ?? MAX_ZOTERO_FILE_BYTES;
    const { dir } = splitDownloadPath(dest);
    const free = () => (this.o.freeSpace ?? statfsFree)(dir);
    if ((await free()) < SPACE_MARGIN) return { note: ZOTERO_WEB_FILE_NOTES.noSpace };
    let res: Dispatcher.ResponseData;
    try {
      res = await this.get(new URL(`${prefix}/items/${attKey}/file`, ZOTERO_API_ORIGIN), true, (s) => s === 200 || (s >= 300 && s < 400));
    } catch (err) {
      if (err instanceof ZoteroWebError) {
        if (err.reason === ZOTERO_WEB_REASONS.notFound) return { note: ZOTERO_WEB_FILE_NOTES.notInStorage };
        if (err.reason === ZOTERO_WEB_REASONS.keyRefused) throw err;
        return { note: ZOTERO_WEB_FILE_NOTES.failed };
      }
      throw err;
    }
    const compressed = header(res.headers, "zotero-file-compressed")?.toLowerCase() === "yes";
    // Follow the storage redirect (without the key), only to Zotero's storage over https.
    for (let hop = 0; res.statusCode >= 300 && res.statusCode < 400; hop++) {
      await res.body.dump().catch(() => {});
      const loc = header(res.headers, "location");
      let next: URL;
      try {
        next = new URL(loc ?? "", ZOTERO_API_ORIGIN);
      } catch {
        return { note: ZOTERO_WEB_FILE_NOTES.redirectRefused };
      }
      if (!loc || hop >= MAX_REDIRECTS || !this.allowed(next)) return { note: ZOTERO_WEB_FILE_NOTES.redirectRefused };
      try {
        res = await this.get(next, false, (s) => s === 200 || (s >= 300 && s < 400));
      } catch (err) {
        if (err instanceof ZoteroWebError) return { note: ZOTERO_WEB_FILE_NOTES.failed };
        throw err;
      }
    }
    const len = Number(header(res.headers, "content-length"));
    if (Number.isFinite(len) && len > max) {
      res.body.destroy();
      return { note: ZOTERO_WEB_FILE_NOTES.tooLarge };
    }
    if (Number.isFinite(len) && (await free()) < len * (compressed ? 2 : 1) + SPACE_MARGIN) {
      res.body.destroy();
      return { note: ZOTERO_WEB_FILE_NOTES.noSpace };
    }
    const target = compressed ? `${dest}.zip` : dest;
    const hash = createHash("md5");
    let size = 0;
    let over = false;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) {
          over = true;
          cb(new Error("too large"));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res.body, meter, createWriteStream(target, { flags: "wx", mode: 0o600 }), { signal: this.signal });
    } catch (err) {
      await fsp.rm(target, { force: true });
      if (this.signal.aborted) throw this.signal.reason ?? err;
      return { note: over ? ZOTERO_WEB_FILE_NOTES.tooLarge : ZOTERO_WEB_FILE_NOTES.failed };
    }
    if (!compressed) {
      if (md5 && /^[0-9a-f]{32}$/iu.test(md5) && hash.digest("hex") !== md5.toLowerCase()) {
        await fsp.rm(target, { force: true });
        return { note: ZOTERO_WEB_FILE_NOTES.checksum };
      }
      return { path: target };
    }
    // Stored compressed (older Zotero clients): a ZIP holding the file, unpacked with the archive limits.
    const out = `${dest}.d`;
    try {
      const entries = await extractArchive(target, out, { maxEntries: 10, maxEntryBytes: max, maxTotalBytes: max }, this.signal);
      const want = splitDownloadPath(dest).name;
      const e = entries.find((x) => !x.refused && x.name === want) ?? entries.find((x) => !x.refused && x.path);
      if (!e) return { note: ZOTERO_WEB_FILE_NOTES.failed };
      // Zotero's MD5 is of the file itself, so it is checked after unpacking.
      if (md5 && /^[0-9a-f]{32}$/iu.test(md5)) {
        const h = createHash("md5");
        for await (const c of createReadStream(e.path) as AsyncIterable<Buffer>) h.update(c);
        if (h.digest("hex") !== md5.toLowerCase()) {
          await fsp.rm(out, { recursive: true, force: true });
          return { note: ZOTERO_WEB_FILE_NOTES.checksum };
        }
      }
      return { path: e.path };
    } catch (err) {
      if (this.signal.aborted) throw this.signal.reason ?? err;
      return { note: ZOTERO_WEB_FILE_NOTES.failed };
    } finally {
      await fsp.rm(target, { force: true });
    }
  }
}

/** A download's folder and file name, by the platform's path rules (Windows separators included). */
export function splitDownloadPath(dest: string, p: Pick<typeof nodePath, "dirname" | "basename"> = nodePath): { dir: string; name: string } {
  return { dir: p.dirname(dest), name: p.basename(dest) };
}

/** A file name from Zotero that is safe as one path segment. */
function safeName(raw: unknown): string {
  let n = typeof raw === "string" ? raw.replace(/[\\/\u0000-\u001f\u007f:*?"<>|]/gu, "_").trim() : "";
  if (n.length > 180) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : "";
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return !n || n === "." || n === ".." || n.startsWith(".") ? `file${n.startsWith(".") ? n : ""}` : n;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const isItem = (x: unknown): x is WebItem => {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.key === "string" && KEY.test(o.key) && !!o.data && typeof o.data === "object" && !Array.isArray(o.data);
};
const asItem = (x: WebItem): WebItem => ({ key: x.key, version: Number.isInteger(x.version) ? x.version : Number(x.data.version) || 0, data: x.data });

async function* pages(api: ZoteroApi, path: string, query: Record<string, string | number>): AsyncGenerator<{ items: WebItem[]; headers: Headers }> {
  let start = 0;
  for (;;) {
    const { body, headers } = await api.json(path, { format: "json", include: "data", limit: PAGE, start, ...query }, true);
    if (!Array.isArray(body)) throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
    yield { items: body.filter(isItem).map(asItem), headers };
    start += body.length;
    const total = Number(header(headers, "total-results"));
    if (body.length < PAGE || (Number.isFinite(total) && start >= total)) return;
    if (start >= MAX_ITEMS) throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
  }
}

const libraryVersionOf = (h: Headers): number | undefined => {
  const v = Number(header(h, "last-modified-version"));
  return Number.isInteger(v) && v >= 0 ? v : undefined;
};

/** Everything fetched, by key; trashed items left out. */
class Tree {
  readonly byKey = new Map<string, WebItem>();
  add(i: WebItem): void {
    if (this.byKey.size >= MAX_ITEMS && !this.byKey.has(i.key)) throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
    if (i.data.deleted) {
      this.byKey.delete(i.key);
      return;
    }
    this.byKey.set(i.key, i);
  }
  parentOf(i: WebItem): string | undefined {
    const p = i.data.parentItem;
    return typeof p === "string" && KEY.test(p) ? p : undefined;
  }
  children(): Map<string, WebItem[]> {
    const m = new Map<string, WebItem[]>();
    for (const i of this.byKey.values()) {
      const p = this.parentOf(i);
      if (!p) continue;
      const list = m.get(p) ?? [];
      list.push(i);
      m.set(p, list);
    }
    return m;
  }
}

/** Everything in the library. */
async function fullTree(api: ZoteroApi, prefix: string, result: ZoteroWebScanResult): Promise<Tree> {
  const tree = new Tree();
  for await (const p of pages(api, `${prefix}/items`, {})) {
    result.libraryVersion ??= libraryVersionOf(p.headers);
    for (const i of p.items) tree.add(i);
  }
  return tree;
}

/** What changed since `since`: each changed item's top-level item, with all its children (and their annotations). */
async function changedTree(api: ZoteroApi, prefix: string, since: number, result: ZoteroWebScanResult): Promise<{ tree: Tree; tops: Set<string> }> {
  const tree = new Tree();
  const changed: WebItem[] = [];
  for await (const p of pages(api, `${prefix}/items`, { since })) {
    result.libraryVersion ??= libraryVersionOf(p.headers);
    for (const i of p.items) {
      changed.push(i);
      tree.add(i);
    }
  }
  // Parents not in the change set (a changed annotation's attachment, an attachment's item), up to two levels.
  for (let round = 0; round < 3; round++) {
    const missing = [...new Set(changed.map((i) => tree.parentOf(i)).concat([...tree.byKey.values()].map((i) => tree.parentOf(i))))].filter(
      (k): k is string => !!k && !tree.byKey.has(k),
    );
    if (!missing.length) break;
    for (let i = 0; i < missing.length; i += 50) {
      const { body } = await api.json(`${prefix}/items`, { format: "json", include: "data", itemKey: missing.slice(i, i + 50).join(","), limit: 50 }, true);
      if (!Array.isArray(body)) throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
      for (const x of body.filter(isItem).map(asItem)) tree.add(x);
    }
  }
  const topOf = (k: string): string | undefined => {
    let cur = tree.byKey.get(k);
    for (let d = 0; cur && d < 4; d++) {
      const p = tree.parentOf(cur);
      if (!p) return cur.key;
      cur = tree.byKey.get(p);
    }
    return undefined;
  };
  const tops = new Set<string>();
  for (const i of changed) {
    const t = topOf(i.key);
    if (t) tops.add(t);
  }
  // The whole of each changed item: its children, and the children of its attachments.
  for (const t of tops) {
    for await (const p of pages(api, `${prefix}/items/${t}/children`, {})) {
      for (const c of p.items) {
        tree.add(c);
        if (c.data.itemType === "attachment") {
          for await (const q of pages(api, `${prefix}/items/${c.key}/children`, {})) for (const a of q.items) tree.add(a);
        }
      }
    }
  }
  return { tree, tops };
}

async function collectionPaths(api: ZoteroApi, prefix: string): Promise<(keys: unknown) => string[][]> {
  const colls = new Map<string, { name: string; parent?: string }>();
  for await (const p of pages(api, `${prefix}/collections`, {})) {
    for (const c of p.items) {
      if (colls.size >= MAX_COLLECTIONS) throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
      if (c.data.deleted) continue;
      const parent = typeof c.data.parentCollection === "string" && KEY.test(c.data.parentCollection) ? c.data.parentCollection : undefined;
      colls.set(c.key, { name: text(str(c.data.name)).slice(0, 200) || "Untitled", ...(parent ? { parent } : {}) });
    }
  }
  const cache = new Map<string, string[] | null>();
  const pathOf = (key: string): string[] | null => {
    if (cache.has(key)) return cache.get(key)!;
    const chain: string[] = [];
    const seen = new Set<string>();
    let ok = true;
    for (let k: string | undefined = key; k; ) {
      const c = colls.get(k);
      if (!c) {
        ok = false; // a collection in the trash (or not visible) on the way: left out, as in the local import
        break;
      }
      if (seen.has(k) || chain.length >= MAX_COLLECTION_DEPTH) break;
      seen.add(k);
      chain.push(c.name);
      k = c.parent;
    }
    const out = ok && chain.length ? chain.reverse() : null;
    cache.set(key, out);
    return out;
  };
  return (keys) => {
    const out: string[][] = [];
    for (const k of Array.isArray(keys) ? keys : []) {
      if (typeof k !== "string" || !colls.has(k)) continue;
      const p = pathOf(k);
      if (p && out.length < MAX_FOLDER_PATHS) out.push(p);
    }
    return out;
  };
}

async function tagColorsOf(api: ZoteroApi, prefix: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { body } = await api.json(`${prefix}/settings/tagColors`);
    const list = (body as { value?: unknown } | null)?.value;
    if (Array.isArray(list)) {
      for (const t of list.slice(0, 1000)) {
        const name = typeof t?.name === "string" ? text(t.name) : "";
        const color = typeof t?.color === "string" ? t.color.trim() : "";
        if (name && /^#[0-9a-f]{3,8}$/iu.test(color)) out.set(name.toLowerCase(), color);
      }
    }
  } catch (err) {
    if (err instanceof ZoteroWebError && err.reason === ZOTERO_WEB_REASONS.keyRefused) throw err;
    // no colours (none set, or the setting cannot be read)
  }
  return out;
}

/** Web API annotation types → the numeric types of zotero.sqlite (zotero-common's mapping). */
const ANNOTATION_TYPE: Readonly<Record<string, number>> = { highlight: 1, note: 2, image: 3, ink: 4, underline: 5, text: 6 };

function annotationOf(a: WebItem, file: string | undefined): ScanAnnotation | undefined {
  const d = a.data;
  const type = ownValue(ANNOTATION_TYPE, str(d.annotationType));
  if (!type) return undefined;
  const cut = (v: unknown) => str(v).slice(0, 65536);
  return zoteroAnnotation(
    {
      key: a.key,
      type,
      authorName: cut(d.annotationAuthorName),
      text: cut(d.annotationText),
      comment: cut(d.annotationComment),
      color: cut(d.annotationColor),
      pageLabel: cut(d.annotationPageLabel),
      position: typeof d.annotationPosition === "string" ? d.annotationPosition.slice(0, 65536) : d.annotationPosition ? JSON.stringify(d.annotationPosition).slice(0, 65536) : null,
      dateAdded: cut(d.dateAdded),
    },
    file,
  );
}

const fieldsOf = (d: Record<string, unknown>): Map<string, string> => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(d)) if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) m.set(k, String(v).slice(0, 65536));
  return m;
};

const relatedOf = (d: Record<string, unknown>): string[] => {
  const r = (d.relations as Record<string, unknown> | undefined)?.["dc:relation"];
  const list = typeof r === "string" ? [r] : Array.isArray(r) ? r : [];
  const keys: string[] = [];
  for (const u of list.slice(0, MAX_RELATED)) {
    const m = typeof u === "string" ? /\/items\/([A-Za-z0-9]{1,32})$/u.exec(u) : null;
    if (m && !keys.includes(m[1]!)) keys.push(m[1]!);
  }
  return keys;
};

async function* scanWeb(o: ZoteroWebOptions, ref: string, result: ZoteroWebScanResult, signal: AbortSignal, ctx: ScanContext | undefined): AsyncGenerator<ScanItem> {
  const fail = (reason: string): ScanItem => ({ key: "zotero-web:", files: [], unreadable: reason });
  result.completed = false;
  result.deletedInZotero = 0;
  result.downloadsFailed = 0;
  delete result.libraryVersion;
  if (!ctx) {
    yield fail(ZOTERO_WEB_REASONS.unavailable);
    return;
  }
  let apiKey: string | null;
  try {
    apiKey = await getSecret(o.apiKeySecretName ?? "zotero-api-key");
  } catch (err) {
    yield fail(err instanceof SecretStoreUnavailableError ? ZOTERO_WEB_REASONS.noStore : ZOTERO_WEB_REASONS.noKey);
    return;
  }
  if (!apiKey) {
    yield fail(ZOTERO_WEB_REASONS.noKey);
    return;
  }
  const api = new ZoteroApi(apiKey, o, signal);
  apiKey = null;
  const prefix = `/${o.libraryType === "user" ? "users" : "groups"}/${o.libraryId}`;
  let tree!: Tree;
  let tops: Set<string> | undefined;
  let pathsOf!: (keys: unknown) => string[][];
  let colors: Map<string, string>;
  try {
    // Read everything at one library version: a change under the scan restarts it (R80 I2).
    for (let attempt = 0; ; attempt++) {
      api.scanVersion = undefined;
      delete result.libraryVersion;
      try {
        if (o.since === undefined) tree = await fullTree(api, prefix, result);
        else ({ tree, tops } = await changedTree(api, prefix, o.since, result));
        pathsOf = await collectionPaths(api, prefix);
        break;
      } catch (err) {
        if (!(err instanceof LibraryChanged)) throw err;
        if (attempt >= MAX_RESTARTS) throw new ZoteroWebError(ZOTERO_WEB_REASONS.changing);
      }
    }
    result.libraryVersion = api.scanVersion ?? result.libraryVersion;
    colors = await tagColorsOf(api, prefix);
    if (o.since !== undefined) {
      const { body } = await api.json(`${prefix}/deleted`, { since: o.since });
      const items = (body as { items?: unknown } | null)?.items;
      result.deletedInZotero = Array.isArray(items) ? items.filter((k) => typeof k === "string").length : 0;
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || signal.aborted) throw signal.reason ?? err;
    yield fail(err instanceof ZoteroWebError ? err.reason : ZOTERO_WEB_REASONS.unavailable);
    return;
  }

  const children = tree.children();
  const counts: NotImported = { standaloneNotes: 0, attachmentNotes: 0, linkedUrls: 0, embeddedImages: 0, baseRelative: 0 };
  let snapshots = 0;
  let pendingDownloads = 0;
  let groupLinked = 0;
  const work = join(await ctx.workDir(), "zotero-web");
  await fsp.mkdir(work, { recursive: true, mode: 0o700 });

  try {
    for (const it of tree.byKey.values()) {
      signal.throwIfAborted();
      const d = it.data;
      const type = str(d.itemType);
      if (tree.parentOf(it)) continue; // children come with their item
      if (tops && !tops.has(it.key)) continue;
      if (type === "note") {
        counts.standaloneNotes++;
        continue;
      }
      if (type === "annotation") continue;
      const isAtt = type === "attachment";
      const kids = children.get(it.key) ?? [];
      const atts = isAtt ? [it] : kids.filter((k) => k.data.itemType === "attachment");
      const notes = isAtt ? [] : kids.filter((k) => k.data.itemType === "note");
      const stamp: string[] = [`${it.key}:${it.version}`];
      const links: Array<{ paths: string[] } | { note: string }> = [];
      const linked = new Set<string>();
      const downloaded: ScanFile[] = [];
      const fileNotes: string[] = [];
      const anns: ScanAnnotation[] = [];
      for (const a of atts) {
        if (a !== it) stamp.push(`${a.key}:${a.version}`);
        const ad = a.data;
        const mode = str(ad.linkMode);
        if (a !== it && str(ad.note).trim()) counts.attachmentNotes++;
        let file: string | undefined;
        if (mode === "imported_file" || mode === "imported_url") {
          if (/^text\//iu.test(str(ad.contentType))) snapshots++;
          else if (ctx.dryRun) pendingDownloads++;
          else {
            const dir = join(work, a.key);
            await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
            const got = await api.file(prefix, a.key, join(dir, safeName(ad.filename)), typeof ad.md5 === "string" ? ad.md5 : undefined);
            if ("note" in got) {
              fileNotes.push(got.note);
              if (RETRYABLE.has(got.note)) {
                // Not recorded as done: the token differs from a later successful run's, so that run retries it.
                result.downloadsFailed++;
                stamp.push(`download-failed:${a.key}`);
              }
            }
            else {
              const st = await fsp.stat(got.path);
              const t = await fileTypeFromFile(got.path).catch(() => undefined);
              downloaded.push({ path: got.path, mime: t?.mime ?? "application/octet-stream", bytes: st.size });
              file = got.path;
            }
          }
        } else if (mode === "linked_file") {
          const p = str(ad.path);
          // In a group library a linked file is a path on another member's computer: never followed.
          if (o.libraryType === "group") groupLinked++;
          else if (p.startsWith("attachments:")) counts.baseRelative++;
          else if (p && !p.includes("\u0000") && (p.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(p) || p.startsWith("\\\\"))) {
            links.push({ paths: [p] });
            linked.add(p);
            file = p;
          } else fileNotes.push("attached file location is not valid");
        } else if (mode === "linked_url") counts.linkedUrls++;
        else if (mode === "embedded_image") counts.embeddedImages++;
        for (const an of children.get(a.key) ?? []) {
          if (an.data.itemType !== "annotation") continue;
          stamp.push(`${an.key}:${an.version}`);
          const x = annotationOf(an, file);
          if (x) anns.push(x);
        }
      }
      for (const n of notes) {
        stamp.push(`${n.key}:${n.version}`);
        const html = str(n.data.note).slice(0, MAX_NOTE_CHARS + 1);
        const body = html.trim() ? noteToMarkdown(html) : "";
        if (!body) continue;
        const createdAt = zoteroTimestamp(n.data.dateAdded);
        anns.push({ key: `zotero:${n.key}`, kind: "note", body, ...(createdAt ? { createdAt } : {}) });
      }

      const fieldMap = fieldsOf(d);
      const creators = isAtt
        ? []
        : (Array.isArray(d.creators) ? d.creators.slice(0, 1000) : []).flatMap((c: unknown) => {
            if (!c || typeof c !== "object") return [];
            const o = c as Record<string, unknown>;
            const single = typeof o.name === "string";
            const x = zoteroCreator(o.firstName, single ? o.name : o.lastName, single, o.creatorType);
            return x ? [x] : [];
          });
      const tags = (Array.isArray(d.tags) ? d.tags.slice(0, 1000) : []).map((t: unknown) => str((t as { tag?: unknown } | null)?.tag));
      const { fields, extra } = recordFields(isAtt ? "attachment" : type, fieldMap, creators, tags);
      const native = text(fieldMap.get("citationKey"));
      const citekey = (native && native.length <= 200 && !/\s/u.test(native) ? native : undefined) ?? extraCitationKey(extra);
      stamp.push(`citekey:${citekey ?? ""}`);
      if (citekey) fields.citekey = citekey;

      const checked = await checkFiles(links);
      const files: ScanFile[] = [...downloaded, ...checked.files.map((f) => (linked.has(f.path) ? { ...f, link: true } : f))];
      const attached = new Set(files.map((f) => f.path));
      const annotations = anns.map((a) => (a.file && !attached.has(a.file) ? (({ file: _f, anchor: _a, ...rest }) => rest)(a) : a));
      if (!fields.title && !files.length && !annotations.length && !fileNotes.length && !(isAtt && ctx.dryRun)) continue;

      const tagColors: Record<string, string> = {};
      for (const t of fields.tags ?? []) {
        const c = colors.get(t.toLowerCase());
        if (c) tagColors[t] = c;
      }
      const paths = pathsOf(d.collections);
      const related = relatedOf(d);
      const added = zoteroTimestamp(d.dateAdded);
      const modified = zoteroTimestamp(d.dateModified);
      const externalKeys: Record<string, string> = {
        zoteroKey: it.key,
        zoteroVersion: String(it.version),
        libraryId: ref,
        ...(related.length ? { related: related.join(",") } : {}),
        ...(added ? { zoteroDateAdded: added } : {}),
        ...(modified ? { zoteroDateModified: modified } : {}),
        ...(citekey ? { citekey } : {}),
      };
      const token = `w${it.version}-${createHash("sha256").update(stamp.sort().join("\n")).digest("hex").slice(0, 16)}`;
      const notesOut = [...fileNotes, ...checked.notes];
      yield {
        key: `zotero:${it.key}`,
        files,
        referenceMetadata: referenceMetadata(fields),
        referenceSource: { kind: "zotero", provider: "zotero-web" },
        ...(paths[0] ? { folderPath: paths[0] } : {}),
        ...(paths.length > 1 ? { moreFolderPaths: paths.slice(1) } : {}),
        ...(fields.tags?.length ? { tags: fields.tags } : {}),
        ...(Object.keys(tagColors).length ? { tagColors } : {}),
        ...(annotations.length ? { annotations } : {}),
        externalKeys,
        version: { id: `${ref}/${it.key}`, version: token },
        ...(notesOut.length ? { fileNotes: notesOut } : {}),
      };
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || signal.aborted) throw signal.reason ?? err;
    // A refused key mid-scan (revoked while importing): the rest cannot be read.
    yield fail(err instanceof ZoteroWebError ? err.reason : ZOTERO_WEB_REASONS.unavailable);
    return;
  }
  const left = ZOTERO_NOTES.notImported(counts);
  if (left) ctx.note?.(left);
  if (snapshots) ctx.note?.(ZOTERO_WEB_NOTES.snapshots(snapshots));
  if (groupLinked) ctx.note?.(ZOTERO_WEB_NOTES.groupLinked(groupLinked));
  if (pendingDownloads) ctx.note?.(ZOTERO_WEB_NOTES.pendingDownloads(pendingDownloads));
  if (result.deletedInZotero) ctx.note?.(ZOTERO_WEB_NOTES.deleted(result.deletedInZotero));
  result.completed = true;
}

const TOOL = { name: "zotero-web-import", version: VERSION };

/** A Zotero library on zotero.org, through the Web API (the key from the OS keyring). */
export function zoteroWebAdapter(opts: ZoteroWebOptions): ZoteroWebAdapter {
  if (opts.libraryType !== "user" && opts.libraryType !== "group") throw new TypeError("libraryType must be user or group");
  if (typeof opts.libraryId !== "string" || !/^\d{1,12}$/u.test(opts.libraryId)) throw new TypeError("libraryId must be a numeric Zotero user or group ID");
  if (opts.since !== undefined && (!Number.isInteger(opts.since) || opts.since < 0)) throw new TypeError("since must be a library version");
  const ref = `${opts.libraryType}:${opts.libraryId}`;
  const result: ZoteroWebScanResult = { deletedInZotero: 0, completed: false, downloadsFailed: 0 };
  return {
    kind: "zotero-web",
    location: ref,
    ref,
    roots: [], // downloads go to the batch work folder (always allowed); linked files elsewhere need approval (R67)
    incremental: true,
    uniqueCitationKeys: true,
    tool: TOOL,
    scan: (signal, ctx) => scanWeb(opts, ref, result, signal, ctx),
    scanResult: () => ({ ...result }),
  };
}

/** For resuming a batch from its record ("user:<id>" / "group:<id>"); a full scan (resumed items are skipped). */
export function zoteroWebAdapterFor(location: string): ImportSourceAdapter | undefined {
  const m = /^(user|group):(\d{1,12})$/u.exec(location);
  return m ? zoteroWebAdapter({ libraryType: m[1] as "user" | "group", libraryId: m[2]! }) : undefined;
}

/** The library version the last finished Web API import of `ref` saw in this project, if any. */
export function zoteroWebSince(repo: Repo, projectId: string, ref: string): number | undefined {
  const p = repo.getProject(projectId);
  const zw = p.importSettings?.zoteroWeb;
  return zw && Object.hasOwn(zw, ref) ? zw[ref]!.lastLibraryVersion : undefined;
}

/**
 * Starts a Zotero Web API batch: refused up front (BatchRefusedError) when no key is saved or there
 * is no keyring; incremental from the project's recorded library version unless `full`. When the
 * batch finishes, the library version Zotero reported is recorded (governed, audited), so the next
 * run asks only for later changes. `done` settles after that.
 */
export async function startZoteroWebImport(
  deps: BulkImportDeps,
  projectId: string,
  opts: ZoteroWebOptions & { full?: boolean },
  options: ImportOptionsInput = {},
): Promise<BatchHandle> {
  const { BatchRefusedError, startBatch } = await import("./bulk/run.js");
  let key: string | null;
  try {
    key = await getSecret(opts.apiKeySecretName ?? "zotero-api-key");
  } catch (err) {
    if (err instanceof SecretStoreUnavailableError) throw new BatchRefusedError(ZOTERO_WEB_REASONS.noStore);
    throw err;
  }
  if (!key) throw new BatchRefusedError(ZOTERO_WEB_REASONS.noKey);
  key = null;
  const { full, ...rest } = opts;
  const ref = `${opts.libraryType}:${opts.libraryId}`;
  const since = full ? undefined : (opts.since ?? zoteroWebSince(deps.repo, projectId, ref));
  const { since: _ignored, ...base } = rest;
  const adapter = zoteroWebAdapter({ ...base, ...(since !== undefined ? { since } : {}) });
  const h = await startBatch(deps, projectId, adapter, options);
  const done = h.done.then(async (r) => {
    const s = adapter.scanResult();
    // Only a run where nothing failed moves `since` on; otherwise the next run asks for the same changes again (R80 I1).
    if (r.state === "finished" && r.counts.failed === 0 && s.completed && s.downloadsFailed === 0 && s.libraryVersion !== undefined && s.libraryVersion !== since) {
      try {
        await recordZoteroWebLibraryVersion(deps.repo, projectId, ref, s.libraryVersion);
      } catch (err) {
        deps.debug?.(`zotero web: the library version could not be recorded (${err instanceof Error ? err.name : "error"})`);
      }
    }
    return r;
  });
  done.catch(() => {});
  return { ...h, done };
}
