/**
 * "Search sources" (Find and acquire Task F12; Ruling R290 b, d, e, g): the settings file, the e-mails by service,
 * which keys are wanted, and "Test".
 *
 * The file. One for the app, in the app's settings folder (never in a library, never per project):
 * `<appConfigDir>/search-sources.json`, 0600 in the 0700 folder, written atomically (a new file renamed over the old,
 * one write at a time in this process: `updateAppSettingStrict`), shaped
 *
 *   { "v": 1, "record": [{ "id", "on" }, …], "copies": [{ "id", "on" }, …], "crossrefEmail"?, "unpaywallEmail"? }
 *
 * It holds no key (keys are in the system password store only). Reading it:
 *   - missing: the defaults (DEFAULT_SEARCH_SETTINGS), nothing said, nothing written;
 *   - there but unreadable or not of this shape (not JSON, a field of the wrong type, an unknown field, an e-mail that
 *     is not one): the defaults AND `problem: "unreadable"`; a read never rewrites it, and the next save sets it aside
 *     (`search-sources.json.unreadable-<stamp>`, never deleted) and writes;
 *   - written by a newer version (an object whose `v` is a whole number above 1): the defaults AND
 *     `problem: "newer"`; it is left exactly as it is and a save is refused (SearchSettingsNewerError), as the Zotero
 *     sync settings treat theirs (R244 M7).
 * Within a file of this shape: a source name this version does not know is dropped; a source it knows that the file
 * does not name is added at the end with its default; the order is the file's; a repeated name counts once (its
 * first place).
 *
 * E-mails (R290 e): `searchContactEmail(s, host)` gives Crossref's e-mail for `api.crossref.org` only (the lookup
 * client's `contactEmailFor`); Unpaywall's goes only to Unpaywall, as `email=` (`findFreeCopies`, F10/F11).
 *
 * Test (R290 g): `testSearchSource` asks one source a FIXED question — the words "Distinction Bourdieu", the DOI
 * 10.1038/171737a0, or (arXiv, DOAB, the Internet Archive, which are asked by title and author) the title
 * "Distinction" by Bourdieu — never anything the researcher typed, nothing about a project; one request, not retried,
 * never cached on disk, within a time limit. A source that needs a key or an e-mail that is not given asks nothing.
 */
import type { LookupContext } from "../lookup/context.js";
import { EMAIL_RE, LookupHttpError, type HttpClient } from "../lookup/http.js";
import { AppSettingUnreadableError, setAppSettingAside, updateAppSettingStrict } from "../app-settings.js";
import { encodeDoi } from "../lookup/crossref.js";
import { DEFAULT_GOVERNANCE } from "@ao/core";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { elicitAsk } from "./elicit.js";
import type { FreeCopySource } from "./free-copy.js";
import { crossrefSearchUrl, openAlexSearchUrl } from "./search.js";
import { DEFAULT_SEARCH_SETTINGS, type RecordSearchSource, type SearchSettings } from "./types.js";


export const SEARCH_SOURCES_FILE = "search-sources.json";
/** The version of the file this build writes and reads. */
export const SEARCH_SOURCES_VERSION = 1;
/** The longest e-mail address kept. */
export const SEARCH_EMAIL_MAX = 254;
/**
 * R298 f: the file is read up to this many bytes; a larger one is unreadable (the defaults, said so; set aside by the
 * next save) without being read whole. The bound is this file's own: the general settings reader (app-settings.ts) is
 * shared with the other settings files, whose behaviour it does not change.
 */
export const SEARCH_SOURCES_MAX_BYTES = 64 * 1024;
/** A file naming more sources than this in a group is not of this shape. */
const SOURCES_IN_FILE_MAX = 64;
const SOURCE_NAME_MAX = 64;

const RECORD_IDS: readonly RecordSearchSource[] = DEFAULT_SEARCH_SETTINGS.record.map((x) => x.id);
const COPY_IDS: readonly FreeCopySource[] = (DEFAULT_SEARCH_SETTINGS.copies ?? []).map((x) => x.id);

/** The settings were written by a newer version of the app: not read, not changed. */
export class SearchSettingsNewerError extends Error {
  constructor() {
    super("These Search sources settings were written by a newer version of the app. Update the app to change them.");
    this.name = "SearchSettingsNewerError";
  }
}

export type SearchSettingsProblem = "unreadable" | "newer";
export interface SearchSettingsRead {
  settings: SearchSettings;
  problem?: SearchSettingsProblem;
}

