/** Sources: create (capture + store), read, update, delete; source.json / source.json.enc and manifest.json. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
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
import { runMutation, type MutateRequest, type Tx } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import { assignCodes, loadPseudonyms, savePseudonyms } from "./pseudonyms.js";
import type { Manifest, ManifestEntry, ProjectState, RepoCore } from "./state.js";

export interface SourceInputFile {
  path: string;
  role: "original";
  handling: "copy" | "link";
}

export interface CreateSourceOptions {
  provenance: Provenance;
  fieldEvidence?: FieldEvidence[];
  verification?: Record<string, FieldVerification>;
  availability?: Availability;
}

export type SourcePatch = Partial<Omit<Source, "id">>;

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
export function storeRequest(p: Provenance): MutateRequest {
  return {
    action: "store",
    store: { identifiable: p.identifiable, hasLocation: false, ...(p.legal.basis ? { legalBasis: p.legal.basis } : {}) },
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

/** Short ids already used by folder names in the project (`[xxxx]` suffix). */
function takenShortIds(st: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const f of st.sources.values()) {
    const m = /\[([0-9a-z]+)\](?: \(\d+\))?$/.exec(f);
    if (m) out.add(m[1]!);
  }
  return out;
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

export async function createSource(
  core: RepoCore,
  projectId: string,
  draftIn: SourceDraft,
  files: SourceInputFile[],
  opts: CreateSourceOptions,
): Promise<SourceFile> {
  core.assertWritable();
  const draft = SourceDraft.parse(draftIn);
  const provenance = Provenance.parse(opts.provenance);
  const reqs: MutateRequest[] = [
    { action: "capture", capture: { method: provenance.captureMethod, ...(draft.identifiers.platform ? { platform: draft.identifiers.platform } : {}) } },
    storeRequest(provenance),
  ];
  return runMutation(
    core,
    projectId,
    reqs,
    async (tx) => {
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
      const taken = await namesIn(core.abs(sourcesDir));
      const folderName = withCollisionSuffix(folderBase, (n) => taken.has(foldName(n)), { isFile: false });
      const folder = `${sourcesDir}/${folderName}`;
      await tx.mkdir(`${folder}/original`);

      const mode = fileMode(core, st, provenance.identifiable);
      const used = new Set<string>();
      const assets: Asset[] = [];
      const hashes: Record<string, string> = {};
      for (const f of files) {
        const assetId = newId();
        const ext = extname(f.path).slice(1).toLowerCase() || "bin";
        let name = originalFileName(folderBase, ext);
        if (tx.encrypted) name = encName(name);
        name = withCollisionSuffix(name, (n) => used.has(foldName(n)));
        used.add(foldName(name));
        const rel = `${folder}/original/${name}`;
        let content: { sha256: string; bytes: number };
        let linked: Asset["linked"];
        if (f.handling === "link") {
          if (tx.encrypted) {
            throw new GovernanceViolationError("This project is encrypted; linked files would stay unencrypted, so copy them instead");
          }
          const abs = resolve(f.path);
          const r = relative(resolve(core.root), abs);
          if (r.startsWith("..") || isAbsolute(r)) {
            throw new Error("Linked files must be inside the library folder (paths stored in the library are library-relative)");
          }
          content = await sha256File(abs);
          linked = { absolutePath: abs, libraryRelativePath: r.split(sep).join("/") };
        } else {
          content = await tx.copyFile(f.path, rel, { encrypt: tx.encrypted, mode });
        }
        const asset: Asset = {
          id: assetId,
          sourceId: id,
          role: "original",
          kind: kindFor(ext),
          path: linked ? linked.libraryRelativePath : rel,
          encrypted: tx.encrypted && !linked,
          sha256: content.sha256,
          bytes: content.bytes,
          mime: mimeFor(ext),
          ...(linked ? { linked } : {}),
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
      tx.onCommit(() => st.sources.set(id, folder));
      tx.index((sink) => sink.indexSource(sf));
      return sf;
    },
    { op: "source.create" },
  );
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

export async function updateSource(core: RepoCore, projectId: string, id: string, patch: SourcePatch): Promise<SourceFile> {
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
      const sf: SourceFile = { ...cur, source };
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
