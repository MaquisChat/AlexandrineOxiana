/**
 * Libraries (spec 4.5): list, create, open, close, locate (NDJSON), reconnect, move (plan, NDJSON
 * progress, delete the old copy), integrity, relink, rebuild the index; and the event stream.
 * Paths the researcher chose come back as given (R96: their own chosen path); everything else is
 * library-relative.
 */
import { dirname } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  checkIntegrity,
  createLibrary,
  defaultLocationEnv,
  defaultSearchRoots,
  deleteOldCopy,
  executeMove,
  findLibrary,
  freeRoomFor,
  listLibraries,
  settleDamagedRegistry,
  suggestedLibraryFolder,
  planMove,
  reconnect,
  relinkMissing,
  scrubPaths,
  type IntegritySample,
  type Library,
} from "@ao/library";
import type { LibraryFolderRoomRequest, LibraryFolderRoomResponse, LibrarySuggestedFolderResponse } from "@ao/shared";
import { ApiError, badRequest, errorBody, toApiError } from "../errors.js";
import { sseFrame } from "../events.js";
import { cheapLocationEnv } from "./watched-folders.js";
import { ndjsonWriter, sseWriter } from "../streams.js";
import { bodyAs, bodyOf, optStr, queryOf, str, strArray, type Ctx } from "./util.js";
import { isLocalAbsolutePath } from "./local-path.js";

function libraryView(ctx: Ctx): Record<string, unknown> | undefined {
  const s = ctx.state.session;
  if (!s) return undefined;
  return {
    libraryId: s.lib.id,
    name: s.lib.name,
    mode: s.lib.mode,
    ...(s.lib.readOnlyReason ? { readOnlyReason: s.lib.readOnlyReason } : {}),
    // Only the holding device's name (R118): never its id, process or a user name.
    ...(s.lib.lockedBy ? { lockedBy: s.lib.lockedBy } : {}),
    // Being rebuilt, failed, or not writable (read-only): absent when the index is ready (D8).
    ...(s.indexStatus ? { index: s.indexStatus } : {}),
  };
}

