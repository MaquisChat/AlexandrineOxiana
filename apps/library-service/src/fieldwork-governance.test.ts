/**
 * Task 36 routes: fieldwork update, consent withdrawal and guarded delete (R97), consent and
 * protocol documents, and the retention list / raw-data destruction.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceDraft } from "@ao/core";
import { deviceDeps, type Deps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };

const FIELD_GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
captureMethods: [manual_upload]
retention:
  rawDataDestroyAfter: 2020-01-01
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let pid: string;
let pdf: string;

type Inject = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; body?: unknown };
async function call(r: Inject) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

function draft(): SourceDraft {
  return {
    projectIds: [],
    type: "interview",
    title: { variants: [{ lang: "en", kind: "original", value: "Interview with the harbour master" }] },
    creators: [],
    identifiers: {},
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
  };
}

async function newSource(): Promise<{ sourceId: string; assetId: string }> {
  const repo = svc.state.session!.repo;
  const sf = await repo.createSource(pid, draft(), [{ path: pdf, role: "original", handling: "copy" }], {
    provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "0" }, fileHashes: {}, legal: { status: "consented" }, identifiable: true },
  });
  return { sourceId: sf.source.id, assetId: sf.assets[0]!.id };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-service-t36-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  const logStream = new Writable({ write: (_c, _e, cb) => cb() });
  svc = await createService({ token: TOKEN, deps, logStream, worker: null });
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
  const r = await call({ method: "POST", url: "/projects", body: { name: "Field", governanceYaml: FIELD_GOV, encryption: { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  pid = r.json.project.id;
  pdf = join(tmp, "form.pdf");
  await writeFile(pdf, "%PDF-1.7\nsigned consent\n%%EOF\n");
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("fieldwork PATCH / DELETE (R97)", () => {
  it("updates a participant, a session and a consent record", async () => {
    const p = (await call({ method: "POST", url: `/projects/${pid}/participants`, body: {} })).json;
    expect(p.code).toBe("P-001");
    const renamed = await call({ method: "PATCH", url: `/projects/${pid}/participants/${p.id}`, body: { code: "P-100" } });
    expect(renamed.status).toBe(400);
    expect(renamed.json.error.message).toMatch(/cannot be changed/);
    const up = await call({ method: "PATCH", url: `/projects/${pid}/participants/${p.id}`, body: { details: { name: "Rosa" } } });
    expect(up.status, up.body).toBe(200);
    expect(up.json).toMatchObject({ code: "P-001", details: { name: "Rosa" } });
    expect((await call({ method: "PATCH", url: `/projects/${pid}/participants/${p.id}`, body: { details: null } })).json.details).toBeUndefined();

    const s = (await call({ method: "POST", url: `/projects/${pid}/sessions`, body: { date: "2026-03-14", place: "Lima" } })).json;
    const su = await call({ method: "PATCH", url: `/projects/${pid}/sessions/${s.id}`, body: { place: null, participantIds: [p.id] } });
    expect(su.status, su.body).toBe(200);
    expect(su.json.place).toBeUndefined();
    expect(su.json.participantIds).toEqual([p.id]);

    const c = (await call({ method: "POST", url: `/projects/${pid}/consents`, body: { participantId: p.id, scope: "audio", date: "2026-03-14" } })).json;
    const cu = await call({ method: "PATCH", url: `/projects/${pid}/consents/${c.id}`, body: { scope: "audio and video", expires: "2027-03-14" } });
    expect(cu.status, cu.body).toBe(200);
    expect(cu.json).toMatchObject({ scope: "audio and video", expires: "2027-03-14" });
    expect((await call({ method: "PATCH", url: `/projects/${pid}/consents/${c.id}`, body: { scope: 7 } })).status).toBe(400);
    // The document is set only by attaching the signed form (R117 I3).
    expect((await call({ method: "PATCH", url: `/projects/${pid}/consents/${c.id}`, body: { documentAssetId: "0190f0f0-0000-7000-8000-0000000000aa" } })).status).toBe(400);
    expect((await call({ method: "PATCH", url: `/projects/${pid}/participants/0190f0f0-0000-7000-8000-000000000000`, body: { details: null } })).status).toBe(404);
  });

  it("withdraws a consent: the record is kept, linked sources are flagged for review, nothing is deleted", async () => {
    const p = (await call({ method: "POST", url: `/projects/${pid}/participants`, body: {} })).json;
    const c = (await call({ method: "POST", url: `/projects/${pid}/consents`, body: { participantId: p.id, scope: "audio", date: "2026-03-14" } })).json;
    const { sourceId } = await newSource();
    await svc.state.session!.repo.linkSourceToFieldwork(pid, sourceId, { participantIds: [p.id] });
    const w = await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/withdraw`, body: { reason: "phoned" } });
    expect(w.status, w.body).toBe(200);
    expect(w.json.flaggedSourceIds).toEqual([sourceId]);
    expect(w.json.consent.withdrawn.at).toEqual(expect.any(String));
    expect((await call({ url: `/projects/${pid}/sources/${sourceId}` })).status).toBe(200);
    expect((await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/withdraw`, body: {} })).status).toBe(400);
    expect((await call({ method: "DELETE", url: `/projects/${pid}/consents/${c.id}` })).status).toBe(405);
  });

  it("deletes a participant or session only when nothing links to it (409 otherwise)", async () => {
    const p = (await call({ method: "POST", url: `/projects/${pid}/participants`, body: {} })).json;
    await call({ method: "POST", url: `/projects/${pid}/consents`, body: { participantId: p.id, scope: "audio", date: "2026-03-14" } });
    const busy = await call({ method: "DELETE", url: `/projects/${pid}/participants/${p.id}` });
    expect(busy.status).toBe(409);
    // Mapped in one place (R117): the service's error mapping knows FieldworkInUseError.
    const { toApiError } = await import("./errors.js");
    const { FieldworkInUseError } = await import("@ao/library");
    expect(toApiError(new FieldworkInUseError("X", ["1 source"])).status).toBe(409);
    expect(busy.json.error.code).toBe("CONFLICT");
    expect(busy.json.error.message).toMatch(/consent record/);
    const free = (await call({ method: "POST", url: `/projects/${pid}/participants`, body: {} })).json;
    expect((await call({ method: "DELETE", url: `/projects/${pid}/participants/${free.id}` })).status).toBe(200);
    const s = (await call({ method: "POST", url: `/projects/${pid}/sessions`, body: { date: "2026-03-14" } })).json;
    const { sourceId } = await newSource();
    await svc.state.session!.repo.linkSourceToFieldwork(pid, sourceId, { sessionId: s.id });
    expect((await call({ method: "DELETE", url: `/projects/${pid}/sessions/${s.id}` })).status).toBe(409);
  });

  it("attaches a dropped consent document to a consent record", async () => {
    const p = (await call({ method: "POST", url: `/projects/${pid}/participants`, body: {} })).json;
    const c = (await call({ method: "POST", url: `/projects/${pid}/consents`, body: { participantId: p.id, scope: "audio", date: "2026-03-14" } })).json;
    const r = await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/document`, body: { path: pdf } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.consent.documentAssetId).toBe(r.json.assetId);
    expect((await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/document`, body: { path: "relative.pdf" } })).status).toBe(400);
    expect((await call({ method: "PATCH", url: `/projects/${pid}/consents/${c.id}`, body: { documentAssetId: null } })).status).toBe(400);
    const off = await call({ method: "PATCH", url: `/projects/${pid}/consents/${c.id}`, body: { documentAssetId: null, detachReason: "wrong form" } });
    expect(off.status, off.body).toBe(200);
    expect(off.json.documentAssetId).toBeUndefined();
    // A detached form comes back only by an explicit re-attach (R119).
    const refused = await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/document`, body: { path: pdf } });
    expect(refused.status).toBe(400);
    // The UI tells this refusal apart by its reason, to offer an explicit re-attach.
    expect(refused.json.error.reason).toBe("detached-form");
    const back = await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/document`, body: { path: pdf, reattach: true } });
    expect(back.status, back.body).toBe(200);
    expect(back.json.consent.documentAssetId).toBe(r.json.assetId);
  });
});

describe("protocol documents (spec 6.3(9))", () => {
  it("adds dropped approval documents under <Project>/protocol/ and lists them", async () => {
    expect((await call({ url: `/projects/${pid}/protocol/documents` })).json.documents).toEqual([]);
    const r = await call({ method: "POST", url: `/projects/${pid}/protocol/documents`, body: { paths: [pdf, tmp] } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.documents).toEqual([{ name: "form.pdf", bytes: expect.any(Number), encrypted: false }]);
    expect(r.json.results.map((x: { outcome: string }) => x.outcome)).toEqual(["added", "failed"]);
    expect(JSON.stringify(r.json.results)).not.toContain(tmp);
    const folder = svc.state.session!.repo.getProject(pid).folder;
    expect(await readFile(join(tmp, "Lib", folder, "protocol", "form.pdf"), "utf8")).toContain("signed consent");
    expect((await call({ url: `/projects/${pid}/protocol/documents` })).json.documents).toHaveLength(1);
    expect((await call({ method: "POST", url: `/projects/${pid}/protocol/documents`, body: { paths: ["form.pdf"] } })).status).toBe(400);
  });
});

describe("retention (spec 6.3(5))", () => {
  it("lists raw originals due for destruction and destroys them only with confirmation, returning the certificate", async () => {
    const { sourceId, assetId } = await newSource();
    const due = await call({ url: `/projects/${pid}/retention` });
    expect(due.status, due.body).toBe(200);
    expect(due.json).toMatchObject({ destroyAfter: "2020-01-01", due: [{ sourceId, assetIds: [assetId], title: "Interview with the harbour master" }] });
    expect((await call({ method: "POST", url: `/projects/${pid}/retention/destroy`, body: { assetIds: [assetId] } })).status).toBe(400);
    expect((await call({ method: "POST", url: `/projects/${pid}/retention/destroy`, body: { assetIds: ["0190f0f0-0000-7000-8000-000000000000"], confirm: true } })).status).toBe(400);
    const r = await call({ method: "POST", url: `/projects/${pid}/retention/destroy`, body: { assetIds: [assetId], confirm: true, by: "Somebody Else" } });
    expect(r.status, r.body).toBe(200);
    expect(r.json.certificate).toMatchObject({ kind: "destruction-certificate" });
    // Who destroyed it is the researcher this service runs as, never text the client sent (R117).
    expect(r.json.certificate.actor).not.toBe("Somebody Else");
    expect(r.json.certificateFile).toMatch(/^Projects\/.+\/retention\/destruction-.+\.json$/);
    expect(JSON.stringify(r.json)).not.toContain(tmp);
    expect((await call({ url: `/projects/${pid}/retention` })).json.due).toEqual([]);
  });
});
