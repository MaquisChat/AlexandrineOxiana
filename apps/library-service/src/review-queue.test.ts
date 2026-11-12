/**
 * The project's whole review queue (Task 67, D14, R172): `GET /projects/:id/review` lists every
 * pending entry of every kind; entries with no batch are decided through the library's own
 * decisions (an import entry by `POST /review/:itemId/decide`, a verification conflict's field by
 * `PATCH /projects/:id/sources/:sid/fields`, R149). A locked project's queue is neither listed nor
 * decided, and nothing about it is said (R96).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceDraft } from "@ao/core";
import { deviceDeps, type Deps } from "@ao/library";
import type { ProjectReviewEntry } from "@ao/shared";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const PASS = "correct horse battery staple";
const auth = { authorization: `Bearer ${TOKEN}` };

/** Unencrypted, identifying (fieldwork), no network lookups. */
const GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService;

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

async function newProject(encrypted = false, name = "Study"): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: GOV, encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(r.status, r.body).toBe(200);
  return r.json.project.id as string;
}

async function fixturePdf(name = "paper.pdf", title = "Coastal Fisheries and Kinship"): Promise<string> {
  const p = join(tmp, "in", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: ["Coastal fisheries and kinship in the delta."] }));
  return p;
}

const draft = (title: string, extra: Partial<SourceDraft> = {}): SourceDraft => ({
  projectIds: [],
  type: "webpage",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
  ...extra,
});
const provenance = () => ({ captureMethod: "manual_upload" as const, capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" as const }, identifiable: false });

/** A source queued as link and profile capture queue one saved with conflicting fields (createSource's reviewItem). */
async function capturedWithConflict(pid: string, title = "A captured page"): Promise<string> {
  const sf = await svc.state.session!.repo.createSource(pid, draft(title), [{ path: await fixturePdf(`${title.replace(/\W/g, "")}.pdf`, title), role: "original", handling: "copy" }], {
    provenance: provenance(),
    reviewItem: { fields: { "/title": "conflict" }, reasons: ["The page and its metadata disagree on the title."] },
  });
  return sf.source.id;
}

/** A source flagged by a consent withdrawal (the fieldwork routes). */
async function flaggedByWithdrawal(pid: string): Promise<string> {
  const repo = svc.state.session!.repo;
  const sf = await repo.createSource(pid, draft("Interview with the harbour master", { type: "interview" }), [], { provenance: provenance() });
  const p = (await call({ method: "POST", url: `/projects/${pid}/participants`, body: {} })).json;
  const c = (await call({ method: "POST", url: `/projects/${pid}/consents`, body: { participantId: p.id, scope: "audio", date: "2026-03-14" } })).json;
  await repo.linkSourceToFieldwork(pid, sf.source.id, { participantIds: [p.id] });
  const w = await call({ method: "POST", url: `/projects/${pid}/consents/${c.id}/withdraw`, body: { reason: "phoned" } });
  expect(w.status, w.body).toBe(200);
  return sf.source.id;
}

async function attached(pid: string, name = "attached.pdf", title = "An Attached Paper"): Promise<string> {
  const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await fixturePdf(name, title)] } });
  expect(att.status, att.body).toBe(200);
  expect(att.json.items[0].outcome).toBe("needs-review");
  return att.json.items[0].sourceId as string;
}

async function importFolder(pid: string, titles: string[], folder = "batch"): Promise<string> {
  for (const [i, t] of titles.entries()) await fixturePdf(join("..", folder, `p${i}.pdf`), t);
  const r = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: join(tmp, folder) }, options: {} } });
  expect(r.status, r.body).toBe(200);
  await svc.state.idle();
  return r.json.batchId as string;
}

