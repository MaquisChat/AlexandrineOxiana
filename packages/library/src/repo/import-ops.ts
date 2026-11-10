/**
 * Package-internal operations for Bulk Import (Task 23): a governed change whose body can read,
 * write and delete sources, copy files in as further originals, and update review entries, all in
 * one transaction (R26: txn marker, change log, audit). Nothing here is part of the public Repo API.
 */
import { Asset, SourceFile, encName, newId, originalFileName, withCollisionSuffix } from "@ao/core";
import { NotFoundError } from "./errors.js";
import { decryptBytes, foldName, mimeFor, namesIn, readMaybe } from "./io.js";
import { runMutation, type MutateRequest, type RefuseHook, type Tx } from "./mutate.js";
import { readFullData, writeProjectData } from "./projects.js";
import { appendReviewEntry, appendReviewUpdate, readReviewEntries, type ReviewEntry, type ReviewInput } from "./review.js";
import { deleteSourceInTx, fileMode, readSourceFile, writeSourceFile } from "./sources.js";
import type { RepoCore } from "./state.js";

export interface ImportOps {
  readonly tx: Tx;
  /** The source as stored now (within this change: as last written by it). */
  readSource(id: string): Promise<SourceFile>;
  /** Writes the source file (recorded in the change log and indexed after commit). */
  writeSource(before: SourceFile | null, sf: SourceFile): Promise<void>;
  deleteSource(id: string): Promise<SourceFile>;
  /** Copies a file into the source's `original/` folder as a further original; returns the asset (not yet written to the source). */
  copyOriginal(sf: SourceFile, input: { fromPath: string; kind: string; ext: string; mime?: string; label: string; fromEncrypted?: boolean; noFollow?: boolean }): Promise<Asset>;
  /** Trashes one asset's file (a copied file inside the source folder; never a linked original). */
  trashAssetFile(a: Asset): Promise<void>;
  reviewEntries(): Promise<ReviewEntry[]>;
  appendReview(input: ReviewInput): Promise<ReviewEntry>;
  updateReview(entry: ReviewEntry): Promise<void>;
  /** Removes project tags (and their use on the given sources), in one write of project.json. */
  deleteTags(tagIds: string[], sourceIds: Iterable<string>): Promise<string[]>;
  /** Reads a project file written by this repo (decrypted when the project is encrypted). */
  readText(rel: string): Promise<string | null>;
}

export function runImportChange<T>(
  core: RepoCore,
  projectId: string,
  reqs: MutateRequest | MutateRequest[],
  fn: (ops: ImportOps) => Promise<T>,
  opts: { op: string; entity?: { type: "source" | "project" | "asset"; id: string }; refuse?: RefuseHook },
): Promise<T> {
  core.assertWritable();
  return runMutation(
    core,
    projectId,
    reqs,
    async (tx) => {
      const st = tx.state;
      const ops: ImportOps = {
        tx,
        readSource: (id) => readSourceFile(core, st, id),
        async writeSource(before, sf) {
          const parsed = SourceFile.parse(sf);
          await writeSourceFile(core, tx, parsed);
          tx.record("source", parsed.source.id, before?.source ?? null, parsed.source);
          const old = new Map((before?.assets ?? []).map((a) => [a.id, a]));
          for (const a of parsed.assets) if (!old.has(a.id)) tx.record("asset", a.id, null, a);
          const now = new Set(parsed.assets.map((a) => a.id));
          for (const a of before?.assets ?? []) if (!now.has(a.id)) tx.record("asset", a.id, a, null);
          if (!st.sources.has(parsed.source.id)) tx.onCommit(() => st.sources.set(parsed.source.id, parsed.source.folder));
          tx.index((sink) => sink.indexSource(parsed));
        },
        deleteSource: (id) => deleteSourceInTx(core, tx, id),
        async copyOriginal(sf, input) {
          const folder = sf.source.folder;
          const folderName = folder.slice(folder.lastIndexOf("/") + 1);
          const sourceName = folderName.replace(/\s*\[[^\]]*\](?: \(\d+\))?\s*$/, "");
          const ext = input.ext.replace(/^\.+/, "").toLowerCase();
          let name = originalFileName(`${sourceName} - ${input.label}`, ext);
          if (tx.encrypted) name = encName(name);
          const dir = `${folder}/original`;
          await tx.mkdir(dir);
          const taken = await namesIn(core.abs(dir));
          name = withCollisionSuffix(name, (n) => taken.has(foldName(n)));
          const rel = `${dir}/${name}`;
          if (input.fromEncrypted && !tx.encrypted) throw new TypeError("an encrypted input file needs an encrypted project");
          const { sha256, bytes } = await tx.copyFile(input.fromPath, rel, {
            encrypt: tx.encrypted,
            mode: fileMode(core, st, sf.source.provenance.identifiable),
            ...(input.fromEncrypted ? { sourceEncrypted: true } : {}),
            ...(input.noFollow ? { noFollow: true } : {}),
          });
          return Asset.parse({
            id: newId(),
            sourceId: sf.source.id,
            role: "original",
            kind: input.kind,
            path: rel,
            encrypted: tx.encrypted,
            sha256,
            bytes,
            mime: input.mime ?? mimeFor(ext),
          });
        },
        async trashAssetFile(a) {
          if (a.linked) return; // a linked original is the user's own file: never touched
          if (await tx.exists(a.path)) await tx.trash(a.path);
        },
        reviewEntries: () => readReviewEntries(core, st),
        appendReview: (input) => appendReviewEntry(core, tx, input),
        updateReview: (entry) => appendReviewUpdate(core, tx, entry),
        async deleteTags(tagIds, sourceIds) {
          const data = await readFullData(core, st);
          const gone = data.tags.filter((t) => tagIds.includes(t.id));
          if (!gone.length) return [];
          const ids = new Set(gone.map((t) => t.id));
          for (const id of sourceIds) {
            if (!st.sources.has(id)) continue;
            const cur = await readSourceFile(core, st, id);
            if (!cur.source.tagIds.some((t) => ids.has(t))) continue;
            const sf: SourceFile = { ...cur, source: { ...cur.source, tagIds: cur.source.tagIds.filter((t) => !ids.has(t)), modifiedAt: tx.at, modifiedBy: tx.actor } };
            await ops.writeSource(cur, sf);
          }
          data.tags = data.tags.filter((t) => !ids.has(t.id));
          await writeProjectData(core, tx, data);
          for (const t of gone) tx.record("tag", t.id, t, null);
          return [...ids];
        },
        async readText(rel) {
          const raw = await readMaybe(core.abs(rel));
          if (!raw) return null;
          if (!tx.encrypted) return raw.toString("utf8");
          const { key, keyId } = tx.key();
          return (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
        },
      };
      if (opts.entity) tx.entity(opts.entity.type, opts.entity.id);
      return fn(ops);
    },
    { op: opts.op, ...(opts.entity ? { entity: opts.entity } : {}), ...(opts.refuse ? { refuse: opts.refuse } : {}) },
  );
}

/** A source that is not in the project (any more). */
export function sourceGone(core: RepoCore, projectId: string, id: string): boolean {
  return !core.state(projectId).sources.has(id);
}

export { NotFoundError };
