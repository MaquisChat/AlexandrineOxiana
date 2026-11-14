/**
 * Sources: search (the library index), read, edit (governed updates; collections and tags through
 * membership), delete, attach files (drag and drop), collections and tags, confirming a field's
 * value (user evidence → user-confirmed), transcript versions, recheck.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { BIBLIO_FIELDS, SourceType, evidenceSourceName, type Asset, type FieldEvidence, type Source, type SourceFile } from "@ao/core";
import {
  ASSET_TEXT_MAX_BYTES,
  addTranscriptVersion,
  confirmField,
  createAttach,
  ocrQueueFor,
  ProjectLockedError,
  proxyQueueFor,
  readTranscript,
  scrubPaths,
  search,
  transcriptVersions,
  type SourcePatch,
} from "@ao/library";
import { isReadablePdfAsset } from "@ao/shared";
import type {
  EvidenceOrigin,
  FieldConfirmRequest,
  FieldReview,
  ProjectRecheckResponse,
  RecheckProgressEvent,
  SourceRecordExtras,
  TranscriptListResponse,
  TranscriptResponse,
  TranscriptSavedResponse,
  TranscriptSaveRequest,
} from "@ao/shared";
import { ApiError, badRequest, notFound } from "../errors.js";
import { bodyAs, bodyOf, intParam, optStr, paramsOf, projectParam, queryOf, str, strArray, type Ctx, type Obj } from "./util.js";

/** Fields a PATCH may change (provenance, folder and ids never). */
const EDITABLE = new Set<string>(["type", "title", "creators", "container", "publisher", "issued", "accessed", "identifiers", "caseAttributes", "availability", ...BIBLIO_FIELDS]);

export const TRANSCRIPT_BODY_LIMIT = ASSET_TEXT_MAX_BYTES + 2 * 1024 * 1024;

const originOf = (src: FieldEvidence["source"]): EvidenceOrigin => ({
  kind: src.kind,
  label: evidenceSourceName({ source: src }),
  ...(src.provider ? { provider: src.provider } : {}),
});

/**
 * Each field's verification and evidence (Task 34a d), sorted by field: what the badges and the
 * evidence popover show, in plain words. `ref` (an internal pointer) is left out; a reason is
 * scrubbed of absolute paths like every message of the service.
 */
export function fieldReviews(sf: SourceFile, roots: Iterable<string>): FieldReview[] {
  const rs = [...roots];
  const fields = new Set([...Object.keys(sf.verification ?? {}), ...(sf.fieldEvidence ?? []).map((e) => e.field)]);
  return [...fields].sort().map((field) => {
    const v = sf.verification?.[field];
    return {
      field,
      status: v?.status ?? "none",
      checks: v?.checks ?? [],
      ...(v?.reason ? { reason: scrubPaths(v.reason, rs) } : {}),
      ...(v && v.current !== undefined ? { current: v.current } : {}),
      ...(v?.values ? { values: v.values.map((x) => ({ value: x.value, from: originOf(x.source) })) } : {}),
      evidence: (sf.fieldEvidence ?? [])
        .filter((e) => e.field === field)
        .map((e) => ({ value: e.value, from: originOf(e.source), ...(e.quote !== undefined ? { quote: e.quote } : {}), at: e.at })),
    };
  });
}

/**
 * A source record as sent to the UI: the stored record, a linked file's absolute path left out
 * (R132: only its library-relative path), and `fields` (fieldReviews).
 */
export function sourceRecord(sf: SourceFile, roots: Iterable<string>): SourceFile & SourceRecordExtras {
  return {
    ...sf,
    assets: sf.assets.map((a) => (a.linked ? ({ ...a, linked: { libraryRelativePath: a.linked.libraryRelativePath } } as typeof a) : a)),
    fields: fieldReviews(sf, roots),
  };
}

/**
 * Of `ids`, the sources with at least one pending entry in the project's review queue, of any kind
 * and whether or not it belongs to an import batch (R172, refining R137: that, and nothing else, is
 * what a library row's "Needs review" means; field verification is shown on the source screen).
 * Read from the index's `review_items`, the cache of `review/pending.jsonl` that every queued entry,
 * every decision and every undo updates; it holds only ids, kinds and statuses for encrypted projects.
 */
function waitingForReview(db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } }, projectId: string, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const rows = db
    .prepare(`SELECT DISTINCT source_id FROM review_items WHERE project_id = ? AND status = 'pending' AND source_id IN (${ids.map(() => "?").join(",")})`)
    .all(projectId, ...ids) as Array<{ source_id: string }>;
  return new Set(rows.map((r) => r.source_id));
}

