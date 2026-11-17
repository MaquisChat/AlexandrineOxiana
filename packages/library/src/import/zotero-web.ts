/**
 * Zotero Web API import for Bulk Import (spec 5.4 "Zotero specifics"; Task 26, R78). Provenance
 * `zotero_import` (tool "zotero-web-import"); legal-basis category 'zotero-import'.
 *
 * Talking to Zotero:
 *   - only `https://api.zotero.org` (API v3: `Zotero-API-Version: 3`; under NODE_ENV=test only, the loopback
 *     origin of AO_ZOTERO_API_ORIGIN, which is then also the only file origin: Task Z11), with the user's key in the
 *     `Zotero-API-Key` header. The key is read from the OS keyring (secrets.ts) when the scan starts
 *     and is never written anywhere, put in a URL, an error, a report or a log;
 *   - API responses are never redirected; a JSON page is at most 10 MB; pages of `limit=100`;
 *   - `Backoff: <s>` makes the next request wait (capped, default 2 min); 429 and 5xx are retried
 *     (5 times) after `Retry-After` (capped) or 1 s, 2 s, 4 s …; 403 and 404 stop with a plain reason;
 *   - only GET is ever sent, to any host (one way: nothing in Zotero is ever changed);
 *   - files: `GET /items/<key>/file` answers 302 to a signed URL on Zotero's storage. The redirect is
 *     followed only where zoteroFileHostAllowed says (https, port 443, R206/A1), and without the key;
 *     a refused host's NAME (never its path or query, which hold a signature) is kept in
 *     `refusedHosts` (at most 5). Each file is streamed into the batch's private (0700) work folder,
 *     at most 2 GB, checked against Zotero's MD5 (a mismatch is fetched again, FILE_TRIES in all),
 *     unpacked when Zotero stored it compressed, and sniffed (`file-type`). A refused redirect, a
 *     missing file (e.g. a library that syncs files over WebDAV, or an older copy that never
 *     matches), a 403 on the file (a key that may not read files: checked against the library so a
 *     revoked key still ends the run), an oversize or damaged file leaves the item with a file note
 *     instead (R66). A dry run, or `files: false`, downloads nothing.
 *
 * Unattended runs (Task Z2; A4, A5): every item request asks with `includeTrashed=1`, so an item in
 * Zotero's bin is seen and never yielded as content; a top-level one known here is yielded as
 * `{ gone: "bin" }`. An incremental run yields each key of `/deleted?since=` that is known here
 * (ScanContext.knownIds, this library only) as `{ gone: "deleted" }`; child keys are counted only. A
 * full run yields a known item as `{ gone: "deleted" }` by absence only when the scan was complete
 * AND the key is missing from the library's complete key list, whole by its own evidence (A6:
 * Total-Results, exactly that many keys, every key the scan saw). The list is taken right after the
 * read, pinned to the scan's version and again after every restart, before any file is downloaded
 * (A7, R215). If it cannot be had whole in 3 tries, the full run is not finished: nobody is gone by
 * absence, the version is not recorded, and the run's notes say so once (ZOTERO_WEB_NOTES.notConfirmed).
 * Gone items are yielded last, after a check that the key may still read the library; any failure first
 * yields none. ScanContext.skip lets the engine pass an item by before anything under it is fetched.
 *
 * No file downloaded twice (Task Z4): before an attachment's file is asked for, ScanContext.fileKnown
 * says whether an earlier import stored this attachment at this very version (the engine's journal,
 * `ext.parts`, with the hash of the asset it became). Then nothing is requested for it (not even the
 * redirect), its annotations carry `assetSha256` and are anchored in that asset, and it counts as brought
 * in (the version token is the one a successful download gives, exactly as before this task). Each item
 * reports its stored files in `version.parts` (attachment version and file hash; a failed download has
 * no part); the engine journals only those the source holds.
 *
 * A complete scan: every paged listing carried Total-Results and added up to it, no page failed or
 * was cut for good (a page cut in mid-body is asked for again), the tag colours came in or are not
 * set, and the read ended in one whole read at one library version (a restart after the library
 * changed, R80, that then read everything is complete; the restart limit is not). A Backoff or
 * Retry-After that was waited out changes nothing; the longest wait asked for (at most a day) is
 * reported in `backoffUntil` for the scheduler.
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
 * the whole item is compared; `/deleted?since=` is counted and its known keys yielded as gone (above;
 * nothing is deleted here). startZoteroWebImport reads `since` from the project's import settings
 * and, when the batch finished, records the library version Zotero reported (a governed, audited
 * write); resumeZoteroWebImport resumes a batch with the `since` and files mode it started with and
 * records the version under the same rule (finishZoteroWebRun). Sources deleted here stay deleted
 * (R73 tombstones, as for the local import).
 *
 * What holds `since` back (the next run asks for the same changes again; A4): a failed item (the scan's
 * own failure included: unreachable, a 429 or 5xx outlasting its retries, a page cut for good, refused
 * key, library gone, the restart limit), a scan that was not complete (above; on a full run with known
 * items unseen, a key list that could not be had whole), a download that failed
 * in a way a later run may fix (5xx, a connection cut, no disk space; also in a part before a resume).
 * What does not: a Backoff or Retry-After waited out, a refused redirect host, a file Zotero says it
 * does not have (404), a checksum that never matched in 3 tries, a key that may not read files, a file
 * over 2 GB. A resumed batch records the LOWEST version any of its parts read at (A5).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { libraryVersion } from "../resources.js";
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
import type { BatchRecord } from "./bulk/batch.js";

const VERSION: string = libraryVersion();

export const ZOTERO_API_ORIGIN = "https://api.zotero.org";

/**
 * Hosts a file download may be redirected to (https only; see zoteroFileHostAllowed for the exact
 * rule). Zotero's file endpoint answers 302 with a pre-signed URL on its Amazon S3 storage
 * (zotero/dataserver `Zotero_Storage::getDownloadURL`; the client's zfs.js reads the `Location`).
 * UNVERIFIED (R79 open): the bucket host could not be observed without a key; these are the
 * documented S3 forms plus Zotero's file host (kept by R206/A1). If a run records a refused host,
 * add it to zoteroFileHostAllowed after the owner's report.
 */
export const ZOTERO_STORAGE_HOSTS: readonly string[] = ["files.zotero.net", "zoterofilestorage.s3.amazonaws.com", "s3.amazonaws.com"];

const STORAGE_PATH = "/zoterofilestorage/";

/**
 * Whether a file redirect may be followed (R206 (3), Amendment A1): https on port 443, no
 * credentials, and host `zoterofilestorage.s3.amazonaws.com`, `files.zotero.net` (any path), or
 * `s3.amazonaws.com` with a path under `/zoterofilestorage/`. Everything else is refused.
 */
export function zoteroFileHostAllowed(u: URL): boolean {
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  if (h === "zoterofilestorage.s3.amazonaws.com" || h === "files.zotero.net") return true;
  return h === "s3.amazonaws.com" && u.pathname.startsWith(STORAGE_PATH) && u.pathname.length > STORAGE_PATH.length;
}

