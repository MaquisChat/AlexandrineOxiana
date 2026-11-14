/**
 * "Search sources" (Find and acquire Task F12; Ruling R290): the settings, the Elicit and OpenAlex keys, and "Test".
 * The shapes and every sentence are @ao/shared's (api/search-settings.ts). Every route is for the desktop app's token
 * only: none is in server.ts's EXTENSION_ROUTES (the extension's token is refused before any runs), and each checks
 * the caller again. None needs an open library, except the per-project part of the GET (`?project=`).
 *
 * The keys (R290 a): `GET/PUT/DELETE /secrets/elicit-api-key` and `/secrets/openalex-api-key`, ONE implementation
 * (`registerSecretKey`, which the Zotero key's routes in routes/zotero.ts use too, R297 d): the value
 * is never sent back; a computer without a password store answers 503 in words and stores nothing anywhere else; the
 * body's field is `apiKey` (covered by the log's redaction); a refusal never repeats what was sent. A PUT or DELETE
 * takes effect for the next request (the service's held copy is replaced: `searchKeyChanged`). A body that is not a JSON
 * object is refused in this module's own sentences (R298 d): the settings' "fields", a key's "key fields", a Test's
 * "no body".
 *
 * The settings (R290 b, d, e): the file is read anew for every GET (an unreadable or newer file is the defaults, said
 * in `problem`); a PUT lists every source of each group once, in order, with on or off; an e-mail is checked with the
 * lookup client's EMAIL_RE (a refusal names the field, never the address); Unpaywall cannot be on without its e-mail.
 * Open Library and the Library of Congress are not in the answer: Find and acquire never asks them (they stay in the
 * file as they were). No e-mail or key is ever logged.
 *
 * Test (R290 g): `POST /settings/search-sources/:group/:id/test`, `group` "record" or "copies" (both hold "openalex").
 * It asks the source a fixed question (the library's `testSearchSource`) through a fresh lookup client (nothing cached
 * answers in the service's place; nothing it gets is written to disk), with OpenAlex's key by host and Crossref's
 * e-mail as the app's own requests carry them; one test per source at a time; within FIND_SOURCE_TEST_TIMEOUT_MS.
 * A test is allowed for a source that is switched off (the researcher is trying it out), never for one whose key or
 * e-mail is missing: that answers its sentence and asks nothing; nor for Elicit during its five-minute pause, which
 * answers the pause's own sentence (R298 c). OpenAlex's key reaches it as every OpenAlex request's does (R297 b).
 */
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { evaluate, isId } from "@ao/core";
import {
  FIND_SOURCE_TEST_DOI,
  FIND_SOURCE_TEST_TIMEOUT_MS,
  FIND_SOURCE_TEST_WORDS,
  HttpClient,
  SECRET_STORE_UNAVAILABLE,
  SEARCH_EMAIL_MAX as LIBRARY_EMAIL_MAX,
  type SecretName,
  SearchSettingsNewerError,
  SecretStoreUnavailableError,
  deleteSecret,
  elicitLastRefusal,
  elicitPausedUntil,
  forgetElicitRefusal,
  getSecret,
  isSearchEmail,
  lookupContextFor,
  providerAllowed,
  searchContactEmail,
  setSecret,
  testSearchSource,
  writeSearchSettings,
  type LookupContext,
  type RecordSearchSource,
  type SearchSettings,
  type SearchSourceTestResult,
  type FreeCopySource,
} from "@ao/library";
import {
  SEARCH_COPY_SOURCES,
  SEARCH_EMAIL_MAX,
  SEARCH_KEY_SECRETS,
  SEARCH_RECORD_SOURCES,
  SEARCH_SETTINGS_TEXT,
  SEARCH_SOURCE_GROUPS,
  SEARCH_SOURCE_TEST_DOI,
  SEARCH_SOURCE_TEST_TIMEOUT_MS,
  SEARCH_SOURCE_TEST_WORDS,
  SEARCH_TEST_TEXT,
  isSearchApiKeyShape,
  searchEmailRefusal,
  type SearchCopyRow,
  type SearchCopySource,
  type SearchRecordRow,
  type SearchRecordSource,
  type SearchSourceTestResponse,
  type SearchSourcesRequest,
  type SearchSourcesResponse,
  type SecretDeleteResponse,
  type SecretStatusResponse,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import type { ServiceState } from "../state.js";
import { bodyOf, paramsOf, queryOf, type Ctx, type Obj, type Same } from "./util.js";

// The library's names and bounds and @ao/shared's are one and the same (Task 47).
true satisfies Same<Exclude<RecordSearchSource, "openlibrary" | "loc">, SearchRecordSource>;
true satisfies Same<FreeCopySource, SearchCopySource>;
true satisfies Same<typeof LIBRARY_EMAIL_MAX, typeof SEARCH_EMAIL_MAX>;
true satisfies Same<typeof FIND_SOURCE_TEST_TIMEOUT_MS, typeof SEARCH_SOURCE_TEST_TIMEOUT_MS>;
true satisfies Same<typeof FIND_SOURCE_TEST_WORDS, typeof SEARCH_SOURCE_TEST_WORDS>;
true satisfies Same<typeof FIND_SOURCE_TEST_DOI, typeof SEARCH_SOURCE_TEST_DOI>;

type KeyName = (typeof SEARCH_KEY_SECRETS)[keyof typeof SEARCH_KEY_SECRETS];

/** The test result in words (the shared sentences, word for word). */
const TEST_ANSWER: Record<SearchSourceTestResult, SearchSourceTestResponse> = {
  answered: { ok: true, sentence: SEARCH_TEST_TEXT.answered },
  unreachable: { ok: false, sentence: SEARCH_TEST_TEXT.unreachable },
  "key-refused": { ok: false, sentence: SEARCH_TEST_TEXT.keyRefused },
  "plan-cap": { ok: false, sentence: SEARCH_TEST_TEXT.elicitPlanCap },
  "needs-key": { ok: false, sentence: SEARCH_TEST_TEXT.needsElicitKey },
  "needs-email": { ok: false, sentence: SEARCH_TEST_TEXT.needsUnpaywallEmail },
  // R298 c: the pause's own sentence (the one the settings row's note says), nothing asked.
  paused: { ok: false, sentence: SEARCH_SETTINGS_TEXT.elicitPaused },
};

/**
 * Only the desktop app's token. A second guard (R298 e): the auth layer already refuses every other caller's token
 * before any of these routes runs (none is in server.ts's EXTENSION_ROUTES); this stays behind it in case that changes.
 */
function uiOnly(req: FastifyRequest, sentence: string = SEARCH_SETTINGS_TEXT.uiOnly): void {
  if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", sentence);
}

/** The body as a JSON object (absent: `{}`); anything else (an array, a string, text) is refused with `sentence` (R298 d). */
function objectBody(req: FastifyRequest, sentence: string): Obj {
  const b: unknown = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== "object" || Array.isArray(b)) throw badRequest(sentence);
  return b as Obj;
}

