/**
 * Sources: search (the library index), read, edit (governed updates; collections and tags through
 * membership), delete, attach files (drag and drop), collections and tags, confirming a field's
 * value (user evidence → user-confirmed), transcript versions, recheck.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { BIBLIO_FIELDS, SourceType, type SourceFile } from "@ao/core";
import {
  ASSET_TEXT_MAX_BYTES,
  addTranscriptVersion,
  confirmField,
  createAttach,
  ocrQueueFor,
  ProjectLockedError,
  proxyQueueFor,
  readAssetText,
  search,
  transcriptVersions,
  type SourcePatch,
} from "@ao/library";
import { ApiError, badRequest, notFound } from "../errors.js";
import { bodyOf, intParam, optStr, paramsOf, projectParam, queryOf, str, strArray, type Ctx, type Obj } from "./util.js";

/** Fields a PATCH may change (provenance, folder and ids never). */
const EDITABLE = new Set<string>(["type", "title", "creators", "container", "publisher", "issued", "accessed", "identifiers", "caseAttributes", "availability", ...BIBLIO_FIELDS]);

export const TRANSCRIPT_BODY_LIMIT = ASSET_TEXT_MAX_BYTES + 2 * 1024 * 1024;

async function sourceOf(ctx: Ctx, projectId: string, sid: string): Promise<SourceFile> {
  const s = ctx.state.requireSession();
  if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
  return s.repo.getSource(projectId, sid);
}

