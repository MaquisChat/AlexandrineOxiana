/**
 * Consent documents (spec 3.6, Task 36, R117 I3–I5): a signed form dropped onto a consent record is
 * stored as an identifiable source of the project, linked to the participant, and its file is
 * recorded as the consent's `documentAssetId` (only this path sets it).
 *
 * The file goes through attach's rules (I4): never a file inside the open library's own folder (by real path, links
 * followed; R368 b — a found file held for the researcher's check comes in only through the review queue), content sniffed (PDF or an image), at most 100 MB, a
 * regular file (no folder or symbolic link), location metadata governed like any dropped photo
 * (a located file in a project that hides locations but is not encrypted is refused; under a
 * location rule a viewing proxy is queued, R83).
 *
 * Two governed changes make the link (create the source, then set the consent's document). The
 * source records the consent's id in its provenance at creation (`externalKeys.consentId`), so a
 * retry after an interruption finds it (same file hash + consent id) instead of storing a second
 * copy, and `reconcileConsentDocuments` (run when the library opens and on unlock) links any form
 * left unlinked.
 */
import * as fsp from "node:fs/promises";
import { libraryVersion } from "./resources.js";
import { basename } from "node:path";
import { fileTypeFromFile } from "file-type";
import type { ConsentRecord, SourceFile } from "@ao/core";
import { extractMetadata } from "./extract/index.js";
import { acceptedType } from "./import/attach.js";
import { locationRule, sha256File, storeInputs } from "./import/common.js";
import { serialStore } from "./import/project-queue.js";
import { pendingFor, proxyQueueFor, proxyTypeFor, type ProxyPlan, type ProxyQueue } from "./import/proxies.js";
import { LOCATED_MEDIA, mayHaveLocation } from "./import/resolve.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";
import { DETACHED_FORM, DETACH_FIRST } from "./repo/fieldwork.js";
import { createSourceRefusing, onProjectOpened, repoLibrary, setConsentDocumentAsset, type Repo } from "./repo/repo.js";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { insideLibrary } from "./fs/inside-library.js";

const VERSION: string = libraryVersion();

/** Largest consent form accepted (bytes). */
export const CONSENT_FORM_MAX_BYTES = 100 * 1024 * 1024;
/** The provenance key that ties a form's source to its consent record. */
export const CONSENT_KEY = "consentId";

/** The form's source and asset for this consent and file hash, if one was already stored. */
async function existingForm(repo: Repo, projectId: string, consentId: string, sha256?: string, skip: ReadonlySet<string> = new Set()): Promise<{ sourceId: string; assetId: string } | undefined> {
  for (const id of repo.listSourceIds(projectId)) {
    let sf: SourceFile;
    try {
      sf = await repo.getSource(projectId, id);
    } catch {
      continue;
    }
    if (sf.source.provenance.externalKeys?.[CONSENT_KEY] !== consentId) continue;
    const a = sf.assets.find((x) => x.role === "original" && x.status !== "destroyed" && !skip.has(x.id) && (sha256 === undefined || x.sha256 === sha256));
    if (a) return { sourceId: id, assetId: a.id };
  }
  return undefined;
}

