/** Sources: create (capture + store), read, update, delete; source.json / source.json.enc and manifest.json. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  LibraryRelativePath,
  LinkedRelativePath,
  Provenance,
  Source,
  SourceDraft,
  SourceFile,
  encName,
  newId,
  originalFileName,
  primary,
  pseudonymize,
  shortId,
  sourceFolderName,
  withCollisionSuffix,
  Annotation,
  type Asset,
  type Availability,
  type FieldEvidence,
  type FieldVerification,
  type PendingProxy,
} from "@ao/core";
import { GovernanceViolationError, ImmutableProvenanceError, NotFoundError } from "./errors.js";
import { decryptBytes, deepEqual, foldName, kindFor, mimeFor, namesIn, readMaybe } from "./io.js";
import { runMutation, type RefuseHook, type MutateRequest, type Tx } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import { assignableWorkspaceTags, refuseUnknownTags } from "./collections.js";
import { assignCodes, loadPseudonyms, participantNames, savePseudonyms } from "./pseudonyms.js";
import { flagIfWithdrawn } from "./withdrawn.js";
import { appendReviewEntry, queueUnlistedConflicts, resolveCaptureEntriesAfterEdit, resolveEntriesOfRemovedSource, resolveSettledCaptureEntries, type QueuedConflicts, type ReexaminedBy, type ReviewInput } from "./review.js";
import { recordDeletion } from "./tombstones.js";
import type { Manifest, ManifestEntry, ProjectState, RepoCore } from "./state.js";
import { isClosed } from "../library.js";
import { SOURCE_CHANGE_UNFINISHED, SOURCE_CHANGE_UNFINISHED_READ_ONLY } from "@ao/shared";


export interface SourceInputFile {
  path: string;
  role: "original";
  handling: "copy" | "link";
  /** Asset kind (default: from the extension), e.g. "platform-metadata" or "thumbnail". */
  kind?: string;
  /** The file is already in this project's encrypted format (e.g. a media worker output). Copy only. */
  encrypted?: boolean;
  /** Stored file extension, e.g. from the sniffed type (default: the path's extension). */
  ext?: string;
  /** MIME type, e.g. the sniffed one (default: from the extension). */
  mime?: string;
  metadata?: Asset["metadata"];
  /** Copy without following a symbolic link at `path` (Bulk Import passes checked real paths, R70). */
  noFollow?: boolean;
}

export interface CreateSourceOptions {
  provenance: Provenance;
  fieldEvidence?: FieldEvidence[];
  verification?: Record<string, FieldVerification>;
  availability?: Availability;
  /** A file being stored carries location data (e.g. GPS in a photo): location governance applies (R54a). */
  hasLocation?: boolean;
  /** Also queue the new source for review (written to `review/pending.jsonl` in the same change, R31). */
  reviewItem?: Omit<ReviewInput, "sourceId">;
  /**
   * Package-internal (Bulk Import, R72): annotations stored with the new source (in source.json,
   * sealed in encrypted projects), given its id, its stored assets (in the order of `files`) and the
   * actor (the author of annotations whose source names none).
   */
  annotations?: (sourceId: string, assets: Asset[], actor: string) => Annotation[];
  /**
   * Package-internal: when the citation key is generated (the draft has none), this turns it into
   * one not yet used in the project (e.g. by appending a, b, c …).
   */
  uniqueCitationKey?: (generated: string) => string;
  /**
   * Package-internal (device import, R83): pairs of `files` indexes stored as one Live Photo (the
   * still and the video): each asset's `metadata.pairedAssetId` names the other.
   */
  pairedFiles?: Array<[number, number]>;
  /**
   * Package-internal (R83): viewing proxies to queue for the stored originals, given those assets
   * (in the order of `files`); written to source.json in the same change (R31).
   */
  pendingProxies?: (assets: Asset[]) => PendingProxy[];
}

export type SourcePatch = Partial<Omit<Source, "id">>;

/** Package-internal: more writes in the same change, after the new source is written (e.g. an import journal line). */
export type CreateInTx = (tx: Tx, sf: SourceFile) => Promise<void>;

/** Types whose folder name starts with the full date rather than the year (spec 4.1 examples). */
const FULL_DATE_TYPES = new Set([
  "social-post", "video", "audio", "image", "webpage", "field-photo", "field-video", "field-recording", "interview",
]);

export const UNENCRYPTED_IDENTIFIABLE_MODE = 0o600;

/** POSIX mode for an unencrypted file belonging to an identifiable source (R19). */
export function fileMode(core: RepoCore, st: ProjectState, identifiable: boolean): number | undefined {
  return identifiable && !core.encrypted(st) ? UNENCRYPTED_IDENTIFIABLE_MODE : undefined;
}

/** The store request for writing data that belongs to a source. */
export function storeRequest(p: Provenance, hasLocation = false): MutateRequest {
  return {
    action: "store",
    store: { identifiable: p.identifiable, hasLocation, ...(p.legal.basis ? { legalBasis: p.legal.basis } : {}) },
  };
}

export function sourceFolderOf(st: ProjectState, id: string): string {
  const folder = st.sources.get(id);
  if (!folder) throw new NotFoundError("Source", id);
  return folder;
}

/**
 * Provenance never changes after creation (R76), by any route: every write of a source file comes
 * through writeSourceFile, which compares the provenance with the one stored (as it is now, within
 * this change too) and refuses a difference with ImmutableProvenanceError. A new source has none
 * stored yet.
 */