export function registerSources(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/projects/:id/sources", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const q = queryOf(req);
    const limit = intParam(q.limit, "limit", 1, 500, 50);
    const offset = intParam(q.offset, "offset", 0, 10_000_000, 0);
    if (q.type !== undefined && !SourceType.safeParse(q.type).success) throw badRequest(`"${q.type}" is not a source type.`);
    if (s.index) {
      return search(s.index.db, {
        projectId,
        ...(q.text ? { text: q.text.slice(0, 500) } : {}),
        ...(q.type ? { types: [q.type as SourceType] } : {}),
        ...(q.collection ? { collectionId: q.collection } : {}),
        ...(q.tag ? { tagIds: [q.tag] } : {}),
        limit,
        offset,
      });
    }
    // A read-only library has no index we may write: list from the files (titles only when unlocked).
    const items = [];
    for (const id of s.repo.listSourceIds(projectId)) {
      const sf = await s.repo.getSource(projectId, id).catch(() => undefined);
      if (!sf) continue;
      const src = sf.source;
      const title = src.title.variants[0]?.value ?? "";
      if (q.text && !title.toLowerCase().includes(q.text.toLowerCase())) continue;
      if (q.type && src.type !== q.type) continue;
      if (q.collection && !src.collectionIds.includes(q.collection)) continue;
      if (q.tag && !src.tagIds.includes(q.tag)) continue;
      items.push({ id, projectId, type: src.type, title, folder: src.folder, needsReview: false, locked: false });
    }
    return { total: items.length, items: items.slice(offset, offset + limit) };
  });

  app.get("/projects/:id/sources/:sid", async (req) => {
    const projectId = projectParam(ctx, req);
    return sourceOf(ctx, projectId, paramsOf(req).sid ?? "");
  });

  app.patch("/projects/:id/sources/:sid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    const b = bodyOf(req);
    const patch: Obj = {};
    for (const [k, v] of Object.entries(b)) {
      if (!EDITABLE.has(k) && k !== "collectionIds" && k !== "tagIds") throw badRequest(`"${k}" cannot be changed here.`);
      patch[k] = v;
    }
    if (b.collectionIds !== undefined) patch.collectionIds = [...new Set(strArray(b, "collectionIds", { max: 1000, itemMax: 64, optional: true }))];
    if (b.tagIds !== undefined) patch.tagIds = [...new Set(strArray(b, "tagIds", { max: 1000, itemMax: 64, optional: true }))];
    // One governed change: fields and membership together (ids checked inside it, R99).
    return Object.keys(patch).length ? s.repo.updateSource(projectId, sid, patch as SourcePatch) : s.repo.getSource(projectId, sid);
  });

  app.delete("/projects/:id/sources/:sid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    await s.repo.deleteSource(projectId, sid);
    return { deleted: true };
  });

  // Researcher-set value of one field, recorded as their own evidence (→ user-confirmed when it agrees).
  app.patch("/projects/:id/sources/:sid/fields", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    const b = bodyOf(req);
    if (!("value" in b)) throw badRequest('"value" is required.');
    return confirmField(s.repo, projectId, sid, str(b, "field", 64), b.value);
  });

  app.post("/projects/:id/sources/:sid/recheck", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    return s.repo.recheckSource(projectId, sid);
  });

  // Every source of the project, as a background job with progress (`job.progress`, kind "recheck").
  app.post("/projects/:id/recheck", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const jobId = randomUUID();
    const ids = s.repo.listSourceIds(projectId);
    const total = ids.length;
    const tally = { changed: 0, failed: 0 };
    // In the work registry: a move stops it between sources; it continues on the moved library (R106).
    const run = (from: number) =>
      state.startWork("recheck", async (ctl) => {
        let done = from;
        for (const id of ids.slice(from)) {
          if (ctl.stopping) return () => run(done);
          const cur = state.session;
          if (!cur) return;
          try {
            const before = await cur.repo.getSource(projectId, id);
            const after = await cur.repo.recheckSource(projectId, id);
            if (after.source.modifiedAt !== before.source.modifiedAt) tally.changed++;
          } catch {
            tally.failed++;
          }
          done++;
          state.events.publish("job.progress", { kind: "recheck", jobId, projectId, done, total, finished: false });
        }
        state.events.publish("job.progress", { kind: "recheck", jobId, projectId, done, total, changed: tally.changed, failed: tally.failed, finished: true });
      });
    run(0);
    return { jobId, total };
  });

  app.post("/projects/:id/attach", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const paths = strArray(b, "paths", { max: 500 });
    const toSourceId = optStr(b, "toSourceId", 64);
    const attach = createAttach({ repo: s.repo, http: s.http, proxies: proxyQueueFor(s.repo) });
    const items = await attach.attachFiles(projectId, paths, toSourceId ? { toSourceId } : {});
    // PDFs without a text layer are offered for OCR by the import flow; attach leaves that choice to the researcher.
    return { items };
  });

  app.post("/projects/:id/sources/:sid/ocr", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    const queued = await ocrQueueFor(s.repo).enqueue(projectId, sid);
    return { queued, workerReady: ocrQueueFor(s.repo).available };
  });

  // ---- collections and tags ----
  app.get("/projects/:id/collections", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    return { collections: (await s.repo.listCollectionsAndTags(projectId)).collections };
  });
  app.post("/projects/:id/collections", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const parentId = optStr(b, "parentId", 64);
    return s.repo.createCollection(projectId, str(b, "name", 500), parentId);
  });
  app.patch("/projects/:id/collections/:cid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const cid = paramsOf(req).cid ?? "";
    const b = bodyOf(req);
    if (!("parentId" in b) && b.name === undefined) throw badRequest('Give "name" and/or "parentId" (null for the top level).');
    // Name and parent together: one governed change (R102).
    return s.repo.updateCollection(projectId, cid, {
      ...(b.name !== undefined ? { name: str(b, "name", 500) } : {}),
      ...("parentId" in b ? { parentId: b.parentId === null ? null : str(b, "parentId", 64) } : {}),
    });
  });
  app.delete("/projects/:id/collections/:cid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    await s.repo.deleteCollection(projectId, paramsOf(req).cid ?? "");
    return { deleted: true };
  });
  app.get("/projects/:id/tags", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const { tags } = await s.repo.listCollectionsAndTags(projectId);
    return { tags, workspaceTags: await s.repo.listWorkspaceTags() };
  });
  app.post("/projects/:id/tags", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const scope = optStr(b, "scope", 16) ?? "project";
    if (scope !== "project" && scope !== "workspace") throw badRequest('"scope" must be "project" or "workspace".');
    return s.repo.createTag(scope === "workspace" ? "workspace" : projectId, str(b, "name", 200), optStr(b, "color", 32));
  });

  app.patch("/projects/:id/tags/:tid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    return s.repo.renameTag(projectId, paramsOf(req).tid ?? "", str(b, "name", 200), optStr(b, "color", 32));
  });
  app.delete("/projects/:id/tags/:tid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    await s.repo.deleteTag(projectId, paramsOf(req).tid ?? "");
    return { deleted: true };
  });

  // ---- workspace tags (R118): every project records the change, so each must be able to take it ----
  const workspaceChange = async <T>(s: { repo: { listProjects(): Array<{ id: string; name: string }> } }, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProjectLockedError) {
        const name = s.repo.listProjects().find((p) => p.id === err.projectId)?.name ?? "an encrypted project";
        throw new ApiError(409, "CONFLICT", `Unlock every encrypted project first (${name} is locked): a workspace tag can be on sources in any project, so each one records the change.`);
      }
      throw err;
    }
  };
  app.patch("/workspace-tags/:tid", async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    if (b.name === undefined) throw badRequest('Give the tag\'s new "name".');
    const tid = paramsOf(req).tid ?? "";
    return workspaceChange(s, () => s.repo.renameWorkspaceTag(tid, str(b, "name", 200), optStr(b, "color", 32)));
  });
  app.delete("/workspace-tags/:tid", async (req) => {
    const s = state.requireWritable();
    const tid = paramsOf(req).tid ?? "";
    await workspaceChange(s, () => s.repo.deleteWorkspaceTag(tid));
    return { deleted: true };
  });

  // ---- transcript versions ----
  app.get("/projects/:id/sources/:sid/transcripts", async (req) => {
    const projectId = projectParam(ctx, req);
    const sf = await sourceOf(ctx, projectId, paramsOf(req).sid ?? "");
    return {
      versions: transcriptVersions(sf).map((a) => ({ id: a.id, path: a.path, mime: a.mime, bytes: a.bytes, tool: a.derivation?.provider, derivation: a.derivation })),
    };
  });
  app.get("/projects/:id/sources/:sid/transcripts/:aid", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const { sid = "", aid = "" } = paramsOf(req);
    const sf = await sourceOf(ctx, projectId, sid);
    if (!transcriptVersions(sf).some((a) => a.id === aid)) throw notFound("That transcript");
    return { id: aid, text: await readAssetText(s.repo, projectId, sid, aid) };
  });
  app.post("/projects/:id/sources/:sid/transcripts", { bodyLimit: TRANSCRIPT_BODY_LIMIT }, async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    const b = bodyOf(req);
    const format = str(b, "format", 8);
    if (format !== "vtt" && format !== "txt") throw badRequest('"format" must be "vtt" or "txt".');
    const basedOn = optStr(b, "basedOn", 64);
    const lang = optStr(b, "lang", 35);
    const asset = await addTranscriptVersion(s.repo, projectId, sid, { text: str(b, "text", ASSET_TEXT_MAX_BYTES), format, ...(basedOn ? { basedOn } : {}), ...(lang ? { lang } : {}) });
    return { id: asset.id, path: asset.path, derivation: asset.derivation };
  });
}