export async function attachConsentDocument(
  repo: Repo,
  projectId: string,
  consentId: string,
  path: string,
  /** `reattach`: link a form that was detached from this record before (explicit, audited; R119). */
  opts: { legalBasis?: string; proxies?: ProxyQueue; reattach?: boolean } = {},
): Promise<{ consent: ConsentRecord; sourceId: string; assetId: string; note?: string }> {
  const fw = await repo.getFieldwork(projectId);
  const c = fw.consents.find((x) => x.id === consentId);
  if (!c) throw new NotFoundError("Consent record", consentId);
  if (c.withdrawn) throw new InvalidInputError("This consent was withdrawn; the record is kept as it was and cannot be changed");
  const p = fw.participants.find((x) => x.id === c.participantId);

  // One form per record: another attached form is detached first, with a reason (R119 I-b).
  if (c.documentAssetId) throw new InvalidInputError(DETACH_FIRST);

  const name = basename(path);
  // R368 b: nothing inside the library's own folder (before the file is looked at; nothing is changed).
  if (await insideLibrary(path, repoLibrary(repo))) throw new InvalidInputError(IN_LIBRARY_TEXT.file);
  const st = await fsp.lstat(path).catch(() => null);
  if (!st) throw new InvalidInputError(`${name} could not be found`);
  if (st.isSymbolicLink()) throw new InvalidInputError(`${name} is a shortcut (symbolic link); drop the form itself`);
  if (!st.isFile()) throw new InvalidInputError(`${name} is not a file`);
  if (st.size > CONSENT_FORM_MAX_BYTES) throw new InvalidInputError(`${name} is larger than 100 MB`);
  const type = await fileTypeFromFile(path).catch(() => undefined);
  const stored = type ? acceptedType(type) : undefined;
  if (!type || !stored || !(stored.ext === "pdf" || stored.kind === "image")) {
    throw new InvalidInputError(`${name} is not a PDF or an image; a consent form must be one of those`);
  }
  const sha256 = await sha256File(path);

  // A retry after an interruption: the form is already stored for this consent.
  const found = await existingForm(repo, projectId, consentId, sha256);
  if (found) {
    // A form detached on purpose comes back only by an explicit re-attach (R119 I-a).
    if (c.detachedAssetIds?.includes(found.assetId) && !opts.reattach) throw new InvalidInputError(DETACHED_FORM);
    const consent = await setConsentDocumentAsset(repo, projectId, consentId, found.assetId, opts.reattach ? { reattach: true } : {});
    return { consent, ...found };
  }

  // Location governance as for any dropped photo (R54a/R57: unreadable metadata counts as located).
  const hasLocation = LOCATED_MEDIA.test(stored.mime) && mayHaveLocation(stored.mime, await extractMetadata(path, stored.mime));
  const proxyType = proxyTypeFor(stored.mime);
  const plan: ProxyPlan = { located: hasLocation, proxies: hasLocation && proxyType ? [{ index: 0, type: proxyType }] : [] };
  const rule = locationRule();
  const legalBasis = opts.legalBasis ?? (await storeInputs(repo, projectId)).legalBasis;

  const sf = await serialStore(repo, projectId, () =>
    createSourceRefusing(
      repo,
      projectId,
      {
        projectIds: [],
        type: stored.kind === "image" ? "image" : "other",
        title: { variants: [{ lang: "en", kind: "original", value: `Consent form ${p?.code ?? ""}`.trim() }] },
        creators: [],
        identifiers: {},
        caseAttributes: {},
        availability: { status: "available" },
        collectionIds: [],
        tagIds: [],
        participantIds: p ? [p.id] : [],
      },
      [{ path, role: "original", handling: "copy", ext: stored.ext, mime: stored.mime, kind: stored.kind, noFollow: true }],
      {
        provenance: {
          captureMethod: "manual_upload",
          capturedAt: new Date().toISOString(),
          tool: { name: "consent-document", version: VERSION },
          fileHashes: {},
          legal: { status: "consented", ...(legalBasis ? { basis: legalBasis } : {}) },
          identifiable: true,
          externalKeys: { [CONSENT_KEY]: consentId },
        },
        ...(hasLocation ? { hasLocation: true } : {}),
        pendingProxies: (assets) => pendingFor(plan, assets, rule.mode()),
      },
      rule.hook,
    ),
  );
  const asset = sf.assets.find((a) => a.role === "original");
  if (!asset) throw new InvalidInputError(`${name} could not be stored`);
  let note: string | undefined;
  if (rule.mode() && plan.proxies.length) {
    const proxies = opts.proxies ?? proxyQueueFor(repo);
    if (proxies.available) proxies.enqueue(projectId, sf.source.id);
    else note = "Its location-safe viewing copy is made once the media helper is available.";
  }
  const consent = await setConsentDocumentAsset(repo, projectId, consentId, asset.id);
  return { consent, sourceId: sf.source.id, assetId: asset.id, ...(note ? { note } : {}) };
}

/**
 * Links consent forms whose second step (setting the consent's document) was interrupted: a
 * consent without a document whose form source exists. Returns how many were linked.
 */
export async function reconcileConsentDocuments(repo: Repo, projectId: string): Promise<number> {
  const fw = await repo.getFieldwork(projectId);
  let linked = 0;
  for (const c of fw.consents) {
    if (c.documentAssetId || c.withdrawn) continue;
    // Never a form that was detached on purpose (R119 I-a).
    const found = await existingForm(repo, projectId, c.id, undefined, new Set(c.detachedAssetIds ?? []));
    if (!found) continue;
    await setConsentDocumentAsset(repo, projectId, c.id, found.assetId);
    linked++;
  }
  return linked;
}

onProjectOpened(async (repo, projectId) => {
  await reconcileConsentDocuments(repo, projectId);
});
