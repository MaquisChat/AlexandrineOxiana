/**
 * What the transcript and verification screens read (Task 34a c, d): transcript versions as
 * segments (machine and human-edited), and source records carrying each field's evidence and
 * verification in a shape the UI renders without knowing the library's internals, with no
 * absolute path in them (R132).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceDeps, type Deps } from "@ao/library";
import type { FieldReview, SourceRecordExtras, TranscriptListResponse, TranscriptResponse } from "@ao/shared";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
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

async function call(r: { method?: "GET" | "POST" | "PATCH"; url: string; body?: unknown }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  return { status: res.statusCode, json: res.json() as any, body: res.body };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-records-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
});
afterEach(async () => {
  await svc.close();
  await rm(tmp, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const r = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
  return r.json.project.id;
}

async function file(name: string, data: Buffer | string): Promise<string> {
  const dir = join(tmp, "in", Math.random().toString(36).slice(2));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), data);
  return join(dir, name);
}

describe("transcripts as segments (Task 34a c)", () => {
  it("a human-edited version: segments with start, end, language, text and flags null; the existing fields kept", async () => {
    const pid = await project();
    const repo = svc.state.session!.repo;
    const sf = await repo.createSource(
      pid,
      { projectIds: [pid], type: "audio", title: { variants: [{ lang: "en", kind: "original", value: "Talk" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: await file("talk.mp3", Buffer.alloc(32, 1)), role: "original", handling: "copy" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    const sid = sf.source.id;
    const vtt = "WEBVTT\n\n00:00.000 --> 00:01.500\nOlá\n\n00:01.500 --> 00:03.000\nTudo bem?\n";
    const saved = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcripts`, body: { text: vtt, format: "vtt", lang: "pt" } });
    expect(saved.status, saved.body).toBe(200);
    const list = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts` })).json as TranscriptListResponse;
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ id: saved.json.id, origin: "human-edit", format: "vtt", tool: "researcher" });
    expect(list.versions[0]!.path.startsWith("/")).toBe(false);
    const t = (await call({ url: `/projects/${pid}/sources/${sid}/transcripts/${saved.json.id}` })).json as TranscriptResponse;
    expect(t).toMatchObject({ id: saved.json.id, text: vtt, format: "vtt", origin: "human-edit", timed: true });
    expect(t.segments).toEqual([
      { start: 0, end: 1.5, lang: "pt", text: "Olá", flags: null },
      { start: 1.5, end: 3, lang: "pt", text: "Tudo bem?", flags: null },
    ]);
    const txt = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/transcripts`, body: { text: "Olá. Tudo bem?", format: "txt" } });
    expect((await call({ url: `/projects/${pid}/sources/${sid}/transcripts/${txt.json.id}` })).json).toMatchObject({ timed: false, segments: [], text: "Olá. Tudo bem?" });
    expect((await call({ url: `/projects/${pid}/sources/${sid}/transcripts/01ZZZZZZZZZZZZZZZZZZZZZZZZ` })).status).toBe(404);
  });
});

describe("evidence and verification on source records (Task 34a d)", () => {
  it("every field's status, checks and evidence in plain words; a user confirmation shows as the researcher's", async () => {
    const pid = await project();
    const pdf = await file("paper.pdf", await buildPdf({ title: "Coastal Fisheries and Kinship", author: "Ana Souza", lines: ["Coastal fisheries and kinship in the delta."] }));
    const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [pdf] } });
    const sid = att.json.items[0].sourceId as string;
    const got = await call({ url: `/projects/${pid}/sources/${sid}` });
    expect(got.status).toBe(200);
    // The stored record's own keys are still there for the screens that use them.
    expect(got.json.source.id).toBe(sid);
    expect(Array.isArray(got.json.fieldEvidence)).toBe(true);
    const rec = got.json as SourceRecordExtras;
    const title = rec.fields.find((f: FieldReview) => f.field === "/title");
    expect(title).toBeDefined();
    expect(["verified", "single-source", "unverified", "conflict", "user-confirmed", "none"]).toContain(title!.status);
    expect(Array.isArray(title!.checks)).toBe(true);
    expect(title!.evidence.length).toBeGreaterThan(0);
    for (const e of title!.evidence) {
      expect(typeof e.from.label).toBe("string");
      expect(e.from.label.length).toBeGreaterThan(0);
      expect(typeof e.at).toBe("string");
      expect(Object.keys(e.from)).not.toContain("ref");
    }
    expect(rec.fields.map((f) => f.field)).toEqual([...rec.fields.map((f) => f.field)].sort());

    const confirmed = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}/fields`, body: { field: "/issued", value: "2001" } });
    expect(confirmed.status, confirmed.body).toBe(200);
    const issued = (confirmed.json as SourceRecordExtras).fields.find((f) => f.field === "/issued")!;
    expect(issued.status).toBe("user-confirmed");
    expect(issued.evidence).toContainEqual(expect.objectContaining({ value: "2001", from: { kind: "user", label: "the researcher" } }));
    // PATCH of the source and recheck answer the same shape.
    const patched = await call({ method: "PATCH", url: `/projects/${pid}/sources/${sid}`, body: { publisher: "Delta Press" } });
    expect(Array.isArray(patched.json.fields)).toBe(true);
    const rechecked = await call({ method: "POST", url: `/projects/${pid}/sources/${sid}/recheck` });
    expect(Array.isArray(rechecked.json.fields)).toBe(true);
  });

  it("a linked file's absolute path never leaves the service (R132)", async () => {
    const pid = await project();
    const linked = await file("linked.pdf", await buildPdf({ title: "Linked Paper", author: "A B", lines: ["x"] }));
    const repo = svc.state.session!.repo;
    const sf = await repo.createSource(
      pid,
      { projectIds: [pid], type: "report", title: { variants: [{ lang: "en", kind: "original", value: "Linked" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path: linked, role: "original", handling: "link" }],
      { provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false } },
    );
    expect(sf.assets[0]!.linked?.absolutePath).toBe(linked);
    for (const r of [
      await call({ url: `/projects/${pid}/sources/${sf.source.id}` }),
      await call({ method: "PATCH", url: `/projects/${pid}/sources/${sf.source.id}`, body: { publisher: "P" } }),
      await call({ method: "POST", url: `/projects/${pid}/sources/${sf.source.id}/recheck` }),
    ]) {
      expect(r.status, r.body).toBe(200);
      expect(r.body).not.toContain(tmp);
      expect(r.json.assets[0].linked).toEqual({ libraryRelativePath: sf.assets[0]!.linked!.libraryRelativePath });
    }
  });
});
