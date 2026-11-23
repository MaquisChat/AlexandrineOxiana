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
 *
 * Task F8 (R267), an author alone: `GET …/:eid/options` gives the entry's lists (the queue's answer carries only
 * their counts); `POST …/:eid/person` and `POST …/:eid/works` take only a person or works stored on THAT entry, so
 * that no request can make the app fetch an arbitrary author or work; no name, title or OpenAlex id is logged or
 * repeated in a refusal (a work already added is named by its position in the request).
 *
 * Task F8b (R279): an entry in "choose" with people stored beside its candidates carries `authorOffer` (counts only);
 * `POST …/:eid/author` (no body) turns it into the author's flow with the people stored.
 *
 * Task F15 (R324 a, d): the queue's answer gives each entry resting as R324 a names its "Where to get it" (`offers`,
 * joined) and `library` (whether "Get through my library" may start); `returnTo` is never sent. The start and cancel
 * routes are in routes/your-library.ts.
 *
 * Task F18c (R345): such an entry's view also says whether "Open it here and fetch the PDF" may start at its links
 * (`linkStart: true`, only when it carries links), a file of a link's start not kept says so (`library.lastFileFrom`),
 * and an entry waiting in the sign-in window opened at one of its links says so (`windowStart: "link"`).
 *
 * Task F20a (R348 e): `browserStart: true` on an entry offered a library start while a browser extension is paired;
 * `waitingIn: "browser"` on an entry waiting in the researcher's own browser; `library.lastFileFrom: "browser"` for a
 * file sent from the browser and not kept. All worked out here (the runner's memory and the pairings), never by the
 * screen.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isId } from "@ao/core";
