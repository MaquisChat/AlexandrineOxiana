/**
 * Two read-only questions to Zotero (Zotero account sync, Task Z3):
 *
 *   - `checkZoteroKey`: what may the key in the password store read? The personal library (and whether
 *     files and notes), and which group libraries, by name.
 *   - `zoteroLibraryUnchanged`: has this library changed since version N? One cheap request that Zotero
 *     answers 304 to when nothing changed.
 *
 * Neither writes anything anywhere: no library, no file, no setting, no log line. Nothing but GET is
 * sent, and only to https://api.zotero.org (in test mode, to AO_ZOTERO_API_ORIGIN; zotero-web.ts). They reuse the Web import's request machinery
 * (`ZoteroApi` in zotero-web.ts: the key as a header read from the password store, Backoff, Retry-After,
 * retries), so the two cannot disagree about how Zotero is spoken to.
 *
 * The key (R78): it is read from the password store, goes into a request header and nowhere else. It is
 * not in a result, an error (message, cause, stack, enumerable property), a log line or a debug line. The
 * `key` field of `/keys/current` is deleted from the parsed answer at once, and nothing built from the
 * raw answer is kept: the result is assembled field by field from what the task names.
 *
 * Errors are reasons, never Zotero's words (`ZoteroAccountError`); an unexpected shape of answer is
 * `offline`, never a crash and never a half-filled result.
 *
 * HOW LONG A CALL MAY WAIT. A settings screen waits on `checkZoteroKey`, so neither function sleeps for
 * minutes. All the waiting one call may do (the pauses between retries and the pause a `Backoff` header
 * asks for before the next request) is bounded by ZOTERO_ACCOUNT_MAX_WAIT_MS in total, and each call
 * makes at most ZOTERO_ACCOUNT_RETRIES retries (1 s, then 2 s). Asked to wait longer than what is left,
 * the call does not wait: it throws `backing-off` with the moment Zotero asked for (`backoffUntil`,
 * ms since the epoch, at most a day ahead as in the scan), and the caller (the sync runner, the screen)
 * decides what to do. A shorter wait is waited out silently, and
 * every pause Zotero asked for on an answer of a call that still succeeded is reported as `backoffUntil`
 * beside the result (both functions). The whole call is also limited in time, requests and waits together:
 * ZOTERO_KEY_CHECK_TIMEOUT_MS and ZOTERO_UNCHANGED_TIMEOUT_MS, measured from the call's start with
 * `setTimeout` and `Date.now` (so fake timers drive them); at the limit whatever is in flight is aborted,
 * the call throws `offline` and nothing is left running. A caller's `signal` ends a call, and a wait, at once.
 *
 * What `zoteroLibraryUnchanged` does NOT notice. It asks `GET <library>/items/top?limit=1&format=keys`
 * with `If-Modified-Since-Version: <since>`. Zotero's documents say a multi-object read answers 304 when
 * nothing in the LIBRARY changed since that version, so a change to a collection, a tag or a deletion
 * moves the library version and gives 200 ("changed"). That is what the stand-in models, and it is
 * UNPROVEN against a real account (listed in the plan under "What only a real Zotero account can
 * prove"): if the real 304 depended only on the versions of the listed objects, a change to a collection
 * alone, or a deletion alone, might not be noticed by this check. Two guards keep the answer on the
 * safe side: a 304 whose `Last-Modified-Version` is present and differs from `since` is "changed" (a
 * library that went back to a lower version after a reset must not look quiet), and every other answer
 * (anything but 304) is "changed" or an error, never "unchanged". A needless run is harmless; a skipped
 * run is not.
 */
import type { Dispatcher } from "undici";
import { getSecret } from "../secrets.js";
import { ZOTERO_WEB_REASONS, ZoteroApi, ZoteroWebError, zoteroApiOrigin, type ZoteroWebScanResult } from "./zotero-web.js";