const queue = async (pid: string, query = "") => {
  const r = await call({ url: `/projects/${pid}/review${query}` });
  expect(r.status, r.body).toBe(200);
  return r.json as { items: ProjectReviewEntry[]; total: number; offset: number; limit: number };
};
const badge = async (pid: string, sid: string) => ((await call({ url: `/projects/${pid}/sources?limit=500` })).json.items as Array<{ id: string; needsReview: boolean }>).find((r) => r.id === sid)?.needsReview;
const decide = (pid: string, itemId: string, decision: Record<string, unknown>) => call({ method: "POST", url: `/review/${itemId}/decide`, body: { projectId: pid, decision } });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-service-t67-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await createService({ token: TOKEN, deps, logStream: new Writable({ write: (_c, _e, cb) => cb() }), worker: null });
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("GET /projects/:id/review: the project's whole queue (Task 67, R172)", () => {
  it("lists every pending entry of every kind, each with its group, batch, source, title, reasons and when it was queued; never another project's", async () => {
    const pid = await newProject();
    const other = await newProject(false, "Other");
    const batchId = await importFolder(pid, ["Rivers of the North", "Lakes of the South"]);
    const attachedId = await attached(pid);
    const capturedId = await capturedWithConflict(pid);
    const flaggedId = await flaggedByWithdrawal(pid);
    await capturedWithConflict(other, "Another project's page");

    const q = await queue(pid);
    expect(q.total).toBe(5);
    expect(q.items).toHaveLength(5);
    expect(q.items.every((e) => e.projectId === pid && e.status === "pending" && typeof e.createdAt === "string" && e.reasons.length > 0)).toBe(true);
    const groups = q.items.map((e) => e.group).sort();
    expect(groups).toEqual(["attach", "capture", "import", "import", "withdrawal"]);
    expect(q.items.filter((e) => e.group === "import").every((e) => e.batchId === batchId && e.kind === "import")).toBe(true);
    expect(q.items.find((e) => e.group === "attach")).toMatchObject({ sourceId: attachedId, kind: "import" });
    expect(q.items.find((e) => e.group === "attach")!.batchId).toBeUndefined();
    expect(q.items.find((e) => e.group === "capture")).toMatchObject({ sourceId: capturedId, kind: "verification", fields: { "/title": "conflict" }, title: "A captured page" });
    expect(q.items.find((e) => e.group === "withdrawal")).toMatchObject({ sourceId: flaggedId, kind: "verification", title: "Interview with the harbour master" });
    expect(q.items.find((e) => e.group === "withdrawal")!.reasons[0]).toMatch(/Consent from participant P-001 .* was withdrawn/);
    expect((await queue(other)).total).toBe(1);
  });

  it("is bounded and paged: offset, limit (0 answers only the total), a source filter; bad values are refused in plain words", async () => {
    const pid = await newProject();
    await importFolder(pid, ["One", "Two", "Three"]);
    const sid = await capturedWithConflict(pid);
    const all = await queue(pid);
    expect(all).toMatchObject({ total: 4, offset: 0, limit: 500 });
    const page = await queue(pid, "?offset=1&limit=2");
    expect(page).toMatchObject({ total: 4, offset: 1, limit: 2 });
    expect(page.items.map((e) => e.id)).toEqual(all.items.slice(1, 3).map((e) => e.id));
    expect(await queue(pid, "?limit=0")).toEqual({ items: [], total: 4, offset: 0, limit: 0 });
    expect(await queue(pid, `?source=${sid}`)).toMatchObject({ total: 1, items: [{ sourceId: sid }] });
    for (const bad of ["?limit=1001", "?limit=-1", "?offset=x"]) {
      const r = await call({ url: `/projects/${pid}/review${bad}` });
      expect(r.status, bad).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
    }
    expect((await call({ url: `/projects/0190f0f0-0000-7000-8000-000000000000/review` })).status).toBe(404);
  });

  it("a locked project's queue is refused before anything is read: no entries, no count, no titles, no path; after unlock it reads again", async () => {
    const pid = await newProject(true);
    const sid = await attached(pid, "sealed.pdf", "A Sealed Paper About Someone");
    expect((await queue(pid)).total).toBe(1);
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    for (const q of ["", "?limit=0", `?source=${sid}`]) {
      const r = await call({ url: `/projects/${pid}/review${q}` });
      expect(r.status).toBe(423);
      expect(r.json).toEqual({ error: { code: "PROJECT_LOCKED", message: "This project is locked. Its passphrase is needed." } });
      expect(r.body).not.toMatch(/Sealed|total|items|\//);
    }
    const [entryId] = (await queue(pid).catch(() => ({ items: [] as ProjectReviewEntry[] }))).items.map((e) => e.id);
    expect(entryId).toBeUndefined();
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await queue(pid)).items).toEqual([expect.objectContaining({ sourceId: sid, group: "attach", title: "A Sealed Paper About Someone" })]);
  });

  it("a locked project's entry is not decided", async () => {
    const pid = await newProject(true);
    await attached(pid);
    const [entry] = (await queue(pid)).items;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const r = await decide(pid, entry!.id, { action: "accept" });
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe("PROJECT_LOCKED");
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await queue(pid)).items.map((e) => e.id)).toEqual([entry!.id]);
  });
});

