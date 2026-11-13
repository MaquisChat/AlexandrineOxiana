/**
 * Task R4: the annotation routes of a source (list, create, recolour or add a note, delete) over the
 * library's governed operations (R3). The desktop app's token only; plain-language errors with no
 * path; nothing typed ever reaches the log or the audit.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, type Annotation } from "@ao/core";
import { deviceDeps, type Deps } from "@ao/library";
import type { AnnotationDeleteResponse, AnnotationListResponse, AnnotationRecord } from "@ao/shared";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PASS = "correct horse battery staple";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
captureMethods: [manual_upload]
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService;
let logged: string[];

const startService = async (): Promise<LibraryService> => {
  logged = [];
  return createService({
    token: TOKEN,
    deps,
    worker: null,
    pairing: { confirmPerMinute: 100 },
    logStream: new Writable({
      write: (c, _e, cb) => {
        logged.push(String(c));
        cb();
      },
    }),
  });
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
async function call(r: { method?: Method; url: string; body?: unknown; raw?: string; headers?: Record<string, string> }) {
  const hasBody = r.body !== undefined || r.raw !== undefined;
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...(r.headers ?? auth), ...(hasBody ? { "content-type": "application/json" } : {}) },
    ...(r.raw !== undefined ? { payload: r.raw } : r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-annotation-routes-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await startService();
  expect((await call({ method: "POST", url: "/libraries", body: { path: join(tmp, "Lib"), name: "Lib" } })).status).toBe(200);
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

const rect = { x: 72, y: 700, w: 200, h: 12 };
const make = (assetId: string, over: Record<string, unknown> = {}) => ({
  kind: "highlight",
  assetId,
  anchors: [{ page: 1, rects: [rect] }],
  quote: "Coastal fisheries and kinship",
  colorName: "yellow",
  ...over,
});

type Seed = (sourceId: string, actor: string) => Annotation[];
interface Fx {
  pid: string;
  sid: string;
  assetId: string;
  otherSid: string;
  base: string;
}

/** A project (plain or encrypted) with two PDF sources; `seed` gives the first source's stored annotations. */
async function fixture(opts: { encrypted?: boolean; seed?: Seed; identifiable?: boolean } = {}): Promise<Fx> {
  const pr = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: opts.identifiable ? GOV.replace("containsIdentifiable: false", "containsIdentifiable: true") : GOV, encryption: opts.encrypted ? { enabled: true, passphrase: PASS } : { enabled: false } } });
  expect(pr.status, pr.body).toBe(200);
  const pid = pr.json.project.id as string;
  const repo = svc.state.session!.repo;
  const src = async (title: string, seed?: Seed) => {
    const dir = join(tmp, "in", newId());
    await mkdir(dir, { recursive: true });
    const path = join(dir, "paper.pdf");
    await writeFile(path, await buildPdf({ title, author: "Ana Souza", lines: [title] }));
    return repo.createSource(
      pid,
      { projectIds: [pid], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: title }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [{ path, role: "original", handling: "copy" }],
      {
        provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: opts.identifiable === true },
        ...(seed ? { annotations: (sid: string, _a: unknown, actor: string) => seed(sid, actor) } : {}),
      },
    );
  };
  const a = await src("Coastal fisheries", opts.seed);
  const b = await src("Other paper");
  return { pid, sid: a.source.id, assetId: a.assets[0]!.id, otherSid: b.source.id, base: `/projects/${pid}/sources/${a.source.id}/annotations` };
}

const ASSET = "01900000-0000-7000-8000-000000000001";
const importedHighlight = (sid: string, actor: string, over: Partial<Annotation> = {}): Annotation => ({
  id: newId(),
  sourceId: sid,
  kind: "highlight",
  anchors: [{ kind: "pdf", id: newId(), assetId: ASSET, page: 2, rects: [{ x: 10, y: 20, w: 30, h: 5 }], sortIndex: "00001|000010|00100" }],
  quote: "from Zotero",
  color: "#ffd500",
  externalKey: "zotero:ABCD2345",
  author: actor,
  createdAt: new Date().toISOString(),
  ...over,
});