interface StoredFile {
  v: 1;
  record: Array<{ id: string; on: boolean }>;
  copies: Array<{ id: string; on: boolean }>;
  crossrefEmail?: string;
  unpaywallEmail?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isEmail = (v: unknown): v is string => typeof v === "string" && v.length <= SEARCH_EMAIL_MAX && EMAIL_RE.test(v);
/** An e-mail address the settings accept: the lookup client's EMAIL_RE, at most SEARCH_EMAIL_MAX characters. */
export const isSearchEmail = isEmail;
const isRows = (v: unknown): v is Array<{ id: string; on: boolean }> =>
  Array.isArray(v) &&
  v.length <= SOURCES_IN_FILE_MAX &&
  v.every((x) => isObj(x) && Object.keys(x).every((k) => k === "id" || k === "on") && typeof x.id === "string" && x.id.length > 0 && x.id.length <= SOURCE_NAME_MAX && typeof x.on === "boolean");

/** A file of this version's shape (source names not yet checked against the known ones). */
function isStored(v: unknown): v is StoredFile {
  if (!isObj(v) || v.v !== SEARCH_SOURCES_VERSION) return false;
  if (Object.keys(v).some((k) => !["v", "record", "copies", "crossrefEmail", "unpaywallEmail"].includes(k))) return false;
  if (!isRows(v.record) || !isRows(v.copies)) return false;
  for (const k of ["crossrefEmail", "unpaywallEmail"] as const) if (v[k] !== undefined && !isEmail(v[k])) return false;
  return true;
}

/** Written by a newer version of the app: an object whose `v` is a whole number above this version. */
const isNewer = (v: unknown): boolean => isObj(v) && Number.isSafeInteger(v.v) && (v.v as number) > SEARCH_SOURCES_VERSION;
/** Nothing: for setting aside a file this version cannot use at all (larger than the bound). */
const refuseAll = (_v: unknown): _v is never => false;

/** The known sources of a group in the file's order, a repeated or unknown one dropped, a missing one added at the end with its default. */
function rowsOf<T extends string>(rows: Array<{ id: string; on: boolean }>, known: readonly T[], defaults: ReadonlyArray<{ id: T; on: boolean }>): Array<{ id: T; on: boolean }> {
  const out: Array<{ id: T; on: boolean }> = [];
  for (const r of rows) if ((known as readonly string[]).includes(r.id) && !out.some((o) => o.id === r.id)) out.push({ id: r.id as T, on: r.on });
  for (const d of defaults) if (!out.some((o) => o.id === d.id)) out.push({ id: d.id, on: d.on });
  return out;
}

/** R298 a: Elicit is always the last of the record sources (it cannot be moved), whatever order is stored or sent. */
function elicitLast<T extends { id: string }>(rows: T[]): T[] {
  return [...rows.filter((x) => x.id !== "elicit"), ...rows.filter((x) => x.id === "elicit")];
}

/** The settings a stored file gives (normalised). */
function settingsOf(f: StoredFile): SearchSettings {
  return {
    record: elicitLast(rowsOf(f.record, RECORD_IDS, DEFAULT_SEARCH_SETTINGS.record)),
    copies: rowsOf(f.copies, COPY_IDS, DEFAULT_SEARCH_SETTINGS.copies ?? []),
    ...(f.crossrefEmail !== undefined ? { crossrefEmail: f.crossrefEmail } : {}),
    ...(f.unpaywallEmail !== undefined ? { unpaywallEmail: f.unpaywallEmail } : {}),
  };
}

/** A fresh copy of the defaults (never the frozen object itself). */
function defaults(): SearchSettings {
  return { record: DEFAULT_SEARCH_SETTINGS.record.map((x) => ({ ...x })), copies: (DEFAULT_SEARCH_SETTINGS.copies ?? []).map((x) => ({ ...x })) };
}

/** The file to write for `s`: only the known sources and the two e-mails, nothing else (no key, whatever `s` holds). */
function fileOf(s: SearchSettings): StoredFile {
  const n = settingsOf({ v: 1, record: s.record ?? [], copies: s.copies ?? [] });
  return {
    v: 1,
    record: n.record.map((x) => ({ id: x.id, on: x.on === true })),
    copies: (n.copies ?? []).map((x) => ({ id: x.id, on: x.on === true })),
    ...(isEmail(s.crossrefEmail) ? { crossrefEmail: s.crossrefEmail } : {}),
    ...(isEmail(s.unpaywallEmail) ? { unpaywallEmail: s.unpaywallEmail } : {}),
  };
}

/** Thrown by `readBounded` for a file that is there but cannot be used (too large, not a file, not JSON). */
class Unusable extends Error {}

/**
 * The file's parsed content, or undefined when it is missing; Unusable when it is there but larger than
 * SEARCH_SOURCES_MAX_BYTES (decided by its size, then by the bytes read: never more than the bound plus one is read),
 * not a regular file, or not JSON. Opened without waiting on a pipe.
 */
async function readBounded(dir: string): Promise<unknown> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(join(dir, SEARCH_SOURCES_FILE), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Unusable();
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > SEARCH_SOURCES_MAX_BYTES) throw new Unusable();
    const buf = Buffer.alloc(SEARCH_SOURCES_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n > SEARCH_SOURCES_MAX_BYTES) throw new Unusable(); // it grew since its size was taken
    }
    try {
      return JSON.parse(buf.subarray(0, n).toString("utf8")) as unknown;
    } catch {
      throw new Unusable();
    }
  } catch (err) {
    throw err instanceof Unusable ? err : new Unusable();
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The settings of this computer, read anew (a save takes effect for the next read). Never throws. */
export async function readSearchSettings(dir: string): Promise<SearchSettingsRead> {
  let raw: unknown;
  try {
    raw = await readBounded(dir);
  } catch {
    return { settings: defaults(), problem: "unreadable" };
  }
  if (raw === undefined) return { settings: defaults() };
  if (isNewer(raw)) return { settings: defaults(), problem: "newer" };
  if (!isStored(raw)) return { settings: defaults(), problem: "unreadable" };
  return { settings: settingsOf(raw) };
}

/**
 * Saves the settings (only the known sources and the two e-mails; never a key): atomically, 0600. A file written by a
 * newer version is left as it is: SearchSettingsNewerError, nothing written. A damaged file is set aside (kept beside
 * it) and the settings written. Returns what was saved, as a read would give it.
 */
export async function writeSearchSettings(dir: string, next: SearchSettings, now: Date): Promise<SearchSettings> {
  const file = fileOf(next);
  const accept = (v: unknown): v is StoredFile | Record<string, unknown> => isStored(v) || isNewer(v);
  const write = () =>
    updateAppSettingStrict(dir, SEARCH_SOURCES_FILE, accept, (cur) => {
      if (cur !== undefined && isNewer(cur)) throw new SearchSettingsNewerError();
      return file;
    });
  // R298 f: a file this read cannot use (over the bound included: never "newer") is set aside, then written. (Setting
  // it aside goes through the general reader, which reads it once, at this save only.)
  let unusable = false;
  try {
    await readBounded(dir);
  } catch {
    unusable = true;
  }
  if (unusable) await setAppSettingAside(dir, SEARCH_SOURCES_FILE, refuseAll, now).catch(() => undefined);
  try {
    await write();
  } catch (err) {
    if (!(err instanceof AppSettingUnreadableError)) throw err;
    // Damaged (or a shape this version cannot use): kept aside, never deleted; then the new settings are written.
    await setAppSettingAside(dir, SEARCH_SOURCES_FILE, accept, now).catch(() => undefined);
    await write();
  }
  return settingsOf(file);
}

/** The e-mail the lookup client may put in the User-Agent of a request to `host`: Crossref's, to api.crossref.org only. */
export function searchContactEmail(s: SearchSettings | undefined, host: string): string | undefined {
  return host === "api.crossref.org" && s && isEmail(s.crossrefEmail) ? s.crossrefEmail : undefined;
}

/** Whether a source's key may be read now: OpenAlex's while OpenAlex is on in either group, Elicit's while Elicit is on. */
export function searchKeyWanted(s: SearchSettings, source: "openalex" | "elicit"): boolean {
  return s.record.some((x) => x.id === source && x.on) || (s.copies ?? []).some((x) => x.id === source && x.on);
}

// ---------------------------------------------------------------------------------------------------------------
// Test

/** The fixed question: these words for a search by typed words, this DOI for a lookup by DOI. */
export const FIND_SOURCE_TEST_WORDS = "Distinction Bourdieu";
export const FIND_SOURCE_TEST_DOI = "10.1038/171737a0";
/** For the services asked by title and author: a fixed book. */
const TEST_TITLE = "Distinction";
const TEST_FAMILY = "Bourdieu";
/** How long one test may take. */
export const FIND_SOURCE_TEST_TIMEOUT_MS = 30_000;

export type SearchSourceTestGroup = "record" | "copies";
/** `paused` (R298 c): Elicit is in its five-minute pause after a 429, so nothing was asked. */
export type SearchSourceTestResult = "answered" | "unreachable" | "key-refused" | "plan-cap" | "needs-key" | "needs-email" | "paused";

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The one address each copy source is asked by Test (built from the fixed question; the lookup forms of F10). */
function copyTestUrl(id: FreeCopySource): { url: string; json: boolean } {
  const doi = encodeDoi(FIND_SOURCE_TEST_DOI);
  switch (id) {
    case "openalex":
      return { url: `https://api.openalex.org/works/doi:${doi}`, json: true };
    case "unpaywall":
      return { url: `https://api.unpaywall.org/v2/${doi}`, json: true };
    case "arxiv":
      return { url: `https://export.arxiv.org/api/query?search_query=${enc(`au:${TEST_FAMILY.toLowerCase()} AND ti:"${TEST_TITLE.toLowerCase()}"`)}&max_results=1`, json: false };
    case "europepmc":
      return { url: `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(`DOI:"${FIND_SOURCE_TEST_DOI}"`)}&resultType=lite&format=json`, json: true };
    case "semanticscholar":
      return { url: `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=openAccessPdf`, json: true };
    case "doab":
      return { url: `https://directory.doabooks.org/rest/search?query=${enc(`dc.title:"${TEST_TITLE}"`)}&expand=metadata`, json: true };
    case "internetarchive":
      return { url: `https://archive.org/advancedsearch.php?q=${enc(`title:(${TEST_TITLE}) AND creator:(${TEST_FAMILY})`)}&fl[]=identifier&rows=1&output=json`, json: true };
  }
}

/** A context that allows exactly the source tried (no project: Test is the researcher trying a service out). */
function testContext(http: HttpClient, provider: string): LookupContext {
  return {
    http,
    policy: { ...DEFAULT_GOVERNANCE, processing: { ...DEFAULT_GOVERNANCE.processing, metadata_lookup: [provider] } },
    projectId: "search-sources-test",
    actor: "search-sources-test",
    sensitive: true,
  };
}

async function within<T>(p: Promise<T>, ms: number, onLate: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => (timer = setTimeout(() => r(onLate), ms)))]);
  } finally {
    clearTimeout(timer);
    p.catch(() => undefined);
  }
}

