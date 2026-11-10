/** Derived assets: new dated files under `derived/`, never overwriting (spec 4.2). */
import {
  Asset,
  DEFAULT_GOVERNANCE,
  derivedFileName,
  effectivePolicy,
  encName,
  newId,
  originalFileName,
  parseGovernance,
  withCollisionSuffix,
  type PendingOcr,
  type PendingProxy,
  type Provenance,
  type SourceFile,
} from "@ao/core";
import { DestroyedParentError, MissingParentError, ProxyRecordRefusedError } from "./errors.js";
import { foldName, mimeFor, namesIn, readMaybe } from "./io.js";
import { runMutation, type RefuseHook, type MutateRequest } from "./mutate.js";
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
  /** MIME type, e.g. the sniffed one (default: from the extension). */
  mime?: string;
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
  /**
   * Package-internal (R83, R85): the pending proxy (source.json `pendingProxies` id) this asset
   * completes, removed in the same change; refused (ProxyRecordRefusedError) when that entry is
   * gone, or when the project's location rule is now stricter than `location`, the rule the proxy
   * was checked against.
   */
  internal: { completesPendingProxy?: string; location?: LocationMode; completesPendingOcr?: string } = {},
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
      // A derived asset's parents must still exist (e.g. not removed by an import's undo, R85 I1).
      for (const parent of input.derivation.parents) {
        const found = cur.assets.find((a) => a.id === parent);
        if (!found || found.status === "destroyed") {
          if (internal.completesPendingProxy) throw new ProxyRecordRefusedError("ORIGINAL_GONE");
          // Nothing may be derived again from destroyed raw data (R92 I4).
          throw found ? new DestroyedParentError(parent) : new MissingParentError(parent);
        }
      }
      if (internal.completesPendingProxy) {
        // Recorded once (R85 I2), and only if it satisfies the rule as it is now (R85 C1).
        if (!(cur.pendingProxies ?? []).some((j) => j.id === internal.completesPendingProxy && !j.failed)) throw new ProxyRecordRefusedError("ALREADY_RECORDED");
        const now = await currentLocationMode(core, st.rel);
        if (stricterLocation(now, internal.location ?? "keep") !== (internal.location ?? "keep")) throw new ProxyRecordRefusedError("RULE_CHANGED");
      }
      if (internal.completesPendingOcr && !(cur.pendingOcr ?? []).some((j) => j.id === internal.completesPendingOcr && !j.failed)) {
        throw new ProxyRecordRefusedError("ALREADY_RECORDED");
      }
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
      const sf: SourceFile = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor }, assets: [...cur.assets, asset] };
      if (internal.completesPendingProxy) withPending(sf, (cur.pendingProxies ?? []).filter((j) => j.id !== internal.completesPendingProxy));
      if (internal.completesPendingOcr) withPendingOcr(sf, (cur.pendingOcr ?? []).filter((j) => j.id !== internal.completesPendingOcr));
      await writeSourceFile(core, tx, sf);
      tx.record("asset", asset.id, null, asset);
      tx.index((sink) => sink.indexSource(sf));
      return asset;
    },
    { op: "asset.derive" },
  );
}

export type LocationMode = "keep" | "coarsen" | "strip";
const LOCATION_ORDER: LocationMode[] = ["keep", "coarsen", "strip"];

/** The stricter of two location rules (strip > coarsen > keep). */
export function stricterLocation(a: LocationMode, b: LocationMode): LocationMode {
  return LOCATION_ORDER.indexOf(a) >= LOCATION_ORDER.indexOf(b) ? a : b;
}

/** The project's location rule as its governance.yaml says now (effective policy); unreadable → strip (fail closed). */
export async function currentLocationMode(core: RepoCore, projectRel: string): Promise<LocationMode> {
  try {
    const raw = await readMaybe(core.abs(`${projectRel}/governance.yaml`));
    return effectivePolicy(raw ? parseGovernance(raw.toString("utf8")) : DEFAULT_GOVERNANCE).policy.sharing.locationMetadata;
  } catch {
    return "strip";
  }
}

/** Sets (or, when empty, removes) a source file's pending OCR jobs. */
function withPendingOcr(sf: SourceFile, list: PendingOcr[]): void {
  if (list.length) sf.pendingOcr = list;
  else delete sf.pendingOcr;
}

/** Package-internal (OCR queue): changes a source's pending OCR jobs in one governed change. Nothing is written when unchanged. */
export async function updatePendingOcr(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  edit: (list: PendingOcr[], sf: SourceFile) => PendingOcr[],
): Promise<SourceFile> {
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
      const before = cur.pendingOcr ?? [];
      const next = edit(structuredClone(before), cur);
      if (JSON.stringify(next) === JSON.stringify(before)) return cur;
      const sf: SourceFile = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor } };
      withPendingOcr(sf, next);
      await writeSourceFile(core, tx, sf);
      tx.record("source", sourceId, cur.source, sf.source);
      return sf;
    },
    { op: "asset.ocr-pending", entity: { type: "source", id: sourceId } },
  );
}

/** Sets (or, when empty, removes) a source file's pending proxies. */
function withPending(sf: SourceFile, list: PendingProxy[]): void {
  if (list.length) sf.pendingProxies = list;
  else delete sf.pendingProxies;
}

/**
 * Package-internal (R83): changes a source's pending viewing proxies (e.g. marks one failed, or
 * drops one whose original is gone) in one governed change. Nothing is written when unchanged.
 */
export async function updatePendingProxies(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  edit: (list: PendingProxy[], sf: SourceFile) => PendingProxy[],
): Promise<SourceFile> {
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
      const before = cur.pendingProxies ?? [];
      const next = edit(structuredClone(before), cur);
      if (JSON.stringify(next) === JSON.stringify(before)) return cur;
      const sf: SourceFile = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor } };
      withPending(sf, next);
      await writeSourceFile(core, tx, sf);
      tx.record("source", sourceId, cur.source, sf.source);
      return sf;
    },
    { op: "asset.proxy-pending", entity: { type: "source", id: sourceId } },
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
  internal: {
    captureMethod?: Provenance["captureMethod"];
    /** The platform the capture is from (protocol.platforms applies, R99 I8). */
    capturePlatform?: string;
    hasLocation?: boolean;
    refuse?: RefuseHook;
    /** Viewing proxies to queue for the new original (R83), written to source.json in the same change. */
    pendingProxies?: (asset: Asset) => PendingProxy[];
  } = {},
): Promise<Asset> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const current = await readSourceFile(core, st, sourceId);
  const reqs: MutateRequest[] = [
    ...(internal.captureMethod ? [{ action: "capture" as const, capture: { method: internal.captureMethod, ...(internal.capturePlatform ? { platform: internal.capturePlatform } : {}) } }] : []),
    storeRequest(current.source.provenance, internal.hasLocation === true),
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
        mime: input.mime ?? mimeFor(ext),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      tx.entity("asset", asset.id);
      const sf: SourceFile = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor }, assets: [...cur.assets, asset] };
      const more = internal.pendingProxies?.(asset) ?? [];
      if (more.length) withPending(sf, [...(cur.pendingProxies ?? []), ...more]);
      await writeSourceFile(core, tx, sf);
      tx.record("asset", asset.id, null, asset);
      tx.index((sink) => sink.indexSource(sf));
      return asset;
    },
    { op: "asset.add-original", entity: { type: "source", id: sourceId }, ...(internal.refuse ? { refuse: internal.refuse } : {}) },
  );
}
