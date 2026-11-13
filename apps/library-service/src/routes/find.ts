/**
 * Find and acquire, slice 1 (Task F5; R225, R226, R237; plan Amendments A2, A3). The shapes are @ao/shared's
 * (api/find.ts); the work is the library's runner (`Session.find`, made in `ServiceState.activate`; its life is in
 * state.ts). Every route is for the desktop app's token only: none is in server.ts's EXTENSION_ROUTES, so the
 * extension's token is refused (403) before any of them runs, and each route checks the caller again.
 *
 * What was typed is the researcher's text and reaches nothing but the library: no refusal repeats a line (a line
 * outside the bounds is named by its number), and nothing here logs a body. Ids are checked with `isId` before
 * anything is looked up. An entry is looked for only in the project addressed: an entry of another project is 404
 * and is never acted on. The queue is read anew for every request (a read may show an entry whose change is then
 * rolled back, A2: the next read is right); nothing here caches a queue or where a match elsewhere is.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isId } from "@ao/core";
import {
  AppSettingUnreadableError,
  FIND_ADD_MAX_LINES,
  FIND_QUEUE_MAX as LIBRARY_QUEUE_MAX,
  FIND_TYPED_MAX,
  FindEntryStateError,
  FindEntryTooLargeError,
  FindIndexNotReadyError,
  FindQueueFullError,
  FindQueueUnreadableError,
  FindQueueUnwritableError,
  FindRunnerClosedError,
  InvalidInputError,
  KeyNotAvailableError,
  NotFoundError,
  ProjectLockedError,
  REFERENCE_MIN_CHARS,
  ReadOnlyLibraryError,
  readAppSettingStrict,
  readFindQueueOf,
  updateAppSettingStrict,
  type FindEntry,
  type FindMatch as LibraryMatch,
  type FindReasonCode as LibraryReasonCode,
  type FindRunner,
  type FindState as LibraryState,
  type FindStoppedFor,
  type OfferLink,
  type WorkCandidate,
} from "@ao/library";
import {
  FIND_ADD_LINES_MAX,
  FIND_BODY_MAX_BYTES,
  FIND_CANDIDATES_SENT,
  FIND_LINE_MAX_CHARS,
  FIND_LINE_MIN_CHARS,
  FIND_QUEUE_MAX,
  FIND_ROUTE_TEXT,
  FIND_STOPPED_TEXT,
  findLineRefusal,
  type FindAddRequest,
  type FindAddResponse,
  type FindChooseRequest,
  type FindDuplicateRequest,
  type FindElsewhereResponse,
  type FindEntryView,
  type FindMatch,
  type FindOfferLink,
  type FindQueueResponse,
  type FindReasonCode,
  type FindRemoveResponse,
  type FindScreenSettings,
  type FindState,
  type FindStoppedCode,
  type FindWorkCandidate,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import type { Session } from "../state.js";
import { bodyAs, bodyOf, paramsOf, type Ctx, type Same } from "./util.js";

// The library's types and @ao/shared's declarations are one and the same (Task 47).
true satisfies Same<LibraryState, FindState>;
true satisfies Same<LibraryReasonCode, FindReasonCode>;
true satisfies Same<FindStoppedFor["code"], FindStoppedCode>;
true satisfies Same<WorkCandidate, FindWorkCandidate>;
true satisfies Same<OfferLink, FindOfferLink>;
true satisfies Same<LibraryMatch, FindMatch>;
true satisfies Same<Omit<FindEntry, "people" | "works" | "removed">, FindEntryView>;
true satisfies Same<typeof LIBRARY_QUEUE_MAX, typeof FIND_QUEUE_MAX>;
true satisfies Same<typeof FIND_ADD_MAX_LINES, typeof FIND_ADD_LINES_MAX>;
true satisfies Same<typeof FIND_TYPED_MAX, typeof FIND_LINE_MAX_CHARS>;
true satisfies Same<typeof REFERENCE_MIN_CHARS, typeof FIND_LINE_MIN_CHARS>;

/** This computer's file of the screen's remembered settings (0600, written with the strict helper). */
export const FIND_SCREEN_FILE = "find-screen.json";
const SCREEN_DEFAULTS: FindScreenSettings = Object.freeze({ checkEverything: false }) as FindScreenSettings;
const SCREEN_KEYS = ["checkEverything", "projectId", "collectionId"];