/** A list row's availability (Task 69, D17): the record's status and, when recorded, when it was first noticed. */
export interface RowAvailability {
  status: string;
  firstNoticedAt?: string;
  /** Task Z5: why it is unavailable, when Zotero said so: deleted there, or in its bin. */
  zotero?: "deleted" | "bin";
}

export const rowAvailability = (src: Source): RowAvailability => {
  const a = src.availability;
  return { status: a.status, ...(a.firstNoticedAt ? { firstNoticedAt: a.firstNoticedAt } : {}), ...(a.zotero ? { zotero: a.zotero } : {}) };
};

/**
 * The availability of each listed source (Task 69, D17), read from its own record: the index does
 * not hold it. Through the light read of source.json alone (R186), which opens no annotations file
 * and cannot raise an integrity warning while annotations are being written. A locked row, or a
 * record that cannot be read, gets none (the interface then shows nothing).
 */
async function availabilityOf(repo: { getSourceRecordWithAssets(projectId: string, id: string): Promise<{ source: Source; assets: Asset[] }> }, projectId: string, rows: Array<{ id: string; locked: boolean }>): Promise<Map<string, { availability: RowAvailability; hasReadablePdf: boolean }>> {
  const out = new Map<string, { availability: RowAvailability; hasReadablePdf: boolean }>();
  await Promise.all(
    rows
      .filter((r) => !r.locked)
      .map(async (r) => {
        const rec = await repo.getSourceRecordWithAssets(projectId, r.id).catch(() => undefined);
        if (rec) out.set(r.id, { availability: rowAvailability(rec.source), hasReadablePdf: rec.assets.some(isReadablePdfAsset) });
      }),
  );
  return out;
}

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
    // While the index is rebuilt (or cannot be written), the list says so (D8).
    const index = s.indexStatus ? { index: s.indexStatus } : {};
    if (s.index) {
      const found = search(s.index.db, {
        projectId,
        ...(q.text ? { text: q.text.slice(0, 500) } : {}),
        ...(q.type ? { types: [q.type as SourceType] } : {}),
        ...(q.collection ? { collectionId: q.collection } : {}),
        ...(q.tag ? { tagIds: [q.tag] } : {}),
        limit,
        offset,
      });
      const waiting = waitingForReview(s.index.db, projectId, found.items.map((i) => i.id));
      // A locked project's queue cannot be read (review/pending.jsonl is encrypted): its rows claim
      // nothing (false, as the index stores for locked rows); they show "Locked" instead.
      const avail = await availabilityOf(s.repo, projectId, found.items);
      return {
        ...found,
        items: found.items.map((i) => {
          const a = avail.get(i.id);
          return { ...i, needsReview: !i.locked && waiting.has(i.id), ...(a ? { availability: a.availability, hasReadablePdf: a.hasReadablePdf } : {}) };
        }),
        ...index,
      };
    }
    // A read-only library has no index we may write: list from the files (titles only when unlocked).
    // Its review queue is not read here, so no row claims needsReview (Task 46b M4).
    const items = [];
    for (const id of s.repo.listSourceIds(projectId)) {
      // Only the record's own fields are needed: the light read (R186).
      const rec = await s.repo.getSourceRecordWithAssets(projectId, id).catch(() => undefined);
      if (!rec) continue;
      const src = rec.source;
      const title = src.title.variants[0]?.value ?? "";
      if (q.text && !title.toLowerCase().includes(q.text.toLowerCase())) continue;
      if (q.type && src.type !== q.type) continue;
      if (q.collection && !src.collectionIds.includes(q.collection)) continue;
      if (q.tag && !src.tagIds.includes(q.tag)) continue;
      items.push({ id, projectId, type: src.type, title, folder: src.folder, needsReview: false, locked: false, availability: rowAvailability(src), hasReadablePdf: rec.assets.some(isReadablePdfAsset) });
    }
    // `limited`: only titles were searched (no full text, no annotations); the interface says so (Task 58 M6).
    return { total: items.length, items: items.slice(offset, offset + limit), limited: true, ...index };
  });

  const record = (sf: SourceFile) => sourceRecord(sf, state.roots);

  app.get("/projects/:id/sources/:sid", async (req) => {
    const projectId = projectParam(ctx, req);
    return record(await sourceOf(ctx, projectId, paramsOf(req).sid ?? ""));
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
    return record(Object.keys(patch).length ? await s.repo.updateSource(projectId, sid, patch as SourcePatch) : await s.repo.getSource(projectId, sid));
  });

  app.delete("/projects/:id/sources/:sid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    await s.repo.deleteSource(projectId, sid);
    // R310 a: the deletion's own change resolved a file waiting for the researcher's check that was found for this
    // record (the library cannot tell the runner): the entries waiting for a place go on — the light wake, nothing in
    // flight touched; still at the limit, they go back to waiting having asked nothing.
    await s.find?.wakeHeldFull(projectId);
    return { deleted: true };
  });

  // Researcher-set value of one field, recorded as their own evidence (→ user-confirmed when it agrees).
  // `field` is a top-level field or one identifier under the verification report's key ("/identifiers/doi", R149);
  // anything else is refused by the library (InvalidInputError → 400 VALIDATION).
  app.patch("/projects/:id/sources/:sid/fields", async (req): Promise<SourceFile & SourceRecordExtras> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    const b = bodyAs<FieldConfirmRequest>(req);
    // Read through the request type before the presence check, which would otherwise let any key compile (R184).
    const value = b.value;
    if (!("value" in b)) throw badRequest('"value" is required.');
    return record(await confirmField(s.repo, projectId, sid, str(b, "field", 64), value));

  });

  app.post("/projects/:id/sources/:sid/recheck", async (req): Promise<SourceFile & SourceRecordExtras> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    return record(await s.repo.recheckSource(projectId, sid));
  });

  // Every source of the project, as a background job with progress (`job.progress`, kind "recheck").
  app.post("/projects/:id/recheck", async (req): Promise<ProjectRecheckResponse> => {
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
          state.events.publish("job.progress", { kind: "recheck", jobId, projectId, done, total, finished: false } satisfies RecheckProgressEvent);
        }
        state.events.publish("job.progress", { kind: "recheck", jobId, projectId, done, total, changed: tally.changed, failed: tally.failed, finished: true } satisfies RecheckProgressEvent);
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
  // Every stored version; a machine run has two (its WebVTT and its segments.json), both readable as segments.
  app.get("/projects/:id/sources/:sid/transcripts", async (req): Promise<TranscriptListResponse> => {
    const projectId = projectParam(ctx, req);
    const sf = await sourceOf(ctx, projectId, paramsOf(req).sid ?? "");
    return {
      versions: transcriptVersions(sf).map((a) => ({
        id: a.id,
        path: a.path,
        mime: a.mime,
        bytes: a.bytes,
        ...(a.derivation?.provider !== undefined ? { tool: a.derivation.provider } : {}),
        derivation: a.derivation,
        origin: a.derivation?.operation === "human-edit" ? "human-edit" : "machine",
        format: a.mime === "application/json" ? "json" : /\.vtt(\.enc)?$/i.test(a.path) ? "vtt" : "txt",
        ...(a.metadata?.flaggedSegments !== undefined ? { flaggedSegments: a.metadata.flaggedSegments } : {}),
      })),
    };
  });
  // One version: its stored text (as before) and its segments (start, end, language, text, flags;
  // flags null for a human edit, which no check has run on).
  app.get("/projects/:id/sources/:sid/transcripts/:aid", async (req): Promise<TranscriptResponse> => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const { sid = "", aid = "" } = paramsOf(req);
    const sf = await sourceOf(ctx, projectId, sid);
    if (!transcriptVersions(sf).some((a) => a.id === aid)) throw notFound("That transcript");
    return readTranscript(s.repo, projectId, sid, aid);
  });
  app.post("/projects/:id/sources/:sid/transcripts", { bodyLimit: TRANSCRIPT_BODY_LIMIT }, async (req): Promise<TranscriptSavedResponse> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const sid = paramsOf(req).sid ?? "";
    await sourceOf(ctx, projectId, sid);
    const b = bodyAs<TranscriptSaveRequest>(req);
    const format = str(b, "format", 8);
    if (format !== "vtt" && format !== "txt") throw badRequest('"format" must be "vtt" or "txt".');
    const basedOn = optStr(b, "basedOn", 64);
    const lang = optStr(b, "lang", 35);
    const text = str(b, "text", ASSET_TEXT_MAX_BYTES);
    const asset = await addTranscriptVersion(s.repo, projectId, sid, { text, format, ...(basedOn ? { basedOn } : {}), ...(lang ? { lang } : {}) });
    return { id: asset.id, path: asset.path, derivation: asset.derivation };
  });
}
