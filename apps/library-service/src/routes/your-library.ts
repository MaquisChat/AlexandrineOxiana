/**
 * "Your library" (Find and acquire Task F15; Ruling R324): the settings, the address worked out from one pasted link,
 * and the start (and cancel) of a fetch through the library. The shapes and every sentence are @ao/shared's
 * (api/find.ts, the section "Task F15"). Every route is for the desktop app's token only: none is in server.ts's
 * EXTENSION_ROUTES (the extension's token is refused before any runs), and each checks the caller again.
 *
 *   GET  /settings/your-library                  → YourLibraryResponse (the file read anew; a problem said)
 *   PUT  /settings/your-library                  YourLibrary → YourLibraryResponse
 *   POST /settings/your-library/derive           { link } → { access, sentence } (200 whether or not an address is found)
 *   POST /settings/your-library/test             no body → { url } (Task F18a, R334 b: the address of one fixed work)
 *   POST /projects/:id/find/:eid/library/start   no body → { url, ticket }
 *   POST /projects/:id/find/:eid/library/cancel  no body → FindEntryView
 *
 * The pasted link is read and dropped: it is never stored, logged, put in an error, or repeated in an answer (only the
 * worked-out address's host — and a link resolver's path — and kind are said). The PUT never trusts the page: an address is accepted only in the form
 * `deriveLibraryAccess` gives (`isLibraryAccess`), the catalogue address only as `catalogueTemplateOk` allows; a
 * refusal names the field, never what was sent.
 *
 * The start is the researcher's press, one entry at a time (the runner's `libraryStart`: one ticket for the whole
 * service, the pause after a hand-over, the limit of waiting files, the entry's view). The service never fetches
 * anything from the library: the answer is the address and the ticket, for the sign-in window (Task F16). Neither is in
 * any log line, audit entry, event, error or file; the answer is `Cache-Control: no-store`. The hand-over (Task F17)
 * ends the ticket through the runner's `libraryHandedOver`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isId } from "@ao/core";
import {
  FindEntryStateError,
  FindLibraryRefusedError,
  FindProjectStoppedError,
  FindRunnerClosedError,
  KeyNotAvailableError,
  LIBRARY_LINK_MAX as LIBRARY_LINK_MAX_HERE,
  NotFoundError,
  ProjectLockedError,
  ReadOnlyLibraryError,
  YOUR_LIBRARY_NAME_MAX as LIBRARY_NAME_MAX,
  YourLibraryNewerError,
  catalogueTemplateOk,
  deriveLibraryAccessWhy,
  isLibraryAccess,
  libraryAccessPlace,
  libraryAddressFor,
  readFindQueueOf,
  readYourLibrary,
  writeYourLibrary,
  yourLibraryNameOk,
  type DeriveRefusal,
  type FindRunner,
  type LibraryAccess as LibraryAccessHere,
  type YourLibrary as YourLibraryHere,
} from "@ao/library";
import {
  FIND_LIBRARY_TEXT,
  FIND_ROUTE_TEXT,
  YOUR_LIBRARY_BODY_MAX_BYTES,
  YOUR_LIBRARY_DERIVE_TEXT,
  YOUR_LIBRARY_LINK_MAX,
  YOUR_LIBRARY_NAME_MAX,
  YOUR_LIBRARY_TEST_DOI,
  YOUR_LIBRARY_TEXT,
  yourLibraryAddressSentence,
  type FindEntryView,
  type FindLibraryStartResponse,
  type LibraryAccess,
  type YourLibrary,
  type YourLibraryDeriveRefusal,
  type YourLibraryDeriveResponse,
  type YourLibraryResponse,
  type YourLibraryTestResponse,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import type { Session } from "../state.js";
import { entryView, libraryPartsOf } from "./find.js";
import { paramsOf, type Ctx, type Obj, type Same } from "./util.js";

// The library's names and bounds and @ao/shared's are one and the same (Task 47).
true satisfies Same<LibraryAccessHere, LibraryAccess>;
true satisfies Same<YourLibraryHere, YourLibrary>;
true satisfies Same<DeriveRefusal, YourLibraryDeriveRefusal>;
true satisfies Same<typeof LIBRARY_LINK_MAX_HERE, typeof YOUR_LIBRARY_LINK_MAX>;
true satisfies Same<typeof LIBRARY_NAME_MAX, typeof YOUR_LIBRARY_NAME_MAX>;

const FIELDS: readonly string[] = ["name", "access", "catalogueSearch", "staySignedIn"];

/** The body as a JSON object (absent: `{}`); anything else is refused with `sentence`. Never repeats what was sent. */
function objectBody(req: FastifyRequest, sentence: string): Obj {
  const b: unknown = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== "object" || Array.isArray(b)) throw badRequest(sentence);
  return b as Obj;
}