// ---- test-only switches (Task Z11, Ruling R289 a) -------------------------------------------------------------
// Each is honoured ONLY when NODE_ENV is exactly "test" (as AO_LOOKUP_FIXTURES, R47): in any other mode its value
// is not looked at. Each is read once, at the service's start (apps/library-service/src/main.ts), by a function
// that takes the environment; in test mode a value not in its exact form refuses the start, naming the variable.

/** `AO_ZOTERO_API_ORIGIN=http://127.0.0.1:<port>`: a stand-in for Zotero's servers on this computer. */
export const ZOTERO_API_ORIGIN_ENV = "AO_ZOTERO_API_ORIGIN";

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u;

/**
 * The stand-in's origin when the switch is on; undefined otherwise (always outside test mode). In test mode a
 * value that is not exactly `http://127.0.0.1:<port>` (port 1–65535; no other host, no "localhost", no https, no
 * path — not even "/" —, no query, no credentials) throws a sentence that names the variable but never its value.
 */
export function zoteroApiOriginFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env.NODE_ENV !== "test") return undefined;
  const value = env[ZOTERO_API_ORIGIN_ENV];
  if (value === undefined) return undefined;
  const m = LOOPBACK_ORIGIN.exec(value);
  if (!m || Number(m[1]) > 65535) {
    throw new Error(`${ZOTERO_API_ORIGIN_ENV} must be exactly http://127.0.0.1:<port> with a port from 1 to 65535 (test mode), so the library service was not started.`);
  }
  return value;
}

/**
 * The loopback origin in force (set only by useZoteroApiOriginFromEnv at the service's start): as typed (the API
 * base) and as parsed once, which is what a redirect is compared with (a parsed origin drops a default port, so
 * `http://127.0.0.1:80` is the origin `http://127.0.0.1`; R307 c).
 */
let testOrigin: { typed: string; parsed: string } | undefined;

/**
 * Applies the origin switch at the service's start. With it on, that one loopback origin is Zotero's API AND the
 * only origin a file may be fetched from (Zotero's real storage hosts are then refused, R289 a); with it off, the
 * product's origin and zoteroFileHostAllowed apply unchanged. Returns the API origin now in force.
 */
export function useZoteroApiOriginFromEnv(env: NodeJS.ProcessEnv): string {
  const typed = zoteroApiOriginFromEnv(env);
  testOrigin = typed === undefined ? undefined : { typed, parsed: new URL(typed).origin };
  return zoteroApiOrigin();
}

/** The API origin in force: ZOTERO_API_ORIGIN, or the test switch's loopback origin. Package-internal. */
export function zoteroApiOrigin(): string {
  return testOrigin?.typed ?? ZOTERO_API_ORIGIN;
}

/** Whether a file redirect may be followed: the product's rule, or (test switch on) the loopback origin only. */
function fileRedirectAllowed(u: URL): boolean {
  if (testOrigin === undefined) return zoteroFileHostAllowed(u);
  return u.origin === testOrigin.parsed && !u.username && !u.password;
}

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
/** Tries of a file whose checksum does not match, within one run (then noted, never retried for ever). */
export const ZOTERO_FILE_TRIES = 3;
/** Refused redirect hosts kept in the scan result. */
const MAX_REFUSED_HOSTS = 5;
/** The longest wait reported in `backoffUntil` (a day). */
const MAX_BACKOFF_REPORT_MS = 24 * 3_600_000;

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
  notInStorage: "attached file is not in Zotero's online storage (it may be kept on a WebDAV server)",
  redirectRefused: "attached file download was redirected elsewhere and was not followed",
  tooLarge: "attached file is larger than 2 GB and was not downloaded",
  failed: "attached file could not be downloaded",
  /** After ZOTERO_FILE_TRIES tries (A5). */
  checksum:
    "attached file did not match Zotero's checksum after 3 tries and was not brought in (the copy in Zotero's storage may be damaged or out of date, or the file may be kept elsewhere, for example on a WebDAV server)",
  noSpace: "attached file was not downloaded: not enough free disk space",
  noFileAccess: "attached file was not fetched: the Zotero key may not read files",
} as const;

/** File notes a later run may not get again: they hold `since` back, so the next run asks for the item again (R80). */
const HOLDS_SINCE: ReadonlySet<string> = new Set([ZOTERO_WEB_FILE_NOTES.failed, ZOTERO_WEB_FILE_NOTES.noSpace]);

/** A file the run wanted and did not store: what the item says, whether `since` waits for it, whether its version token is marked. */
interface FileMiss {
  note: string;
  /** The version token is marked (`download-failed:<key>`), so a later run that stores the file sees the item as changed. */
  stamp: boolean;
}
const miss = (note: string, stamp: boolean): FileMiss => ({ note, stamp });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const ZOTERO_WEB_NOTES = {
  snapshots: (n: number) => `Not imported from Zotero: ${plural(n, "web page snapshot", "web page snapshots")}.`,
  pendingDownloads: (n: number) => `${plural(n, "file is", "files are")} downloaded from Zotero when the import runs (not in this preview).`,
  groupLinked: (n: number) =>
    `Not imported from Zotero: ${plural(n, "linked file in a group library", "linked files in a group library")} (linked files live on the computer of the member who added them).`,
  /** Counts top-level items known here only (A5); Z5 adds what it marked. */
  deleted: (n: number) => `${plural(n, "item you have here was", "items you have here were")} deleted in Zotero since the last sync; nothing was deleted here.`,
  filesOff: (n: number) => `${plural(n, "attached file was", "attached files were")} not fetched: the Zotero key may not read files.`,
  /** A full run not finished for lack of a whole key list (A7, R215): once in the run's notes. */
  notConfirmed: "This sync could not confirm which items were deleted in Zotero, so the next sync will read the whole library again.",
} as const;

/** Package-internal (zotero-web-account.ts). */
export class ZoteroWebError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The library changed while the scan read it (412, or a different Last-Modified-Version). */
class LibraryChanged extends Error {}

/** A JSON answer that broke off in its body, or is not JSON: asked for again (bounded). */
class CutAnswer extends Error {}