function isScreen(v: unknown): v is FindScreenSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !SCREEN_KEYS.includes(k))) return false;
  if (typeof o.checkEverything !== "boolean") return false;
  for (const k of ["projectId", "collectionId"]) if (o[k] !== undefined && (typeof o[k] !== "string" || !isId(o[k]))) return false;
  return true;
}

const screenOf = (v: FindScreenSettings): FindScreenSettings => ({
  checkEverything: v.checkEverything,
  ...(v.projectId !== undefined ? { projectId: v.projectId } : {}),
  ...(v.collectionId !== undefined ? { collectionId: v.collectionId } : {}),
});

/** The screen's remembered settings: the defaults when the file is missing or cannot be read (never rewritten by a read). */
export async function readFindScreen(appConfigDir: string): Promise<FindScreenSettings> {
  try {
    const v = await readAppSettingStrict(appConfigDir, FIND_SCREEN_FILE, isScreen);
    return v ? screenOf(v) : { ...SCREEN_DEFAULTS };
  } catch {
    return { ...SCREEN_DEFAULTS };
  }
}

/** An entry as the screen gets it: no `people` and `works`, at most FIND_CANDIDATES_SENT candidates. */
export function entryView(e: FindEntry): FindEntryView {
  const { people: _people, works: _works, removed: _removed, candidates, ...rest } = e;
  return { ...rest, ...(candidates ? { candidates: candidates.slice(0, FIND_CANDIDATES_SENT) } : {}) };
}

/** A library refusal said in words, with the `reason` the screen may act on; anything else is passed on as it is. */
function said(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  if (err instanceof ProjectLockedError || err instanceof KeyNotAvailableError) return new ApiError(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
  if (err instanceof ReadOnlyLibraryError) return new ApiError(409, "READ_ONLY", FIND_ROUTE_TEXT.readOnly, "read-only");
  if (err instanceof FindQueueFullError) return new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.queueFull, "queue-full");
  // The store's own sentence (A2).
  if (err instanceof FindQueueUnreadableError) return new ApiError(409, "CONFLICT", err.message, "queue-unreadable");
  if (err instanceof FindEntryStateError) return new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
  if (err instanceof FindIndexNotReadyError) return new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.indexNotReady, "index-not-ready");
  if (err instanceof FindRunnerClosedError) return new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed");
  if (err instanceof NotFoundError) return new ApiError(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound);
  // The library's sentences never repeat what was typed.
  if (err instanceof InvalidInputError || err instanceof FindEntryTooLargeError) return new ApiError(400, "VALIDATION", err.message, "line");
  if (err instanceof FindQueueUnwritableError) return new ApiError(503, "UNAVAILABLE", err.message);
  return err;
}

async function inWords<T>(p: () => Promise<T>): Promise<T> {
  try {
    return await p();
  } catch (err) {
    throw said(err);
  }
}

/** Entries removed through this service, per open library and project: a press on one is a 409 in words, not a 404. */
const removedHere = new WeakMap<Session, Map<string, Set<string>>>();
const REMOVED_KEPT = 5000;
function noteRemoved(s: Session, projectId: string, entryId: string): void {
  let m = removedHere.get(s);
  if (!m) removedHere.set(s, (m = new Map()));
  let ids = m.get(projectId);
  if (!ids) m.set(projectId, (ids = new Set()));
  ids.add(entryId);
  // Bounded: the oldest are forgotten first (a press on one of those is then a 404).
  for (const old of ids) {
    if (ids.size <= REMOVED_KEPT) break;
    ids.delete(old);
  }
}
const wasRemoved = (s: Session, projectId: string, entryId: string) => removedHere.get(s)?.get(projectId)?.has(entryId) === true;