async function assertProvenanceUnchanged(core: RepoCore, tx: Tx, sf: SourceFile): Promise<void> {
  const folder = sf.source.folder;
  const raw = await readMaybe(core.abs(tx.encrypted ? `${folder}/source.json.enc` : `${folder}/source.json`));
  if (!raw) return;
  let text: string;
  if (tx.encrypted) {
    const { key, keyId } = tx.key();
    text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
  } else text = raw.toString("utf8");
  const stored = SourceFile.parse(JSON.parse(text));
  if (stored.source.id !== sf.source.id) throw new TypeError("source folder belongs to another source");
  if (!deepEqual(stored.source.provenance, sf.source.provenance)) throw new ImmutableProvenanceError();
}

/** The annotations file of a source folder (R74 I4). */
const annotationsRel = (folder: string, encrypted: boolean) => `${folder}/${encrypted ? "annotations.json.enc" : "annotations.json"}`;

/** An annotation-file problem a read found, to be recorded once confirmed (R77). */
type AnnotationProblem = { file: string; kind: "annotations-unreadable" | "annotations-hash-mismatch"; detail: string };

export async function readSourceFile(core: RepoCore, st: ProjectState, id: string): Promise<SourceFile> {
  const read = await readSourcePair(core, st, id);
  // A source whose change did not finish and could not be undone (its folder named by a pending marker) is read as
  // it is, with the true thing said, never as changed outside the app; nothing there to confirm (R473 I1).
  if (unfinishedHere(core, st, sourceFolderOf(st, id))) return read.sf;
  if (!read.problem) return read.sf;
  // Inside a turn no write is in progress: the problem is recorded as found.
  if (core.holdsTurn()) {
    recordProblem(core, st, read.problem);
    return read.sf;
  }
  // A read outside the write queue can fall between the two files a write updates (the annotations
  // file, then source.json): a problem is confirmed in the queue's turn, after any write in progress,
  // and recorded only if it is still there (D21). The read waits for that turn at most CONFIRM_WAIT_MS
  // (FR-423, R469 c): a long write (a restore) holds the queue for its whole length. If the turn has
  // not come by then, the read answers without the warning (nothing unconfirmed is reported) and the
  // confirmation goes on in the queue, recording the warning when its turn comes.
  const confirmed = await withinConfirmWait(confirmProblem(core, st, id));
  return confirmed === undefined ? read.sf : confirmed.sf;
}

/** How long a read waits for the write queue's turn to confirm a problem it found (FR-423, R469 c). */
export const CONFIRM_WAIT_MS = 2_000;

/** Test seam (R47): `onRun` is called when a confirmation runs in its turn, only while NODE_ENV is "test". */
export const confirmationSeams: { onRun?: (sourceId: string) => void } = {};

/** The confirmations waiting for their turn, per repository, by project and source: one per source at a time. */
const confirmations = new WeakMap<RepoCore, Map<string, Promise<{ sf: SourceFile; problem?: AnnotationProblem } | undefined>>>();

/**
 * One confirmation of a source's annotation problem, in the write queue's turn: the pair read again there, and a
 * problem still there recorded there. It ends, recording nothing, when by its turn the library was closed (as a
 * move closes it), the project is no longer this one, or a lock was asked since it was made (the key may be gone:
 * reading then refuses, which also records nothing). A refusal reaches the readers still waiting for it, as before;
 * with none waiting it ends as `undefined`, and the confirmation always has a handler: never an unhandled rejection.
 */
function confirmProblem(core: RepoCore, st: ProjectState, id: string): Promise<{ sf: SourceFile; problem?: AnnotationProblem } | undefined> {
  let mine = confirmations.get(core);
  if (!mine) confirmations.set(core, (mine = new Map()));
  const key = `${st.project.id}\0${id}`;
  const waiting = mine.get(key);
  if (waiting) return waiting;
  const asks = core.lockAsks.get(st.project.id) ?? 0;
  const run = core
    .serial(async () => {
      if (confirmationSeams.onRun && process.env.NODE_ENV === "test") confirmationSeams.onRun(id);
      if (isClosed(core.library) || core.projects.get(st.project.id) !== st || (core.lockAsks.get(st.project.id) ?? 0) !== asks) return undefined;
      const again = await readSourcePair(core, st, id);
      if (!unfinishedHere(core, st, sourceFolderOf(st, id)) && again.problem) recordProblem(core, st, again.problem);
      return again;
    })
    .catch((err: unknown) => {
      // A lock (the key gone), or the source deleted meanwhile: nothing to record. A refusal while a reader still
      // waits reaches that reader, as before.
      if (waitingReaders.get(run) ?? 0) throw err;
      return undefined;
    })
    .finally(() => mine.delete(key));
  run.catch(() => {});
  mine.set(key, run);
  return run;
}

/** Readers still waiting for a confirmation (within their bound). */
const waitingReaders = new WeakMap<Promise<unknown>, number>();

/** The confirmation's outcome, or `undefined` when it has not come within CONFIRM_WAIT_MS. */
async function withinConfirmWait<T>(p: Promise<T>): Promise<T | undefined> {
  waitingReaders.set(p, (waitingReaders.get(p) ?? 0) + 1);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), CONFIRM_WAIT_MS)))]);
  } finally {
    clearTimeout(timer);
    waitingReaders.set(p, (waitingReaders.get(p) ?? 1) - 1);
  }
}

/** Records a confirmed problem of a source no pending marker names (those are said by `unfinishedHere`). */
function recordProblem(core: RepoCore, st: ProjectState, problem: AnnotationProblem): void {
  annotationWarning(core, st, problem.file, problem.kind, problem.detail);
}

/**
 * R473 I1 (replacing FR-425's project-wide silence): whether a marker of this project that is not finished or rolled
 * back yet names a path in this source folder. Those files may be the change's own leftovers, so they are not called
 * changed outside the app; instead the true thing is said, once per source, for as long as the roll-back waits: it
 * is done at the next open for changes (R26), which also records a file someone changed meanwhile. Every other
 * source of the project keeps its outside-change warning.
 */
