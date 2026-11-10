/** Derived assets: new dated files under `derived/`, never overwriting (spec 4.2). */
import { Asset, derivedFileName, encName, newId, originalFileName, withCollisionSuffix, type Provenance } from "@ao/core";
import { foldName, mimeFor, namesIn } from "./io.js";
import { runMutation, type MutateRequest } from "./mutate.js";
import { fileMode, readSourceFile, storeRequest, writeSourceFile } from "./sources.js";
import type { RepoCore } from "./state.js";

export interface DerivedAssetInput {
  /** File to copy (or encrypt) into the source's `derived/` folder. */
  fromPath: string;
  kind: string;
  lang?: string;
  /** Tool/model or "human-edit". */
  tool: string;
  ext: string;
  derivation: NonNullable<Asset["derivation"]>;
  /** `fromPath` is already in this project's encrypted format (e.g. a media worker output). */
  fromEncrypted?: boolean;
  metadata?: Asset["metadata"];
}

/** A later original added to an existing source, e.g. a new dated platform-metadata snapshot. */
export interface OriginalAssetInput {
  fromPath: string;
  kind: string;
  ext: string;
  /** Distinguishes the file name from the source's other originals, e.g. "platform-metadata 2026-11-10 0930". */
  label: string;
  fromEncrypted?: boolean;
  metadata?: Asset["metadata"];
}

export async function addDerivedAsset(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  input: DerivedAssetInput,
): Promise<Asset> {
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
      const folder = cur.source.folder;
      // The folder name is already pseudonymized; drop its "[id]" (and any collision suffix).
      const folderName = folder.slice(folder.lastIndexOf("/") + 1);
      const sourceName = folderName.replace(/\s*\[[^\]]*\](?: \(\d+\))?\s*$/, "");
      let name = derivedFileName({
        sourceName,
        kind: input.kind,
        ...(input.lang ? { lang: input.lang } : {}),
        tool: input.tool,
        modified: tx.now,
        ext: input.ext,
        tz: core.tz,
      });
      if (tx.encrypted) name = encName(name);
      const dir = `${folder}/derived`;
      await tx.mkdir(dir);
      const taken = await namesIn(core.abs(dir));
      name = withCollisionSuffix(name, (n) => taken.has(foldName(n)));
      const rel = `${dir}/${name}`;
      const identifiable = cur.source.provenance.identifiable;
      if (input.fromEncrypted && !tx.encrypted) throw new TypeError("an encrypted input file needs an encrypted project");
      const { sha256, bytes } = await tx.copyFile(input.fromPath, rel, {
        encrypt: tx.encrypted,
        mode: fileMode(core, st, identifiable),
        ...(input.fromEncrypted ? { sourceEncrypted: true } : {}),
      });
      const asset = Asset.parse({
        id: newId(),
        sourceId,
        role: "derived",
        kind: input.kind,
        path: rel,
        encrypted: tx.encrypted,
        sha256,
        bytes,
        mime: mimeFor(input.ext.replace(/^\.+/, "")),
        derivation: input.derivation,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      tx.entity("asset", asset.id);
      const sf = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor }, assets: [...cur.assets, asset] };
      await writeSourceFile(core, tx, sf);
      tx.record("asset", asset.id, null, asset);
      tx.index((sink) => sink.indexSource(sf));
      return asset;
    },
    { op: "asset.derive" },
  );
}

/**
 * Adds an original file to an existing source (originals are never replaced: a refreshed platform
 * snapshot is a new, dated original next to the first one). Named `<source> - <label>.<ext>` in
 * `original/`, governed and audited like any change to the source.
 */
export async function addOriginalAsset(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  input: OriginalAssetInput,
  /** Package-internal: a newly captured file (e.g. a drop onto the source): its capture method is evaluated and audited in the same change. */
  internal: { captureMethod?: Provenance["captureMethod"] } = {},
): Promise<Asset> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const current = await readSourceFile(core, st, sourceId);
  const reqs: MutateRequest[] = [
    ...(internal.captureMethod ? [{ action: "capture" as const, capture: { method: internal.captureMethod } }] : []),
    storeRequest(current.source.provenance),
  ];
  return runMutation(
    core,
    projectId,
    reqs,
    async (tx) => {
      const cur = await readSourceFile(core, st, sourceId);
      const folder = cur.source.folder;
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
        mode: fileMode(core, st, cur.source.provenance.identifiable),
        ...(input.fromEncrypted ? { sourceEncrypted: true } : {}),
      });
      const asset = Asset.parse({
        id: newId(),
        sourceId,
        role: "original",
        kind: input.kind,
        path: rel,
        encrypted: tx.encrypted,
        sha256,
        bytes,
        mime: mimeFor(ext),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      tx.entity("asset", asset.id);
      const sf = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor }, assets: [...cur.assets, asset] };
      await writeSourceFile(core, tx, sf);
      tx.record("asset", asset.id, null, asset);
      tx.index((sink) => sink.indexSource(sf));
      return asset;
    },
    { op: "asset.add-original", entity: { type: "source", id: sourceId } },
  );
}
