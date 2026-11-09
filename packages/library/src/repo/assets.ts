/** Derived assets: new dated files under `derived/`, never overwriting (spec 4.2). */
import { Asset, derivedFileName, encName, newId, withCollisionSuffix } from "@ao/core";
import { foldName, mimeFor, namesIn } from "./io.js";
import { runMutation } from "./mutate.js";
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
      const { sha256, bytes } = await tx.copyFile(input.fromPath, rel, {
        encrypt: tx.encrypted,
        mode: fileMode(core, st, identifiable),
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