function unfinishedHere(core: RepoCore, st: ProjectState, folder: string): boolean {
  if (![...(st.unfinished ?? [])].some((p) => p === folder || p.startsWith(`${folder}/`))) return false;
  const readOnly = core.library.mode !== "read-write" || core.noHeal;
  const kind = readOnly ? "source-change-unfinished-read-only" : "source-change-unfinished";
  if (!core.integrityWarnings.some((w) => w.kind === kind && w.file === folder)) {
    core.integrityWarnings.push({ projectId: st.project.id, kind, detail: readOnly ? SOURCE_CHANGE_UNFINISHED_READ_ONLY : SOURCE_CHANGE_UNFINISHED, file: folder });
  }
  return true;
}

/** Reads source.json and its annotations file; a problem with the pair is returned, not recorded. */
async function readSourcePair(core: RepoCore, st: ProjectState, id: string): Promise<{ sf: SourceFile; problem?: AnnotationProblem }> {
  const folder = sourceFolderOf(st, id);
  const encrypted = core.encrypted(st);
  const read = async (rel: string): Promise<string | null> => {
    const raw = await readMaybe(core.abs(rel));
    if (!raw) return null;
    if (!encrypted) return raw.toString("utf8");
    const { key, keyId } = core.key(st);
    return (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
  };
  const text = await read(encrypted ? `${folder}/source.json.enc` : `${folder}/source.json`);
  if (text === null) throw new NotFoundError("Source", id);
  const sf = SourceFile.parse(JSON.parse(text));
  // Annotations in their own file; a source.json from before keeps them inline (moved on its next
  // write). A missing or damaged file never makes the source unreadable (R77): no annotations,
  // and an integrity warning; a file whose hash differs from the recorded one is read, with a warning.
  let problem: AnnotationProblem | undefined;
  if (!sf.annotations.length && sf.annotationCount) {
    const rel = annotationsRel(folder, encrypted);
    let anns: string | null = null;
    try {
      anns = await read(rel);
      if (anns === null) throw new Error("missing");
      sf.annotations = Annotation.array().parse(JSON.parse(anns));
      if (sf.annotationsSha256 && createHash("sha256").update(anns).digest("hex") !== sf.annotationsSha256) {
        problem = { file: rel, kind: "annotations-hash-mismatch", detail: "The annotations file of a source was changed outside the app; it was read as it is." };
      }
    } catch {
      sf.annotations = [];
      problem = { file: rel, kind: "annotations-unreadable", detail: "The annotations file of a source is missing or damaged; the source is shown without annotations." };
    }
  }
  return problem ? { sf, problem } : { sf };
}

/** Records an annotation-file integrity warning once per file (R77). */
function annotationWarning(core: RepoCore, st: ProjectState, file: string, kind: "annotations-unreadable" | "annotations-hash-mismatch", detail: string): void {
  if (core.integrityWarnings.some((w) => w.kind === kind && w.file === file)) return;
  core.integrityWarnings.push({ projectId: st.project.id, kind, detail, file });
}

/** The annotations file as it is on disk now: missing, unreadable (cannot be decrypted or parsed), or its hash. */
async function annotationsOnDisk(core: RepoCore, tx: Tx, rel: string): Promise<{ status: "missing" | "unreadable" } | { status: "ok"; sha: string }> {
  const raw = await readMaybe(core.abs(rel));
  if (!raw) return { status: "missing" };
  try {
    let text: string;
    if (tx.encrypted) {
      const { key, keyId } = tx.key();
      text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
    } else text = raw.toString("utf8");
    Annotation.array().parse(JSON.parse(text));
    return { status: "ok", sha: createHash("sha256").update(text).digest("hex") };
  } catch {
    return { status: "unreadable" };
  }
}

/** Manifest edits made earlier in the same transaction (state is only updated on commit). */
const pendingManifest = new WeakMap<Tx, Manifest>();

async function putManifest(tx: Tx, edit: (m: Manifest) => void): Promise<void> {
  const st = tx.state;
  const next = structuredClone(pendingManifest.get(tx) ?? st.manifest);
  const before = JSON.stringify(next);
  edit(next);
  if (JSON.stringify(next) === before) return;
  pendingManifest.set(tx, next);
  await tx.writeFile(`${st.rel}/manifest.json`, JSON.stringify(next, null, 2));
  tx.onCommit(() => {
    st.manifest = next;
  });
}

function manifestEntry(sf: SourceFile): ManifestEntry {
  const e: ManifestEntry = { id: sf.source.id, type: sf.source.type, folder: sf.source.folder, files: sf.assets.filter((a) => a.status !== "destroyed").map((a) => a.path) };
  if (sf.source.issued) e.issuedYear = sf.source.issued.slice(0, 4);
  return e;
}

/** Test seam (R47): runs between a source's annotations file and its source.json being written. */
let betweenSourceFiles: ((folder: string) => Promise<void>) | undefined;

/**
 * Test seam (R47): `fn` runs in every source write after the annotations file is written (or
 * removed) and before source.json is, only while NODE_ENV is "test"; `undefined` removes it.
 */
export function pauseBetweenSourceFilesForTests(fn: ((folder: string) => Promise<void>) | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("pauseBetweenSourceFilesForTests is only available in tests (NODE_ENV=test).");
  betweenSourceFiles = fn;
}

/**
 * Writes source.json, or source.json.enc plus the manifest entry in encrypted projects. The
 * annotations go to annotations.json(.enc) — only when they changed since they were read (their
 * hash), so an edit of the source's fields never rewrites thousands of annotations (R74 I4);
 * source.json keeps their count and hash.
 */
export async function writeSourceFile(core: RepoCore, tx: Tx, sf: SourceFile): Promise<void> {
  const full = SourceFile.parse(sf);
  const folder = full.source.folder;
  await assertProvenanceUnchanged(core, tx, full);
  const annRel = annotationsRel(folder, tx.encrypted);
  const { annotationCount: _c, annotationsSha256: _s, ...rest } = full;
  let meta: { annotationCount?: number; annotationsSha256?: string } = {};
  // Compared with the file as it is on disk now, never with a hash the caller brought (R77).
  let disk = await annotationsOnDisk(core, tx, annRel);
  if (disk.status === "unreadable") {
    // A damaged file is set aside, not overwritten or deleted: it may still be recoverable.
    const stamp = tx.at.replace(/[:.]/gu, "-");
    await tx.copyFile(core.abs(annRel), `${folder}/annotations.unreadable-${stamp}.json${tx.encrypted ? ".enc" : ""}`, { mode: 0o600 });
    await tx.trash(annRel);
    disk = { status: "missing" };
  }
  if (full.annotations.length) {
    const annJson = JSON.stringify(full.annotations);
    const sha = createHash("sha256").update(annJson).digest("hex");
    if (disk.status !== "ok" || disk.sha !== sha) {
      await tx.writeFile(annRel, annJson, tx.encrypted ? { encrypt: true } : { mode: fileMode(core, tx.state, full.source.provenance.identifiable) });
    }
    meta = { annotationCount: full.annotations.length, annotationsSha256: sha };
  } else if (disk.status === "ok") {
    await tx.trash(annRel);
  }
  if (betweenSourceFiles && process.env.NODE_ENV === "test") await betweenSourceFiles(folder);
  const parsed: SourceFile = { ...rest, annotations: [], ...meta };
  const json = JSON.stringify(parsed, null, 2);
  if (core.encrypted(tx.state)) {
    await tx.writeFile(`${folder}/source.json.enc`, json, { encrypt: true });
    await putManifest(tx, (m) => {
      const i = m.sources.findIndex((x) => x.id === parsed.source.id);
      if (i >= 0) m.sources[i] = manifestEntry(parsed);
      else m.sources.push(manifestEntry(parsed));
    });
  } else {
    await tx.writeFile(`${folder}/source.json`, json, { mode: fileMode(core, tx.state, parsed.source.provenance.identifiable) });
  }
}

function folderDate(d: SourceDraft, p: Provenance): string {
  if (!d.issued) return p.capturedAt.slice(0, 10);
  return FULL_DATE_TYPES.has(d.type) ? d.issued : d.issued.slice(0, 4);
}

function shortTitle(d: SourceDraft): string {
  const t = primary(d.title).trim();
  const head = t.split(/:\s/)[0]?.trim();
  return head || t || "Untitled";
}

function creatorName(d: SourceDraft): string | undefined {
  const c = d.creators[0];
  return c ? c.family?.trim() || c.literal?.trim() || c.handle?.trim() || c.given?.trim() : undefined;
}

function citationKeyFor(name: string | undefined, d: SourceDraft): string {
  const clean = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const word = primary(d.title)
    .split(/\s+/)
    .map(clean)
    .find((w) => w && !["a", "an", "the"].includes(w));
  return `${clean(name ?? "") || "anon"}${d.issued?.slice(0, 4) ?? ""}${word ?? ""}`;
}

/** Per project's source map: the short ids its folder names use (kept current as sources are created). */
const shortIdCache = new WeakMap<Map<string, string>, Set<string>>();

/** Short ids already used by folder names in the project (`[xxxx]` suffix). */
function takenShortIds(st: ProjectState): Set<string> {
  let out = shortIdCache.get(st.sources);
  if (!out) {
    out = new Set<string>();
    for (const f of st.sources.values()) {
      const m = /\[([0-9a-z]+)\](?: \(\d+\))?$/.exec(f);
      if (m) out.add(m[1]!);
    }
    shortIdCache.set(st.sources, out);
  }
  return out;
}

/** Folded names in a folder, re-read only when the folder changed since (its mtime) — `Sources/` grows with every source. */
const namesCache = new Map<string, { mtimeMs: number; names: Set<string> }>();

async function folderNames(dir: string): Promise<Set<string>> {
  const st = await fsp.stat(dir).catch(() => null);
  if (!st) return new Set();
  const c = namesCache.get(dir);
  if (c && c.mtimeMs === st.mtimeMs) return c.names;
  const names = await namesIn(dir);
  namesCache.set(dir, { mtimeMs: st.mtimeMs, names });
  return names;
}

/** Records a folder this process just created in `dir`, keeping the cached listing current. */
async function noteFolder(dir: string, name: string): Promise<void> {
  const c = namesCache.get(dir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!c || !st) return;
  c.names.add(foldName(name));
  c.mtimeMs = st.mtimeMs;
}

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.digest("hex"), bytes };
}

