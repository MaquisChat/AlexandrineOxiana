/**
 * Bulk Import (spec 5.4): dry run, start (progress as `import.progress` events), pause / resume /
 * cancel / undo, report, review list; device import (spec 5.3). Watched folders: routes/watched-folders.ts
 * (Task W7: a folder only by grant, never a path from the page). Adapters are the
 * library's own (`adapterFor`), chosen by `adapter.kind`.
 */
import type { FastifyInstance } from "fastify";
import type { ImportOptionsInput } from "@ao/core";
import {
  adapterFor,
  ZoteroSyncFileBusyError,
  pauseLink,
  researcherName,
  researcherNameOk,
  resumeZoteroWebImport,
  startZoteroWebImport,
  zoteroWebAdapter,
  zoteroWebSince,
  proxyQueueFor,
  type ImportSourceAdapter,
} from "@ao/library";
import { ZOTERO_SYNC_SENTENCES, type ZoteroSyncUndoNote } from "@ao/shared";
import { ApiError, badRequest, notFound } from "../errors.js";
import type { ServiceState } from "../state.js";
import { registerZotero } from "./zotero.js";
import { bodyOf, optBool, optObj, optStr, paramsOf, projectParam, str, strArray, type Ctx, type Obj } from "./util.js";

const PATH_KINDS = new Set(["folder", "zip", "bibtex", "ris", "csl-json", "zotero-rdf", "calibre", "zotero-local"]);
const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

type AdapterSpec = { web: false; adapter: ImportSourceAdapter } | { web: true; libraryType: "user" | "group"; libraryId: string; full: boolean };

function adapterSpec(o: Obj | undefined): AdapterSpec {
  if (!o) throw badRequest('"adapter" is required, e.g. { "kind": "folder", "path": "/…" }.');
  const kind = str(o, "kind", 32);
  if (kind === "zotero-web") {
    const libraryType = str(o, "libraryType", 8);
    if (libraryType !== "user" && libraryType !== "group") throw badRequest('"libraryType" must be "user" or "group".');
    const given = str(o, "libraryId", 12);
    if (!/^\d{1,12}$/.test(given)) throw badRequest('"libraryId" must be a number.');
    // Canonical before anything uses it (R250 a): "042" is library 42.
    const libraryId = String(Number(given));
    if (libraryId === "0") throw badRequest('"libraryId" must be a number.');
    return { web: true, libraryType, libraryId, full: optBool(o, "full") === true };
  }
  if (!PATH_KINDS.has(kind)) throw badRequest(`"${kind}" is not an import source. Use one of: ${[...PATH_KINDS, "zotero-web"].join(", ")}.`);
  const path = str(o, kind === "zotero-local" ? "dataDir" : "path", 4096);
  if (!isAbsolute(path)) throw badRequest("The import path must be absolute.");
  const adapter = adapterFor(kind as Parameters<typeof adapterFor>[0], path);
  if (!adapter) throw badRequest(`"${kind}" is not an import source.`);
  return { web: false, adapter };
}

function approvals(o: Obj | undefined): { folders?: string[]; files?: string[] } {
  if (!o) return {};
  return { folders: strArray(o, "folders", { optional: true, max: 100 }), files: strArray(o, "files", { optional: true, max: 1000 }) };
}

/** The project a batch belongs to: one this service runs, else found among the projects' batches. */
export async function batchProject(state: ServiceState, batchId: string): Promise<string> {
  const s = state.requireSession();
  const running = s.batches.get(batchId);
  if (running) return running.projectId;
  if (s.bulk) {
    for (const p of s.repo.listProjects()) {
      if (!s.repo.isUnlocked(p.id)) continue;
      const list = await s.bulk.listBatches(p.id).catch(() => []);
      if (list.some((b) => b.batchId === batchId)) return p.id;
    }
  }
  throw notFound("That import");
}