/** The most one call may sleep in all (retries and a Backoff it waits out), so that a screen is never kept waiting for minutes. */
export const ZOTERO_ACCOUNT_MAX_WAIT_MS = 10_000;
/** Retries of a 429, 5xx or dropped connection within one call (waits of 1 s and 2 s). */
export const ZOTERO_ACCOUNT_RETRIES = 2;
/** A group's name is kept to this many characters. */
export const ZOTERO_GROUP_NAME_MAX = 200;
/** The whole of `checkZoteroKey` (requests, retries and waits together), measured from its start; then it ends `offline`. */
export const ZOTERO_KEY_CHECK_TIMEOUT_MS = 30_000;
/** The whole of `zoteroLibraryUnchanged`, measured from its start; then it ends `offline`. */
export const ZOTERO_UNCHANGED_TIMEOUT_MS = 15_000;

const GROUPS_PAGE = 100;
const MAX_GROUP_PAGES = 50;
const MAX_REPORTED_BACKOFF_MS = 24 * 3_600_000;

export type ZoteroAccountReason = "no-key" | "no-store" | "key-refused" | "library-gone" | "offline" | "backing-off";

/** Plain sentences, one per reason: never the server's words, the key, a host's path or a file path. */
export const ZOTERO_ACCOUNT_MESSAGES: Readonly<Record<ZoteroAccountReason, string>> = {
  "no-key": "No Zotero API key is saved on this computer.",
  "no-store": "This computer's password store cannot be used, so the Zotero API key cannot be read.",
  "key-refused": "Zotero refused the API key (it may be wrong, revoked, or not allowed to read this library).",
  "library-gone": "Zotero has no such library for this key (a group that was deleted, or one this account has left).",
  offline: "Zotero could not be reached, or gave an answer that could not be understood.",
  "backing-off": "Zotero asked for a longer wait before the next request.",
};

export class ZoteroAccountError extends Error {
  /** `backoffUntil` (ms since the epoch) is set only when Zotero asked to wait; it is absent, not undefined, otherwise. */
  declare readonly backoffUntil?: number;
  constructor(
    readonly reason: ZoteroAccountReason,
    backoffUntil?: number,
  ) {
    super(ZOTERO_ACCOUNT_MESSAGES[reason]);
    if (backoffUntil !== undefined) this.backoffUntil = backoffUntil;
  }
}
// Not an own property: an error's enumerable properties are only what the caller needs (reason, backoffUntil).
Object.defineProperty(ZoteroAccountError.prototype, "name", { value: "ZoteroAccountError", writable: true, configurable: true });

export interface ZoteroKeyAccess {
  /** The numeric user id, as a string. */
  userId: string;
  /** What the key may do with the personal library. `write` is information only: nothing in the app writes. */
  personal: { library: boolean; files: boolean; notes: boolean; write: boolean };
  /** Group libraries the key may READ (listed groups the key has no permission for are left out). */
  groups: Array<{ ref: string; name: string; write: boolean }>;
  /**
   * Present only when Zotero asked for a pause (`Backoff` or `Retry-After`) on ANY answer during the check
   * and the check still succeeded (waited out, or sent with the last answer): the moment (ms since the
   * epoch, at most a day ahead) before which no run of any kind should start. A pause that made the
   * call fail is the error `backing-off` instead.
   */
  backoffUntil?: number;
}

interface CallOptions {
  dispatcher?: Dispatcher;
  /** Aborts the call (the abort reason is thrown as it is). */
  signal?: AbortSignal;
  /** Test seam: the sleep used for every wait (the bound on all waiting still applies). */
  sleep?: (ms: number) => Promise<void>;
}

/** A wait that would take longer than this call may wait. */
class WaitTooLong extends Error {
  constructor(readonly ms: number) {
    super("wait too long");
  }
}

/** A wait that ends at once, with the abort reason, when `signal` aborts (no timer is left behind). */
function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(signal.reason);
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
}