export interface ZoteroWebOptions {
  libraryType: "user" | "group";
  /** The numeric user or group ID (Zotero → Settings → Security / the group's URL). */
  libraryId: string;
  /** The keyring entry holding the API key (default "zotero-api-key"). */
  apiKeySecretName?: SecretName;
  /** Ask only for items changed after this library version (incremental). */
  since?: number;
  /** Read the whole library, whatever `since` says (startZoteroWebImport: ignore the recorded version). */
  full?: boolean;
  /** Download files (default true). False: nothing is downloaded, and one scan note counts the files left (a key that may not read files). */
  files?: boolean;
  /** Test seams. */
  dispatcher?: Dispatcher;
  sleep?: (ms: number) => Promise<void>;
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
  /**
   * The scan read the whole library (or every change) without stopping, and nothing it should have
   * yielded as gone was held back (a full run whose picture was not whole is not complete).
   */
  completed: boolean;
  /** Downloads that failed in a way a later run may fix (network, 5xx, a cut, disk space). */
  downloadsFailed: number;
  /** The latest moment any Backoff or Retry-After in this run asked for (ms since the epoch, uncapped). */
  backoffUntil?: number;
  /** Names of the hosts file redirects went to that were refused (never a path or query), at most 5. */
  refusedHosts: string[];
  /** Items yielded as gone: deleted in Zotero, or in Zotero's bin. */
  goneKeys: { deleted: number; bin: number };
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
/** Package-internal (zotero-web-account.ts reuses the key handling, Backoff and retries); not exported from the package index. */
export class ZoteroApi {
  private nextAt = 0;
  /**
   * The library version the scan is reading (from the first page). Later item and collection
   * requests send it as If-Unmodified-Since-Version; a 412 or another Last-Modified-Version means the
   * library changed under the scan (LibraryChanged).
   */
  scanVersion: number | undefined;
  /**
   * The scan is not complete (A5): a page held entries that were not items, a listing had no
   * Total-Results or did not add up to it, or something that should have come in failed for a
   * passing reason (tag colours). Since is held back and nothing is yielded gone by absence.
   */
  lossy = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxWait: number;

  constructor(
    private readonly apiKey: string,
    private readonly o: ZoteroWebOptions,
    private readonly signal: AbortSignal,
    /** Where back-offs and refused hosts are reported (the adapter's scan result). */
    private readonly result: ZoteroWebScanResult,
  ) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = o.maxRetries ?? MAX_RETRIES;
    this.maxWait = o.maxWaitMs ?? MAX_WAIT_MS;
  }

  private async waitTurn(): Promise<void> {
    const wait = this.nextAt - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.signal.throwIfAborted();
  }

  /** Waits as a retry does after `attempt` failures (1 s, 2 s, 4 s …, capped). */
  async pause(attempt: number): Promise<void> {
    await this.sleep(this.retryWait(attempt, undefined));
    this.signal.throwIfAborted();
  }

  /** The server asked for a pause of `ms`: the run reports the longest one asked for (uncapped). */
  private askedToWait(ms: number | undefined): void {
    if (ms === undefined) return;
    // A day at most: a wild header must not park the scheduler for years (M6).
    const until = Date.now() + Math.min(ms, MAX_BACKOFF_REPORT_MS);
    this.result.backoffUntil = Math.max(this.result.backoffUntil ?? 0, until);
  }

  private noteBackoff(h: Headers): void {
    const ms = retryAfterMs(header(h, "backoff"), Date.now());
    this.askedToWait(ms);
    if (ms !== undefined) this.nextAt = Math.max(this.nextAt, Date.now() + Math.min(ms, this.maxWait));
  }

  private refusedHost(u: URL | undefined): void {
    const h = u?.hostname.toLowerCase().slice(0, 253);
    const list = this.result.refusedHosts;
    if (h && !list.includes(h) && list.length < MAX_REFUSED_HOSTS) list.push(h);
  }

  private retryWait(attempt: number, h: Headers | undefined): number {
    const ms = h ? retryAfterMs(header(h, "retry-after"), Date.now()) : undefined;
    return Math.min(ms ?? 1000 * 2 ** attempt, this.maxWait);
  }

  private headers(withKey: boolean): Record<string, string> {
    return { "user-agent": USER_AGENT, "zotero-api-version": "3", ...(withKey ? { "zotero-api-key": this.apiKey } : {}) };
  }