/** The password store's refusal, in words that fit what was asked (as for the Zotero key). */
function storeError(e: unknown, message: string): unknown {
  return e instanceof SecretStoreUnavailableError ? new ApiError(503, "UNAVAILABLE", message) : e;
}

/** What tells one kept key's routes apart: its name, its sentences, its shape, and what follows a change. */
export interface SecretKeyRoutes {
  name: SecretName;
  /** The 403 for a caller other than the desktop app. */
  uiOnly: string;
  /** The 503 of a GET or DELETE with no password store. */
  noStoreForStatus: string;
  /** A PUT with a field other than `apiKey`. */
  keyFields: string;
  /** A PUT whose `apiKey` is not of the shape (`isShape`). */
  keyShape: string;
  isShape: (v: unknown) => v is string;
  /** A PUT whose body is not a JSON object: this sentence; unset, the general one of routes/util.ts (`bodyOf`). */
  notObject?: string;
  /** After a PUT (the value) or a DELETE (null) went through. */
  changed?: (value: string | null) => void;
}

/**
 * ONE implementation of a kept key's three routes (R290 a, R297 d: the Zotero, Elicit and OpenAlex keys): write-only
 * (`GET` says whether one is stored, never the value), UI only; a refusal never repeats what was sent; with no password
 * store, 503 in words and nothing stored anywhere else (a PUT's 503 is the library's own SECRET_STORE_UNAVAILABLE).
 */