/** The policy requests creating a source evaluates: its capture method (unless pre-authorized) and `store`. */
function createRequests(draft: SourceDraft, provenance: Provenance, opts: CreateSourceOptions, captureAuthorized: boolean): MutateRequest[] {
  return [
    ...(captureAuthorized
      ? []
      : [{ action: "capture" as const, capture: { method: provenance.captureMethod, ...(draft.identifiers.platform ? { platform: draft.identifiers.platform } : {}) } }]),
    storeRequest(provenance, opts.hasLocation === true),
  ];
}

export async function createSource(
  core: RepoCore,
  projectId: string,
  draftIn: SourceDraft,
  files: SourceInputFile[],
  opts: CreateSourceOptions,
  /** Package-internal: the caller already evaluated and audited this capture (link capture), so only `store` is evaluated here. */
  internal: { captureAuthorized?: boolean; refuse?: RefuseHook; inTx?: CreateInTx } = {},
): Promise<SourceFile> {
  core.assertWritable();
  const draft = SourceDraft.parse(draftIn);
  const provenance = Provenance.parse(opts.provenance);
  return runMutation(
    core,
    projectId,
    createRequests(draft, provenance, opts, internal.captureAuthorized === true),
    (tx) => writeNewSource(core, tx, projectId, draft, provenance, files, opts, internal.inTx),
    { op: "source.create", ...(internal.refuse ? { refuse: internal.refuse } : {}) },
  );
}