async function auditEvents(pid: string): Promise<Array<{ details?: Record<string, unknown> }>> {
  const r = await call({ url: `/projects/${pid}/audit?limit=1000` });
  expect(r.status, r.body).toBe(200);
  return (Array.isArray(r.json) ? r.json : r.json.events) as any[];
}

describe("annotation routes (Task R4)", () => {
  it("list, create, recolour, add a note, delete: each audited once", async () => {
    const f = await fixture();
    const empty = await call({ url: f.base });
    expect(empty.status, empty.body).toBe(200);
    expect(empty.json).toEqual({ annotations: [], count: 0, textChars: 0 });

    const created = await call({ method: "POST", url: f.base, body: make(f.assetId, { pageLabel: "iv" }) });
    expect(created.status, created.body).toBe(201);
    const a = created.json as AnnotationRecord;
    expect(a).toMatchObject({ sourceId: f.sid, kind: "highlight", colorName: "yellow", imported: false, pageLabel: "iv", quote: "Coastal fisheries and kinship", otherAnchorKinds: [] });
    expect(a.pdfAnchors).toHaveLength(1);
    expect(a.pdfAnchors[0]).toMatchObject({ assetId: f.assetId, page: 1, rects: [rect], sortIndexDerived: true });
    expect(a.pdfAnchors[0]!.sortIndex).toMatch(/^\d{5}\|\d{6}\|\d{5}$/);
    expect(a.importedColour).toBeUndefined();
    expect(typeof a.author).toBe("string");

    const listed = (await call({ url: f.base })).json as AnnotationListResponse;
    expect(listed.annotations.map((x) => x.id)).toEqual([a.id]);
    expect(listed.count).toBe(1);
    expect(listed.textChars).toBe("Coastal fisheries and kinship".length);

    const recoloured = await call({ method: "PATCH", url: `${f.base}/${a.id}`, body: { colorName: "green" } });
    expect(recoloured.status, recoloured.body).toBe(200);
    expect(recoloured.json).toMatchObject({ id: a.id, colorName: "green" });
    const noted = await call({ method: "PATCH", url: `${f.base}/${a.id}`, body: { body: "my note" } });
    expect(noted.json).toMatchObject({ body: "my note", colorName: "green" });
    const cleared = await call({ method: "PATCH", url: `${f.base}/${a.id}`, body: { body: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.json.body).toBeUndefined();

    const gone = await call({ method: "DELETE", url: `${f.base}/${a.id}` });
    expect(gone.status, gone.body).toBe(200);
    expect(gone.json as AnnotationDeleteResponse).toEqual({ deleted: true, id: a.id });
    expect((await call({ url: f.base })).json.count).toBe(0);

    const ops = (await auditEvents(f.pid)).map((e) => e.details?.op);
    expect(ops.filter((o) => o === "annotation.create")).toHaveLength(1);
    expect(ops.filter((o) => o === "annotation.update")).toHaveLength(3);
    expect(ops.filter((o) => o === "annotation.delete")).toHaveLength(1);
    // No typed text in the audit (R177).
    const text = JSON.stringify(await auditEvents(f.pid));
    expect(text).not.toContain("my note");
    expect(text).not.toContain("Coastal fisheries and kinship");
  });

  it("a page note needs its words", async () => {
    const f = await fixture();
    const blank = await call({ method: "POST", url: f.base, body: make(f.assetId, { kind: "note", quote: undefined, body: "" }) });
    expect(blank.status).toBe(400);
    expect(blank.json.error).toMatchObject({ code: "VALIDATION", message: "Write the note first." });
    const ok = await call({ method: "POST", url: f.base, body: make(f.assetId, { kind: "note", quote: undefined, body: "page note" }) });
    expect(ok.status, ok.body).toBe(201);
    expect(ok.json).toMatchObject({ kind: "note", body: "page note" });
  });

  it("bad shapes answer 400 VALIDATION naming the field, in plain words with no path", async () => {
    const f = await fixture();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ colorName: "pink" }, /colorName/],
      [{ kind: "underline" }, /kind/],
      [{ assetId: undefined }, /assetId/],
      [{ anchors: [] }, /anchors/],
      [{ anchors: [{ page: 0, rects: [rect] }] }, /page/],
      [{ anchors: [{ page: 1, rects: [{ x: 1, y: 1, w: -1, h: 1 }] }] }, /negative/],
      [{ anchors: [{ page: 1, rects: [{ x: "1", y: 1, w: 1, h: 1 }] }] }, /rects/],
      [{ anchors: [{ page: 1, rects: [rect] }, { page: 1, rects: [rect] }] }, /once/],
      [{ quote: 5 }, /quote/],
      [{ pageLabel: "x".repeat(65) }, /pageLabel/],
      [{ id: "x" }, /id/],
    ];
    for (const [over, re] of cases) {
      const r = await call({ method: "POST", url: f.base, body: make(f.assetId, over) });
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
      expect(r.json.error.message).toMatch(re);
      expect(r.json.error.message).not.toContain(tmp);
    }
    for (const raw of ["[]", "not json"]) expect((await call({ method: "POST", url: f.base, raw })).status, raw).toBe(400);
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    expect((await call({ method: "PATCH", url: `${f.base}/no-such`, body: { colorName: "red" } })).status).toBe(404);
    for (const body of [{}, { colorName: "pink" }, { body: 5 }, { quote: "changed" }]) {
      const r = await call({ method: "PATCH", url: `${f.base}/${made.id}`, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
    }
  });

  it("a quote, a note or a page label with control characters is refused; a line break and a tab are kept", async () => {
    const f = await fixture();
    const msg = "A note cannot contain control characters.";
    for (const over of [{ quote: "a\u0000b" }, { quote: "a\u001bb" }, { body: "n\u0007" }, { pageLabel: "i\u0008" }, { quote: "a\u007fb" }, { body: "x\u0085y" }, { body: "a\rb" }, { body: "a\r\nb" }, { quote: "a\rb" }, { pageLabel: "i\tv" }, { pageLabel: "i\nv" }]) {
      const r = await call({ method: "POST", url: f.base, body: make(f.assetId, over) });
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.json.error).toMatchObject({ code: "VALIDATION", message: msg });
    }
    const fine = await call({ method: "POST", url: f.base, body: make(f.assetId, { quote: "line one\nline two\tend", body: " keep my spaces " }) });
    expect(fine.status, fine.body).toBe(201);
    // Nothing is trimmed silently.
    expect(fine.json).toMatchObject({ quote: "line one\nline two\tend", body: " keep my spaces " });
    for (const body of [{ body: "n\u0000" }, { body: "n\u001f" }, { body: "n\r" }, { body: "n\r\nm" }]) {
      const r = await call({ method: "PATCH", url: `${f.base}/${fine.json.id}`, body });
      expect(r.status).toBe(400);
      expect(r.json.error.message).toBe(msg);
    }
    expect((await call({ method: "PATCH", url: `${f.base}/${fine.json.id}`, body: { body: "two\nlines\tand tab" } })).status).toBe(200);
  });

  it("the extension token is refused", async () => {
    const f = await fixture();
    const code = await call({ method: "POST", url: "/extension/pair" });
    const c = await svc.app.inject({ method: "POST", url: "/extension/pair/confirm", headers: { origin: EXT, "content-type": "application/json" }, payload: JSON.stringify({ code: code.json.code }) });
    const ext = { authorization: `Bearer ${c.json().token as string}`, origin: EXT };
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    for (const [method, url, body] of [
      ["GET", f.base, undefined],
      ["POST", f.base, make(f.assetId)],
      ["PATCH", `${f.base}/${made.id}`, { colorName: "red" }],
      ["DELETE", `${f.base}/${made.id}`, undefined],
    ] as const) {
      const r = await call({ method, url, ...(body ? { body } : {}), headers: ext });
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN");
    }
    expect((await call({ url: f.base })).json.count).toBe(1);
  });

  it("read-only library answers READ_ONLY in plain words", async () => {
    const f = await fixture();
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    await svc.close();
    const metaPath = join(tmp, "Lib", "library.json");
    await writeFile(metaPath, JSON.stringify({ ...JSON.parse(await readFile(metaPath, "utf8")), formatVersion: 99 }));
    svc = await startService();
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: join(tmp, "Lib") } })).json).toMatchObject({ mode: "read-only" });
    // Reading still works.
    expect((await call({ url: f.base })).json.count).toBe(1);
    for (const [method, url, body] of [
      ["POST", f.base, make(f.assetId)],
      ["PATCH", `${f.base}/${made.id}`, { colorName: "red" }],
      ["DELETE", `${f.base}/${made.id}`, undefined],
    ] as const) {
      const r = await call({ method, url, ...(body ? { body } : {}) });
      expect(r.status, method).toBe(409);
      expect(r.json.error).toMatchObject({ code: "READ_ONLY", message: "This library is open read-only, so nothing can be changed." });
    }
  });

  it("locked project answers 423", async () => {
    const f = await fixture({ encrypted: true });
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    expect(made.id).toBeTruthy();
    expect((await call({ method: "POST", url: `/projects/${f.pid}/lock` })).status).toBe(200);
    for (const [method, url, body] of [
      ["GET", f.base, undefined],
      ["POST", f.base, make(f.assetId)],
      ["PATCH", `${f.base}/${made.id}`, { colorName: "red" }],
      ["DELETE", `${f.base}/${made.id}`, undefined],
    ] as const) {
      const r = await call({ method, url, ...(body ? { body } : {}) });
      expect(r.status, method).toBe(423);
      expect(r.json.error.code).toBe("PROJECT_LOCKED");
    }
    expect((await call({ method: "POST", url: `/projects/${f.pid}/unlock`, body: { secret: PASS } })).status).toBe(200);
    expect((await call({ url: f.base })).json.count).toBe(1);
  });

  it("a policy refusal answers 403 POLICY_DENIED with its reason, and nothing changes", async () => {
    const f = await fixture({ identifiable: true, encrypted: true });
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    // The project's rules now ask for a legal basis for identifiable data, which this source has none of.
    const got = await call({ url: `/projects/${f.pid}/governance` });
    const put = await call({ method: "PUT", url: `/projects/${f.pid}/governance`, body: { yaml: GOV.replace("containsIdentifiable: false", "containsIdentifiable: true").replace("requireLegalBasis: false", "requireLegalBasis: true"), baseSha256: got.json.sha256 } });
    expect(put.status, put.body).toBe(200);
    for (const [method, url, body] of [
      ["POST", f.base, make(f.assetId)],
      ["PATCH", `${f.base}/${made.id}`, { colorName: "red" }],
    ] as const) {
      const r = await call({ method, url, body });
      expect(r.status, `${method} ${r.body}`).toBe(403);
      expect(r.json.error.code).toBe("POLICY_DENIED");
      expect(typeof r.json.error.reason).toBe("string");
    }
    const list = (await call({ url: f.base })).json as AnnotationListResponse;
    expect(list.annotations).toHaveLength(1);
    expect(list.annotations[0]!.colorName).toBe("yellow");
  });

  it("the count cap answers 409 with the sentence", async () => {
    const f = await fixture({
      seed: (sid, actor) => Array.from({ length: 10_000 }, (_, i) => ({ id: newId(), sourceId: sid, kind: "note" as const, body: `n${i}`, anchors: [], author: actor, createdAt: new Date().toISOString() })),
    });
    const r = await call({ method: "POST", url: f.base, body: make(f.assetId) });
    expect(r.status, r.body).toBe(409);
    expect(r.json.error).toMatchObject({ code: "CONFLICT", message: "This source already has 10,000 annotations, the most one source can hold. Delete some to add more." });
    expect(((await call({ url: f.base })).json as AnnotationListResponse).count).toBe(10_000);
  }, 60_000);

  it("the text cap answers 413 with the sentence", async () => {
    // Ten stored notes of 1.6 MB (as an import can leave them), then a quote that passes 16 MB.
    const big = "x".repeat(1_677_000);
    const f = await fixture({
      seed: (sid, actor) => Array.from({ length: 10 }, () => ({ id: newId(), sourceId: sid, kind: "note" as const, body: big, anchors: [], author: actor, createdAt: new Date().toISOString() })),
    });
    const r = await call({ method: "POST", url: f.base, body: make(f.assetId, { quote: "y".repeat(60_000) }) });
    expect(r.status, r.body.slice(0, 300)).toBe(413);
    expect(r.json.error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", message: "This source's annotations would pass 16 MB of text, the most one source can hold." });
  }, 60_000);

  it("a body over 1 MB is refused", async () => {
    const f = await fixture();
    const r = await call({ method: "POST", url: f.base, raw: JSON.stringify(make(f.assetId, { quote: "a".repeat(1_100_000) })) });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
    const rects = Array.from({ length: 1000 }, (_, i) => ({ x: i + 0.123456, y: i + 0.123456, w: 100.123456, h: 10.123456 }));
    const many = { ...make(f.assetId), anchors: Array.from({ length: 50 }, (_, p) => ({ page: p + 1, rects })) };
    const r2 = await call({ method: "POST", url: f.base, raw: JSON.stringify(many) });
    expect(r2.status).toBe(413);
    expect(((await call({ url: f.base })).json as AnnotationListResponse).count).toBe(0);
  });

  it("an imported Zotero highlight lists with colorName and importedColour", async () => {
    const f = await fixture({
      seed: (sid, actor) => [
        importedHighlight(sid, actor),
        importedHighlight(sid, actor, { externalKey: "zotero:EXACT000", color: "#ffd400", anchors: [{ kind: "pdf", id: newId(), assetId: ASSET, page: 2, rects: [{ x: 10, y: 20, w: 30, h: 5 }], sortIndex: "00001|000020|00100" }] }),
      ],
    });
    const list = (await call({ url: f.base })).json as AnnotationListResponse;
    const [near, exact] = list.annotations;
    expect(near).toMatchObject({ imported: true, colorName: "yellow", importedColour: "#ffd500", quote: "from Zotero" });
    expect(near!.pdfAnchors[0]).toMatchObject({ page: 2, sortIndex: "00001|000010|00100", sortIndexDerived: false });
    expect(exact).toMatchObject({ imported: true, colorName: "yellow" });
    expect(exact!.importedColour).toBeUndefined();
    // Once the researcher recolours it, the name is theirs and the imported value is still shown.
    const r = await call({ method: "PATCH", url: `${f.base}/${near!.id}`, body: { colorName: "blue" } });
    expect(r.json).toMatchObject({ colorName: "blue", importedColour: "#ffd500", imported: true });
    expect((await call({ method: "DELETE", url: `${f.base}/${exact!.id}` })).json).toEqual({ deleted: true, id: exact!.id });
  });

  it("the list never returns another source's or project's annotations", async () => {
    const f = await fixture();
    const other = `/projects/${f.pid}/sources/${f.otherSid}/annotations`;
    const mine = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    expect((await call({ url: other })).json.annotations).toEqual([]);
    expect((await call({ method: "PATCH", url: `${other}/${mine.id}`, body: { colorName: "red" } })).status).toBe(404);
    expect((await call({ method: "DELETE", url: `${other}/${mine.id}` })).status).toBe(404);
    // An asset of another source is not this source's asset.
    const otherAsset = (await call({ url: `/projects/${f.pid}/sources/${f.otherSid}` })).json.assets[0].id as string;
    expect((await call({ method: "POST", url: f.base, body: make(otherAsset) })).status).toBe(404);
    expect((await call({ url: `/projects/${f.pid}/sources/01ZZZZZZZZZZZZZZZZZZZZZZZZ/annotations` })).status).toBe(404);
    expect((await call({ url: `/projects/01ZZZZZZZZZZZZZZZZZZZZZZZZ/sources/${f.sid}/annotations` })).status).toBe(404);
    const p2 = (await call({ method: "POST", url: "/projects", body: { name: "Two", governanceYaml: GOV, encryption: { enabled: false } } })).json.project.id as string;
    expect((await call({ url: `/projects/${p2}/sources/${f.sid}/annotations` })).status).toBe(404);
    // The existing source route is neither shadowed nor shadowing.
    expect((await call({ url: `/projects/${f.pid}/sources/${f.sid}` })).json.source.id).toBe(f.sid);
  });

  it("the list is sorted per document: reading order within each asset", async () => {
    const f = await fixture();
    const mk = async (page: number, y: number, quote: string) =>
      (await call({ method: "POST", url: f.base, body: make(f.assetId, { quote, anchors: [{ page, rects: [{ x: 50, y, w: 50, h: 10 }] }] }) })).json as AnnotationRecord;
    const p3 = await mk(3, 500, "page three");
    const low = await mk(1, 100, "low");
    const high = await mk(1, 600, "high");
    const list = (await call({ url: f.base })).json as AnnotationListResponse;
    expect(list.annotations.map((a) => a.id)).toEqual([high.id, low.id, p3.id]);
  });

  it("an annotation with no anchors lists, and can be deleted", async () => {
    const f = await fixture({ seed: (sid, actor) => [{ id: newId(), sourceId: sid, kind: "highlight", anchors: [], quote: "adrift", author: actor, createdAt: new Date().toISOString() }] });
    const list = (await call({ url: f.base })).json as AnnotationListResponse;
    expect(list.annotations[0]).toMatchObject({ quote: "adrift", pdfAnchors: [], otherAnchorKinds: [], colorName: "yellow" });
    expect((await call({ method: "DELETE", url: `${f.base}/${list.annotations[0]!.id}` })).status).toBe(200);
  });

  it("no log line contains the note", async () => {
    const f = await fixture();
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId, { body: "secret-note-text", quote: "secret-quote-text" }) })).json as AnnotationRecord;
    await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body: "secret-note-text two" } });
    await call({ method: "POST", url: f.base, body: make(f.assetId, { colorName: "pink", body: "secret-note-text three" }) });
    await call({ method: "DELETE", url: `${f.base}/${made.id}` });
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("")).not.toContain("secret-note-text");
    expect(logged.join("")).not.toContain("secret-quote-text");
  });

  it("an error answer is exactly {error:{code,message}} and carries no path", async () => {
    const f = await fixture();
    const bad = await call({ method: "POST", url: f.base, body: make("no-such-asset") });
    expect(bad.status).toBe(404);
    expect(JSON.stringify(bad.json)).not.toContain(tmp);
    expect(Object.keys(bad.json)).toEqual(["error"]);
  });

  it("a note of only spaces is refused with its own sentence, never removes a note; an explicit empty value removes it", async () => {
    const f = await fixture();
    const sentence = "A note cannot be only spaces.";
    const bad = await call({ method: "POST", url: f.base, body: make(f.assetId, { body: "   " }) });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatchObject({ code: "VALIDATION", message: sentence });
    expect((await call({ method: "POST", url: f.base, body: make(f.assetId, { kind: "note", quote: undefined, body: " \n\t " }) })).json.error.message).toBe(sentence);
    expect(((await call({ url: f.base })).json as AnnotationListResponse).count).toBe(0);

    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId, { body: " real note " }) })).json as AnnotationRecord;
    expect(made.body).toBe(" real note ");
    for (const body of ["   ", "\n", "\t "]) {
      const r = await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body } });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.message).toBe(sentence);
    }
    expect((await call({ url: f.base })).json.annotations[0].body).toBe(" real note ");
    // The explicit empty value, as null or as "", removes it.
    expect((await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body: "" } })).json.body).toBeUndefined();
    await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body: "again" } });
    const gone = await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body: null } });
    expect(gone.status).toBe(200);
    expect(gone.json.body).toBeUndefined();
    // A page note cannot have its words removed.
    const pn = (await call({ method: "POST", url: f.base, body: make(f.assetId, { kind: "note", quote: undefined, body: "page note" }) })).json as AnnotationRecord;
    expect((await call({ method: "PATCH", url: `${f.base}/${pn.id}`, body: { body: "" } })).json.error.message).toBe("Write the note first.");
  });

  it("a source with two PDFs: listed document by document, in reading order within each (A4); documents in the order they first appear; anchorless last", async () => {
    const pr = await call({ method: "POST", url: "/projects", body: { name: "Two", governanceYaml: GOV, encryption: { enabled: false } } });
    const pid = pr.json.project.id as string;
    const files: Array<{ path: string; role: "original"; handling: "copy" }> = [];
    for (const n of ["a", "b"]) {
      const dir = join(tmp, "in", newId());
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${n}.pdf`);
      await writeFile(path, await buildPdf({ title: `Doc ${n}`, author: "X", lines: [n] }));
      files.push({ path, role: "original", handling: "copy" });
    }
    const sf = await svc.state.session!.repo.createSource(
      pid,
      { projectIds: [pid], type: "article-journal", title: { variants: [{ lang: "en", kind: "original", value: "Two PDFs" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      files,
      {
        provenance: { captureMethod: "manual_upload", capturedAt: new Date().toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
        annotations: (sid: string, _a: unknown, actor: string) => [{ id: newId(), sourceId: sid, kind: "highlight" as const, anchors: [], quote: "adrift", author: actor, createdAt: new Date().toISOString() }],
      },
    );
    const [A, B] = [sf.assets[0]!.id, sf.assets[1]!.id];
    const base = `/projects/${pid}/sources/${sf.source.id}/annotations`;
    const mk = async (asset: string, page: number, y: number) =>
      ((await call({ method: "POST", url: base, body: make(asset, { quote: `${asset === A ? "A" : "B"}${page}@${y}`, anchors: [{ page, rects: [{ x: 50, y, w: 50, h: 10 }] }] }) })).json as AnnotationRecord).id;
    // Interleaved: a plain sort over the whole source would give p1 of both documents before any p2.
    const a2 = await mk(A, 2, 400);
    const b1l = await mk(B, 1, 100);
    const a1 = await mk(A, 1, 300);
    const b2 = await mk(B, 2, 500);
    const b1h = await mk(B, 1, 600);
    const list = (await call({ url: base })).json as AnnotationListResponse;
    const ids = list.annotations.map((x) => x.id);
    // Documents in first-seen (stored) order: the anchorless one was stored first but has no document, so it is last.
    expect(ids.slice(0, 5)).toEqual([a1, a2, b1h, b1l, b2]);
    expect(list.annotations[5]).toMatchObject({ quote: "adrift", pdfAnchors: [] });
    expect(list.count).toBe(6);
  });

  it("extra fields inside an anchor or a rectangle are refused, not ignored", async () => {
    const f = await fixture();
    for (const anchors of [
      [{ page: 1, rects: [rect], id: "forced" }],
      [{ page: 1, rects: [rect], assetId: "x", kind: "text-range" }],
      [{ page: 1, rects: [{ ...rect, extra: 1 }] }],
    ]) {
      const r = await call({ method: "POST", url: f.base, body: make(f.assetId, { anchors }) });
      expect(r.status, JSON.stringify(anchors)).toBe(400);
      expect(r.json.error.code).toBe("VALIDATION");
    }
  });

  it("a not-found answer is a plain sentence that never echoes what was typed in the address", async () => {
    const f = await fixture();
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId) })).json as AnnotationRecord;
    const odd = "%3Cscript%3Ealert(1)%3C%2Fscript%3E";
    const cases: Array<[Method, string, unknown, string]> = [
      ["PATCH", `${f.base}/${odd}`, { colorName: "red" }, "That highlight or note was not found."],
      ["DELETE", `${f.base}/${odd}`, undefined, "That highlight or note was not found."],
      ["GET", `/projects/${f.pid}/sources/${odd}/annotations`, undefined, "That source was not found."],
      ["POST", f.base, make(`<b>x</b>`), "That file is not part of this source."],
    ];
    for (const [method, url, body, message] of cases) {
      const r = await call({ method, url, ...(body ? { body } : {}) });
      expect(r.status, url).toBe(404);
      expect(r.json.error).toEqual({ code: "NOT_FOUND", message });
    }
    expect(made.id).toBeTruthy();
  });

  it("a note with nothing visible in it is refused like a note of only spaces, and never replaces a note; a real note containing such characters is kept as typed", async () => {
    const f = await fixture();
    const sentence = "A note cannot be only spaces.";
    const invisible = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u180E", "\u00AD", "\u3164", " \u200B\n\u2060\t\uFEFF ", "\u200B\u00A0\u2003"];
    for (const body of invisible) {
      const r = await call({ method: "POST", url: f.base, body: make(f.assetId, { body }) });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.message).toBe(sentence);
    }
    const made = (await call({ method: "POST", url: f.base, body: make(f.assetId, { body: "real note" }) })).json as AnnotationRecord;
    for (const body of invisible) {
      const r = await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body } });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.message).toBe(sentence);
    }
    expect((await call({ url: f.base })).json.annotations[0].body).toBe("real note");
    const odd = "zero\u200Bwidth \uFEFFand\u2060 joiner\u200D";
    const kept = await call({ method: "PATCH", url: `${f.base}/${made.id}`, body: { body: odd } });
    expect(kept.status).toBe(200);
    expect(kept.json.body).toBe(odd);
  });
});