export function registerSecretKey(app: FastifyInstance, k: SecretKeyRoutes): void {
  const path = `/secrets/${k.name}`;
  app.get(path, async (req): Promise<SecretStatusResponse> => {
    uiOnly(req, k.uiOnly);
    try {
      return { stored: (await getSecret(k.name)) !== null };
    } catch (e) {
      throw storeError(e, k.noStoreForStatus);
    }
  });
  app.put(path, async (req): Promise<SecretStatusResponse> => {
    uiOnly(req, k.uiOnly);
    const b = k.notObject !== undefined ? objectBody(req, k.notObject) : bodyOf(req);
    if (Object.keys(b).some((x) => x !== "apiKey")) throw badRequest(k.keyFields);
    // The value is never echoed: the message describes the rule, not what was sent.
    if (!k.isShape(b.apiKey)) throw badRequest(k.keyShape);
    try {
      await setSecret(k.name, b.apiKey);
    } catch (e) {
      throw storeError(e, SECRET_STORE_UNAVAILABLE);
    }
    k.changed?.(b.apiKey);
    return { stored: true };
  });
  app.delete(path, async (req): Promise<SecretDeleteResponse> => {
    uiOnly(req, k.uiOnly);
    let removed: boolean;
    try {
      removed = await deleteSecret(k.name);
    } catch (e) {
      throw storeError(e, k.noStoreForStatus);
    }
    k.changed?.(null);
    return { removed };
  });
}

/** The Elicit or the OpenAlex key's routes: the shared sentences; a change replaces the key the service holds. */
function registerSearchKey(app: FastifyInstance, state: ServiceState, name: KeyName): void {
  registerSecretKey(app, {
    name,
    uiOnly: SEARCH_SETTINGS_TEXT.uiOnly,
    noStoreForStatus: SEARCH_SETTINGS_TEXT.noStoreForStatus,
    keyFields: SEARCH_SETTINGS_TEXT.keyFields,
    keyShape: SEARCH_SETTINGS_TEXT.keyShape,
    isShape: isSearchApiKeyShape,
    notObject: SEARCH_SETTINGS_TEXT.keyFields,
    changed: (value) => {
      state.searchKeyChanged(name, value);
      if (name === "elicit-api-key") forgetElicitRefusal();
      // R312 c (R297 c): an OpenAlex key saved wakes the entries waiting for its spent allowance (a DELETE wakes nothing).
      if (name === "openalex-api-key" && value !== null) state.wakeFindAllowance();
    },
  });
}

/** Whether a project's rules allow an acquiring method (the runner's own check, `evaluate` of a capture). */
function acquireAllowed(ctx: LookupContext, method: "reference_lookup" | "free_copy"): boolean {
  if (!ctx.policy) return false;
  const d = evaluate(ctx.policy, {
    action: "capture",
    projectId: ctx.projectId,
    actor: ctx.actor,
    now: (ctx.clock?.() ?? new Date()).toISOString(),
    ...(ctx.tz ? { tz: ctx.tz } : {}),
    capture: { method },
  });
  return d.result !== "deny";
}

/** The note on Elicit's row now: its pause, or its last refusal. */
function elicitNote(): string | undefined {
  if (elicitPausedUntil(Date.now()) !== undefined) return SEARCH_SETTINGS_TEXT.elicitPaused;
  const r = elicitLastRefusal();
  return r === "key-refused" ? SEARCH_SETTINGS_TEXT.elicitKeyRefused : r === "plan-cap" ? SEARCH_TEST_TEXT.elicitPlanCap : undefined;
}