export interface NewSourceInput {
  draft: SourceDraft;
  files: SourceInputFile[];
  opts: CreateSourceOptions;
  inTx?: CreateInTx;
}

/**
 * Package-internal (Bulk Import): creates several sources in ONE governed change. Every source's
 * capture and store requests are evaluated (right before anything is written, R42) and each allow
 * is audited as an event about its own source; a deny of any of them stores none and is NOT
 * audited here: the caller must then create them one by one (each refusal audited once there). Each source is written exactly as `createSource` writes it.
 */
export async function createSources(core: RepoCore, projectId: string, items: NewSourceInput[], refuse?: RefuseHook): Promise<SourceFile[]> {
  core.assertWritable();
  const parsed = items.map((it) => ({ ...it, draft: SourceDraft.parse(it.draft), provenance: Provenance.parse(it.opts.provenance) }));
  const reqs: MutateRequest[] = [];
  const owner: number[] = [];
  parsed.forEach((it, i) => {
    for (const r of createRequests(it.draft, it.provenance, it.opts, false)) {
      reqs.push(r);
      owner.push(i);
    }
  });
  const ids: string[] = [];
  return runMutation(
    core,
    projectId,
    reqs,
    async (tx) => {
      const out: SourceFile[] = [];
      for (const it of parsed) {
        const sf = await writeNewSource(core, tx, projectId, it.draft, it.provenance, it.files, it.opts, it.inTx);
        ids.push(sf.source.id);
        out.push(sf);
      }
      return out;
    },
    {
      op: "source.create",
      ...(refuse ? { refuse } : {}),
      entityFor: (i) => (ids[owner[i]!] ? { type: "source" as const, id: ids[owner[i]!]! } : undefined),
      // A refused group is retried source by source by the caller, which audits each refusal once.
      unauditedDeny: true,
    },
  );
}

