/** Sources: create (capture + store), read, update, delete; source.json / source.json.enc and manifest.json. */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
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
  type Asset,
  type Availability,
  type FieldEvidence,
  type FieldVerification,
} from "@ao/core";
import { GovernanceViolationError, ImmutableProvenanceError, NotFoundError } from "./errors.js";
import { decryptBytes, deepEqual, foldName, kindFor, mimeFor, namesIn, readMaybe } from "./io.js";
import { runMutation, type RefuseHook, type MutateRequest, type Tx } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import { assignCodes, loadPseudonyms, savePseudonyms } from "./pseudonyms.js";
import { appendReviewEntry, type ReviewInput } from "./review.js";
import type { Manifest, ManifestEntry, ProjectState, RepoCore } from "./state.js";

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

export async function readSourceFile(core: RepoCore, st: ProjectState, id: string): Promise<SourceFile> {
  const folder = sourceFolderOf(st, id);
  let text: string;
  if (core.encrypted(st)) {
    const { key, keyId } = core.key(st);
    const raw = await readMaybe(core.abs(`${folder}/source.json.enc`));
    if (!raw) throw new NotFoundError("Source", id);
    text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
  } else {
    const raw = await readMaybe(core.abs(`${folder}/source.json`));
    if (!raw) throw new NotFoundError("Source", id);
    text = raw.toString("utf8");
  }
  return SourceFile.parse(JSON.parse(text));
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
  const e: ManifestEntry = { id: sf.source.id, type: sf.source.type, folder: sf.source.folder, files: sf.assets.map((a) => a.path) };
  if (sf.source.issued) e.issuedYear = sf.source.issued.slice(0, 4);
  return e;
}

/** Writes source.json, or source.json.enc plus the manifest entry in encrypted projects. */
export async function writeSourceFile(core: RepoCore, tx: Tx, sf: SourceFile): Promise<void> {
  const parsed = SourceFile.parse(sf);
  const json = JSON.stringify(parsed, null, 2);
  const folder = parsed.source.folder;
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
    // Every name form of each creator (handle with and without "@", literal, family, given,
    // "given family") maps to its code; pseudonymize() matches the longest first.
    const text = new Map(map);
    draft.creators.forEach((c, i) => {
      const code = codes[i];
      if (!code) return;
      const bare = c.handle?.replace(/^@+/, "");
      for (const n of [c.handle, bare, c.literal, c.family, c.given, [c.given, c.family].filter(Boolean).join(" ")]) {
        if (n?.trim() && !text.has(n.trim())) text.set(n.trim(), code);
      }
    });
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
      content = await tx.copyFile(f.path, rel, { encrypt: tx.encrypted, mode, ...(f.encrypted ? { sourceEncrypted: true } : {}) });
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

  const name = tx.pseudonymize ? creator : creatorName(draft);
  const source = Source.parse({
    ...draft,
    id,
    projectIds: [projectId, ...draft.projectIds.filter((p) => p !== projectId)],
    participantIds,
    folder,
    citationKey: draft.citationKey ?? citationKeyFor(name, draft),
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
    annotations: [],
    fieldEvidence: opts.fieldEvidence ?? [],
    verification: opts.verification ?? {},
  });
  await writeSourceFile(core, tx, sf);
  tx.record("source", id, null, source);
  for (const a of assets) tx.record("asset", a.id, null, a);
  if (opts.reviewItem) await appendReviewEntry(core, tx, { sourceId: id, ...opts.reviewItem });
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

export function listSourceIds(core: RepoCore, projectId: string): string[] {
  return [...core.state(projectId).sources.keys()];
}

const FIXED_FIELDS = ["folder", "createdAt", "createdBy"] as const;

export async function updateSource(
  core: RepoCore,
  projectId: string,
  id: string,
  patch: SourcePatch,
  /** Package-internal: also replace the source file's field evidence and verification (a recheck after a machine change). */
  extra: { fieldEvidence?: (cur: SourceFile) => FieldEvidence[]; verification?: (next: SourceFile) => Record<string, FieldVerification> } = {},
): Promise<SourceFile> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const check = (cur: SourceFile) => {
    if ("provenance" in patch && !deepEqual(patch.provenance, cur.source.provenance)) throw new ImmutableProvenanceError();
    for (const f of FIXED_FIELDS) {
      if (f in patch && patch[f] !== cur.source[f]) throw new TypeError(`${f} cannot be changed`);
    }
  };
  const current = await readSourceFile(core, st, id);
  check(current);
  return runMutation(
    core,
    projectId,
    storeRequest(current.source.provenance),
    async (tx) => {
      const cur = await readSourceFile(core, st, id);
      check(cur);
      const source = Source.parse({
        ...cur.source,
        ...patch,
        id,
        provenance: cur.source.provenance,
        modifiedAt: tx.at,
        modifiedBy: tx.actor,
      });
      let sf: SourceFile = { ...cur, source, ...(extra.fieldEvidence ? { fieldEvidence: extra.fieldEvidence(cur) } : {}) };
      if (extra.verification) sf = { ...sf, verification: extra.verification(sf) };
      await writeSourceFile(core, tx, sf);
      tx.record("source", id, cur.source, source);
      tx.index((sink) => sink.indexSource(sf));
      return sf;
    },
    { op: "source.update", entity: { type: "source", id } },
  );
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

/** Deletes one source inside a running mutation (its folder is trashed; linked originals are not touched). */
export async function deleteSourceInTx(core: RepoCore, tx: Tx, id: string): Promise<SourceFile> {
  const st = tx.state;
  const cur = await readSourceFile(core, st, id);
  await tx.trash(cur.source.folder);
  if (tx.encrypted) await putManifest(tx, (m) => void (m.sources = m.sources.filter((x) => x.id !== id)));
  for (const a of cur.assets) tx.record("asset", a.id, a, null);
  tx.record("source", id, cur.source, null);
  tx.onCommit(() => st.sources.delete(id));
  tx.index((sink) => sink.removeSource(id));
  return cur;
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
      const cur = await readSourceFile(core, st, id);
      await tx.trash(cur.source.folder);
      if (tx.encrypted) await putManifest(tx, (m) => void (m.sources = m.sources.filter((x) => x.id !== id)));
      for (const a of cur.assets) tx.record("asset", a.id, a, null);
      tx.record("source", id, cur.source, null);
      tx.onCommit(() => st.sources.delete(id));
      tx.index((sink) => sink.removeSource(id));
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