  /** One GET with retries on 429/5xx/network errors. `accept(status)` decides which answers are final. */
  async get(url: URL, withKey: boolean, accept: (s: number) => boolean, extra: Record<string, string> = {}): Promise<Dispatcher.ResponseData> {
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
      if (withKey && (s === 429 || s === 503)) this.askedToWait(retryAfterMs(header(res.headers, "retry-after"), Date.now()));
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
    const url = new URL(path, zoteroApiOrigin());
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    // An answer cut in the middle of its body (or unreadable as JSON) is asked for again, like a dropped one (M7).
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.jsonOnce(url, versioned);
      } catch (err) {
        if (!(err instanceof CutAnswer)) throw err;
        if (this.signal.aborted) throw this.signal.reason ?? err;
        if (attempt >= this.maxRetries) throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
        await this.sleep(this.retryWait(attempt, undefined));
      }
    }
  }

  private async jsonOnce(url: URL, versioned: boolean): Promise<{ body: unknown; headers: Headers }> {
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
    try {
      for await (const c of res.body as AsyncIterable<Buffer>) {
        size += c.length;
        if (size > max) {
          res.body.destroy();
          throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
        }
        chunks.push(c);
      }
    } catch (err) {
      if (err instanceof ZoteroWebError || this.signal.aborted) throw err;
      throw new CutAnswer();
    }
    try {
      return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, headers: res.headers };
    } catch {
      throw new CutAnswer();
    }
  }

  /**
   * Whether the key may still read the library: one small request. Throws the refusal (keyRefused,
   * notFound) or `unavailable` like any request.
   */
  async checkLibrary(prefix: string): Promise<void> {
    const { body } = await this.json(`${prefix}/items/top`, { format: "versions", limit: 1 });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
  }

  /**
   * Downloads an attachment's file into `dest` (streamed, capped, MD5-checked). Returns the
   * file's path, or what the item says instead. A file whose checksum does not match is fetched
   * again, ZOTERO_FILE_TRIES times in all, then noted (`checksum`: damaged, out of date, or kept on
   * WebDAV). Never throws for a file-level problem; aborts and refused keys do.
   */
  async file(prefix: string, attKey: string, dest: string, md5: string | undefined): Promise<{ path: string } | FileMiss> {
    for (let attempt = 1; ; attempt++) {
      const got = await this.fileOnce(prefix, attKey, dest, md5);
      if (!("mismatch" in got)) return got;
      if (attempt >= ZOTERO_FILE_TRIES) return miss(ZOTERO_WEB_FILE_NOTES.checksum, true);
    }
  }

  private async fileOnce(prefix: string, attKey: string, dest: string, md5: string | undefined): Promise<{ path: string } | FileMiss | { mismatch: true }> {
    // A file Zotero does not have, or one too large, is not worth asking for again; anything else marks the item's token.
    const note = (n: string): FileMiss => miss(n, n !== ZOTERO_WEB_FILE_NOTES.notInStorage && n !== ZOTERO_WEB_FILE_NOTES.tooLarge);
    const max = this.o.maxFileBytes ?? MAX_ZOTERO_FILE_BYTES;
    const { dir } = splitDownloadPath(dest);
    const free = () => (this.o.freeSpace ?? statfsFree)(dir);
    if ((await free()) < SPACE_MARGIN) return note(ZOTERO_WEB_FILE_NOTES.noSpace);
    let res: Dispatcher.ResponseData;
    try {
      res = await this.get(new URL(`${prefix}/items/${attKey}/file`, zoteroApiOrigin()), true, (s) => s === 200 || (s >= 300 && s < 400));
    } catch (err) {
      if (err instanceof ZoteroWebError) {
        if (err.reason === ZOTERO_WEB_REASONS.notFound) return note(ZOTERO_WEB_FILE_NOTES.notInStorage);
        if (err.reason === ZOTERO_WEB_REASONS.keyRefused) {
          // A key that may not read files, or a key revoked meanwhile: the library itself says which.
          try {
            await this.checkLibrary(prefix);
          } catch (e) {
            if (e instanceof ZoteroWebError && e.reason !== ZOTERO_WEB_REASONS.unavailable) throw e;
            if (e instanceof ZoteroWebError) return note(ZOTERO_WEB_FILE_NOTES.failed);
            throw e;
          }
          return note(ZOTERO_WEB_FILE_NOTES.noFileAccess);
        }
        return note(ZOTERO_WEB_FILE_NOTES.failed);
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
        next = new URL(loc ?? "", zoteroApiOrigin());
      } catch {
        return note(ZOTERO_WEB_FILE_NOTES.redirectRefused);
      }
      if (!loc || hop >= MAX_REDIRECTS) return note(ZOTERO_WEB_FILE_NOTES.redirectRefused);
      if (!fileRedirectAllowed(next)) {
        this.refusedHost(next); // its name only: the path and query carry the signature
        return note(ZOTERO_WEB_FILE_NOTES.redirectRefused);
      }
      try {
        res = await this.get(next, false, (s) => s === 200 || (s >= 300 && s < 400));
      } catch (err) {
        if (err instanceof ZoteroWebError) return note(ZOTERO_WEB_FILE_NOTES.failed);
        throw err;
      }
    }
    const len = Number(header(res.headers, "content-length"));
    if (Number.isFinite(len) && len > max) {
      res.body.destroy();
      return note(ZOTERO_WEB_FILE_NOTES.tooLarge);
    }
    if (Number.isFinite(len) && (await free()) < len * (compressed ? 2 : 1) + SPACE_MARGIN) {
      res.body.destroy();
      return note(ZOTERO_WEB_FILE_NOTES.noSpace);
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
      return note(over ? ZOTERO_WEB_FILE_NOTES.tooLarge : ZOTERO_WEB_FILE_NOTES.failed);
    }
    if (!compressed) {
      if (md5 && /^[0-9a-f]{32}$/iu.test(md5) && hash.digest("hex") !== md5.toLowerCase()) {
        await fsp.rm(target, { force: true });
        return { mismatch: true };
      }
      return { path: target };
    }
    // Stored compressed (older Zotero clients): a ZIP holding the file, unpacked with the archive limits.
    const out = `${dest}.d`;
    try {
      const entries = await extractArchive(target, out, { maxEntries: 10, maxEntryBytes: max, maxTotalBytes: max }, this.signal);
      const want = splitDownloadPath(dest).name;
      const e = entries.find((x) => !x.refused && x.name === want) ?? entries.find((x) => !x.refused && x.path);
      if (!e) return note(ZOTERO_WEB_FILE_NOTES.failed);
      // Zotero's MD5 is of the file itself, so it is checked after unpacking.
      if (md5 && /^[0-9a-f]{32}$/iu.test(md5)) {
        const h = createHash("md5");
        for await (const c of createReadStream(e.path) as AsyncIterable<Buffer>) h.update(c);
        if (h.digest("hex") !== md5.toLowerCase()) {
          await fsp.rm(out, { recursive: true, force: true });
          return { mismatch: true };
        }
      }
      return { path: e.path };
    } catch (err) {
      if (this.signal.aborted) throw this.signal.reason ?? err;
      return note(ZOTERO_WEB_FILE_NOTES.failed);
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

/** Item listings ask for the bin too (an item in Zotero's bin carries `data.deleted`). */
const WITH_BIN = { includeTrashed: 1 } as const;

async function* pages(api: ZoteroApi, path: string, query: Record<string, string | number>): AsyncGenerator<{ items: WebItem[]; headers: Headers }> {
  let start = 0;
  for (;;) {
    const { body, headers } = await api.json(path, { format: "json", include: "data", limit: PAGE, start, ...query }, true);
    if (!Array.isArray(body)) throw new ZoteroWebError(ZOTERO_WEB_REASONS.unavailable);
    const items = body.filter(isItem).map(asItem);
    if (items.length !== body.length) api.lossy = true; // something on the page was not an item: not a whole picture
    yield { items, headers };
    start += body.length;
    const total = Number(header(headers, "total-results"));
    if (Number.isFinite(total) && header(headers, "total-results") !== undefined) {
      if (start >= total) {
        if (start !== total) api.lossy = true; // more than announced: the listing moved under us
        return;
      }
      if (!body.length) {
        // The listing ended before the total it announced.
        api.lossy = true;
        return;
      }
    } else {
      // No Total-Results: nothing says the listing is whole (A5, I3). Read on to a short page, but not complete.
      api.lossy = true;
      if (body.length < PAGE) return;
    }
    if (start >= MAX_ITEMS) throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
  }
}

const libraryVersionOf = (h: Headers): number | undefined => {
  const v = Number(header(h, "last-modified-version"));
  return Number.isInteger(v) && v >= 0 ? v : undefined;
};

/** Everything fetched, by key; items in the bin kept apart (`trashed`), never as content. */
class Tree {
  readonly byKey = new Map<string, WebItem>();
  readonly trashed = new Map<string, WebItem>();
  add(i: WebItem): void {
    if (this.byKey.size + this.trashed.size >= MAX_ITEMS && !this.has(i.key)) throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
    if (i.data.deleted) {
      this.byKey.delete(i.key);
      this.trashed.set(i.key, i);
      return;
    }
    this.trashed.delete(i.key);
    this.byKey.set(i.key, i);
  }
  /** Seen in this scan, in the library or in its bin. */
  has(key: string): boolean {
    return this.byKey.has(key) || this.trashed.has(key);
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

/** Everything in the library, the bin included. */
async function fullTree(api: ZoteroApi, prefix: string, result: ZoteroWebScanResult): Promise<Tree> {
  const tree = new Tree();
  for await (const p of pages(api, `${prefix}/items`, WITH_BIN)) {
    result.libraryVersion ??= libraryVersionOf(p.headers);
    for (const i of p.items) tree.add(i);
  }
  return tree;
}

/**
 * What changed since `since`: each changed item's top-level item, with all its children (and their
 * annotations), except items `skip` says the engine passes by (nothing is listed under them).
 */
async function changedTree(api: ZoteroApi, prefix: string, since: number, result: ZoteroWebScanResult, skip: (topKey: string) => boolean): Promise<{ tree: Tree; tops: Set<string> }> {
  const tree = new Tree();
  const changed: WebItem[] = [];
  for await (const p of pages(api, `${prefix}/items`, { since, ...WITH_BIN })) {
    result.libraryVersion ??= libraryVersionOf(p.headers);
    for (const i of p.items) {
      changed.push(i);
      tree.add(i);
    }
  }
  // Parents not in the change set (a changed annotation's attachment, an attachment's item), up to two levels.
  for (let round = 0; round < 3; round++) {
    const missing = [...new Set(changed.map((i) => tree.parentOf(i)).concat([...tree.byKey.values()].map((i) => tree.parentOf(i))))].filter(
      (k): k is string => !!k && !tree.has(k),
    );
    if (!missing.length) break;
    for (let i = 0; i < missing.length; i += 50) {
      const { body } = await api.json(`${prefix}/items`, { format: "json", include: "data", itemKey: missing.slice(i, i + 50).join(","), limit: 50, ...WITH_BIN }, true);
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
    if (t && !skip(t)) tops.add(t);
  }
  // The whole of each changed item: its children, and the children of its attachments.
  for (const t of tops) {
    for await (const p of pages(api, `${prefix}/items/${t}/children`, WITH_BIN)) {
      for (const c of p.items) {
        tree.add(c);
        if (c.data.itemType === "attachment" && !c.data.deleted) {
          for await (const q of pages(api, `${prefix}/items/${c.key}/children`, WITH_BIN)) for (const a of q.items) tree.add(a);
        }
      }
    }
  }
  return { tree, tops };
}

/**
 * The item's collection paths (names, root first) and, beside each (Z6, R236 f), the Zotero collection keys along it:
 * the key, not the name, tells a collection renamed in Zotero from a new one.
 */
type CollectionPaths = (keys: unknown) => { paths: string[][]; keys: string[][] };

async function collectionPaths(api: ZoteroApi, prefix: string): Promise<CollectionPaths> {
  const colls = new Map<string, { name: string; parent?: string }>();
  for await (const p of pages(api, `${prefix}/collections`, {})) {
    for (const c of p.items) {
      if (colls.size >= MAX_COLLECTIONS) throw new ZoteroWebError(ZOTERO_WEB_REASONS.tooLarge);
      if (c.data.deleted) continue;
      const parent = typeof c.data.parentCollection === "string" && KEY.test(c.data.parentCollection) ? c.data.parentCollection : undefined;
      colls.set(c.key, { name: text(str(c.data.name)).slice(0, 200) || "Untitled", ...(parent ? { parent } : {}) });
    }
  }
  const cache = new Map<string, { names: string[]; keys: string[] } | null>();
  const pathOf = (key: string): { names: string[]; keys: string[] } | null => {
    if (cache.has(key)) return cache.get(key)!;
    const chain: string[] = [];
    const chainKeys: string[] = [];
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
      chainKeys.push(k);
      k = c.parent;
    }
    const out = ok && chain.length ? { names: chain.reverse(), keys: chainKeys.reverse() } : null;
    cache.set(key, out);
    return out;
  };
  return (keys) => {
    const out = { paths: [] as string[][], keys: [] as string[][] };
    for (const k of Array.isArray(keys) ? keys : []) {
      if (typeof k !== "string" || !colls.has(k)) continue;
      const p = pathOf(k);
      if (p && out.paths.length < MAX_FOLDER_PATHS) {
        out.paths.push(p.names);
        out.keys.push(p.keys);
      }
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
    // 404: no colours set. Anything else is a passing failure: the colours did not come in (M4).
    if (!(err instanceof ZoteroWebError && err.reason === ZOTERO_WEB_REASONS.notFound)) api.lossy = true;
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
      sortIndex: str(d.annotationSortIndex).slice(0, 64),
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

async function* scanWeb(
  o: ZoteroWebOptions,
  ref: string,
  result: ZoteroWebScanResult,
  signal: AbortSignal,
  ctx: ScanContext | undefined,
  readVersions: { zoteroReadVersions?: number[] },
): AsyncGenerator<ScanItem> {
  const fail = (reason: string): ScanItem => ({ key: "zotero-web:", files: [], unreadable: reason });
  result.completed = false;
  result.deletedInZotero = 0;
  result.downloadsFailed = 0;
  result.refusedHosts = [];
  result.goneKeys = { deleted: 0, bin: 0 };
  delete result.libraryVersion;
  delete result.backoffUntil;
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
  const api = new ZoteroApi(apiKey, o, signal, result);
  apiKey = null;
  const prefix = `/${o.libraryType === "user" ? "users" : "groups"}/${o.libraryId}`;
  const since = o.full ? undefined : o.since;
  const wantFiles = o.files !== false;
  const skip = (key: string): boolean => ctx.skip?.(key) === true;
  let tree!: Tree;
  let tops: Set<string> | undefined;
  let pathsOf!: CollectionPaths;
  let colors: Map<string, string>;
  /** Keys `/deleted?since=` lists (items; children among them). */
  let deletedKeys: string[] = [];
  /** Top-level items of this library known here (an item never imported is neither content nor gone). */
  const knownHere = knownOf(ctx, ref);
  /** Full runs (A6, A7): the complete key list, asked for when known items went unseen; undefined when it could not be had whole. */
  let keyList: Set<string> | undefined;
  let keyListAsked = false;
  try {
    // Read everything at one library version: a change under the scan restarts it (R80 I2).
    for (let attempt = 0; ; attempt++) {
      api.scanVersion = undefined;
      api.lossy = false;
      delete result.libraryVersion;
      keyList = undefined;
      keyListAsked = false;
      try {
        if (since === undefined) tree = await fullTree(api, prefix, result);
        else ({ tree, tops } = await changedTree(api, prefix, since, result, (k) => skip(`zotero:${k}`)));
        pathsOf = await collectionPaths(api, prefix);
        // A7 (R215): the key list that decides "gone by absence" is taken here, at the version the scan is pinned
        // to and again after every restart, BEFORE any file is downloaded (hours of downloads, during which the
        // researcher goes on using Zotero, no longer lie between the read and the list). Pinned: a library that
        // changed meanwhile restarts the read (R80). Only when something known here went unseen (A6's rules).
        if (since === undefined && !api.lossy && [...knownHere].some((k) => !tree.has(k))) {
          keyListAsked = true;
          keyList = await completeKeyList(api, prefix, tree);
        }
        break;
      } catch (err) {
        if (!(err instanceof LibraryChanged)) throw err;
        if (attempt >= MAX_RESTARTS) throw new ZoteroWebError(ZOTERO_WEB_REASONS.changing);
      }
    }
    result.libraryVersion = api.scanVersion ?? result.libraryVersion;
    // The version this part of the batch read at: kept in the batch record (C1, A5). Unknown: none is recorded.
    const read = api.scanVersion;
    if (read === undefined) delete readVersions.zoteroReadVersions;
    else if (readVersions.zoteroReadVersions && !readVersions.zoteroReadVersions.includes(read)) readVersions.zoteroReadVersions.push(read);
    colors = await tagColorsOf(api, prefix);
    if (since !== undefined) {
      const { body } = await api.json(`${prefix}/deleted`, { since });
      const items = (body as { items?: unknown } | null)?.items;
      deletedKeys = Array.isArray(items) ? items.filter((k): k is string => typeof k === "string") : [];
      result.deletedInZotero = deletedKeys.length;
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
  let filesOff = 0;
  let groupLinked = 0;
  const work = join(await ctx.workDir(), "zotero-web");
  await fsp.mkdir(work, { recursive: true, mode: 0o700 });
  // Gone from Zotero: only items known here (an item never imported is neither content nor gone), and
  // only after every page was read (a failure has returned above). Decided here, before the items, from what the
  // listing read (nothing the items below fetch changes it), so that the total below counts them (R392).
  const gone = new Map<string, { gone: "deleted" | "bin"; version: string }>();
  /** A full run not finished for lack of a whole key list (A7): said once in the run's notes. */
  let notConfirmed = false;
  for (const t of tree.trashed.values()) if (!tree.parentOf(t) && knownHere.has(t.key)) gone.set(t.key, { gone: "bin", version: `bin:${t.version}` });
  /** Top-level items known here that Zotero says it deleted (the note counts these, A5). */
  let deletedHere = 0;
  if (since !== undefined) {
    // Incremental: only what Zotero said. Keys of items known here (child keys never are: they are counted only).
    for (const k of deletedKeys) {
      if (!knownHere.has(k) || tree.has(k)) continue;
      deletedHere++;
      gone.set(k, { gone: "deleted", version: "deleted" });
    }
  } else if (!api.lossy) {
    // Full: absence alone never makes an item gone (A5). A known item not seen is gone only when its key is
    // also missing from the library's complete key list, whole by its own evidence (A6), taken before the
    // downloads at the scan's version (A7).
    const unseen = [...knownHere].filter((k) => !tree.has(k));
    if (unseen.length) {
      if (keyListAsked && keyList) {
        for (const k of unseen) if (!keyList.has(k)) gone.set(k, { gone: "deleted", version: "deleted" });
      } else {
        // No whole key list: this full run is not finished (A6). Nobody is gone by absence and the version is not
        // recorded, so the next run is full again and makes the check again; the run says so (A7).
        api.lossy = true;
        notConfirmed = keyListAsked;
      }
    }
  }
  for (const k of [...gone.keys()]) if (skip(`zotero:${k}`)) gone.delete(k);

  // R392: every page is read, so the number of items this scan will yield is known before the first: the top-level
  // items below (children, notes, annotations and what the engine passes by left out) and the gone ones. An item
  // found empty below (known only once its files are looked at) lowers it when it is passed by.
  let told = gone.size;
  for (const it of tree.byKey.values()) {
    if (tree.parentOf(it) || (tops && !tops.has(it.key)) || skip(`zotero:${it.key}`)) continue;
    const type = str(it.data.itemType);
    if (type !== "note" && type !== "annotation") told++;
  }
  ctx.total?.(told);

  try {
    for (const it of tree.byKey.values()) {
      signal.throwIfAborted();
      const d = it.data;
      const type = str(d.itemType);
      if (tree.parentOf(it)) continue; // children come with their item
      if (tops && !tops.has(it.key)) continue;
      // The engine passes this item by (e.g. already in a resumed batch's journal): nothing is fetched for it.
      if (skip(`zotero:${it.key}`)) continue;
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
      /** Stored files by attachment key: its version and the file's hash (Z4; a failed download has none). */
      const parts: Record<string, { v: number; sha256: string }> = {};
      for (const a of atts) {
        if (a !== it) stamp.push(`${a.key}:${a.version}`);
        const ad = a.data;
        const mode = str(ad.linkMode);
        if (a !== it && str(ad.note).trim()) counts.attachmentNotes++;
        let file: string | undefined;
        /** Z4: the hash of the stored file this attachment's annotations are anchored in, when it was not downloaded again. */
        let storedSha: string | undefined;
        if (mode === "imported_file" || mode === "imported_url") {
          const snapshot = /^text\//iu.test(str(ad.contentType));
          // Stored by an earlier import at this very version (the engine's journal): nothing is asked for, not even
          // the redirect. Counts as brought in: the version token is the one a successful download gives.
          const known = snapshot ? undefined : knownFile(ctx, `${ref}/${it.key}`, a.key, a.version);
          if (snapshot) snapshots++;
          else if (known) {
            storedSha = known;
            parts[a.key] = { v: a.version, sha256: known };
          } else if (!wantFiles) {
            // A key that may not read files: none is asked for; one scan note counts them, and the token is marked.
            filesOff++;
            stamp.push(`download-failed:${a.key}`);
          } else if (ctx.dryRun) pendingDownloads++;
          else {
            const dir = join(work, a.key);
            await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
            const got = await api.file(prefix, a.key, join(dir, safeName(ad.filename)), typeof ad.md5 === "string" ? ad.md5 : undefined);
            if ("note" in got) {
              fileNotes.push(got.note);
              // Not recorded as done: the token differs from a later successful run's, so that run retries it.
              if (got.stamp) stamp.push(`download-failed:${a.key}`);
              // A failure a later run may fix holds since back (R80 I1).
              if (HOLDS_SINCE.has(got.note)) result.downloadsFailed++;
            }
            else {
              const st = await fsp.stat(got.path);
              const t = await fileTypeFromFile(got.path).catch(() => undefined);
              downloaded.push({ path: got.path, mime: t?.mime ?? "application/octet-stream", bytes: st.size });
              file = got.path;
              // The engine journals this part only if the source then holds a file with this hash (Z4).
              parts[a.key] = { v: a.version, sha256: await sha256Of(got.path) };
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
          if (x && storedSha && x.anchor) x.assetSha256 = storedSha;
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
      const hasParts = Object.keys(parts).length > 0;
      if (!fields.title && !files.length && !annotations.length && !fileNotes.length && !hasParts && !(isAtt && ctx.dryRun)) {
        ctx.total?.(--told); // an empty item: not one after all
        continue;
      }

      const tagColors: Record<string, string> = {};
      for (const t of fields.tags ?? []) {
        const c = colors.get(t.toLowerCase());
        if (c) tagColors[t] = c;
      }
      const { paths, keys: pathKeys } = pathsOf(d.collections);
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
        ...(paths.length ? { folderKeys: pathKeys } : {}),
        ...(fields.tags?.length ? { tags: fields.tags } : {}),
        ...(Object.keys(tagColors).length ? { tagColors } : {}),
        ...(annotations.length ? { annotations } : {}),
        externalKeys,
        version: { id: `${ref}/${it.key}`, version: token, ...(hasParts ? { parts } : {}) },
        ...(notesOut.length ? { fileNotes: notesOut } : {}),
      };
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || signal.aborted) throw signal.reason ?? err;
    // A refused key mid-scan (revoked while importing): the rest cannot be read.
    yield fail(err instanceof ZoteroWebError ? err.reason : ZOTERO_WEB_REASONS.unavailable);
    return;
  }

  if (gone.size) {
    // The key must still read this library now: a key revoked half-way yields no gone item.
    try {
      await api.checkLibrary(prefix);
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || signal.aborted) throw signal.reason ?? err;
      yield fail(err instanceof ZoteroWebError ? err.reason : ZOTERO_WEB_REASONS.unavailable);
      return;
    }
    for (const [k, g] of gone) {
      signal.throwIfAborted();
      result.goneKeys[g.gone]++;
      yield { key: `zotero:${k}`, files: [], gone: g.gone, version: { id: `${ref}/${k}`, version: g.version } };
    }
  }

  const left = ZOTERO_NOTES.notImported(counts);
  if (left) ctx.note?.(left);
  if (snapshots) ctx.note?.(ZOTERO_WEB_NOTES.snapshots(snapshots));
  if (groupLinked) ctx.note?.(ZOTERO_WEB_NOTES.groupLinked(groupLinked));
  if (pendingDownloads) ctx.note?.(ZOTERO_WEB_NOTES.pendingDownloads(pendingDownloads));
  if (filesOff) ctx.note?.(ZOTERO_WEB_NOTES.filesOff(filesOff));
  if (deletedHere) ctx.note?.(ZOTERO_WEB_NOTES.deleted(deletedHere));
  if (notConfirmed) ctx.note?.(ZOTERO_WEB_NOTES.notConfirmed);
  result.completed = !api.lossy;
}

/** Tries of the key list before a full run gives up on gone-by-absence (A6). */
const KEY_LIST_TRIES = 3;

/**
 * The library's complete key list, bin included, in one listing (`format=versions`, no limit), whole
 * by its own evidence (A6): it carries Total-Results, holds exactly that many valid keys, and holds
 * every key this scan saw (live or in the bin). A key absent from a whole list is deleted as of that list
 * (A6). It is asked for right after the read, pinned to the scan's version (A7): a library that changed
 * meanwhile (412, another Last-Modified-Version) throws LibraryChanged and the read restarts (R80). Asked
 * up to KEY_LIST_TRIES times with the usual waits; undefined when it cannot be had whole. A refusal (403)
 * or a library gone (404) is thrown.
 */
async function completeKeyList(api: ZoteroApi, prefix: string, seen: Tree): Promise<Set<string> | undefined> {
  for (let attempt = 0; attempt < KEY_LIST_TRIES; attempt++) {
    if (attempt) await api.pause(attempt - 1);
    let got: { body: unknown; headers: Headers };
    try {
      got = await api.json(`${prefix}/items`, { format: "versions", ...WITH_BIN }, true);
    } catch (err) {
      if (err instanceof ZoteroWebError && (err.reason === ZOTERO_WEB_REASONS.keyRefused || err.reason === ZOTERO_WEB_REASONS.notFound)) throw err;
      if (!(err instanceof ZoteroWebError)) throw err;
      continue;
    }
    const keys = wholeKeys(got.body, got.headers, seen);
    if (keys) return keys;
  }
  return undefined;
}

function wholeKeys(body: unknown, headers: Headers, seen: Tree): Set<string> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const total = header(headers, "total-results");
  if (total === undefined || !/^\d{1,9}$/u.test(total.trim())) return undefined;
  const keys = Object.keys(body as Record<string, unknown>);
  if (Number(total) !== keys.length || keys.some((k) => !KEY.test(k))) return undefined;
  const set = new Set(keys);
  for (const k of seen.byKey.keys()) if (!set.has(k)) return undefined;
  for (const k of seen.trashed.keys()) if (!set.has(k)) return undefined;
  return set;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** Z4: the hash of a file the engine says it stored for this attachment at this version (ScanContext.fileKnown), if any. */
function knownFile(ctx: ScanContext, versionId: string, attKey: string, attVersion: number): string | undefined {
  let got: { sha256: string } | undefined;
  try {
    got = ctx.fileKnown?.(versionId, attKey, attVersion);
  } catch {
    got = undefined; // the file is downloaded, as before
  }
  return typeof got?.sha256 === "string" && SHA256.test(got.sha256) ? got.sha256 : undefined;
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of createReadStream(path) as AsyncIterable<Buffer>) h.update(c);
  return h.digest("hex");
}

/** The item keys of this library (`<ref>/<key>`) among the ids the engine knows; ids of any other library are left out. */
function knownOf(ctx: ScanContext, ref: string): Set<string> {
  const out = new Set<string>();
  let ids: ReadonlySet<string> | undefined;
  try {
    ids = ctx.knownIds?.();
  } catch {
    ids = undefined;
  }
  for (const id of ids ?? []) {
    if (typeof id !== "string" || !id.startsWith(`${ref}/`)) continue;
    const k = id.slice(ref.length + 1);
    if (KEY.test(k)) out.add(k);
  }
  return out;
}

const TOOL = { name: "zotero-web-import", version: VERSION };

/** A Zotero library on zotero.org, through the Web API (the key from the OS keyring). */
export function zoteroWebAdapter(opts: ZoteroWebOptions): ZoteroWebAdapter {
  if (opts.libraryType !== "user" && opts.libraryType !== "group") throw new TypeError("libraryType must be user or group");
  if (typeof opts.libraryId !== "string" || !/^\d{1,12}$/u.test(opts.libraryId)) throw new TypeError("libraryId must be a numeric Zotero user or group ID");
  if (opts.since !== undefined && (!Number.isInteger(opts.since) || opts.since < 0)) throw new TypeError("since must be a library version");
  const ref = `${opts.libraryType}:${opts.libraryId}`;
  const since = opts.full ? undefined : opts.since;
  const result: ZoteroWebScanResult = { deletedInZotero: 0, completed: false, downloadsFailed: 0, refusedHosts: [], goneKeys: { deleted: 0, bin: 0 } };
  // Kept with the batch record (the engine copies it at each checkpoint), so a resumed batch asks for the same
  // changes with the same files mode, and knows the version every part read at (C1, A5).
  const resumeOptions: NonNullable<ImportSourceAdapter["resumeOptions"]> = {
    ...(since !== undefined ? { zoteroSince: since } : {}),
    zoteroFiles: opts.files !== false,
    zoteroReadVersions: [],
  };
  return {
    kind: "zotero-web",
    location: ref,
    ref,
    roots: [], // downloads go to the batch work folder (always allowed); linked files elsewhere need approval (R67)
    incremental: true,
    uniqueCitationKeys: true,
    tool: TOOL,
    resumeOptions,
    scan: (signal, ctx) => scanWeb(opts, ref, result, signal, ctx, resumeOptions),
    scanResult: () => ({ ...result, refusedHosts: [...result.refusedHosts], goneKeys: { ...result.goneKeys } }),
  };
}

/**
 * For resuming a batch from its record ("user:<id>" / "group:<id>"), with the options it started
 * with: its `since` (absent in records written before Task Z2, and for full runs: a full scan) and
 * files mode. Items already in the batch's journal are passed by before anything is fetched.
 */
export function zoteroWebAdapterFor(location: string, adapterOptions?: BatchRecord["adapterOptions"]): ZoteroWebAdapter | undefined {
  const m = /^(user|group):(\d{1,12})$/u.exec(location);
  if (!m) return undefined;
  const since = adapterOptions?.zoteroSince;
  const a = zoteroWebAdapter({
    libraryType: m[1] as "user" | "group",
    libraryId: m[2]!,
    ...(Number.isInteger(since) && since! >= 0 ? { since } : {}),
    ...(adapterOptions?.zoteroFiles === false ? { files: false } : {}),
  });
  // The versions the earlier parts read at. A record without them (written before A5), or with anything
  // that is not a version, leaves the batch's read version unknown: then no version is ever recorded for it.
  const read = adapterOptions?.zoteroReadVersions;
  if (Array.isArray(read) && read.length && read.every((v) => Number.isInteger(v) && v >= 0)) a.resumeOptions!.zoteroReadVersions = [...read];
  else delete a.resumeOptions!.zoteroReadVersions;
  return a;
}

/** The library version the last finished Web API import of `ref` saw in this project, if any. */
export function zoteroWebSince(repo: Repo, projectId: string, ref: string): number | undefined {
  const p = repo.getProject(projectId);
  const zw = p.importSettings?.zoteroWeb;
  return zw && Object.hasOwn(zw, ref) ? zw[ref]!.lastLibraryVersion : undefined;
}

/** Refused up front (BatchRefusedError) when no key is saved or there is no keyring; the key itself is not kept. */
async function requireKey(name: SecretName | undefined): Promise<void> {
  const { BatchRefusedError } = await import("./bulk/run.js");
  let key: string | null;
  try {
    key = await getSecret(name ?? "zotero-api-key");
  } catch (err) {
    if (err instanceof SecretStoreUnavailableError) throw new BatchRefusedError(ZOTERO_WEB_REASONS.noStore);
    throw err;
  }
  if (!key) throw new BatchRefusedError(ZOTERO_WEB_REASONS.noKey);
  key = null;
}

/**
 * Starts a Zotero Web API batch: refused up front (BatchRefusedError) when no key is saved or there
 * is no keyring; incremental from the project's recorded library version unless `full`. When the
 * batch finishes, the library version Zotero reported is recorded (finishZoteroWebRun), so the next
 * run asks only for later changes. `done` settles after that. An incremental run does not fetch
 * unchanged items, so it does not back-fill the sort index of annotations imported before it was kept
 * (R196); a `full` run does (the reader orders such a page geometrically until then).
 */
export async function startZoteroWebImport(deps: BulkImportDeps, projectId: string, opts: ZoteroWebOptions, options: ImportOptionsInput = {}): Promise<BatchHandle> {
  const { startBatch } = await import("./bulk/run.js");
  await requireKey(opts.apiKeySecretName);
  const { full, since: given, ...base } = opts;
  const ref = `${opts.libraryType}:${opts.libraryId}`;
  const since = full ? undefined : (given ?? zoteroWebSince(deps.repo, projectId, ref));
  const adapter = zoteroWebAdapter({ ...base, ...(since !== undefined ? { since } : {}) });
  const h = await startBatch(deps, projectId, adapter, options);
  return finishZoteroWebRun(deps, projectId, adapter, h, since);
}

/**
 * Resumes a Zotero Web API batch (paused, cancelled or interrupted) with the `since` and files mode
 * it started with, and, when it is done, records the library version under the same rule as a
 * start (finishZoteroWebRun). A batch of another kind is resumed as resumeBatch does it.
 */
export async function resumeZoteroWebImport(deps: BulkImportDeps, projectId: string, batchId: string): Promise<BatchHandle> {
  const { resumeBatch } = await import("./bulk/run.js");
  const { findBatch } = await import("./bulk/batch.js");
  const rec = await findBatch(deps.repo, projectId, batchId);
  const adapter = rec?.source.kind === "zotero-web" ? zoteroWebAdapterFor(rec.source.location, rec.adapterOptions) : undefined;
  if (!rec || !adapter || rec.state === "finished" || rec.state === "undone") return resumeBatch(deps, projectId, batchId);
  await requireKey(undefined);
  const h = await resumeBatch(deps, projectId, batchId, adapter);
  return finishZoteroWebRun(deps, projectId, adapter, h, rec.adapterOptions?.zoteroSince);
}

/**
 * When a Web batch (started or resumed) is done, records a library version, so the next run asks only
 * for later changes: the LOWEST version any part of the batch read at (`adapterOptions.zoteroReadVersions`;
 * none known for a part: nothing recorded). Only a run where nothing held it back moves it on (R80 I1,
 * A4): the batch finished with no failed item, the scan was complete, and no download failed in a way a
 * later run may fix, in this run or, for a resumed batch, in any earlier part of it (its journal). A
 * Backoff or Retry-After that was waited out holds nothing back.
 * The batch record keeps the version it recorded (`recordedLibraryVersion`), written first, so that
 * undo can put `since` back (Z5). `done` settles after that.
 */
export function finishZoteroWebRun(deps: BulkImportDeps, projectId: string, adapter: ZoteroWebAdapter, h: BatchHandle, since: number | undefined): BatchHandle {
  const done = h.done.then(async (r) => {
    const s = adapter.scanResult();
    // A Backoff or Retry-After that was waited out holds nothing back (A4); a failure that outlasted its retries is a failed item.
    if (r.state !== "finished" || r.counts.failed !== 0 || !s.completed || s.downloadsFailed !== 0) return r;
    try {
      const { BOOKKEEPING, findBatch, latestByKey, readJournal, writeBatchRecord } = await import("./bulk/batch.js");
      const rec = await findBatch(deps.repo, projectId, r.batchId);
      if (!rec || rec.state !== "finished") return r;
      // The LOWEST version any part of the batch read at (C1, A5): the items an earlier part brought in were
      // passed by later, so whatever changed in Zotero after that part's read must be asked for again.
      const read = rec.adapterOptions?.zoteroReadVersions;
      if (!Array.isArray(read) || !read.length || !read.every((x) => Number.isInteger(x) && x >= 0)) return r;
      const v = Math.min(...read);
      if (v === since) return r;
      // A download that failed before a resume is in the journal, not in this run's scan result.
      for (const e of latestByKey(await readJournal(deps.repo, projectId, rec.dir)).values()) if (e.notes?.some((n) => HOLDS_SINCE.has(n))) return r;
      const projectRel = deps.repo.getProject(projectId).folder;
      await deps.repo.mutate(projectId, BOOKKEEPING, (tx) => writeBatchRecord(tx, projectRel, { ...rec, recordedLibraryVersion: v }), { op: "import.batch.save" });
      await recordZoteroWebLibraryVersion(deps.repo, projectId, adapter.ref, v);
    } catch (err) {
      deps.debug?.(`zotero web: the library version could not be recorded (${err instanceof Error ? err.name : "error"})`);
    }
    return r;
  });
  done.catch(() => {});
  return { ...h, done };
}