describe("deciding entries that have no batch (Task 67)", () => {
  it("a drag-and-drop entry is decided by the library's import decision (governed, audited): it leaves the queue and the row's badge clears", async () => {
    const pid = await newProject();
    const sid = await attached(pid);
    const [entry] = (await queue(pid)).items;
    expect(entry).toMatchObject({ group: "attach", sourceId: sid });
    expect(await badge(pid, sid)).toBe(true);
    const r = await decide(pid, entry!.id, { action: "keep-both" });
    expect(r.status, r.body).toBe(200);
    expect((await queue(pid)).total).toBe(0);
    expect(await badge(pid, sid)).toBe(false);
    const ops = ((await call({ url: `/projects/${pid}/audit?limit=1000` })).json.events as Array<{ details?: { op?: string } }>).map((e) => e.details?.op);
    expect(ops).toContain("review.decide");
  });

  it("a capture's conflicting field is confirmed through the source screen's own confirm (R149): the field becomes confirmed by you", async () => {
    const pid = await newProject();
    const sid = await capturedWithConflict(pid);
    const r = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}/fields`, body: { field: "/title", value: { variants: [{ lang: "en", kind: "original", value: "A captured page" }] } } });
    expect(r.status, r.body).toBe(200);
    expect((r.json.fields as Array<{ field: string; status: string }>).find((f) => f.field === "/title")?.status).toBe("user-confirmed");
  });

  it("a verification entry the import decision does not cover is refused in plain words, without a path, and stays in the queue", async () => {
    const pid = await newProject();
    await flaggedByWithdrawal(pid);
    const [entry] = (await queue(pid)).items;
    const r = await decide(pid, entry!.id, { action: "accept" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not an import item/);
    expect(r.body).not.toContain(tmp);
    expect((await queue(pid)).total).toBe(1);
  });

  // ---- R176: verification entries are resolved by the library's own ways ----

  it("a capture entry leaves the queue, and its badge clears, once its conflicting field is confirmed (R176 1)", async () => {
    const pid = await newProject();
    const sid = await capturedWithConflict(pid);
    const r = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}/fields`, body: { field: "/title", value: { variants: [{ lang: "en", kind: "original", value: "A captured page" }] } } });
    expect(r.status, r.body).toBe(200);
    expect((await queue(pid)).total).toBe(0);
    expect(await badge(pid, sid)).toBe(false);
    const events = (await call({ url: `/projects/${pid}/audit?limit=1000` })).json.events as Array<{ details?: { op?: string; reviewResolved?: { by: string } } }>;
    expect(events.find((e) => e.details?.reviewResolved)?.details).toMatchObject({ op: "source.update", reviewResolved: { by: "confirmation" } });
  });

  it("the queue sends each verification entry's cause: a capture's, or the withdrawal's with its consent record (R176 3)", async () => {
    const pid = await newProject();
    await capturedWithConflict(pid);
    await flaggedByWithdrawal(pid);
    const items = (await queue(pid)).items;
    expect(items.find((e) => e.group === "capture")?.cause).toEqual({ kind: "capture-conflict" });
    expect(items.find((e) => e.group === "withdrawal")?.cause).toEqual({ kind: "consent-withdrawal", consentIds: [expect.any(String)] });
  });

  const reviewed = (pid: string, itemId: string, reason?: unknown) =>
    call({ method: "POST", url: `/review/${itemId}/reviewed-after-withdrawal`, body: { projectId: pid, ...(reason !== undefined ? { reason } : {}) } });

  it("a consent-withdrawal entry is decided by Reviewed after the withdrawal, with a reason stored as typed: it leaves the queue and its badge clears (R176 2)", async () => {
    const pid = await newProject();
    const sid = await flaggedByWithdrawal(pid);
    const [entry] = (await queue(pid)).items;
    const reason = "  Spoke with P-001: the audio may be kept, not quoted.";
    const r = await reviewed(pid, entry!.id, reason);
    expect(r.status, r.body).toBe(200);
    // The contract the interface's api module and test double follow (WithdrawalReviewedResponse).
    expect(r.json).toEqual({ entry: { id: entry!.id, sourceId: sid, status: "resolved", decision: "reviewed-after-withdrawal", resolvedAt: expect.any(String), reason } });
    expect((await queue(pid)).total).toBe(0);
    expect(await badge(pid, sid)).toBe(false);
    const events = (await call({ url: `/projects/${pid}/audit?limit=1000` })).json.events as Array<{ action: string; details?: Record<string, unknown> }>;
    expect(events.find((e) => e.action === "review-withdrawal")).toMatchObject({ action: "review-withdrawal", details: { op: "review.withdrawal-reviewed", reviewEntry: entry!.id, reason } });
  });

  it("Reviewed after the withdrawal without a reason is refused in plain words, and the entry stays", async () => {
    const pid = await newProject();
    await flaggedByWithdrawal(pid);
    const [entry] = (await queue(pid)).items;
    for (const reason of ["", "   "]) {
      const r = await reviewed(pid, entry!.id, reason);
      expect(r.status).toBe(403);
      expect(r.json.error).toMatchObject({ code: "POLICY_DENIED", reason: "A reason is required to record that this source was reviewed after the withdrawal" });
    }
    const missing = await reviewed(pid, entry!.id);
    expect(missing.status).toBe(400);
    expect((await queue(pid)).total).toBe(1);
  });

  it("Reviewed after the withdrawal twice at once: one is recorded, the other is a conflict in plain words", async () => {
    const pid = await newProject();
    await flaggedByWithdrawal(pid);
    const [entry] = (await queue(pid)).items;
    const rs = await Promise.all([reviewed(pid, entry!.id, "first"), reviewed(pid, entry!.id, "second")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.json.error).toMatchObject({ code: "CONFLICT", message: "This entry has already been reviewed." });
  });

  it("Reviewed after the withdrawal is refused for a locked project before anything is read, and for an entry of another kind", async () => {
    const pid = await newProject(true);
    await flaggedByWithdrawal(pid);
    const [entry] = (await queue(pid)).items;
    expect((await call({ method: "POST", url: `/projects/${pid}/lock` })).status).toBe(200);
    const r = await reviewed(pid, entry!.id, "a reason");
    expect(r.status).toBe(423);
    expect(r.json).toEqual({ error: { code: "PROJECT_LOCKED", message: "This project is locked. Its passphrase is needed." } });
    expect((await call({ method: "POST", url: `/projects/${pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await queue(pid)).total).toBe(1);
    const sid = await attached(pid);
    const imp = (await queue(pid)).items.find((e) => e.sourceId === sid)!;
    const wrong = await reviewed(pid, imp.id, "a reason");
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.message).toMatch(/not an entry flagged by a consent withdrawal/);
    expect(wrong.body).not.toContain(tmp);
  });

  it("deleting a source resolves its pending entries: none is left in the queue (R176 4)", async () => {
    const pid = await newProject();
    const sid = await flaggedByWithdrawal(pid);
    expect((await call({ method: "DELETE", url: `/projects/${pid}/sources/${sid}` })).status).toBe(200);
    expect((await queue(pid)).total).toBe(0);
    const rows = svc.state.session!.index!.db.prepare("SELECT status FROM review_items WHERE project_id = ? AND source_id = ?").all(pid, sid) as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "resolved" }]);
  });
});