/** Writes one new source inside a running change (the body of `createSource`). */
async function writeNewSource(
  core: RepoCore,
  tx: Tx,
  projectId: string,
  draft: SourceDraft,
  provenance: Provenance,
  files: SourceInputFile[],
  opts: CreateSourceOptions,
  inTx: CreateInTx | undefined,
): Promise<SourceFile> {
  const st = tx.state;
  // A new source may be given only tags that exist now: no workspace tag being deleted (41a N2).
  await refuseUnknownTags(core, st, [], draft.tagIds);
  const id = newId();
  tx.entity("source", id);
  const short = shortId(id, takenShortIds(st));

  // Names, pseudonymized when the decision requires it (spec 4.4).
  let creator = creatorName(draft);
  let title = shortTitle(draft);
  const participantIds = [...draft.participantIds];
  if (tx.pseudonymize) {
    const map = await loadPseudonyms(core, st);
    const data = await readFullData(core, st);
    const { codes, participantIds: ids, changed } = assignCodes(draft.creators, map, data, tx);
    for (const pid of ids) if (!participantIds.includes(pid)) participantIds.push(pid);
    if (changed) {
      await savePseudonyms(tx, map);
      await writeProjectData(core, tx, data);
    }
    creator = codes.find((c) => c !== undefined) ?? (draft.creators.length ? "Unknown" : undefined);
    // The project's participant names (the map, the participants' name details) and every name
    // form of each creator, the list citations use too (R387 d); pseudonymize() matches the longest first.
    const text = participantNames(map, data.participants, draft.creators.map((c, i) => ({ creator: c, code: codes[i] })));
    title = pseudonymize(title, text);
  }
  const folderBase = sourceFolderName({ dateOrYear: folderDate(draft, provenance), primaryCreator: creator, shortTitle: title, shortId: short });
  const sourcesDir = `${st.rel}/Sources`;
  // A cached listing is fine only if the folder did not change since (mtime); the name chosen
  // is checked on disk once more.
  const taken = await folderNames(core.abs(sourcesDir));
  const folderName = withCollisionSuffix(folderBase, (n) => taken.has(foldName(n)) || existsSync(core.abs(`${sourcesDir}/${n}`)), { isFile: false });
  const folder = `${sourcesDir}/${folderName}`;
  await tx.mkdir(`${folder}/original`);
  await noteFolder(core.abs(sourcesDir), folderName);
  takenShortIds(st).add(short);

  const mode = fileMode(core, st, provenance.identifiable);
  const used = new Set<string>();
  const assets: Asset[] = [];
  const hashes: Record<string, string> = {};
  for (const f of files) {
    const assetId = newId();
    const ext =
      f.ext?.replace(/^\.+/, "").toLowerCase() || extname(f.encrypted ? f.path.replace(/\.enc$/i, "") : f.path).slice(1).toLowerCase() || "bin";
    let name = originalFileName(folderBase, ext);
    if (tx.encrypted) name = encName(name);
    name = withCollisionSuffix(name, (n) => used.has(foldName(n)));
    used.add(foldName(name));
    const rel = `${folder}/original/${name}`;
    let content: { sha256: string; bytes: number };
    let linked: Asset["linked"];
    if (f.handling === "link") {
      if (f.encrypted) throw new TypeError("an encrypted input file cannot be linked");
      if (tx.encrypted) {
        throw new GovernanceViolationError("This project is encrypted; linked files would stay unencrypted, so copy them instead");
      }
      // A linked file may be outside the library (R24): its path relative to the library root
      // may start with "..". It cannot be on another drive, nor in the library's work folder.
      const abs = resolve(f.path);
      const r = relative(resolve(core.root), abs);
      const rel = r.split(sep).join("/");
      if (isAbsolute(r) || !LinkedRelativePath.safeParse(rel).success) {
        throw new Error("This file cannot be linked from where it is (another drive than the library); copy it instead");
      }
      if (rel === ".tmp" || rel.startsWith(".tmp/")) throw new Error("Files in the library's work folder cannot be linked");
      content = await sha256File(abs);
      linked = { absolutePath: abs, libraryRelativePath: rel };
    } else {
      if (f.encrypted && !tx.encrypted) throw new TypeError("an encrypted input file needs an encrypted project");
      content = await tx.copyFile(f.path, rel, { encrypt: tx.encrypted, mode, ...(f.encrypted ? { sourceEncrypted: true } : {}), ...(f.noFollow ? { noFollow: true } : {}) });
    }
    const asset: Asset = {
      id: assetId,
      sourceId: id,
      role: "original",
      kind: f.kind ?? kindFor(ext),
      path: linked ? linked.libraryRelativePath : rel,
      encrypted: tx.encrypted && !linked,
      sha256: content.sha256,
      bytes: content.bytes,
      mime: f.mime ?? mimeFor(ext),
      ...(linked ? { linked } : {}),
      ...(f.metadata ? { metadata: f.metadata } : {}),
    };
    assets.push(asset);
    hashes[assetId] = content.sha256;
  }

  for (const [i, j] of opts.pairedFiles ?? []) {
    const a = assets[i];
    const b = assets[j];
    if (!a || !b || a === b) continue;
    assets[i] = { ...a, metadata: { ...(a.metadata ?? {}), pairedAssetId: b.id } };
    assets[j] = { ...b, metadata: { ...(b.metadata ?? {}), pairedAssetId: a.id } };
  }
  const pending = opts.pendingProxies?.(assets) ?? [];

  const name = tx.pseudonymize ? creator : creatorName(draft);
  const source = Source.parse({
    ...draft,
    id,
    projectIds: [projectId, ...draft.projectIds.filter((p) => p !== projectId)],
    participantIds,
    folder,
    citationKey: draft.citationKey ?? (opts.uniqueCitationKey ?? ((k: string) => k))(citationKeyFor(name, draft)),
    provenance: { ...provenance, fileHashes: { ...provenance.fileHashes, ...hashes } },
    availability: opts.availability ?? draft.availability,
    createdAt: tx.at,
    createdBy: tx.actor,
    modifiedAt: tx.at,
    modifiedBy: tx.actor,
  });
  const sf = SourceFile.parse({
    formatVersion: 1,
    source,
    assets,
    annotations: (opts.annotations?.(id, assets, tx.actor) ?? []).map((a) => Annotation.parse(a)),
    fieldEvidence: opts.fieldEvidence ?? [],
    verification: opts.verification ?? {},
    ...(pending.length ? { pendingProxies: pending } : {}),
  });
  await writeSourceFile(core, tx, sf);
  tx.record("source", id, null, source);
  for (const a of assets) tx.record("asset", a.id, null, a);
  for (const a of sf.annotations) tx.record("annotation", a.id, null, a);
  if (opts.reviewItem) await appendReviewEntry(core, tx, { sourceId: id, ...opts.reviewItem });
  // Linked to a participant whose consent was withdrawn: queued for review (R117 I1).
  await flagIfWithdrawn(core, tx, st.data, id, source);
  if (inTx) await inTx(tx, sf);
  tx.onCommit(() => st.sources.set(id, folder));
  tx.index((sink) => sink.indexSource(sf));
  return sf;
}

export async function getSource(core: RepoCore, projectId: string, id: string): Promise<SourceFile> {
  const st = core.state(projectId);
  core.assertUnlocked(st);
  return readSourceFile(core, st, id);
}

/**
 * A source's own record from `source.json(.enc)` ALONE (R186): it does not open the annotations
 * file, makes no cross-file check and records no integrity warning, so a list may read it for every
 * row while annotations are being written. For anything that needs the annotations, use getSource.
 */
export async function getSourceRecord(core: RepoCore, projectId: string, id: string): Promise<Source> {
  return (await getSourceRecordWithAssets(core, projectId, id)).source;
}

/**
 * The same light read (R186), keeping the assets that `source.json` holds and that the read already
 * parses: a list row can say what kind of files its source has without reading anything more (R222).
 */
export async function getSourceRecordWithAssets(core: RepoCore, projectId: string, id: string): Promise<{ source: Source; assets: Asset[] }> {
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const folder = sourceFolderOf(st, id);
  const encrypted = core.encrypted(st);
  const raw = await readMaybe(core.abs(encrypted ? `${folder}/source.json.enc` : `${folder}/source.json`));
  if (!raw) throw new NotFoundError("Source", id);
  let text: string;
  if (encrypted) {
    const { key, keyId } = core.key(st);
    text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
  } else text = raw.toString("utf8");
  const sf = SourceFile.parse(JSON.parse(text));
  return { source: sf.source, assets: sf.assets };
}

/**
 * Task F15 (R328 e): a stamp of a source's record file — its inode, size, and modification and change times — or null
 * when the record is not (or no longer) there. It reads nothing of the file (one `stat`), so a list may ask it for
 * every row to know whether what it read before still stands: a write by the app (atomic, so a new file) and a change
 * made outside the app both change it. Refused for a locked project, as a read is.
 */