function boundedSleep(real: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
  let spent = 0;
  return async (ms) => {
    if (spent + ms > ZOTERO_ACCOUNT_MAX_WAIT_MS) throw new WaitTooLong(ms);
    spent += ms;
    await real(ms);
  };
}

async function readKey(): Promise<string> {
  let key: string | null;
  try {
    key = await getSecret("zotero-api-key");
  } catch {
    // SecretStoreUnavailableError, or anything else the store does: what it says (it may name the store) is dropped.
    throw new ZoteroAccountError("no-store");
  }
  if (!key) throw new ZoteroAccountError("no-key");
  return key;
}

/**
 * Runs `fn` with a client that holds the key, and turns everything that can go wrong into a
 * ZoteroAccountError with a fixed reason. `notFound` is what `notFoundIs` says.
 */
async function withApi<T>(o: CallOptions, notFoundIs: ZoteroAccountReason, timeoutMs: number, fn: (api: ZoteroApi, seen: ZoteroWebScanResult) => Promise<T>): Promise<T> {
  let key: string | null = await readKey();
  const result: ZoteroWebScanResult = { deletedInZotero: 0, completed: false, downloadsFailed: 0, refusedHosts: [], goneKeys: { deleted: 0, bin: 0 } };
  // One limit on the whole call: the deadline aborts whatever is in flight (a request, a wait) and the call ends `offline`.
  const deadline = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, deadline.signal]) : deadline.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort(new Error("timeout"));
  }, timeoutMs);
  const real = o.sleep ?? abortableSleep(signal);
  const api = new ZoteroApi(
    key,
    {
      libraryType: "user",
      libraryId: "0",
      ...(o.dispatcher ? { dispatcher: o.dispatcher } : {}),
      sleep: boundedSleep(real),
      maxRetries: ZOTERO_ACCOUNT_RETRIES,
      // The bound is enforced by boundedSleep, which throws instead of waiting: the client must not shorten a wait first.
      maxWaitMs: Number.MAX_SAFE_INTEGER,
    },
    signal,
    result,
  );
  key = null;
  try {
    return await fn(api, result);
  } catch (err) {
    const until = result.backoffUntil;
    if (timedOut) throw new ZoteroAccountError("offline", until);
    if (o.signal?.aborted) throw err;
    // An error raised by our own reading of an answer keeps the back-off seen before it.
    if (err instanceof ZoteroAccountError) throw err.backoffUntil === undefined && until !== undefined ? new ZoteroAccountError(err.reason, until) : err;
    if (err instanceof WaitTooLong) throw new ZoteroAccountError("backing-off", until ?? Date.now() + Math.min(err.ms, MAX_REPORTED_BACKOFF_MS));
    if (err instanceof ZoteroWebError && err.reason === ZOTERO_WEB_REASONS.keyRefused) throw new ZoteroAccountError("key-refused", until);
    if (err instanceof ZoteroWebError && err.reason === ZOTERO_WEB_REASONS.notFound) throw new ZoteroAccountError(notFoundIs, until);
    // Unreachable, 5xx or 429 that outlasted its retries, a cut or unreadable answer, too large, anything unexpected.
    throw new ZoteroAccountError("offline", until);
  } finally {
    // Nothing is left running: the timer is cleared and anything still in flight is aborted.
    clearTimeout(timer);
    deadline.abort(new Error("done"));
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A permission flag: absent is false (Zotero leaves out what a key may not do); anything but a boolean is a shape we do not know. */
function flag(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  throw new ZoteroAccountError("offline");
}

function flags(v: unknown): { library: boolean; write: boolean } {
  if (!isObject(v)) throw new ZoteroAccountError("offline");
  return { library: flag(v["library"]), write: flag(v["write"]) };
}

interface KeyAnswer {
  userId: string;
  personal: ZoteroKeyAccess["personal"];
  /** What `access.groups` grants: `all`, and per-group entries (these win for their own group). */
  all: { library: boolean; write: boolean } | undefined;
  byId: Map<string, { library: boolean; write: boolean }>;
}

/** Reads `/keys/current`. The key field is deleted first; only named fields are kept. Throws `offline` for any other shape. */
export function parseKeyAnswer(body: unknown): KeyAnswer {
  if (!isObject(body)) throw new ZoteroAccountError("offline");
  Reflect.deleteProperty(body, "key");
  const id = body["userID"];
  const userId = typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : typeof id === "string" && /^[1-9]\d{0,11}$/u.test(id) ? id : undefined;
  if (userId === undefined) throw new ZoteroAccountError("offline");
  const access = body["access"];
  if (!isObject(access)) throw new ZoteroAccountError("offline");
  // `user` is left out of a key that has no access to the personal library.
  const u = access["user"];
  if (u !== undefined && !isObject(u)) throw new ZoteroAccountError("offline");
  const personal = { library: flag(u?.["library"]), files: flag(u?.["files"]), notes: flag(u?.["notes"]), write: flag(u?.["write"]) };
  // `groups` is left out of (or empty for) a key that has no group access.
  const g = access["groups"];
  if (g !== undefined && !isObject(g)) throw new ZoteroAccountError("offline");
  let all: KeyAnswer["all"];
  const byId = new Map<string, { library: boolean; write: boolean }>();
  for (const [k, v] of Object.entries(g ?? {})) {
    if (k === "all") all = flags(v);
    else if (/^\d{1,12}$/u.test(k)) byId.set(k, flags(v));
    // Any other name is not a shape we know: it grants nothing.
  }
  return { userId, personal, all, byId };
}

/** `name` cut to at most ZOTERO_GROUP_NAME_MAX characters (code points), never inside a character (an accent stays with its letter, an emoji stays whole). */
export function capGroupName(name: string): string {
  if (Array.from(name).length <= ZOTERO_GROUP_NAME_MAX) return name;
  let out = "";
  let n = 0;
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of seg.segment(name)) {
    const len = Array.from(segment).length;
    if (n + len > ZOTERO_GROUP_NAME_MAX) break;
    out += segment;
    n += len;
  }
  // A first character with more than the cap of marks on it: cut by code points rather than return nothing.
  return out === "" ? Array.from(name).slice(0, ZOTERO_GROUP_NAME_MAX).join("") : out;
}