export function registerFind(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const limit = { bodyLimit: FIND_BODY_MAX_BYTES };

  const uiOnly = (req: FastifyRequest) => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Find and acquire is used from the desktop app.");
  };

  /** The project (and entry) addressed: ids checked first, then the project looked up in the open library. */
  const addressed = (req: FastifyRequest, withEntry: boolean): { s: Session; projectId: string; entryId: string } => {
    uiOnly(req);
    const p = paramsOf(req);
    const projectId = p.id ?? "";
    const entryId = p.eid ?? "";
    if (!isId(projectId)) throw badRequest("That is not a project's id.");
    if (withEntry && !isId(entryId)) throw badRequest("That is not a queue entry's id.");
    const s = state.requireSession();
    if (!s.repo.listProjects().some((x) => x.id === projectId)) throw new ApiError(404, "NOT_FOUND", "That project was not found.");
    return { s, projectId, entryId };
  };

  /** A changing request: refused for a read-only library, and while Find and acquire is stopped for the library. */
  const runnerOf = (s: Session): FindRunner => {
    state.assertNotMoving();
    if (s.lib.mode === "read-only" || !s.index) throw new ApiError(409, "READ_ONLY", FIND_ROUTE_TEXT.readOnly, "read-only");
    if (!s.find || state.session !== s) throw new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed");
    return s.find;
  };

  /** The entry of THIS project: 404 when it is not in its queue (409 in words when it was removed here). */
  const entryOf = async (s: Session, projectId: string, entryId: string): Promise<FindEntry> => {
    const q = await inWords(() => readFindQueueOf(s.repo, projectId));
    const e = q.entries.get(entryId);
    if (e) return e;
    if (wasRemoved(s, projectId, entryId)) throw new ApiError(409, "CONFLICT", "This entry was removed from the queue. Nothing was changed.", "entry-state");
    throw new ApiError(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound);
  };

  app.get("/projects/:id/find", async (req, reply): Promise<FindQueueResponse> => {
    const { s, projectId } = addressed(req, false);
    const q = await inWords(() => readFindQueueOf(s.repo, projectId));
    const readOnly = s.lib.mode === "read-only" || !s.index;
    const runner = state.session === s ? s.find : undefined;
    let stopped: FindStoppedCode | undefined;
    if (readOnly) stopped = "read-only";
    else if (runner) stopped = runner.stoppedFor(projectId)?.code ?? (state.findIndexReady(s) ? undefined : "index-not-ready");
    reply.header("Cache-Control", "no-store");
    return {
      entries: [...q.entries.values()].map(entryView),
      checkEverything: state.findCheckEverything,
      lockedProjectsNotChecked: runner && !readOnly ? runner.lockedNotChecked() : 0,
      readOnly,
      unreadableLines: q.unreadableLines,
      ...(stopped ? { stopped: { code: stopped, text: FIND_STOPPED_TEXT[stopped] } } : {}),
    };
  });

  app.post("/projects/:id/find", limit, async (req): Promise<FindAddResponse> => {
    const { s, projectId } = addressed(req, false);
    const runner = runnerOf(s);
    const b = bodyAs<FindAddRequest>(req);
    if (!Array.isArray(b.lines)) throw badRequest('"lines" must be a list of references, one per line.');
    const given = b.lines as unknown[];
    if (given.length === 0) throw badRequest(FIND_ROUTE_TEXT.noLines);
    if (given.length > FIND_ADD_LINES_MAX) throw badRequest(FIND_ROUTE_TEXT.tooManyLines);
    const lines = given.map((l, i) => {
      const t = typeof l === "string" ? l.trim() : "";
      // At least 2 characters, and at most 500 UTF-16 units (the library's own bound).
      if (Array.from(t).length < FIND_LINE_MIN_CHARS || t.length > FIND_LINE_MAX_CHARS) throw new ApiError(400, "VALIDATION", findLineRefusal(i + 1), "line");
      return t;
    });
    const collectionId = b.collectionId;
    if (collectionId !== undefined && (typeof collectionId !== "string" || !isId(collectionId))) throw badRequest("The collection is not one of this project's.");
    const r = await inWords(() => runner.add(projectId, lines, collectionId));
    return { added: r.added.map(entryView), mergedLines: r.mergedLines };
  });

  app.post("/projects/:id/find/:eid/choose", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    const b = bodyAs<FindChooseRequest>(req);
    const candidateId = b.candidateId;
    if (candidateId !== null && (typeof candidateId !== "string" || candidateId.length === 0 || candidateId.length > 512)) throw badRequest('"candidateId" must be a candidate\'s id, or null for "None of these".');
    const cur = await entryOf(s, projectId, entryId);
    // Only an entry waiting for a choice: a second press, or a press on any other state, is a 409 in words.
    if (cur.state !== "choose") throw new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
    if (candidateId !== null && !cur.candidates?.some((c) => c.id === candidateId)) throw new ApiError(400, "VALIDATION", FIND_ROUTE_TEXT.unknownCandidate, "unknown-candidate");
    return entryView(await inWords(() => runner.choose(projectId, entryId, candidateId)));
  });

  app.post("/projects/:id/find/:eid/duplicate", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    const same = bodyAs<FindDuplicateRequest>(req).same;
    if (typeof same !== "boolean") throw badRequest('"same" must be true or false.');
    await entryOf(s, projectId, entryId);
    return entryView(await inWords(() => runner.confirmDuplicate(projectId, entryId, same)));
  });

  app.post("/projects/:id/find/:eid/add-here", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    bodyOf(req);
    await entryOf(s, projectId, entryId);
    return entryView(await inWords(() => runner.addHereAsWell(projectId, entryId)));
  });

  app.post("/projects/:id/find/:eid/retry", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    bodyOf(req);
    await entryOf(s, projectId, entryId);
    return entryView(await inWords(() => runner.retry(projectId, entryId)));
  });

  app.delete("/projects/:id/find/:eid", limit, async (req): Promise<FindRemoveResponse> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    await entryOf(s, projectId, entryId);
    await inWords(() => runner.remove(projectId, entryId));
    noteRemoved(s, projectId, entryId);
    return { removed: true };
  });

  // Where the match in another project is: worked out now, never stored, never cached (A3).
  app.get("/projects/:id/find/:eid/elsewhere", async (req, reply): Promise<FindElsewhereResponse> => {
    const { s, projectId, entryId } = addressed(req, true);
    reply.header("Cache-Control", "no-store");
    await entryOf(s, projectId, entryId);
    const runner = state.session === s ? s.find : undefined;
    if (!runner) return null;
    const m = await inWords(() => runner.elsewhere(projectId, entryId));
    if (!m) return null;
    // Locked or removed meanwhile: null ("Already in another project that is locked now.").
    const other = s.repo.listProjects().find((p) => p.id === m.projectId);
    if (!other || !s.repo.isUnlocked(other.id)) return null;
    return { projectId: other.id, projectName: other.name, sourceId: m.sourceId };
  });

  app.get("/find/screen", async (req): Promise<FindScreenSettings> => {
    uiOnly(req);
    return readFindScreen(state.deps.appConfigDir);
  });

  app.put("/find/screen", limit, async (req): Promise<FindScreenSettings> => {
    uiOnly(req);
    const b = bodyOf(req);
    for (const k of Object.keys(b)) if (!SCREEN_KEYS.includes(k)) throw badRequest(`"${k}" is not part of this request.`);
    if (typeof b.checkEverything !== "boolean") throw badRequest('"checkEverything" must be true or false.');
    for (const k of ["projectId", "collectionId"]) if (b[k] !== undefined && (typeof b[k] !== "string" || !isId(b[k]))) throw badRequest(`"${k}" must be an id.`);
    const next = screenOf(b as unknown as FindScreenSettings);
    try {
      await updateAppSettingStrict(state.deps.appConfigDir, FIND_SCREEN_FILE, isScreen, () => next);
    } catch (err) {
      if (err instanceof AppSettingUnreadableError) throw new ApiError(503, "UNAVAILABLE", "This computer's Find and acquire settings could not be read, so they were not changed.");
      throw err;
    }
    state.findCheckEverything = next.checkEverything;
    return next;
  });
}