export function sourceRecordStamp(core: RepoCore, projectId: string, id: string): string | null {
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const folder = st.sources.get(id);
  if (!folder) return null;
  // Synchronous on purpose: one `stat` is a few microseconds, far less than a promise through the thread pool, and a
  // list asks it for every row.
  const s = statSync(core.abs(core.encrypted(st) ? `${folder}/source.json.enc` : `${folder}/source.json`), { bigint: true, throwIfNoEntry: false });
  return s ? `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` : null;
}

export function listSourceIds(core: RepoCore, projectId: string): string[] {
  return [...core.state(projectId).sources.keys()];
}

const FIXED_FIELDS = ["folder", "createdAt", "createdBy"] as const;

export async function updateSource(
  core: RepoCore,
  projectId: string,
  id: string,
  /**
   * The change, or (package-internal) a function that builds it from the source as read inside the
   * governed change, so a merge with the current value never works on a stale read (lost update).
   */
  patchOrBuild: SourcePatch | ((cur: Source) => SourcePatch),
  /** Package-internal: also replace the source file's field evidence and verification (a recheck after a machine change). */
  extra: {
    fieldEvidence?: (cur: SourceFile) => FieldEvidence[];
    verification?: (next: SourceFile) => Record<string, FieldVerification>;
    /**
     * A confirm (R149) or a recheck: the source's capture-conflict review entries left with no listed
     * field in conflict or unconfirmed are resolved in this same change, and the audit event says so (R176 1).
     */
    resolveReview?: "confirmation" | "recheck";
    /**
     * A confirmation (R191): the fields the researcher confirmed in this change, as the verification
     * report names them (`/title`, `/identifiers/doi`). The audit entry names each and whether the
     * recorded value was kept or another chosen; never the value.
     */
    confirmed?: readonly string[];
  } = {},
): Promise<SourceFile> {
  let resolved: string[] = [];
  let confirmed: FieldConfirmation[] = [];
  let by: ReexaminedBy | undefined;
  let queued: QueuedConflicts[] = [];
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const build = (cur: SourceFile): SourcePatch => (typeof patchOrBuild === "function" ? patchOrBuild(cur.source) : patchOrBuild);
  const check = (cur: SourceFile, patch: SourcePatch) => {
    if ("provenance" in patch && !deepEqual(patch.provenance, cur.source.provenance)) throw new ImmutableProvenanceError();
    for (const f of FIXED_FIELDS) {
      if (f in patch && patch[f] !== cur.source[f]) throw new TypeError(`${f} cannot be changed`);
    }
  };
  const current = await readSourceFile(core, st, id);
  check(current, build(current));
  return runMutation(
    core,
    projectId,
    storeRequest(current.source.provenance),
    async (tx) => {
      const cur = await readSourceFile(core, st, id);
      const patch = build(cur);
      check(cur, patch);
      // Collections and tags set by the patch must exist (checked in this change, R99).
      if (patch.collectionIds || patch.tagIds) {
        const data = await readFullData(core, tx.state);
        for (const c of patch.collectionIds ?? []) if (!data.collections.some((x) => x.id === c)) throw new NotFoundError("Collection", c);
        const ws = patch.tagIds?.length ? await assignableWorkspaceTags(core) : [];
        for (const t of patch.tagIds ?? []) if (!data.tags.some((x) => x.id === t) && !ws.some((x) => x.id === t)) throw new NotFoundError("Tag", t);
      }
      // Fieldwork links set by the patch must exist (R119).
      const linksChange = "participantIds" in patch || "sessionId" in patch;
      if (linksChange) {
        for (const p of patch.participantIds ?? []) if (!tx.state.data.participants.some((x) => x.id === p)) throw new NotFoundError("Participant", p);
        if (patch.sessionId !== undefined && !tx.state.data.sessions.some((x) => x.id === patch.sessionId)) throw new NotFoundError("Session", patch.sessionId);
      }
      const source = Source.parse({
        ...cur.source,
        ...patch,
        id,
        provenance: cur.source.provenance,
        modifiedAt: tx.at,
        modifiedBy: tx.actor,
      });
      let sf: SourceFile = { ...cur, source, ...(extra.fieldEvidence ? { fieldEvidence: extra.fieldEvidence(cur) } : {}) };
      // The stored report is rewritten only by what recomputes it (a confirm, a recheck, a capture's new
      // evidence: `extra.verification`); an ordinary edit never touches it (fix round 2, I3).
      if (extra.verification) sf = { ...sf, verification: extra.verification(sf) };
      await writeSourceFile(core, tx, sf);
      tx.record("source", id, cur.source, source);
      confirmed = (extra.confirmed ?? []).map((field) => ({ field, choice: deepEqual(atPointer(cur.source, field), atPointer(source, field)) ? "kept" : "changed" }));
      // New links to a participant whose consent was withdrawn: queued for review (R117 I1, R119).
      if (linksChange) await flagIfWithdrawn(core, tx, tx.state.data, id, source, cur.source);
      // Every field the recomputed report has in conflict is listed in a pending capture-conflict entry,
      // in this change (R193 b: new or left without one by D19), before the entries are re-examined, so
      // an entry it extends is not resolved under it.
      if (extra.verification) queued = await queueUnlistedConflicts(core, tx, sf);
      // The source's capture entries are re-examined in this change (R176 1): against the new report
      // when one was computed; after an ordinary edit, against the stored report and the source as edited.
      by = extra.resolveReview ?? (extra.verification ? "recheck" : "edit");
      resolved =
        by === "edit"
          ? await resolveCaptureEntriesAfterEdit(core, tx, cur as unknown as Parameters<typeof resolveCaptureEntriesAfterEdit>[2], sf as unknown as Parameters<typeof resolveCaptureEntriesAfterEdit>[3])
          : await resolveSettledCaptureEntries(core, tx, sf, by);
      tx.index((sink) => sink.indexSource(sf));
      return sf;
    },
    {
      op: "source.update",
      entity: { type: "source", id },
      auditDetails: () => ({
        ...(confirmed.length ? { confirmed } : {}),
        ...(resolved.length ? { reviewResolved: { entries: resolved, by } } : {}),
        // One shape in every audit event that carries it: an array of { entry, fields } (here one element).
        ...(queued.length ? { reviewQueued: queued } : {}),
      }),
    },
  );
}