/** The ids and names of the groups `/users/<id>/groups` lists (all pages), of those `readable` says may be read. */
async function listGroups(api: ZoteroApi, userId: string, readable: (id: string) => boolean): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  let start = 0;
  for (let page = 0; page < MAX_GROUP_PAGES; page++) {
    const { body, headers } = await api.json(`/users/${userId}/groups`, { limit: GROUPS_PAGE, start });
    if (!Array.isArray(body)) throw new ZoteroAccountError("offline");
    for (const e of body as unknown[]) {
      if (!isObject(e)) throw new ZoteroAccountError("offline");
      const data = e["data"];
      const rawId = e["id"] ?? (isObject(data) ? data["id"] : undefined);
      if (typeof rawId !== "number" || !Number.isSafeInteger(rawId) || rawId <= 0) throw new ZoteroAccountError("offline");
      const id = String(rawId);
      // A group the key may not read is not looked at further: its name is never kept.
      if (!readable(id) || seen.has(id)) continue;
      const name = isObject(data) ? data["name"] : undefined;
      if (typeof name !== "string") throw new ZoteroAccountError("offline");
      seen.add(id);
      out.push({ id, name: capGroupName(name) });
    }
    start += body.length;
    // The listing is whole or the call fails: every page names the total, and what was read adds up to it.
    const totalHeader = headers["total-results"];
    const total = Number(Array.isArray(totalHeader) ? totalHeader[0] : totalHeader);
    if (totalHeader === undefined || !Number.isSafeInteger(total) || total < 0 || start > total) throw new ZoteroAccountError("offline");
    if (start === total) return out;
    // Not there yet, but the page was empty or short: a half-filled list is never returned.
    if (body.length < GROUPS_PAGE) throw new ZoteroAccountError("offline");
  }
  throw new ZoteroAccountError("offline");
}