import {
  FIND_ADD_MAX_LINES,
  FIND_CHOOSE_WORKS_MAX as LIBRARY_CHOOSE_WORKS_MAX,
  FIND_PEOPLE_MAX as LIBRARY_PEOPLE_MAX,
  FIND_PERSON_WORKS_MAX as LIBRARY_PERSON_WORKS_MAX,
  FIND_QUEUE_MAX as LIBRARY_QUEUE_MAX,
  FIND_TYPED_MAX,
  FindAlreadyAddedError,
  FindNoAuthorError,
  FindUnknownOptionError,
  worksAddedFrom,
  isPersonId,
  isWorkId,
  type PersonCandidate,
  FindEntryStateError,
  FindEntryTooLargeError,
  FindIndexNotReadyError,
  FindProjectStoppedError,
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
  readFindQueueOf,
  type FindEntry,
  type FindMatch as LibraryMatch,
  type FindReasonCode as LibraryReasonCode,
  type FindRunner,
  type FindState as LibraryState,
  type FindStoppedFor,
  type OfferLink,
  type WorkCandidate,
  libraryChancesOf,
  readYourLibrary,
  restsForLibrary,
  whereToGetIt,
} from "@ao/library";
import {
  FIND_ADD_LINES_MAX,
  FIND_BODY_MAX_BYTES,
  FIND_CANDIDATES_SENT,
  FIND_CHOOSE_WORKS_MAX,
  FIND_PEOPLE_MAX,
  FIND_PERSON_WORKS_MAX,
  findAlreadyAddedRefusal,
  findWorkIdRefusal,
  type FindAuthorOffer,
  type FindOptionsResponse,
  type FindPersonCandidate,
  type FindPersonRequest,
  type FindPersonWork,
  type FindWorksRequest,
  type FindWorksResponse,
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
  type FindLibraryChance,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { FIND_SCREEN_KEYS, findScreenOf, readFindScreen, writeFindScreen } from "../find-screen.js";
import type { Session } from "../state.js";
import { bodyAs, bodyOf, paramsOf, type Ctx, type Same } from "./util.js";

// The library's types and @ao/shared's declarations are one and the same (Task 47).
true satisfies Same<LibraryState, FindState>;
true satisfies Same<LibraryReasonCode, FindReasonCode>;
true satisfies Same<FindStoppedFor["code"] | "index-needs-rebuild", FindStoppedCode>; // the service tells "needs a rebuild" from "being rebuilt" (R247 b)
true satisfies Same<WorkCandidate, FindWorkCandidate>;
true satisfies Same<OfferLink, FindOfferLink>;
true satisfies Same<LibraryMatch, FindMatch>;
true satisfies Same<Omit<FindEntry, "people" | "works" | "removed" | "returnTo"> & { peopleCount?: number; worksCount?: number; addedCount?: number; authorOffer?: FindAuthorOffer; library?: FindLibraryChance; linkStart?: true; windowStart?: "link"; browserStart?: true; waitingIn?: "browser" }, FindEntryView>;
true satisfies Same<PersonCandidate, FindPersonCandidate>;
true satisfies Same<typeof LIBRARY_PEOPLE_MAX, typeof FIND_PEOPLE_MAX>;
true satisfies Same<typeof LIBRARY_PERSON_WORKS_MAX, typeof FIND_PERSON_WORKS_MAX>;
true satisfies Same<typeof LIBRARY_CHOOSE_WORKS_MAX, typeof FIND_CHOOSE_WORKS_MAX>;
true satisfies Same<typeof LIBRARY_QUEUE_MAX, typeof FIND_QUEUE_MAX>;
true satisfies Same<typeof FIND_ADD_MAX_LINES, typeof FIND_ADD_LINES_MAX>;
true satisfies Same<typeof FIND_TYPED_MAX, typeof FIND_LINE_MAX_CHARS>;
true satisfies Same<typeof REFERENCE_MIN_CHARS, typeof FIND_LINE_MIN_CHARS>;

/**
 * An entry as the screen gets it: at most FIND_CANDIDATES_SENT candidates; an author's lists (people, works) only as
 * COUNTS (R267 b: a queue of 500 entries must not carry 200 works each) — the lists come from `GET …/:eid/options`.
 * `added` is the set of works added from it, worked out from the queue's live entries (R271 M5; `addedOf`).
 */
export function entryView(e: FindEntry, added?: ReadonlySet<string>, library?: LibraryParts): FindEntryView {
  // F15: what a waiting entry returns to stays in the library (`returnTo` is never sent).
  // R470 a: the researcher's pick "Get a copy for this source" stays in the library too (`copyDespiteLink`).
  const { people, works, removed: _removed, candidates, morePeople, returnTo: _returnTo, copyDespiteLink: _pick, offers: stored, ...rest } = e;
  // F15: on an entry with library parts, its offers are the joined list (none: no offers); on an entry waiting in the
  // sign-in window none (its stored links are kept for its return); otherwise as stored.
  const offers = e.state === "waiting-sign-in" ? undefined : library ? library.offers : stored;
  const n = works && added ? works.filter((w) => added.has(w.id)).length : 0;
  // F8b (R279 c): an entry asking among works with people stored beside them carries an author offer — counts only.
  const offer = e.state === "choose" && people?.length ? { peopleCount: people.length, ...(morePeople ? { morePeople } : {}) } : undefined;
  return {
    ...rest,
    ...(candidates ? { candidates: candidates.slice(0, FIND_CANDIDATES_SENT) } : {}),
    ...(offer ? { authorOffer: offer } : {}),
    ...(people && !offer ? { peopleCount: people.length } : {}),
    ...(morePeople && !offer ? { morePeople } : {}),
    ...(works ? { worksCount: works.length } : {}),
    ...(n > 0 ? { addedCount: n } : {}),
    // F15 (R324 a, d): an entry resting as R324 a names carries "Where to get it" (the copy services' links joined with
    // the plan's) and whether a start through the library is offered.
    ...(offers !== undefined && (!library || offers.length > 0) ? { offers } : {}),
    ...(library?.library ? { library: library.library } : {}),
    // F18c (R345 b): "Open it here and fetch the PDF" — only where links are shown.
    ...(library?.linkStart && offers?.length ? { linkStart: true as const } : {}),
    // F18c (R345 e): a wait in the sign-in window opened at one of the entry's links.
    ...(e.state === "waiting-sign-in" && library?.windowStart === "link" ? { windowStart: "link" as const } : {}),
    // F20a (R348 e): "Get through my library in my own browser" — only beside a library start that is offered.
    ...(library?.browserStart && library.library?.canStart === true ? { browserStart: true as const } : {}),
    // F20a (R348 e): a wait in the researcher's own browser.
    ...(e.state === "waiting-sign-in" && library?.waitingIn === "browser" ? { waitingIn: "browser" as const } : {}),
  };
}

/**
 * Task F15: the parts of an entry's view about the library (only for an entry resting as R324 a names). F18c: whether
 * a link start may be made (`linkStart`); for an entry waiting in the sign-in window, only `windowStart` (no offers).
 */
export type LibraryParts = { offers: OfferLink[]; library?: FindLibraryChance; linkStart?: true; windowStart?: "link"; browserStart?: true; waitingIn?: "browser" };

/**
 * Task F15 (R324 a, d): for the entries of a project's queue, the library parts of their views: "Where to get it" (the
 * copy services' links first, then the publisher's page, the catalogue, Open Library and WorldCat; the hosts parsed
 * from the addresses) and `library` (whether "Get through my library" may start, or "no-library"). "Your library" is
 * read anew; the rules, each resting entry's record and the runner's work are asked by the library's
 * `libraryChancesOf` — through the runner's `libraryChances`, which reads a record only when its file changed (R328 e).
 * A project that cannot be read now gives nothing (the view is then as before). F20a (R348 e): `paired` — at least one
 * browser extension is paired (the caller's `pairing.list()`), for `browserStart`.
 */
export async function libraryPartsOf(appConfigDir: string, s: Session, projectId: string, entries: Iterable<FindEntry>, o: { paired: boolean }): Promise<Map<string, LibraryParts>> {
  const out = new Map<string, LibraryParts>();
  const list = [...entries];
  // F18c (R345 e): an entry waiting in the sign-in window opened at one of its links; F20a (R348 e): or waiting in the
  // researcher's own browser (the runner's memory only).
  for (const e of list) {
    if (e.state !== "waiting-sign-in") continue;
    const link = s.find?.windowStartOf(projectId, e.id) === "link";
    const browser = s.find?.waitingIn(projectId, e.id) === "browser";
    if (link || browser) out.set(e.id, { offers: [], ...(link ? { windowStart: "link" as const } : {}), ...(browser ? { waitingIn: "browser" as const } : {}) });
  }
  if (!list.some(restsForLibrary)) return out;
  const { settings } = await readYourLibrary(appConfigDir);
  const runner = s.find;
  let chances: Awaited<ReturnType<typeof libraryChancesOf>>;
  try {
    // R328 e: through the open library's runner, a record is read only when its file changed since it was last read
    // (a read-only library has no runner: its records are read each time).
    chances = runner ? await runner.libraryChances(projectId, list, settings.access) : await libraryChancesOf(s.repo, projectId, list, { access: settings.access });
  } catch {
    return out;
  }
  const byId = new Map(list.map((e) => [e.id, e]));
  for (const [id, c] of chances) {
    const offers = whereToGetIt(c.work, settings, byId.get(id)?.offers ?? []);
    const chance: FindLibraryChance | undefined = c.chance === "yes" ? { canStart: true } : c.chance === "no-library" ? { canStart: false, reason: "no-library" } : undefined;
    // Task F17 (R329 g): what became of the last file handed over that could not be held (the runner's memory only).
    const library: FindLibraryChance | undefined = c.lastFile ? { ...(chance ?? { canStart: false, reason: "not-offered" }), lastFile: c.lastFile, ...(c.lastFileFrom ? { lastFileFrom: c.lastFileFrom } : {}) } : chance;
    out.set(id, { offers, ...(library ? { library } : {}), ...(c.link ? { linkStart: true as const } : {}), ...(c.chance === "yes" && o.paired ? { browserStart: true as const } : {}) });
  }
  return out;
}

/** R271 M5: per author's entry, the works added from it — those of the live entries made from it. */
function addedOf(entries: Iterable<FindEntry>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const all = [...entries];
  for (const e of all) if (e.parentId !== undefined && !out.has(e.parentId)) out.set(e.parentId, worksAddedFrom(all, e.parentId));
  return out;
}

/**
 * Task F8: the entry's lists for the dialog that opens on it; each work added from it (worked out from the live
 * entries, R271 M5) is marked; in "choose-works", whose works they are (R271 M6).
 */
export function optionsOf(e: FindEntry, added: ReadonlySet<string>): FindOptionsResponse {
  const chosen = e.state === "choose-works" ? e.people?.find((p) => p.id === e.chosen) : undefined;
  return {
    ...(e.candidates ? { candidates: e.candidates.slice(0, FIND_CANDIDATES_SENT) } : {}),
    ...(e.people && e.state === "choose-person" ? { people: e.people } : {}),
    ...(e.works ? { works: e.works.map((w): FindPersonWork => (added.has(w.id) ? { ...w, added: true } : w)) } : {}),
    ...(chosen ? { person: { name: chosen.name, ...(chosen.affiliation ? { affiliation: chosen.affiliation } : {}), subjects: chosen.subjects } } : {}),
  };
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
  // Task F8: a person or a work not among the entry's own (400); a work already added from it, by its position (409).
  if (err instanceof FindUnknownOptionError) {
    return err.kind === "person" ? new ApiError(400, "VALIDATION", FIND_ROUTE_TEXT.unknownPerson, "unknown-person") : new ApiError(400, "VALIDATION", FIND_ROUTE_TEXT.unknownWork, "unknown-work");
  }
  if (err instanceof FindAlreadyAddedError) return new ApiError(409, "CONFLICT", findAlreadyAddedRefusal(err.position), "already-added");
  // Task F8b: "Show this author's works" on an entry that carries no author offer (any more).
  if (err instanceof FindNoAuthorError) return new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.noAuthor, "no-author");
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

  /**
   * A press on the runner. The runner itself refuses a press that reaches its store turn after `stopAll()` or
   * `stop(projectId)` and writes nothing, and `stopAll()` waits for presses already in their turn (R245): the service
   * no longer counts presses. A press refused because Find and acquire stopped for the library meanwhile is a 503 in
   * words; one refused because the project was stopped is 423 when the project is locked now, else a 409 in words
   * that say nothing was added (or changed) (R247 M3). A press that fails while the project has been locked meanwhile
   * is 423.
   */
  const pressed = async <T>(s: Session, projectId: string, fn: () => Promise<T>, nothing = "Nothing was changed."): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (state.session !== s || !s.find || err instanceof FindRunnerClosedError) throw new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed");
      if (err instanceof FindProjectStoppedError) {
        if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
        const why = stoppedOf(s, projectId);
        throw new ApiError(409, "CONFLICT", why ? `${FIND_STOPPED_TEXT[why]} ${nothing}` : FIND_ROUTE_TEXT.projectStopped, "stopped");
      }
      if (!(err instanceof ApiError) && !s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
      throw said(err);
    }
  };

  /**
   * Why nothing is done for the project's queue now: the runner's own code, with the index's state said truly
   * (R247 b): "index-not-ready" only while a rebuild runs, "index-needs-rebuild" when it cannot be trusted and none runs.
   */
  const stoppedOf = (s: Session, projectId: string): FindStoppedCode | undefined => {
    const code = s.find?.stoppedFor(projectId)?.code;
    if (code && code !== "index-not-ready") return code;
    const index = state.findIndexState(s);
    if (index === "ready") return code === "index-not-ready" ? "index-not-ready" : undefined;
    return index === "rebuilding" ? "index-not-ready" : "index-needs-rebuild";
  };

  /** The entry of THIS project: 404 when its queue does not hold it (never there, another project's, or removed by anyone; R245). */
  const entryOf = async (s: Session, projectId: string, entryId: string): Promise<FindEntry> => {
    const q = await inWords(() => readFindQueueOf(s.repo, projectId));
    const e = q.entries.get(entryId);
    if (e) return e;
    throw new ApiError(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound);
  };

  app.get("/projects/:id/find", async (req, reply): Promise<FindQueueResponse> => {
    const { s, projectId } = addressed(req, false);
    const q = await inWords(() => readFindQueueOf(s.repo, projectId));
    const readOnly = s.lib.mode === "read-only" || !s.index;
    const runner = state.session === s ? s.find : undefined;
    const stopped: FindStoppedCode | undefined = readOnly ? "read-only" : runner ? stoppedOf(s, projectId) : undefined;
    // Read from the file every time (R247 M10): right after an open, the answer never lags behind it.
    const screen = await readFindScreen(state.deps.appConfigDir);
    reply.header("Cache-Control", "no-store");
    const added = addedOf(q.entries.values());
    // F15 (R324 a, d): "Where to get it" and whether a start through the library is offered, for the resting entries.
    const library = await libraryPartsOf(state.deps.appConfigDir, s, projectId, q.entries.values(), { paired: ctx.pairing.list().length > 0 });
    return {
      entries: [...q.entries.values()].map((e) => entryView(e, added.get(e.id), library.get(e.id))),
      checkEverything: screen.checkEverything,
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
    const r = await pressed(s, projectId, () => runner.add(projectId, lines, collectionId), "Nothing was added.");
    return { added: r.added.map((e) => entryView(e)), mergedLines: r.mergedLines };
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
    return entryView(await pressed(s, projectId, () => runner.choose(projectId, entryId, candidateId)));
  });

  app.post("/projects/:id/find/:eid/duplicate", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    const same = bodyAs<FindDuplicateRequest>(req).same;
    if (typeof same !== "boolean") throw badRequest('"same" must be true or false.');
    await entryOf(s, projectId, entryId);
    return entryView(await pressed(s, projectId, () => runner.confirmDuplicate(projectId, entryId, same)));
  });

  app.post("/projects/:id/find/:eid/add-here", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    bodyOf(req);
    await entryOf(s, projectId, entryId);
    return entryView(await pressed(s, projectId, () => runner.addHereAsWell(projectId, entryId)));
  });

  app.post("/projects/:id/find/:eid/retry", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    bodyOf(req);
    await entryOf(s, projectId, entryId);
    return entryView(await pressed(s, projectId, () => runner.retry(projectId, entryId)));
  });

  // R470 a: "Get a copy for this source" — on an entry resting because its record's only original is a linked file that
  // cannot be found now (409 "entry-state" otherwise). The copy part then looks for a copy under the project's rules and
  // the Search sources settings, as for every copy; a copy found waits for the researcher's check.
  app.post("/projects/:id/find/:eid/get-copy", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    // R285 b: it takes no body.
    if (Object.keys(bodyOf(req)).length > 0) throw badRequest(FIND_ROUTE_TEXT.noBody);
    await entryOf(s, projectId, entryId);
    return entryView(await pressed(s, projectId, () => runner.getCopy(projectId, entryId)));
  });

  app.delete("/projects/:id/find/:eid", limit, async (req): Promise<FindRemoveResponse> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    await entryOf(s, projectId, entryId);
    await pressed(s, projectId, () => runner.remove(projectId, entryId));
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

  // ------------------------------------------------------------------------------------------------------------
  // Task F8 (R267): an author alone — the entry's lists, the person, the works ticked.

  /** The entry's lists for its dialog (people, works with those already added marked, or candidates): read anew, never cached. */
  app.get("/projects/:id/find/:eid/options", async (req, reply): Promise<FindOptionsResponse> => {
    const { s, projectId, entryId } = addressed(req, true);
    reply.header("Cache-Control", "no-store");
    const q = await inWords(() => readFindQueueOf(s.repo, projectId));
    const e = q.entries.get(entryId);
    if (!e) throw new ApiError(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound);
    return optionsOf(e, worksAddedFrom(q.entries.values(), entryId));
  });

  /** The person meant, for an entry asking "which person" only; one of THAT entry's people (no request names another author). */
  app.post("/projects/:id/find/:eid/person", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    const personId = bodyAs<FindPersonRequest>(req).personId;
    if (!isPersonId(personId)) throw new ApiError(400, "VALIDATION", FIND_ROUTE_TEXT.personId, "person-id");
    const cur = await entryOf(s, projectId, entryId);
    // A second press, or a press on any other state: a 409 in words, nothing changed.
    if (cur.state !== "choose-person") throw new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
    if (!cur.people?.some((p) => p.id === personId)) throw new ApiError(400, "VALIDATION", FIND_ROUTE_TEXT.unknownPerson, "unknown-person");
    return entryView(await pressed(s, projectId, () => runner.choosePerson(projectId, entryId, personId)));
  });

  /** The works ticked (1 to 50), for an entry choosing works only; each becomes an entry of its own. */
  app.post("/projects/:id/find/:eid/works", limit, async (req): Promise<FindWorksResponse> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    const workIds = bodyAs<FindWorksRequest>(req).workIds as unknown;
    // Every refusal of a malformed list carries the reason "work-ids" (R271 M9).
    const malformed = (message: string) => new ApiError(400, "VALIDATION", message, "work-ids");
    if (!Array.isArray(workIds)) throw malformed('"workIds" must be a list of the works ticked.');
    if (workIds.length === 0) throw malformed(FIND_ROUTE_TEXT.noWorks);
    if (workIds.length > FIND_CHOOSE_WORKS_MAX) throw malformed(FIND_ROUTE_TEXT.tooManyWorks);
    workIds.forEach((id, i) => {
      if (!isWorkId(id)) throw malformed(findWorkIdRefusal(i + 1));
    });
    const ids = workIds as string[];
    const cur = await entryOf(s, projectId, entryId);
    if (cur.state !== "choose-works") throw new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
    const offered = new Set((cur.works ?? []).map((w) => w.id));
    if (!ids.every((id) => offered.has(id))) throw new ApiError(400, "VALIDATION", FIND_ROUTE_TEXT.unknownWork, "unknown-work");
    const r = await pressed(s, projectId, () => runner.chooseWorks(projectId, entryId, ids), "Nothing was added.");
    // The count is worked out from the queue as it now is (R271 M5).
    const now = await inWords(() => readFindQueueOf(s.repo, projectId));
    return { added: r.added.map((e) => entryView(e)), entry: entryView(r.parent, worksAddedFrom(now.entries.values(), entryId)) };
  });

  /**
   * Task F8b (R279 c): "Show this author's works" — for an entry in "choose" that carries an author offer only (else a
   * 409 in words, nothing changed). No body. It becomes "choose-person" with the people already stored, or "looking-up"
   * with the one person whose works the runner then fetches ("choose-works", by `find.progress`).
   */
  app.post("/projects/:id/find/:eid/author", limit, async (req): Promise<FindEntryView> => {
    const { s, projectId, entryId } = addressed(req, true);
    const runner = runnerOf(s);
    // The request names nothing: a body field is refused, never repeated.
    if (Object.keys(bodyOf(req)).length > 0) throw badRequest(FIND_ROUTE_TEXT.noBody);
    const cur = await entryOf(s, projectId, entryId);
    if (cur.state !== "choose" || !cur.people?.length) throw new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.noAuthor, "no-author");
    return entryView(await pressed(s, projectId, () => runner.asAuthor(projectId, entryId)));
  });

  app.get("/find/screen", async (req): Promise<FindScreenSettings> => {
    uiOnly(req);
    return readFindScreen(state.deps.appConfigDir);
  });

  app.put("/find/screen", limit, async (req): Promise<FindScreenSettings> => {
    uiOnly(req);
    const b = bodyOf(req);
    for (const k of Object.keys(b)) if (!FIND_SCREEN_KEYS.includes(k)) throw badRequest(`"${k}" is not part of this request.`);
    if (typeof b.checkEverything !== "boolean") throw badRequest('"checkEverything" must be true or false.');
    for (const k of ["projectId", "collectionId"]) if (b[k] !== undefined && (typeof b[k] !== "string" || !isId(b[k]))) throw badRequest(`"${k}" must be an id.`);
    const next = findScreenOf(b as unknown as FindScreenSettings);
    await writeFindScreen(state.deps.appConfigDir, next, state.opts.now());
    state.findCheckEverything = next.checkEverything;
    return next;
  });
}
