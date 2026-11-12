/**
 * Small governed actions the local library service (Task 30) offers on top of the repository, so the
 * service itself never touches library files:
 *
 *  - checkCaptureAllowed: the `capture` decision for links, before anything is queued (a deny is
 *    audited and thrown as PolicyDeniedError; an allow is not audited — each capture audits its own).
 *  - confirmField: the researcher sets a field's value; recorded as `user` field evidence and the
 *    verification recomputed in the same change, so an agreeing value becomes `user-confirmed`.
 *  - readAssetText: the text of a derived text asset (transcript, OCR), decrypted when needed.
 */
import { join } from "node:path";
import { recheckSourceFile, type Asset, type Provenance, type Source, type SourceFile } from "@ao/core";
import { classifyUrl } from "./capture/platforms.js";
import { decryptBytes, readMaybe } from "./repo/io.js";
import { authorizeProcessing, projectDataKey, repoLibrary, updateSourceRechecked, type Repo } from "./repo/repo.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";

/**
 * Evaluates (and on deny, audits and throws) the `capture` decision for each platform the links are on,
 * for each of `methods` (default the downloader; the extension's link lists need browser capture too, R116).
 */
export async function checkCaptureAllowed(repo: Repo, projectId: string, urls: string[], methods: ReadonlyArray<Provenance["captureMethod"]> = ["downloader"]): Promise<void> {
  const platforms = new Set<string>();
  for (const u of urls) {
    platforms.add(classifyUrl(u).platform);
  }
  for (const method of methods) {
    for (const platform of platforms) {
      await authorizeProcessing(repo, projectId, { action: "capture", capture: { method, platform } }, { op: "capture.preflight" });
    }
  }
}

/**
 * Source fields a person may set through confirmField (top-level bibliographic fields). The
 * identifiers are not here: they are confirmed one at a time as `/identifiers/<key>` (R149).
 */
export const CONFIRMABLE_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "creators",
  "issued",
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
  const ident = /^\/?identifiers\/(.+)$/.exec(field);
  if (ident) return confirmIdentifier(repo, projectId, sourceId, ident[1]!, value);
  const name = field.replace(/^\//, "");
  if (!CONFIRMABLE_FIELDS.has(name)) throw new InvalidInputError(`"${field}" is not a field that can be set here`);
  const at = new Date().toISOString();
  const pointer = `/${name}`;
  return updateSourceRechecked(repo, projectId, sourceId, { [name]: value } as Partial<Omit<Source, "id">>, {
    fieldEvidence: (cur) => [...cur.fieldEvidence.filter((e) => !(e.field === pointer && e.source.kind === "user")), { field: pointer, value, source: { kind: "user" }, at }],
    verification: (next) => recheckSourceFile(next, {}).verification,
  });
}

/**
 * Identifiers a person may confirm one at a time (R149), named as the verification report names
 * them: `/identifiers/<key>`. `platform` is a classification, not an identifier, and is not here.
 */
export const CONFIRMABLE_IDENTIFIERS: ReadonlySet<string> = new Set(["doi", "isbn", "issn", "url", "platformPostId", "arxiv"]);
const IDENTIFIER_MAX = 2048;

const identifierText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= IDENTIFIER_MAX;

/**
 * One identifier set by the researcher and recorded as their evidence at `/identifiers/<key>`, the
 * pointer the verification report uses, so the badge can become user-confirmed (R149). The other
 * identifiers are kept. ISBN is a list in the record: a single ISBN is recorded as a list of one.
 */
async function confirmIdentifier(repo: Repo, projectId: string, sourceId: string, key: string, raw: unknown): Promise<SourceFile> {
  if (!CONFIRMABLE_IDENTIFIERS.has(key)) throw new InvalidInputError(`"/identifiers/${key}" is not a field that can be set here`);
  let value: string | string[];
  if (key === "isbn") {
    const list = typeof raw === "string" ? [raw] : raw;
    if (!Array.isArray(list) || list.length === 0 || list.length > 50 || !list.every(identifierText)) throw new InvalidInputError("an ISBN must be text (or a list of them)");
    value = list.map((x) => x.trim());
  } else {
    if (!identifierText(raw)) throw new InvalidInputError(`the ${key} must be text of at most ${IDENTIFIER_MAX} characters`);
    value = raw.trim();
  }
  const pointer = `/identifiers/${key}`;
  const at = new Date().toISOString();
  // The other identifiers are taken from the source as read inside the governed change, so two
  // confirms at once both land (re-review N2: no lost update).
  return updateSourceRechecked(repo, projectId, sourceId, (cur) => ({ identifiers: { ...cur.identifiers, [key]: value } }), {
    fieldEvidence: (c) => [...c.fieldEvidence.filter((e) => !(e.field === pointer && e.source.kind === "user")), { field: pointer, value, source: { kind: "user" }, at }],
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
