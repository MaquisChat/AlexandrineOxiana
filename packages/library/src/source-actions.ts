/**
 * Small governed actions the local library service (Task 30) offers on top of the repository, so the
 * service itself never touches library files:
 *
 *  - checkCaptureAllowed: the `capture` decision for links, before anything is queued (a deny is
 *    audited and thrown as PolicyDeniedError; an allow is not audited — each capture audits its own).
 *  - confirmField: the researcher sets a field's value; recorded as `user` field evidence and the
 *    verification recomputed in the same change, so an agreeing value becomes `user-confirmed`.
 *  - addTranscriptVersion: a human-edited transcript stored as a new derived version (never
 *    replacing the machine one).
 *  - readAssetText: the text of a derived text asset (transcript, OCR), decrypted when needed.
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { recheckSourceFile, type Asset, type Source, type SourceFile } from "@ao/core";
import { classifyUrl } from "./capture/platforms.js";
import { decryptBytes, readMaybe } from "./repo/io.js";
import { authorizeProcessing, projectDataKey, repoLibrary, updateSourceRechecked, type Repo } from "./repo/repo.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";
import { activeTemp } from "./tmp-registry.js";

/** Evaluates (and on deny, audits and throws) the `capture` decision for each platform the links are on. */
export async function checkCaptureAllowed(repo: Repo, projectId: string, urls: string[]): Promise<void> {
  const platforms = new Set<string>();
  for (const u of urls) {
    platforms.add(classifyUrl(u).platform);
  }
  for (const platform of platforms) {
    await authorizeProcessing(repo, projectId, { action: "capture", capture: { method: "downloader", platform } }, { op: "capture.preflight" });
  }
}

/** Source fields a person may set through confirmField (top-level bibliographic fields). */
export const CONFIRMABLE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "creators",
  "issued",
  "identifiers",
  "container",
  "publisher",
  "type",
  "volume",
  "issue",
  "page",
  "edition",
  "numberOfPages",
  "publisherPlace",
  "collectionTitle",
  "collectionNumber",
  "genre",
  "medium",
  "number",
]);

/**
 * Sets one field (`/title`, `/issued` …) to `value` and records it as the researcher's own evidence;
 * the verification is recomputed in the same governed change (R38: user-confirmed only when the
 * value agrees). Throws TypeError for a field that cannot be set this way or an invalid value.
 */
export async function confirmField(repo: Repo, projectId: string, sourceId: string, field: string, value: unknown): Promise<SourceFile> {
  const name = field.replace(/^\//, "");
  if (!CONFIRMABLE_FIELDS.has(name)) throw new InvalidInputError(`"${field}" is not a field that can be set here`);
  const at = new Date().toISOString();
  const pointer = `/${name}`;
  return updateSourceRechecked(repo, projectId, sourceId, { [name]: value } as Partial<Omit<Source, "id">>, {
    fieldEvidence: (cur) => [...cur.fieldEvidence.filter((e) => !(e.field === pointer && e.source.kind === "user")), { field: pointer, value, source: { kind: "user" }, at }],
    verification: (next) => recheckSourceFile(next, {}).verification,
  });
}

/** Largest text returned by readAssetText (bytes). */
export const ASSET_TEXT_MAX_BYTES = 8 * 1024 * 1024;

/** The UTF-8 text of one of the source's derived text assets (decrypted in encrypted projects). */
export async function readAssetText(repo: Repo, projectId: string, sourceId: string, assetId: string): Promise<string> {
  const sf = await repo.getSource(projectId, sourceId);
  const asset = sf.assets.find((a) => a.id === assetId);
  if (!asset || asset.role !== "derived" || asset.status === "destroyed") throw new NotFoundError("Asset", assetId);
  if (asset.bytes > ASSET_TEXT_MAX_BYTES + 1024) throw new InvalidInputError("this file is too large to show as text");
  let raw = await readMaybe(join(repoLibrary(repo).root, ...asset.path.split("/")));
  if (!raw) throw new NotFoundError("Asset", assetId);
  if (asset.encrypted) {
    const k = projectDataKey(repo, projectId);
    if (!k) throw new InvalidInputError("this file is encrypted but the project is not");
    raw = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
  }
  return raw.toString("utf8");
}

/** Transcript versions of a source (machine and human-edited), newest last. */
export function transcriptVersions(sf: SourceFile): Asset[] {
  return sf.assets
    .filter((a) => a.role === "derived" && a.kind === "transcript" && a.status !== "destroyed")
    .sort((a, b) => (a.derivation?.at ?? "").localeCompare(b.derivation?.at ?? ""));
}

/**
 * Stores a human-edited transcript as a new version (derived asset, tool `human-edit`) next to the
 * versions it was edited from; `basedOn` is the version edited (its parents are inherited, so the
 * new version derives from the same media).
 */
export async function addTranscriptVersion(
  repo: Repo,
  projectId: string,
  sourceId: string,
  input: { text: string; format: "vtt" | "txt"; basedOn?: string; lang?: string },
): Promise<Asset> {
  if (typeof input.text !== "string" || input.text.length === 0) throw new InvalidInputError("the transcript text is empty");
  if (Buffer.byteLength(input.text, "utf8") > ASSET_TEXT_MAX_BYTES) throw new InvalidInputError("the transcript is too long");
  if (input.format !== "vtt" && input.format !== "txt") throw new InvalidInputError('format must be "vtt" or "txt"');
  if (input.format === "vtt" && !/^﻿?WEBVTT/.test(input.text)) throw new InvalidInputError("a WebVTT transcript must start with WEBVTT");
  const sf = await repo.getSource(projectId, sourceId);
  let parents: string[];
  if (input.basedOn) {
    const base = transcriptVersions(sf).find((a) => a.id === input.basedOn);
    if (!base) throw new NotFoundError("Transcript", input.basedOn);
    parents = base.derivation?.parents?.length ? [...base.derivation.parents] : [base.id];
  } else {
    const media = sf.assets.find((a) => a.role === "original" && a.status !== "destroyed" && (a.mime.startsWith("audio/") || a.mime.startsWith("video/")));
    parents = media ? [media.id] : [];
  }
  const root = repoLibrary(repo).root;
  const name = `worker-edit-${randomUUID()}`;
  const work = join(root, ".tmp", name);
  activeTemp.add(name);
  try {
    await fsp.mkdir(work, { recursive: true, mode: 0o700 });
    const file = join(work, `transcript.${input.format}`);
    await fsp.writeFile(file, input.text, { mode: 0o600 });
    return await repo.addDerivedAsset(projectId, sourceId, {
      fromPath: file,
      kind: "transcript",
      ...(input.lang ? { lang: input.lang } : {}),
      tool: "human-edit",
      ext: input.format,
      derivation: {
        parents,
        operation: "human-edit",
        provider: "researcher",
        ranAt: "local",
        params: input.basedOn ? { basedOn: input.basedOn } : {},
        at: new Date().toISOString(),
        triggeredBy: "user",
      },
    });
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(name);
  }
}