const responseOf = (s: YourLibraryHere, problem?: "unreadable" | "newer"): YourLibraryResponse => ({
  ...s,
  // R336 i: the stored address named in the derive's own words (none when no library is set).
  ...(s.access ? { addressSentence: yourLibraryAddressSentence(libraryAccessPlace(s.access), s.access.kind) } : {}),
  ...(problem ? { problem: { code: problem, text: problem === "newer" ? YOUR_LIBRARY_TEXT.newer : YOUR_LIBRARY_TEXT.unreadable } } : {}),
});

/** A start through the library refused, in words, with the `reason` the screen may act on. */
const LIBRARY_REFUSAL: Record<FindLibraryRefusedError["code"], { reason: string; message?: string }> = {
  "not-offered": { reason: "library-not-offered", message: FIND_LIBRARY_TEXT.notOffered },
  "no-library": { reason: "no-library", message: FIND_LIBRARY_TEXT.noLibrary },
  busy: { reason: "library-busy", message: FIND_LIBRARY_TEXT.busy },
  pause: { reason: "library-pause" },
  "held-full": { reason: "library-held-full", message: FIND_LIBRARY_TEXT.heldFull },
};

export function registerYourLibrary(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const limit = { bodyLimit: YOUR_LIBRARY_BODY_MAX_BYTES };
  const uiOnly = (req: FastifyRequest) => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", YOUR_LIBRARY_TEXT.uiOnly);
  };

  app.get("/settings/your-library", async (req, reply): Promise<YourLibraryResponse> => {
    uiOnly(req);
    reply.header("Cache-Control", "no-store");
    const r = await readYourLibrary(state.deps.appConfigDir);
    return responseOf(r.settings, r.problem);
  });

  app.put("/settings/your-library", limit, async (req, reply): Promise<YourLibraryResponse> => {
    uiOnly(req);
    reply.header("Cache-Control", "no-store");
    const b = objectBody(req, YOUR_LIBRARY_TEXT.fields);
    if (Object.keys(b).some((k) => !FIELDS.includes(k))) throw badRequest(YOUR_LIBRARY_TEXT.fields);
    const name = b.name === undefined || b.name === null ? "" : b.name;
    if (typeof name !== "string" || !yourLibraryNameOk(name.trim())) throw badRequest(YOUR_LIBRARY_TEXT.name);
    const access = b.access === undefined ? null : b.access;
    // Never trusted: only an address of the form "derive" itself gives.
    if (access !== null && !isLibraryAccess(access)) throw badRequest(YOUR_LIBRARY_TEXT.access);
    const cat = b.catalogueSearch === undefined || b.catalogueSearch === null || b.catalogueSearch === "" ? undefined : b.catalogueSearch;
    if (cat !== undefined && !catalogueTemplateOk(cat)) throw badRequest(YOUR_LIBRARY_TEXT.catalogueSearch);
    if (b.staySignedIn !== undefined && typeof b.staySignedIn !== "boolean") throw badRequest(YOUR_LIBRARY_TEXT.staySignedIn);
    const cur = await readYourLibrary(state.deps.appConfigDir);
    if (cur.problem === "newer") throw new ApiError(409, "CONFLICT", YOUR_LIBRARY_TEXT.newer);
    try {
      const saved = await writeYourLibrary(state.deps.appConfigDir, { name: name.trim(), access, ...(cat !== undefined ? { catalogueSearch: cat } : {}), staySignedIn: b.staySignedIn === true }, state.opts.now());
      return responseOf(saved);
    } catch (err) {
      if (err instanceof YourLibraryNewerError) throw new ApiError(409, "CONFLICT", YOUR_LIBRARY_TEXT.newer);
      throw err;
    }
  });

  app.post("/settings/your-library/derive", limit, async (req, reply): Promise<YourLibraryDeriveResponse> => {
    uiOnly(req);
    reply.header("Cache-Control", "no-store");
    const b = objectBody(req, YOUR_LIBRARY_TEXT.link);
    if (Object.keys(b).some((k) => k !== "link") || typeof b.link !== "string") throw badRequest(YOUR_LIBRARY_TEXT.link);
    // The link is read here and dropped: only the address worked out from it (or a refusal's code) goes on.
    const r = deriveLibraryAccessWhy(b.link);
    if ("refused" in r) return { access: null, sentence: YOUR_LIBRARY_DERIVE_TEXT[r.refused] };
    return { access: r.access, sentence: yourLibraryAddressSentence(libraryAccessPlace(r.access), r.access.kind) };
  });

  /**
   * Task F18a (R334 b): "Test" — the library's address for ONE fixed, well-known work, by the stored access. It takes
   * nothing (no link, no DOI, no project) and gives no ticket: the page opens the sign-in window with a ticket of its
   * own, which no hand-over can match, so nothing the window might fetch is ever kept. The address is in the answer
   * only (`no-store`): no log line (bodies are never logged), audit entry, event or error carries it.
   */
  app.post("/settings/your-library/test", limit, async (req, reply): Promise<YourLibraryTestResponse> => {
    uiOnly(req);
    // R336 f: every answer of this route, its refusals included, is no-store.
    reply.header("Cache-Control", "no-store");
    if (Object.keys(objectBody(req, YOUR_LIBRARY_TEXT.noBody)).length) throw badRequest(YOUR_LIBRARY_TEXT.noBody);
    const r = await readYourLibrary(state.deps.appConfigDir);
    if (r.problem === "newer") throw new ApiError(409, "CONFLICT", YOUR_LIBRARY_TEXT.newer);
    if (r.problem === "unreadable") throw new ApiError(409, "CONFLICT", YOUR_LIBRARY_TEXT.unreadable);
    if (!r.settings.access) throw new ApiError(409, "CONFLICT", FIND_LIBRARY_TEXT.noLibrary, "no-library");
    const url = libraryAddressFor(r.settings.access, { id: "your-library-test", title: "", creators: [], type: "article-journal", identifiers: { doi: YOUR_LIBRARY_TEST_DOI }, providers: [] });
    if (!url) throw new ApiError(409, "CONFLICT", YOUR_LIBRARY_TEXT.testNoAddress);
    return { url };
  });

  // ------------------------------------------------------------------------------------------------------------
  // Starting and cancelling a fetch through the library (R324 a–c).

  const addressed = (req: FastifyRequest): { s: Session; runner: FindRunner; projectId: string; entryId: string } => {
    uiOnly(req);
    const p = paramsOf(req);
    const projectId = p.id ?? "";
    const entryId = p.eid ?? "";
    if (!isId(projectId)) throw badRequest("That is not a project's id.");
    if (!isId(entryId)) throw badRequest("That is not a queue entry's id.");
    if (Object.keys(objectBody(req, YOUR_LIBRARY_TEXT.noBody)).length) throw badRequest(YOUR_LIBRARY_TEXT.noBody);
    const s = state.requireSession();
    if (!s.repo.listProjects().some((x) => x.id === projectId)) throw new ApiError(404, "NOT_FOUND", "That project was not found.");
    state.assertNotMoving();
    if (s.lib.mode === "read-only" || !s.index) throw new ApiError(409, "READ_ONLY", FIND_ROUTE_TEXT.readOnly, "read-only");
    if (!s.find || state.session !== s) throw new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed");
    if (!s.repo.isUnlocked(projectId)) throw new ApiError(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
    return { s, runner: s.find, projectId, entryId };
  };

  /** A refusal of the runner in words (each its own status, as the find routes give them). Nothing else is passed on. */
  const said = (s: Session, projectId: string, err: unknown): unknown => {
    if (err instanceof ApiError) return err;
    if (err instanceof FindLibraryRefusedError) {
      const r = LIBRARY_REFUSAL[err.code];
      return new ApiError(409, "CONFLICT", r.message ?? err.message, r.reason);
    }
    if (state.session !== s || !s.find || err instanceof FindRunnerClosedError) return new ApiError(503, "UNAVAILABLE", FIND_ROUTE_TEXT.closed, "closed");
    if (err instanceof ProjectLockedError || err instanceof KeyNotAvailableError || !s.repo.isUnlocked(projectId)) return new ApiError(423, "PROJECT_LOCKED", FIND_ROUTE_TEXT.locked, "locked");
    if (err instanceof FindProjectStoppedError) return new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.projectStopped, "stopped");
    if (err instanceof ReadOnlyLibraryError) return new ApiError(409, "READ_ONLY", FIND_ROUTE_TEXT.readOnly, "read-only");
    if (err instanceof NotFoundError) return new ApiError(404, "NOT_FOUND", FIND_ROUTE_TEXT.entryNotFound);
    if (err instanceof FindEntryStateError) return new ApiError(409, "CONFLICT", FIND_ROUTE_TEXT.entryState, "entry-state");
    return err;
  };

  app.post("/projects/:id/find/:eid/library/start", limit, async (req, reply): Promise<FindLibraryStartResponse> => {
    const { s, runner, projectId, entryId } = addressed(req);
    const { settings } = await readYourLibrary(state.deps.appConfigDir);
    let got: { url: string; ticket: string };
    try {
      got = await runner.libraryStart(projectId, entryId, settings.access);
    } catch (err) {
      throw said(s, projectId, err);
    }
    reply.header("Cache-Control", "no-store");
    return { url: got.url, ticket: got.ticket };
  });

  app.post("/projects/:id/find/:eid/library/cancel", limit, async (req, reply): Promise<FindEntryView> => {
    const { s, runner, projectId, entryId } = addressed(req);
    let back;
    try {
      back = await runner.libraryCancel(projectId, entryId);
    } catch (err) {
      throw said(s, projectId, err);
    }
    reply.header("Cache-Control", "no-store");
    const q = await readFindQueueOf(s.repo, projectId).catch(() => null);
    const parts = await libraryPartsOf(state.deps.appConfigDir, s, projectId, q ? q.entries.values() : [back]);
    return entryView(back, undefined, parts.get(back.id));
  });
}