/** Starts a streamed response (NDJSON or SSE) with the headers the hooks set (CORS). */
function startStream(reply: FastifyReply, contentType: string): void {
  reply.hijack();
  const headers: Record<string, string> = { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" };
  for (const [k, v] of Object.entries(reply.getHeaders())) if (typeof v === "string") headers[k] = v;
  reply.raw.writeHead(200, headers);
}

/** An NDJSON stream whose writes wait for the client to drain (R99). */
function ndjson(reply: FastifyReply): (value: unknown) => Promise<void> {
  startStream(reply, "application/x-ndjson");
  return ndjsonWriter(reply.raw);
}

const ndjsonError = (ctx: Ctx, err: unknown) => errorBody(toApiError(err), ctx.state.roots);

function absPath(o: Record<string, unknown>, key: string): string {
  const p = str(o, key, 4096);
  if (!isLocalAbsolutePath(p)) throw badRequest(`"${key}" must be an absolute path.`);
  return p;
}

/** A rebuild the researcher asked for, stopped because the library was closed or moved meanwhile (M4). */
const stoppedByClose = () =>
  new ApiError(409, "CONFLICT", "The rebuild stopped because the library was closed or moved. Open the library and choose \"Rebuild library from folder\" again if it is still needed.");

export function registerLibraries(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/libraries", async () => {
    // At start the last open library is being reopened (D5): the first answers wait once for that
    // attempt, at most 30 s (a network drive that does not answer); later ones answer at once and,
    // while it still runs, name it as `reopening` (I1).
    await state.waitForStartup();
    // A damaged list is set aside now, with its notice, so the chooser does not just look empty (R181 a).
    await settleDamagedRegistry(state.deps).catch((err: unknown) => state.opts.log.warn({ err: err instanceof Error ? err.name : "error" }, "the list of libraries could not be set aside"));
    const known = await listLibraries(state.deps).catch(() => []);
    // This computer's own notices, for the chooser too (Task 68 fix round 1, M1).
    await state.refreshNotices();
    return {
      libraries: known.map((e) => ({ libraryId: e.libraryId, name: e.name, lastKnownPaths: e.lastKnownPaths })),
      notices: state.notices,
      ...(state.session
        ? { current: libraryView(ctx) }
        : state.reopening
          ? { reopening: state.reopening }
          : state.notFound
            ? { notFound: state.notFound }
            : {}),
    };
  });

  app.post("/libraries", async (req) => {
    const b = bodyOf(req);
    const path = absPath(b, "path");
    const name = str(b, "name", 200);
    state.roots.add(path);
    await state.closeLibrary();
    if (state.shuttingDown) throw new ApiError(503, "UNAVAILABLE", "The library service is shutting down.");
    const lib = await createLibrary(path, name, state.deps);
    await state.adopt(lib, { newLibrary: true });
    return libraryView(ctx);
  });

  // R447: for "Choose a library", shown before any library is open. The folder to offer for a new library (nothing is
  // created; only whether the few candidate folders in the home folder exist and are empty is read), and the free room on
  // the disk under a folder the researcher has typed or picked (the path in the body; only the room is read).
  app.get("/libraries/suggested-folder", async (): Promise<LibrarySuggestedFolderResponse> => {
    const folder = await suggestedLibraryFolder(cheapLocationEnv()).catch(() => undefined);
    return folder ? { folder } : {};
  });

  app.post("/libraries/folder-room", async (req): Promise<LibraryFolderRoomResponse> => {
    const path = absPath(bodyAs<LibraryFolderRoomRequest>(req), "path");
    const freeBytes = await freeRoomFor(path);
    return freeBytes === undefined ? {} : { freeBytes };
  });

  app.post("/libraries/open", async (req) => {
    const path = absPath(bodyOf(req), "path");
    state.roots.add(path);
    await state.closeLibrary();
    const lib = await state.openLibrary(path);
    await state.adopt(lib);
    return libraryView(ctx);
  });

  app.post("/libraries/close", async () => {
    await state.closeLibrary();
    // Closed by the researcher: the next start shows the chooser (D5).
    await state.forgetOpenLibrary();
    return { closed: true };
  });

  // Searches the usual places (or `roots`) for the library, streaming each folder found as NDJSON.
  app.post("/libraries/locate", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = bodyOf(req);
    const libraryId = str(b, "libraryId", 64);
    const given = b.roots === undefined ? undefined : strArray(b, "roots", { max: 50 }).map((r) => (isLocalAbsolutePath(r) ? r : (() => { throw badRequest('"roots" must be absolute paths.'); })()));
    let roots = given;
    if (!roots) {
      const known = (await listLibraries(state.deps).catch(() => [])).find((e) => e.libraryId === libraryId);
      roots = [...new Set([...(known?.lastKnownPaths ?? []).map((p) => dirname(p)), ...(await defaultSearchRoots(await defaultLocationEnv()))])];
    }
    const ac = new AbortController();
    const write = ndjson(reply);
    reply.raw.on("close", () => ac.abort());
    try {
      for await (const f of findLibrary(libraryId, roots, { signal: ac.signal })) await write({ found: f });
      await write({ done: true });
    } catch (err) {
      if (!ac.signal.aborted) await write(ndjsonError(ctx, err));
    }
    reply.raw.end();
  });

  app.post("/libraries/reconnect", async (req) => {
    const b = bodyOf(req);
    const path = absPath(b, "path");
    const libraryId = str(b, "libraryId", 64);
    state.roots.add(path);
    await state.closeLibrary();
    if (state.shuttingDown) throw new ApiError(503, "UNAVAILABLE", "The library service is shutting down.");
    const r = await reconnect(path, libraryId, state.deps, { tz: state.tz, onLockLost: () => state.publishState() });
    await state.adopt(r.library);
    return {
      ...libraryView(ctx),
      integrity: r.integrity,
      rebuilt: r.rebuilt,
      ...(r.rebuildSkipped ? { rebuildSkipped: r.rebuildSkipped } : {}),
      ...(r.moveIncomplete ? { moveIncomplete: true } : {}),
      warnings: r.warnings.map((w) => scrubPaths(w, state.roots)),
    };
  });

  app.post("/libraries/move/plan", async (req) => {
    const s = state.requireSession();
    const dest = absPath(bodyOf(req), "dest");
    const plan = await planMove(s.lib, dest, await defaultLocationEnv(), { sourceRepo: s.repo, tz: state.tz });
    return {
      destination: plan.destination,
      perProject: plan.perProject.map((p) => ({ projectId: p.projectId, name: p.name, folder: p.folder, decision: p.decision })),
      projectsMovedAway: plan.projectsMovedAway,
      totalBytes: plan.totalBytes,
      fileCount: plan.fileCount,
    };
  });

  // Copies, verifies and switches to `dest`, streaming progress as NDJSON; the service then works on
  // the new copy. Nothing writes to the library meanwhile (R99 I5): imports are paused (the move is
  // refused if one cannot be), watches, queues and the backup scheduler stopped; afterwards they
  // start on the library now open, and the paused imports resume there.
  //
  // A move is marked as ASKED FOR at the earliest point of its request (R399 b): this route's own
  // onRequest hook, which runs right after the global one (host, origin and token checks: nothing
  // that has not passed them may change what move/status says) and before the body is read or
  // anything waits. Fastify has no earlier per-route point. The mark ends when the handler ends
  // (the move ran or was refused); a request refused before its handler (its body unreadable, the
  // global 409) ends it when its answer is sent or the connection closes.
  const asked = new Map<FastifyRequest, { handling: boolean }>();
  const endAsked = (req: FastifyRequest) => {
    if (asked.delete(req)) state.movesAsked--;
  };
  /** The destination and the screen's attempt id of a move request, when its body carries both. */
  const askedFor = (req: FastifyRequest): { dest: string; attempt: string } | undefined => {
    const b = req.body as Record<string, unknown> | null | undefined;
    if (!b || typeof b !== "object" || typeof b.dest !== "string" || typeof b.attempt !== "string") return undefined;
    if (!b.attempt || b.attempt.length > 64) return undefined;
    return { dest: b.dest, attempt: b.attempt };
  };
  /** A move refused after it was marked keeps its reason under its attempt, as executeMove's failures are (R399 c). */
  const recordRefusal = (req: FastifyRequest, error: { code: string; message: string; reason?: string }) => {
    const a = askedFor(req);
    if (a) state.recordMoveFailure({ newRoot: a.dest, attempt: a.attempt, error });
  };
  app.post(
    "/libraries/move",
    {
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        const mark = { handling: false };
        asked.set(req, mark);
        state.movesAsked++;
        reply.raw.once("close", () => {
          if (!mark.handling) endAsked(req);
        });
      },
      // A refusal answered before the handler ran (the global 409 while another move runs, a body
      // that could not be read): recorded before its answer goes out, so the mark never ends first.
      onSend: async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        if (asked.get(req)?.handling === false && reply.statusCode >= 400 && typeof payload === "string") {
          try {
            const body = JSON.parse(payload) as { error?: { code: string; message: string; reason?: string } };
            if (body.error) recordRefusal(req, body.error);
          } catch {
            // not an error body: nothing to keep
          }
        }
        return payload;
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const mark = asked.get(req);
      if (mark) mark.handling = true;
      let finished = false;
      try {
        await runMove(req, reply, () => (finished = true));
      } catch (err) {
        // Refused or failed before the move finished: its reason is kept before the mark ends.
        if (!finished) recordRefusal(req, errorBody(toApiError(err), state.roots).error);
        throw err;
      } finally {
        endAsked(req);
      }
    },
  );
  const runMove = async (req: FastifyRequest, reply: FastifyReply, onFinished: () => void) => {
    if (state.moving) throw new ApiError(409, "CONFLICT", "A move of this library is already running.");
    const s = state.requireWritable();
    const b = bodyOf(req);
    const dest = absPath(b, "dest");
    const excludeProjectIds = strArray(b, "excludeProjectIds", { optional: true, max: 10_000, itemMax: 64 });
    // The screen's own id for this request: a failure is kept under it, so that a screen that lost
    // its connection can tell its own move's failure from an earlier one (R379).
    const attempt = optStr(b, "attempt", 64) ?? null;
    // From here every change is refused (503 MOVE_IN_PROGRESS) and background work waits (R102 N2).
    // An earlier failure is kept until this move has its own outcome (R399 c).
    state.moving = true;
    try {
      // Changes already being made finish first (this request is one of the in-flight ones, R106 I1).
      for (let waited = 0; state.inFlightMutating() > 1; waited += 25) {
        if (waited >= 60_000) throw new ApiError(409, "CONFLICT", "Some changes are still being made. Try the move again in a moment.");
        await new Promise((r) => setTimeout(r, 25));
      }
      let paused: Awaited<ReturnType<typeof state.quiesce>>;
      try {
        paused = await state.quiesce(s); // 409 before the stream starts when work cannot pause
      } catch (err) {
        // Refused before anything was copied: a transcription the move stopped (FR-385) runs again
        // now, in the library still open, rather than at its next open.
        state.moving = false;
        state.resumeStoppedTranscriptions(s);
        throw err;
      }
      state.roots.add(dest);
      // Lines are dropped once the client is gone: the move itself always runs to its end (R102 N1).
      const write = ndjson(reply);
      const oldRoot = s.lib.root;
      let moved: Awaited<ReturnType<typeof executeMove>>;
      try {
        await ctx.beforeExecuteMove?.();
        moved = await executeMove(s.lib, dest, {
          deps: state.deps,
          env: await defaultLocationEnv(),
          excludeProjectIds,
          sourceRepo: s.repo,
          ...(s.index ? { index: s.index } : {}),
          tz: state.tz,
          onProgress: (p) => write({ progress: p }),
        });
      } catch (err) {
        // Not moved: the old library carries on as before.
        state.moving = false;
        if (state.session === s) {
          state.activate(s);
          state.resumeBatches(paused);
          state.restartStoppedWork();
        }
        const body = ndjsonError(ctx, err);
        state.recordMoveFailure({ newRoot: dest, attempt, error: body.error });
        await write(body);
        reply.raw.end();
        return;
      }
      const r = moved;
      const warnings = r.warnings.map((w) => scrubPaths(w, state.roots));
      const pending = state.recordMove({ oldRoot, newRoot: r.newRoot, confirmToken: r.confirmToken, warnings });
      state.forgetMoveFailure();
      onFinished();
      // The library now lives at the destination (the move closed the old copy): open it there, retrying once.
      // If it still cannot be opened, what was paused resumes once it is (R106).
      state.resumeWhenOpened(r.newRoot, paused, oldRoot);
      let lib: Library | undefined;
      for (let attempt = 0; attempt < 2 && !lib; attempt++) {
        try {
          lib = await state.openLibrary(r.newRoot);
        } catch (err) {
          state.opts.log.warn({ err: state.describe(err), attempt }, "the moved library could not be opened");
        }
      }
      await state.closeLibrary();
      state.moving = false;
      if (!lib) {
        // Nothing is lost: the move finished and verified; the imports paused for it wait in the new
        // copy, resumable once it is opened there. The old copy is kept until its deletion is confirmed.
        await write(
          errorBody(new ApiError(503, "LIBRARY_OFFLINE", "The library was moved and verified, but it could not be opened at its new place. Open it there to continue; paused imports can be resumed then, and the old copy is kept until you confirm its deletion."), state.roots),
        );
        reply.raw.end();
        return;
      }
      // Adopting it resumes the paused imports and the stopped work (resumeWhenOpened, in activate).
      await state.adopt(lib);
      await write({
        done: true,
        result: { newRoot: r.newRoot, confirmToken: r.confirmToken, expiresAt: pending.expiresAt, fileCount: r.fileCount, totalBytes: r.totalBytes, filesCopied: r.filesCopied, projectsMovedAway: r.projectsMovedAway, warnings },
      });
      reply.raw.end();
    } finally {
      state.moving = false;
    }
  };

  // What is true of the moves, for a screen whose connection to its move was lost (R379): whether
  // one is running now (or was asked for and has not yet ended or been refused, R399 b); the last finished move's token (single use, 15 minutes); the last move that
  // stopped with an error (15 minutes, or until the next move starts).
  app.get("/libraries/move/status", async () => {
    const m = state.pendingMove();
    const f = state.failedMove();
    return { pending: m ?? null, running: state.moving || state.movesAsked > 0, failed: f ? { newRoot: f.newRoot, attempt: f.attempt, error: f.error } : null };
  });

  app.post("/libraries/move/delete-old", async (req) => {
    const token = str(bodyOf(req), "token", 256);
    const m = state.pendingMove();
    if (!m || m.confirmToken !== token) throw new ApiError(400, "VALIDATION", "That confirmation is not valid (it is single use and expires after 15 minutes).");
    let r: Awaited<ReturnType<typeof deleteOldCopy>>;
    try {
      r = await deleteOldCopy(m.oldRoot, token, { deps: state.deps, ...(state.session ? { destRepo: state.session.repo } : {}), tz: state.tz });
    } finally {
      // A mark may have appeared (Task 50): the banner follows.
      state.publishState();
    }
    state.forgetMove();
    return { ...r, warnings: r.warnings.map((w) => scrubPaths(w, state.roots)) };
  });

  app.get("/libraries/integrity", async (req) => {
    const s = state.requireSession();
    const q = queryOf(req).sample;
    let sample: IntegritySample = 0.05;
    if (q === "full") sample = "full";
    else if (q !== undefined) {
      const n = Number(q);
      if (!(n > 0 && n <= 1)) throw badRequest('"sample" must be a fraction above 0 and at most 1, or "full".');
      sample = n;
    }
    const report = await checkIntegrity(s.lib, sample, { keyRing: s.ring });
    const projectWarnings = await state.projectWarnings(s);
    return {
      report: { ...report, errors: report.errors.map((e) => ({ path: e.path, message: scrubPaths(e.message, state.roots) })) },
      integrityWarnings: state.integrityWarnings(s),
      projectWarnings,
    };
  });

  // ---- interrupted changes recovery could not settle (R27): listed, and resolved by the researcher's choice ----
  app.get("/libraries/pending-writes", async () => {
    const s = state.requireSession();
    const names = new Map(s.repo.listProjects().map((p) => [p.id, p.name]));
    const list = await s.repo.pendingWrites();
    return {
      pendingWrites: list.map((p) => ({
        txn: p.txn,
        projectId: p.projectId,
        project: p.projectId === "*" ? "library" : (names.get(p.projectId) ?? "a project"),
        status: p.status,
        canKeep: p.canKeep,
        canRollBack: p.canRollBack,
        steps: p.steps,
        ...(p.detail ? { detail: scrubPaths(p.detail, state.roots) } : {}),
      })),
    };
  });

  app.post("/libraries/pending-writes/:txn/resolve", async (req) => {
    const s = state.requireWritable();
    const txn = (req.params as { txn?: string }).txn ?? "";
    const choice = str(bodyOf(req), "choice", 16);
    if (choice !== "roll-back" && choice !== "keep") throw badRequest('"choice" must be "roll-back" or "keep".');
    const r = await s.repo.resolvePendingWrite(txn, choice);
    // The index was built with the change half there (or, kept, without it): rebuild it in the background.
    state.startIndexRebuild(s, true);
    state.publishState();
    return r;
  });

  app.post("/libraries/relink", async (req) => {
    const s = state.requireWritable();
    const searchDir = absPath(bodyOf(req), "searchDir");
    try {
      const r = await relinkMissing(s.lib, searchDir, s.repo, { keyRing: s.ring });
      return { ...r, warnings: r.warnings.map((w) => scrubPaths(w, state.roots)) };
    } finally {
      // A mark may have appeared (Task 50): the banner follows.
      state.publishState();
    }
  });

  // "Rebuild library from folder" (spec 4.3): the index made again from the files, whatever its state.
  app.post("/libraries/rebuild-index", async () => {
    const s = state.requireWritable();
    // One already running (e.g. the open's): wait for it, then rebuild as asked (M3).
    for (let i = 0; s.indexRebuild && i < 3; i++) await s.indexRebuild.done;
    if (state.session !== s) throw stoppedByClose();
    try {
      const r = await state.rebuildIndex(s, true);
      return { indexed: r?.indexed ?? 0, lockedProjects: r?.lockedProjects.length ?? 0, errors: r?.errors.length ?? 0 };
    } catch (err) {
      // Stopped between sources because the library closed or moved (M4): said in plain words.
      if (err instanceof Error && err.name === "AbortError") throw stoppedByClose();
      throw err;
    }
  });

  // Server-sent events; read with fetch streaming and the Authorization header (never a query token).
  app.get("/events", async (_req: FastifyRequest, reply: FastifyReply) => {
    const s = state.session;
    if (s) await state.projectWarnings(s).catch(() => {});
    startStream(reply, "text/event-stream");
    // A client that falls too far behind is dropped (R99); it reconnects and gets a fresh state.
    const send = sseWriter(reply.raw);
    send(sseFrame({ type: "library.state", data: state.libraryState() }));
    const off = state.events.subscribe((e) => void send(sseFrame(e)));
    const beat = setInterval(() => send(": keep-alive\n\n"), 25_000);
    beat.unref?.();
    // The response closes when the client goes away (the request's own "close" fires once it is read).
    reply.raw.on("close", () => {
      off();
      clearInterval(beat);
    });
  });
}