/**
 * Asks one source its fixed question with `http` (the caller gives a fresh client, so that nothing cached answers in
 * the service's place; its `keyFor` adds OpenAlex's key by host): "answered" when the service answered (a 404 is an
 * answer), "key-refused" when it refused a key it was sent (401 or 403), "plan-cap" (Elicit's 400 for its plan),
 * "unreachable" otherwise — and, asking nothing, "paused" (Elicit during its five-minute pause), "needs-key" (Elicit without `key`) or "needs-email" (Unpaywall
 * without a well-formed `email`). Never throws.
 */
export async function testSearchSource(
  group: SearchSourceTestGroup,
  id: string,
  o: { http: HttpClient; key?: string; email?: string; timeoutMs?: number },
): Promise<SearchSourceTestResult> {
  const timeoutMs = o.timeoutMs ?? FIND_SOURCE_TEST_TIMEOUT_MS;
  if (group === "record" && id === "elicit") {
    if (!o.key) return "needs-key";
    const ac = new AbortController();
    const out = await within(elicitAsk(FIND_SOURCE_TEST_WORDS, o.key, testContext(o.http, "elicit"), { timeoutMs, signal: ac.signal }), timeoutMs + 100, { kind: "failed" as const });
    ac.abort();
    if (out.kind === "answered") return "answered";
    if (out.kind === "key-refused") return "key-refused";
    if (out.kind === "plan-cap") return "plan-cap";
    if (out.kind === "paused") return "paused";
    return "unreachable";
  }
  let target: { url: string; json: boolean; query?: Record<string, string>; host: string };
  if (group === "record" && (id === "crossref" || id === "openalex")) {
    const url = id === "crossref" ? crossrefSearchUrl(FIND_SOURCE_TEST_WORDS) : openAlexSearchUrl(FIND_SOURCE_TEST_WORDS);
    target = { url, json: true, host: new URL(url).hostname };
  } else if (group === "copies" && (COPY_IDS as readonly string[]).includes(id)) {
    if (id === "unpaywall" && !isEmail(o.email)) return "needs-email";
    const t = copyTestUrl(id as FreeCopySource);
    target = { ...t, host: new URL(t.url).hostname, ...(id === "unpaywall" ? { query: { email: o.email! } } : {}) };
  } else {
    return "unreachable";
  }
  const ask = async (): Promise<SearchSourceTestResult> => {
    try {
      const body = await o.http.getText(target.url, {
        // A key no other request uses: this one answer is never served from (or into) another's cache entry.
        cacheKey: `search-sources-test:${randomUUID()}`,
        ttlDays: 0,
        sensitive: true,
        final429: () => true,
        final5xx: true,
        ...(target.query ? { query: target.query } : {}),
      });
      if (body === null) return "answered"; // 404: the service answered that it has no such work
      if (target.json) JSON.parse(body);
      return "answered";
    } catch (e) {
      // Whether a key went with it, asked after the request (a key read lazily is held by then).
      if (e instanceof LookupHttpError && (e.status === 401 || e.status === 403) && o.http.keyTag(target.host) !== "") return "key-refused";
      return "unreachable";
    }
  };
  return within(ask(), timeoutMs, "unreachable");
}
