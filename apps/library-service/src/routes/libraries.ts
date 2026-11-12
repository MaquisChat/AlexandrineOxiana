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
  listLibraries,
  planMove,
  rebuildIndex,
  reconnect,
  relinkMissing,
  scrubPaths,
  type IntegritySample,
  type Library,
} from "@ao/library";
import { ApiError, badRequest, errorBody, toApiError } from "../errors.js";
import { sseFrame } from "../events.js";
import { ndjsonWriter, sseWriter } from "../streams.js";
import { bodyOf, queryOf, str, strArray, type Ctx } from "./util.js";

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

const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
function absPath(o: Record<string, unknown>, key: string): string {
  const p = str(o, key, 4096);
  if (!isAbsolute(p) || p.includes("\0")) throw badRequest(`"${key}" must be an absolute path.`);
  return p;
}

export function registerLibraries(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/libraries", async () => {
    const known = await listLibraries(state.deps).catch(() => []);
    return { libraries: known.map((e) => ({ libraryId: e.libraryId, name: e.name, lastKnownPaths: e.lastKnownPaths })), ...(state.session ? { current: libraryView(ctx) } : {}) };
  });

  app.post("/libraries", async (req) => {
    const b = bodyOf(req);
    const path = absPath(b, "path");
    const name = str(b, "name", 200);
    state.roots.add(path);
    await state.closeLibrary();
    if (state.shuttingDown) throw new ApiError(503, "UNAVAILABLE", "The library service is shutting down.");
    const lib = await createLibrary(path, name, state.deps);
    await state.adopt(lib);
    return libraryView(ctx);
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
    return { closed: true };
  });

  // Searches the usual places (or `roots`) for the library, streaming each folder found as NDJSON.
  app.post("/libraries/locate", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = bodyOf(req);
    const libraryId = str(b, "libraryId", 64);
    const given = b.roots === undefined ? undefined : strArray(b, "roots", { max: 50 }).map((r) => (isAbsolute(r) ? r : (() => { throw badRequest('"roots" must be absolute paths.'); })()));
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
  app.post("/libraries/move", async (req: FastifyRequest, reply: FastifyReply) => {
    if (state.moving) throw new ApiError(409, "CONFLICT", "A move of this library is already running.");
    const s = state.requireWritable();
    const b = bodyOf(req);
    const dest = absPath(b, "dest");
    const excludeProjectIds = strArray(b, "excludeProjectIds", { optional: true, max: 10_000, itemMax: 64 });
    // From here every change is refused (503 MOVE_IN_PROGRESS) and background work waits (R102 N2).
    state.moving = true;
    try {
      // Changes already being made finish first (this request is one of the in-flight ones, R106 I1).
      for (let waited = 0; state.inFlightMutating() > 1; waited += 25) {
        if (waited >= 60_000) throw new ApiError(409, "CONFLICT", "Some changes are still being made. Try the move again in a moment.");
        await new Promise((r) => setTimeout(r, 25));
      }
      const paused = await state.quiesce(s); // 409 before the stream starts when work cannot pause
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
        await write(ndjsonError(ctx, err));
        reply.raw.end();
        return;
      }
      const r = moved;
      const pending = state.recordMove({ oldRoot, newRoot: r.newRoot, confirmToken: r.confirmToken });
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
        result: { newRoot: r.newRoot, confirmToken: r.confirmToken, expiresAt: pending.expiresAt, fileCount: r.fileCount, totalBytes: r.totalBytes, filesCopied: r.filesCopied, projectsMovedAway: r.projectsMovedAway, warnings: r.warnings.map((w) => scrubPaths(w, state.roots)) },
      });
      reply.raw.end();
    } finally {
      state.moving = false;
    }
  });

  // The last move's token (single use, 15 minutes), e.g. after the move's stream was cut off.
  app.get("/libraries/move/status", async () => {
    const m = state.pendingMove();
    return { pending: m ?? null };
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
    void state.startWork("index", async () => {
      await rebuildIndex(s.index, s.ring, s.lib, (done, total) => state.events.publish("job.progress", { kind: "index", done, total }));
    });
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

  app.post("/libraries/rebuild-index", async () => {
    const s = state.requireWritable();
    const r = await rebuildIndex(s.index, s.ring, s.lib, (done, total) => state.events.publish("job.progress", { kind: "index", done, total }));
    state.publishState();
    return { indexed: r.indexed, lockedProjects: r.lockedProjects.length, errors: r.errors.length };
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