export function registerImport(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  /** Claims a Zotero library for a manual import (R250 a), or refuses with the existing sentence. */
  const claimed = (s: Parameters<ServiceState["zoteroSync"]["claim"]>[1], ref: string) => {
    const release = state.zoteroSync.claim(ref, s);
    if (!release) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.importRunning);
    return release;
  };
  // Before an import: the Zotero Web key and where the Zotero data folder is (Task 57).
  registerZotero(app, ctx);

  app.post("/projects/:id/import/dry-run", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const spec = adapterSpec(optObj(b, "adapter"));
    const approveOutside = approvals(optObj(b, "approveOutside"));
    if (spec.web) {
      const since = spec.full ? undefined : zoteroWebSince(s.repo, projectId, `${spec.libraryType}:${spec.libraryId}`);
      return s.bulk.dryRun(projectId, zoteroWebAdapter({ libraryType: spec.libraryType, libraryId: spec.libraryId, ...(since !== undefined ? { since } : {}) }), { approveOutside });
    }
    return s.bulk.dryRun(projectId, spec.adapter, { approveOutside });
  });

  app.post("/projects/:id/import", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const spec = adapterSpec(optObj(b, "adapter"));
    const options = (optObj(b, "options") ?? {}) as ImportOptionsInput;
    // One Zotero library is read by one import or sync at a time, whatever the project (A10, R250 a): claimed before
    // anything is awaited, given up when the batch ends (or at once when it cannot start).
    const release = spec.web ? claimed(s, `${spec.libraryType}:${spec.libraryId}`) : undefined;
    let h: Awaited<ReturnType<typeof startZoteroWebImport>>;
    try {
      h = spec.web
        ? await startZoteroWebImport({ repo: s.repo, http: s.http, index: s.index, proxies: proxyQueueFor(s.repo) }, projectId, { libraryType: spec.libraryType, libraryId: spec.libraryId, ...(spec.full ? { full: true } : {}) }, options)
        : await s.bulk.startBatch(projectId, spec.adapter, options);
    } catch (err) {
      release?.();
      throw err;
    }
    if (release) void h.done.then(release, release);
    state.followBatch(s, projectId, h);
    return { batchId: h.batchId };
  });

  app.get("/projects/:id/imports", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    return { batches: await s.bulk.listBatches(projectId) };
  });

  // A running batch is paused, resumed or cancelled in place; one that is not running (cancelled,
  // paused, failed or interrupted) is resumed from its record; a finished one cannot be (R99 I3).
  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/imports/:batchId/${action}`, async (req) => {
      const s = state.requireWritable();
      const batchId = paramsOf(req).batchId ?? "";
      const projectId = await batchProject(state, batchId);
      const running = s.batches.get(batchId);
      // A sync's batch is the sync's to pause and resume (R250 k).
      if (action !== "cancel" && state.zoteroSync.ownsBatch(batchId)) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.belongsToSync);
      if (running) {
        running.handle[action]();
        return { batchId, action };
      }
      const listed = (await s.bulk.listBatches(projectId)).find((b) => b.batchId === batchId);
      const shown = listed?.state;
      if (action !== "cancel" && listed?.origin === "zotero-sync") throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.belongsToSync);
      if (action !== "resume") throw new ApiError(409, "CONFLICT", "This import is not running.", shown);
      if (shown === "finished" || shown === "undone") throw new ApiError(409, "CONFLICT", "This import has already finished.", shown);
      // Not while an import or sync of the same Zotero library runs (R250 a): claimed in this same step.
      const release = listed?.ref ? claimed(s, listed.ref) : undefined;
      // A Zotero Web batch resumes with the version it started from and records the new one when done (Z2).
      let h: Awaited<ReturnType<typeof resumeZoteroWebImport>>;
      try {
        h =
          listed?.kind === "zotero-web"
            ? await resumeZoteroWebImport({ repo: s.repo, http: s.http, index: s.index, proxies: proxyQueueFor(s.repo) }, projectId, batchId)
            : await s.bulk.resumeBatch(projectId, batchId);
      } catch (err) {
        release?.();
        throw err;
      }
      if (release) void h.done.then(release, release);
      state.followBatch(s, projectId, h);
      return { batchId, action };
    });
  }

  app.post("/imports/:batchId/undo", async (req) => {
    const s = state.requireWritable();
    const batchId = paramsOf(req).batchId ?? "";
    const projectId = await batchProject(state, batchId);
    // The batch says itself whether it is the sync's, and of which Zotero library (its own record, R248).
    const listed = (await s.bulk.listBatches(projectId)).find((b) => b.batchId === batchId);
    const r = await s.bulk.undoBatch(projectId, batchId);
    s.batches.delete(batchId);
    state.publishState();
    // An undo of a sync's batch pauses its link in the same request, so the next sync does not at once bring back what
    // was undone (R206 4, R242 b).
    const run = listed?.origin === "zotero-sync" && listed.ref ? { ref: listed.ref } : undefined;
    if (!run) return r;
    let note: ZoteroSyncUndoNote | undefined;
    try {
      // Said only when a link was in fact paused (R250 d): none when the Zotero library is no longer linked.
      if ((await pauseLink(state.deps.appConfigDir, s.lib.id, run.ref, "undone")) > 0) note = { paused: true, message: ZOTERO_SYNC_SENTENCES.undonePaused };
    } catch (err) {
      // R306 b: another program held the settings' lock: why it was not paused is said too, in the lock's sentence.
      note = { paused: false, message: err instanceof ZoteroSyncFileBusyError ? `${ZOTERO_SYNC_SENTENCES.undoNotPaused} ${err.message}` : ZOTERO_SYNC_SENTENCES.undoNotPaused };
    }
    return note ? { ...r, zoteroSync: note } : r;
  });

  app.get("/imports/:batchId/report", async (req) => {
    const s = state.requireWritable();
    const batchId = paramsOf(req).batchId ?? "";
    return s.bulk.batchReport(await batchProject(state, batchId), batchId);
  });

  app.get("/imports/:batchId/review", async (req) => {
    const s = state.requireWritable();
    const batchId = paramsOf(req).batchId ?? "";
    return { items: await s.bulk.listReview(await batchProject(state, batchId), batchId) };
  });

  app.post("/projects/:id/device-import", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const dir = str(b, "dir", 4096);
    if (!isAbsolute(dir)) throw badRequest('"dir" must be an absolute path.');
    const sessionId = optStr(b, "sessionId", 64);
    const participantIds = strArray(b, "participantIds", { optional: true, max: 1000, itemMax: 64 });
    const options = (optObj(b, "options") ?? {}) as ImportOptionsInput & { researcherName?: string };
    // The photographer: the name given for this import, else this device's researcher name (R84/R117).
    const given = typeof options.researcherName === "string" ? options.researcherName.trim() : "";
    // Checked like the device setting before it becomes the photographer in provenance (41a M6).
    if (given !== "" && !researcherNameOk(given)) throw badRequest('"researcherName" must be 1 to 200 characters, with no control, format or line-separator characters.');
    const researcher = given || (await researcherName(state.deps.appConfigDir));
    const { researcherName: _given, ...rest } = options;
    const h = await s.bulk.importDeviceFolder(projectId, dir, {
      ...rest,
      ...(researcher ? { researcherName: researcher } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(participantIds.length ? { participantIds } : {}),
    });
    state.followBatch(s, projectId, h);
    return { batchId: h.batchId };
  });
}