/**
 * One field a confirmation settled, as its audit entry records it (R191): the field as the
 * verification report names it, and whether the researcher kept the value recorded or chose
 * another. Never the value, an alternative or anything the researcher typed.
 */
export interface FieldConfirmation {
  field: string;
  choice: "kept" | "changed";
}

/** The value at a `/a/b` pointer of a source (undefined when absent). */
function atPointer(source: Source, pointer: string): unknown {
  let v: unknown = source;
  for (const part of pointer.split("/").slice(1)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

/** Rewrites one source inside a running mutation (membership, fieldwork links). */
export async function editSource(core: RepoCore, tx: Tx, id: string, edit: (s: Source) => Source): Promise<SourceFile> {
  const cur = await readSourceFile(core, tx.state, id);
  const source = Source.parse({ ...edit(structuredClone(cur.source)), modifiedAt: tx.at, modifiedBy: tx.actor });
  const sf: SourceFile = { ...cur, source };
  await writeSourceFile(core, tx, sf);
  tx.record("source", id, cur.source, source);
  tx.index((sink) => sink.indexSource(sf));
  return sf;
}

/**
 * Deletes one source inside a running mutation (its folder is trashed; linked originals are not
 * touched). Every path that deletes a source comes through here; a source imported incrementally
 * (Zotero) leaves a deletion record so a later run does not bring it back (R73), except when the
 * deletion is a batch undo (`undo`), which is not the user's. The source's pending review entries
 * are resolved in the same change (R176 4: "source-removed"; "undone" for an undo, coordinator's
 * ruling 3), except `keepReview`, the entry a review decision resolves itself. `reviewEntries: false`
 * says the caller knows the source has no pending entry (no caller uses it now: an undo reads the
 * queue inside each removal, fix round 2 N3).
 */
export async function deleteSourceInTx(core: RepoCore, tx: Tx, id: string, opts: { undo?: boolean; keepReview?: string; reviewEntries?: boolean } = {}): Promise<{ sf: SourceFile; tombstoned: string[] }> {
  const st = tx.state;
  const cur = await readSourceFile(core, st, id);
  const tombstoned = opts.undo ? [] : await recordDeletion(core, tx, cur);
  if (opts.reviewEntries !== false) {
    await resolveEntriesOfRemovedSource(core, tx, id, { ...(opts.keepReview ? { keep: opts.keepReview } : {}), decision: opts.undo ? "undone" : "source-removed" });
  }
  await tx.trash(cur.source.folder);
  if (tx.encrypted) await putManifest(tx, (m) => void (m.sources = m.sources.filter((x) => x.id !== id)));
  for (const a of cur.assets) tx.record("asset", a.id, a, null);
  for (const a of cur.annotations) tx.record("annotation", a.id, a, null);
  tx.record("source", id, cur.source, null);
  tx.onCommit(() => st.sources.delete(id));
  tx.index((sink) => sink.removeSource(id));
  return { sf: cur, tombstoned };
}

export async function deleteSource(core: RepoCore, projectId: string, id: string): Promise<void> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  sourceFolderOf(st, id);
  await runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      await deleteSourceInTx(core, tx, id);
    },
    { op: "source.delete", entity: { type: "source", id } },
  );
}

/**
 * Points a linked (not copied) asset at a new library-relative location (relinking a missing
 * linked file, spec 4.5). Governed and audited like any edit of the source; the file itself is not
 * touched. The new path must hold a file with the asset's recorded SHA-256 (checked by the caller).
 */
export class LinkedContentChangedError extends Error {
  override name = "LinkedContentChangedError";
  constructor(readonly path: string) {
    super(`The file at ${path} is not (or no longer) the linked asset's content; nothing was changed`);
  }
}

export async function relinkLinkedAsset(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  assetId: string,
  libraryRelativePath: string,
): Promise<SourceFile> {
  LibraryRelativePath.parse(libraryRelativePath);
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const current = await readSourceFile(core, st, sourceId);
  return runMutation(
    core,
    projectId,
    storeRequest(current.source.provenance),
    async (tx) => {
      const cur = await readSourceFile(core, st, sourceId);
      const before = cur.assets.find((a) => a.id === assetId);
      if (!before?.linked) throw new NotFoundError("Linked asset", assetId);
      // Re-check inside the mutation: the file may have changed since the caller matched it.
      const abs = core.abs(libraryRelativePath);
      const fst = await fsp.lstat(abs).catch(() => null);
      if (!fst?.isFile() || (await sha256File(abs)).sha256 !== before.sha256) throw new LinkedContentChangedError(libraryRelativePath);
      const after: Asset = {
        ...before,
        path: libraryRelativePath,
        linked: { absolutePath: resolve(core.abs(libraryRelativePath)), libraryRelativePath },
      };
      const sf: SourceFile = {
        ...cur,
        source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor },
        assets: cur.assets.map((a) => (a.id === assetId ? after : a)),
      };
      await writeSourceFile(core, tx, sf);
      tx.entity("asset", assetId);
      tx.record("asset", assetId, before, after);
      tx.index((sink) => sink.indexSource(sf));
      return sf;
    },
    { op: "asset.relink", entity: { type: "asset", id: assetId } },
  );
}