/** The answer for settings `s` (only the sources Find and acquire asks), with the project's rules when given. */
function responseOf(s: SearchSettings, problem: "unreadable" | "newer" | undefined, rules?: LookupContext): SearchSourcesResponse {
  const record: SearchRecordRow[] = s.record
    .filter((x): x is { id: SearchRecordSource; on: boolean } => (SEARCH_RECORD_SOURCES as readonly string[]).includes(x.id))
    .map((x) => {
      const note = x.id === "elicit" ? elicitNote() : undefined;
      return {
        id: x.id,
        on: x.on,
        ...(rules ? { allowedByRules: acquireAllowed(rules, "reference_lookup") && providerAllowed(rules, x.id) } : {}),
        ...(note ? { note } : {}),
      };
    });
  const copies: SearchCopyRow[] = (s.copies ?? []).map((x) => ({
    id: x.id,
    on: x.on,
    ...(rules ? { allowedByRules: acquireAllowed(rules, "free_copy") && (x.id !== "openalex" || providerAllowed(rules, "openalex")) } : {}),
  }));
  return {
    record,
    copies,
    ...(s.crossrefEmail ? { crossrefEmail: s.crossrefEmail } : {}),
    ...(s.unpaywallEmail ? { unpaywallEmail: s.unpaywallEmail } : {}),
    ...(problem ? { problem: { code: problem, text: problem === "newer" ? SEARCH_SETTINGS_TEXT.newer : SEARCH_SETTINGS_TEXT.unreadable } } : {}),
  };
}

/** A group's rows from a request: every source exactly once, `on` a boolean, nothing else; otherwise a refusal. */
function rowsOf<T extends string>(v: unknown, known: readonly T[]): Array<{ id: T; on: boolean }> {
  if (!Array.isArray(v) || v.length !== known.length) throw badRequest(SEARCH_SETTINGS_TEXT.sources);
  const out: Array<{ id: T; on: boolean }> = [];
  for (const x of v) {
    if (!x || typeof x !== "object" || Array.isArray(x)) throw badRequest(SEARCH_SETTINGS_TEXT.sources);
    const o = x as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "id" && k !== "on") || typeof o.on !== "boolean") throw badRequest(SEARCH_SETTINGS_TEXT.sources);
    if (typeof o.id !== "string" || !(known as readonly string[]).includes(o.id) || out.some((r) => r.id === o.id)) throw badRequest(SEARCH_SETTINGS_TEXT.sources);
    out.push({ id: o.id as T, on: o.on });
  }
  return out;
}