/**
 * What the key in the password store may read: `GET /keys/current`, then (only if the key has any group
 * access) `GET /users/<id>/groups`, paged. A group is in the result only if the key's own access says it
 * may read that group's library (`access.groups.all.library`, or `access.groups.<id>.library`, which wins
 * for its group): the list also holds public groups the key has no permission for.
 * Throws ZoteroAccountError (see the header for the reasons and for how long it may wait).
 */
export async function checkZoteroKey(o: CallOptions = {}): Promise<ZoteroKeyAccess> {
  return withApi(o, "offline", ZOTERO_KEY_CHECK_TIMEOUT_MS, async (api, seen) => {
    const { body } = await api.json("/keys/current");
    const a = parseKeyAnswer(body);
    const rule = (id: string): { library: boolean; write: boolean } => a.byId.get(id) ?? a.all ?? { library: false, write: false };
    const anyGroup = a.all?.library === true || [...a.byId.values()].some((v) => v.library);
    const listed = anyGroup ? await listGroups(api, a.userId, (id) => rule(id).library) : [];
    const out: ZoteroKeyAccess = {
      userId: a.userId,
      personal: a.personal,
      groups: listed.map((g) => ({ ref: `group:${g.id}`, name: g.name, write: rule(g.id).write })),
    };
    if (seen.backoffUntil !== undefined) out.backoffUntil = seen.backoffUntil;
    return out;
  });
}

/**
 * Has the library `ref` (`user:<id>` or `group:<id>`) changed since library version `since`? ONE request:
 * `GET <prefix>/items/top?limit=1&format=keys` with `If-Modified-Since-Version: <since>`. 304 is
 * `{ unchanged: true }` and nothing else is fetched; 200 is `{ unchanged: false }`. A `Backoff` or
 * `Retry-After` Zotero sent with it is reported as `backoffUntil` beside the answer. A key Zotero refuses,
 * a library that is not found (a group that was deleted or left: `library-gone`), an unreachable server and the like throw ZoteroAccountError. See the header for what
 * this does not notice, and for the rule that doubt means "changed".
 * @throws TypeError when `ref` or `since` is not valid (a mistake in the caller, before any request).
 */
export async function zoteroLibraryUnchanged(o: CallOptions & { ref: string; since: number }): Promise<{ unchanged: boolean; backoffUntil?: number }> {
  const m = /^(user|group):([1-9]\d{0,11})$/u.exec(o.ref);
  if (!m) throw new TypeError("ref must be user:<id> or group:<id>");
  if (!Number.isSafeInteger(o.since) || o.since < 0) throw new TypeError("since must be a library version (a non-negative integer)");
  const prefix = `/${m[1] === "user" ? "users" : "groups"}/${m[2]}`;
  return withApi(o, "library-gone", ZOTERO_UNCHANGED_TIMEOUT_MS, async (api, seen) => {
    const url = new URL(`${prefix}/items/top?limit=1&format=keys`, zoteroApiOrigin());
    const res = await api.get(url, true, (s) => s === 200 || s === 304, { "if-modified-since-version": String(o.since) });
    await res.body.dump().catch(() => {});
    let unchanged = false;
    if (res.statusCode === 304) {
      const v = res.headers["last-modified-version"];
      const reported = Array.isArray(v) ? v[0] : v;
      // A 304 that names another library version than the one asked about is not "nothing changed".
      unchanged = reported === undefined || Number(reported) === o.since;
    }
    return seen.backoffUntil === undefined ? { unchanged } : { unchanged, backoffUntil: seen.backoffUntil };
  });
}
