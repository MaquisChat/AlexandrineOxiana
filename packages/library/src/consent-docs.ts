/**
 * Consent documents (spec 3.6, Task 36): a signed form dropped onto a consent record is stored as an
 * identifiable source of the project, linked to the participant, and its file is recorded as the
 * consent's `documentAssetId`. Both steps are governed changes (capture/store, then the consent
 * update); a withdrawn consent takes no new document.
 */
import { createRequire } from "node:module";
import { basename } from "node:path";
import type { ConsentRecord } from "@ao/core";
import { storeInputs } from "./import/common.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";
import type { Repo } from "./repo/repo.js";

const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export async function attachConsentDocument(
  repo: Repo,
  projectId: string,
  consentId: string,
  path: string,
  opts: { legalBasis?: string } = {},
): Promise<{ consent: ConsentRecord; sourceId: string; assetId: string }> {
  const fw = await repo.getFieldwork(projectId);
  const c = fw.consents.find((x) => x.id === consentId);
  if (!c) throw new NotFoundError("Consent record", consentId);
  if (c.withdrawn) throw new InvalidInputError("This consent was withdrawn; the record is kept as it was and cannot be changed");
  const p = fw.participants.find((x) => x.id === c.participantId);
  const legalBasis = opts.legalBasis ?? (await storeInputs(repo, projectId)).legalBasis;
  const sf = await repo.createSource(
    projectId,
    {
      projectIds: [],
      type: "other",
      title: { variants: [{ lang: "en", kind: "original", value: `Consent form ${p?.code ?? ""}`.trim() }] },
      creators: [],
      identifiers: {},
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: p ? [p.id] : [],
    },
    [{ path, role: "original", handling: "copy", noFollow: true }],
    {
      provenance: {
        captureMethod: "manual_upload",
        capturedAt: new Date().toISOString(),
        tool: { name: "consent-document", version: VERSION },
        fileHashes: {},
        legal: { status: "consented", ...(legalBasis ? { basis: legalBasis } : {}) },
        identifiable: true,
      },
    },
  );
  const asset = sf.assets.find((a) => a.role === "original");
  if (!asset) throw new InvalidInputError(`${basename(path)} could not be stored`);
  const consent = await repo.updateConsent(projectId, consentId, { documentAssetId: asset.id });
  return { consent, sourceId: sf.source.id, assetId: asset.id };
}