/** An e-mail field: absent or null removes it; otherwise a well-formed address (the refusal names the field only). */
function emailOf(b: Record<string, unknown>, field: "crossrefEmail" | "unpaywallEmail"): string | undefined {
  const v = b[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw badRequest(searchEmailRefusal(field));
  const t = v.trim();
  if (t === "") return undefined;
  if (!isSearchEmail(t)) throw badRequest(searchEmailRefusal(field));
  return t;
}

export function registerSearchSettings(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  registerSearchKey(app, state, SEARCH_KEY_SECRETS.elicit);
  registerSearchKey(app, state, SEARCH_KEY_SECRETS.openalex);

  app.get("/settings/search-sources", async (req): Promise<SearchSourcesResponse> => {
    uiOnly(req);
    const q = queryOf(req);
    let rules: LookupContext | undefined;
    if (q.project !== undefined) {
      if (!isId(q.project)) throw badRequest(SEARCH_SETTINGS_TEXT.notProject);
      const s = state.requireSession();
      if (!s.repo.listProjects().some((p) => p.id === q.project)) throw new ApiError(404, "NOT_FOUND", SEARCH_SETTINGS_TEXT.projectNotFound);
      rules = await lookupContextFor(s.repo, q.project, s.http);
    }
    const r = await state.readSearchSources();
    return responseOf(r.settings, r.problem, rules);
  });

  app.put("/settings/search-sources", async (req): Promise<SearchSourcesResponse> => {
    uiOnly(req);
    const b = objectBody(req, SEARCH_SETTINGS_TEXT.fields) as Record<string, unknown> & Partial<Record<keyof SearchSourcesRequest, unknown>>;
    if (Object.keys(b).some((k) => !["record", "copies", "crossrefEmail", "unpaywallEmail"].includes(k))) throw badRequest(SEARCH_SETTINGS_TEXT.fields);
    const record = rowsOf(b.record, SEARCH_RECORD_SOURCES);
    const copies = rowsOf(b.copies, SEARCH_COPY_SOURCES);
    const crossrefEmail = emailOf(b, "crossrefEmail");
    const unpaywallEmail = emailOf(b, "unpaywallEmail");
    if (!unpaywallEmail && copies.some((x) => x.id === "unpaywall" && x.on)) throw badRequest(SEARCH_SETTINGS_TEXT.unpaywallNeedsEmail);
    const cur = await state.readSearchSources();
    if (cur.problem === "newer") throw new ApiError(409, "CONFLICT", SEARCH_SETTINGS_TEXT.newer);
    // The sources the screen does not show (Open Library, the Library of Congress) keep their place at the end.
    const kept = cur.settings.record.filter((x) => !(SEARCH_RECORD_SOURCES as readonly string[]).includes(x.id));
    const next: SearchSettings = {
      record: [...record, ...kept],
      copies,
      ...(crossrefEmail ? { crossrefEmail } : {}),
      ...(unpaywallEmail ? { unpaywallEmail } : {}),
    };
    let saved: SearchSettings;
    try {
      saved = await writeSearchSettings(state.deps.appConfigDir, next, state.opts.now());
    } catch (err) {
      if (err instanceof SearchSettingsNewerError) throw new ApiError(409, "CONFLICT", SEARCH_SETTINGS_TEXT.newer);
      throw err;
    }
    state.searchSourcesSaved(saved);
    return responseOf(saved, undefined);
  });

  /** The tests running now, by `group/id`: one per source at a time. */
  const running = new Set<string>();
  app.post("/settings/search-sources/:group/:id/test", async (req): Promise<SearchSourceTestResponse> => {
    uiOnly(req);
    const { group = "", id = "" } = paramsOf(req);
    const known =
      (SEARCH_SOURCE_GROUPS as readonly string[]).includes(group) &&
      (group === "record" ? (SEARCH_RECORD_SOURCES as readonly string[]) : (SEARCH_COPY_SOURCES as readonly string[])).includes(id);
    if (!known) throw new ApiError(404, "NOT_FOUND", SEARCH_SETTINGS_TEXT.unknownSource);
    if (Object.keys(objectBody(req, SEARCH_SETTINGS_TEXT.noBody)).length) throw badRequest(SEARCH_SETTINGS_TEXT.noBody);
    const slot = `${group}/${id}`;
    if (running.has(slot)) throw new ApiError(409, "CONFLICT", SEARCH_SETTINGS_TEXT.testRunning);
    running.add(slot);
    // R304 a: the place is given up on every way out, at the Test's time limit at the latest, whatever it waits on.
    let limit: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<SearchSourceTestResponse>((r) => (limit = setTimeout(() => r(TEST_ANSWER.unreachable), FIND_SOURCE_TEST_TIMEOUT_MS)));
    const run = (async (): Promise<SearchSourceTestResponse> => {
      const { settings } = await state.readSearchSources();
      // A keyed source's key, read within the one bound (R304 a): a store that fails or does not answer in time is
      // said (the key routes' sentence for a store that is not available), and nothing is asked.
      const keyName = group === "record" && id === "elicit" ? "elicit-api-key" : id === "openalex" ? "openalex-api-key" : undefined;
      const read = keyName ? await state.searchKeyWithin(keyName) : undefined;
      if (read?.unreadable) return { ok: false, sentence: SEARCH_SETTINGS_TEXT.noStoreForStatus };
      // A key or an e-mail that is needed and missing: said, and nothing asked (testSearchSource asks nothing then).
      const key = keyName === "elicit-api-key" ? read?.key : undefined;
      const http = new HttpClient({
        // A fresh client: nothing cached answers in the service's place. Its requests are made "sensitive" by the
        // library (memory only), so nothing it gets is written under this folder, which is never created.
        libraryRoot: join(state.deps.appConfigDir, "search-sources-test"),
        // OpenAlex's key as every request to api.openalex.org has it (R297 b): read lazily, within its short bound.
        keyFor: (h) => state.searchKeyForHost(h),
        keyReady: (h) => state.searchKeyReady(h),
        contactEmailFor: (h) => searchContactEmail(settings, h),
        maxRetries: 0,
        attemptTimeoutMs: FIND_SOURCE_TEST_TIMEOUT_MS,
      });
      const result = await testSearchSource(group as "record" | "copies", id, {
        http,
        ...(key ? { key } : {}),
        ...(settings.unpaywallEmail ? { email: settings.unpaywallEmail } : {}),
      });
      return TEST_ANSWER[result];
    })();
    try {
      return await Promise.race([run, late]);
    } finally {
      clearTimeout(limit);
      run.catch(() => undefined);
      running.delete(slot);
    }
  });
}
