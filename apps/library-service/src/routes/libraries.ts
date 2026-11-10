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
  openLibrary,
  planMove,
  rebuildIndex,
  reconnect,
  relinkMissing,
  scrubPaths,
  type IntegritySample,
} from "@ao/library";
import { ApiError, badRequest, errorBody, toApiError } from "../errors.js";
import { sseFrame } from "../events.js";
import { bodyOf, queryOf, str, strArray, type Ctx } from "./util.js";

/** Old library folders awaiting deletion after a move, by the move's single-use token. */
const moveTokens = new Map<string, string>();

function libraryView(ctx: Ctx): Record<string, unknown> | undefined {
  const s = ctx.state.session;
  if (!s) return undefined;
  return { libraryId: s.lib.id, name: s.lib.name, mode: s.lib.mode, ...(s.lib.readOnlyReason ? { readOnlyReason: s.lib.readOnlyReason } : {}) };
}

/** Starts a streamed response (NDJSON or SSE) with the headers the hooks set (CORS). */
function stream(reply: FastifyReply, contentType: string): (line: string) => boolean {
  reply.hijack();
  const headers: Record<string, string> = { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" };
  for (const [k, v] of Object.entries(reply.getHeaders())) if (typeof v === "string") headers[k] = v;
  reply.raw.writeHead(200, headers);
  return (line: string) => reply.raw.write(line);
}

function ndjsonError(ctx: Ctx, err: unknown): string {
  return `${JSON.stringify(errorBody(toApiError(err), ctx.state.roots))}\n`;
}

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
    const lib = await createLibrary(path, name, state.deps);
    await state.adopt(lib);
    return libraryView(ctx);
  });

  app.post("/libraries/open", async (req) => {
    const path = absPath(bodyOf(req), "path");
    state.roots.add(path);
    await state.closeLibrary();
    const lib = await openLibrary(path, state.deps, { onLockLost: () => state.publishState() });
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
    const write = stream(reply, "application/x-ndjson");
    reply.raw.on("close", () => ac.abort());
    try {
      for await (const f of findLibrary(libraryId, roots, { signal: ac.signal })) write(`${JSON.stringify({ found: f })}\n`);
      write(`${JSON.stringify({ done: true })}\n`);
    } catch (err) {
      if (!ac.signal.aborted) write(ndjsonError(ctx, err));
    }
    reply.raw.end();
  });

  app.post("/libraries/reconnect", async (req) => {
    const b = bodyOf(req);
    const path = absPath(b, "path");
    const libraryId = str(b, "libraryId", 64);
    state.roots.add(path);
    await state.closeLibrary();
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

  // Copies, verifies and switches to `dest`, streaming progress as NDJSON; the service then works on the new copy.
  app.post("/libraries/move", async (req: FastifyRequest, reply: FastifyReply) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const dest = absPath(b, "dest");
    const excludeProjectIds = strArray(b, "excludeProjectIds", { optional: true, max: 10_000, itemMax: 64 });
    state.roots.add(dest);
    const write = stream(reply, "application/x-ndjson");
    try {
      const oldRoot = s.lib.root;
      const r = await executeMove(s.lib, dest, {
        deps: state.deps,
        env: await defaultLocationEnv(),
        excludeProjectIds,
        sourceRepo: s.repo,
        ...(s.index ? { index: s.index } : {}),
        tz: state.tz,
        onProgress: (p) => void write(`${JSON.stringify({ progress: p })}\n`),
      });
      moveTokens.set(r.confirmToken, oldRoot);
      // The library now lives at the destination: switch to it.
      await state.closeLibrary();
      await state.adopt(await openLibrary(r.newRoot, state.deps, { onLockLost: () => state.publishState() }));
      write(`${JSON.stringify({ done: true, result: { newRoot: r.newRoot, confirmToken: r.confirmToken, fileCount: r.fileCount, totalBytes: r.totalBytes, filesCopied: r.filesCopied, projectsMovedAway: r.projectsMovedAway, warnings: r.warnings.map((w) => scrubPaths(w, state.roots)) } })}\n`);
    } catch (err) {
      write(ndjsonError(ctx, err));
    }
    reply.raw.end();
  });

  app.post("/libraries/move/delete-old", async (req) => {
    const token = str(bodyOf(req), "token", 256);
    const oldRoot = moveTokens.get(token);
    if (!oldRoot) throw new ApiError(400, "VALIDATION", "That confirmation is not valid (it is single use and expires).");
    const r = await deleteOldCopy(oldRoot, token, { deps: state.deps, ...(state.session ? { destRepo: state.session.repo } : {}), tz: state.tz });
    moveTokens.delete(token);
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

  app.post("/libraries/relink", async (req) => {
    const s = state.requireWritable();
    const searchDir = absPath(bodyOf(req), "searchDir");
    const r = await relinkMissing(s.lib, searchDir, s.repo, { keyRing: s.ring });
    return { ...r, warnings: r.warnings.map((w) => scrubPaths(w, state.roots)) };
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
    const write = stream(reply, "text/event-stream");
    write(sseFrame({ type: "library.state", data: state.libraryState() }));
    const off = state.events.subscribe((e) => void write(sseFrame(e)));
    const beat = setInterval(() => write(": keep-alive\n\n"), 25_000);
    beat.unref?.();
    const done = () => {
      off();
      clearInterval(beat);
    };
    // The response closes when the client goes away (the request's own "close" fires once it is read).
    reply.raw.on("close", done);
  });
}
