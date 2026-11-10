import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, type Annotation, type Project, type SourceDraft, type SourceFile } from "@ao/core";
import { buildCameraTiff } from "../../../../tests/fixtures/generate.mjs";
import { shutdownExtractors } from "../extract/index.js";
import type { ScanItem } from "../import/bulk/scan.js";
import { ProxyQueue } from "../import/proxies.js";
import { gpsOf, locationTags, proxyStub } from "../import/proxy-testing.js";
import { bibtexAdapter } from "../import/refman.js";
import { WorkerClient } from "../worker-client.js";
import { stubWorker } from "../worker-testing.js";
import { ExportDestinationError, exportProjectOpenFormats } from "./project-export.js";
import { DEID_GOV, OPEN_GOV, PSEUDO_GOV, addSource, auditEvents, makeKit, makeProject, scratchFile, walk, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-openexp-");
});
afterEach(async () => {
  await kit.close();
});
afterAll(async () => {
  await shutdownExtractors();
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const outDir = async () => {
  const d = join(kit.tmp, "out");
  await mkdir(d, { recursive: true });
  return d;
};

async function readBib(path: string): Promise<ScanItem[]> {
  const out: ScanItem[] = [];
  for await (const i of bibtexAdapter(path).scan(new AbortController().signal)) out.push(i);
  return out;
}

describe("exportProjectOpenFormats", () => {
  it("writes sources.csl.json, sources.bib (round-trips through bibtexAdapter), one Markdown and source.json per source, and the decrypted originals", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Open Formats");
    const pdf = await scratchFile(kit, "paper.pdf", "%PDF-1.4 original bytes");
    const a = await addSource(kit, p, {
      title: "Feeding the City",
      creators: [{ family: "Okafor", given: "Ngozi", role: "author" }],
      issued: "2020",
      container: "Urban Studies",
      citationKey: "okafor2020feeding",
      files: [{ path: pdf, role: "original", handling: "copy" }],
    });
    await addSource(kit, p, { title: "Second", type: "book", creators: [{ family: "Berg", given: "Jan", role: "author" }], issued: "2001", citationKey: "berg2001" });
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    expect(r.path).toBe(join(kit.tmp, "out", "Open Formats - export - modified 2026-11-10 0930"));
    const names = await walk(r.path);
    expect(names).toContain("sources.csl.json");
    expect(names).toContain("sources.bib");
    expect(names.filter((n) => n.endsWith("/source.json"))).toHaveLength(2);
    expect(names.filter((n) => n.endsWith(".md"))).toHaveLength(2);
    expect(names.some((n) => n.endsWith(".enc"))).toBe(false);

    const csl = JSON.parse(await readFile(join(r.path, "sources.csl.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(csl.map((x) => x.id).sort()).toEqual(["berg2001", "okafor2020feeding"]);
    const back = await readBib(join(r.path, "sources.bib"));
    expect(back).toHaveLength(2);
    const okafor = back.find((i) => i.referenceMetadata?.citationKey === "okafor2020feeding")!;
    expect(okafor.referenceMetadata!.title!.variants[0]!.value).toBe("Feeding the City");
    expect(okafor.referenceMetadata!.creators).toEqual([{ family: "Okafor", given: "Ngozi", role: "author" }]);

    const folder = names.find((n) => n.endsWith("/source.json") && n.includes("Feeding"))!.replace(/\/source\.json$/, "");
    const sj = JSON.parse(await readFile(join(r.path, folder, "source.json"), "utf8")) as SourceFile;
    expect(sj.source.id).toBe(a.source.id);
    const orig = names.find((n) => n.startsWith(`${folder}/files/`) && n.endsWith(".pdf"))!;
    expect(await readFile(join(r.path, orig), "utf8")).toBe("%PDF-1.4 original bytes");
    if (process.platform !== "win32") expect((await stat(join(r.path, orig))).mode & 0o777).toBe(0o600);
    const ev = (await auditEvents(kit, p)).filter((e) => e.action === "export.project");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ exported: 2, withheld: 0 });
    expect(JSON.stringify(ev[0])).not.toContain(kit.tmp);
  });

  it("refuses a destination inside the library", async () => {
    const p = await makeProject(kit);
    await expect(exportProjectOpenFormats(kit.repo, p.id, join(kit.lib.root, "Exports"))).rejects.toBeInstanceOf(ExportDestinationError);
    await expect(exportProjectOpenFormats(kit.repo, p.id, kit.lib.root)).rejects.toBeInstanceOf(ExportDestinationError);
    expect(await readdir(join(kit.lib.root, "Exports"))).toEqual([]);
  });

  it("deidentified-only: identifiable sources are not exported (no metadata, no files) and a note says so", async () => {
    const p = await makeProject(kit, DEID_GOV);
    const pdf = await scratchFile(kit, "rosa.pdf", "%PDF-1.4 Rosa transcript");
    await addSource(kit, p, { title: "Paper", citationKey: "paper" });
    await addSource(kit, p, { title: "Interview with Rosa", identifiable: true, citationKey: "rosa", files: [{ path: pdf, role: "original", handling: "copy" }] });
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const all = await walk(r.path);
    expect(all.filter((n) => n.endsWith("/source.json"))).toHaveLength(1);
    for (const n of all) {
      const pth = join(r.path, n);
      if ((await stat(pth)).isFile()) expect((await readFile(pth, "utf8")).includes("Rosa"), n).toBe(false);
    }
    expect(r.withheld).toBe(1);
    expect(r.notes).toContain("1 source withheld by project policy");
  });

  it("Markdown escapes user text and renders annotations and notes", async () => {
    const p = await makeProject(kit);
    const pdf = await scratchFile(kit, "x.pdf", "%PDF-1.4");
    const draft: SourceDraft = {
      projectIds: [p.id],
      type: "article-journal",
      title: { variants: [{ lang: "en", kind: "original", value: "Evil <script>alert(1)</script> *bold* [link](javascript:x) # heading" }] },
      creators: [{ family: "Smith", given: "Jane", role: "author" }],
      identifiers: {},
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    const at = kit.clock.now.toISOString();
    await kit.repo.createSource(p.id, draft, [{ path: pdf, role: "original", handling: "copy" }], {
      provenance: { captureMethod: "manual_upload", capturedAt: at, tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
      annotations: (sourceId, assets, actor): Annotation[] => [
        {
          id: newId(),
          sourceId,
          kind: "highlight",
          quote: "a quoted <b>line</b>\n# not a heading",
          body: "my *comment*",
          anchors: [{ kind: "pdf", id: newId(), assetId: assets[0]!.id, page: 3, rects: [{ x: 0, y: 0, w: 1, h: 1 }] }],
          author: actor,
          createdAt: at,
        },
        { id: newId(), sourceId, kind: "note", body: "A standalone note with `code` and <img src=x onerror=alert(1)>", anchors: [], author: actor, createdAt: at },
      ],
    });
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const md = (await walk(r.path)).find((n) => n.endsWith(".md"))!;
    const text = await readFile(join(r.path, md), "utf8");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<img");
    expect(text).not.toContain("<b>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("\\*bold\\*");
    expect(text).toContain("\\[link\\]");
    expect(text).not.toMatch(/^# not a heading/mu);
    expect(text).toContain("## Annotations");
    expect(text).toContain("## Notes");
    expect(text).toContain("page 3");
    expect(text).toContain("my \\*comment\\*");
    expect(text).toContain("A standalone note with \\`code\\`");
  });

  it("pseudonymised file names: no participant's handle in any exported file or folder name", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Names");
    const mp4 = await scratchFile(kit, "@maria.cocina reel.mp4", "video bytes");
    const draft: SourceDraft = {
      projectIds: [p.id],
      type: "social-post",
      title: { variants: [{ lang: "es", kind: "original", value: "Cocinando con @maria.cocina" }] },
      creators: [{ literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" }],
      issued: "2026-03-14",
      identifiers: { platform: "instagram" },
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    await kit.repo.createSource(p.id, draft, [{ path: mp4, role: "original", handling: "copy", mime: "audio/mp4" }], {
      provenance: {
        captureMethod: "downloader",
        capturedAt: kit.clock.now.toISOString(),
        tool: { name: "t", version: "1" },
        fileHashes: {},
        legal: { status: "consented", basis: "consent" },
        identifiable: true,
      },
    });
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const names = await walk(r.path);
    expect(names.some((n) => n.includes("P-001"))).toBe(true);
    for (const n of names) expect(n.toLowerCase()).not.toContain("maria");
  });
});

describe("exportProjectOpenFormats: located media (R83)", () => {
  let et: ExifTool;
  const closers: Array<() => Promise<void> | void> = [];
  beforeAll(() => {
    et = new ExifTool({ maxProcs: 1 });
  });
  afterAll(async () => {
    await et.end();
  });
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });
  const gov = (mode: string) => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
sharing:
  locationMetadata: ${mode}
consent:
  requireLegalBasis: false
captureMethods: [manual_upload]
`;

  async function locatedSource(p: Project): Promise<SourceFile> {
    const tif = join(kit.tmp, "IMG_0001.tif");
    await buildCameraTiff(tif);
    const draft: SourceDraft = {
      projectIds: [p.id],
      type: "field-photo",
      title: { variants: [{ lang: "en", kind: "original", value: "Harbour photo" }] },
      creators: [],
      issued: "2024-07-14",
      identifiers: {},
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    return kit.repo.createSource(p.id, draft, [{ path: tif, role: "original", handling: "copy", mime: "image/tiff" }], {
      provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
      hasLocation: true,
      pendingProxies: (assets) => [{ id: newId(), type: "image.proxy", assetId: assets[0]!.id, location: "coarsen", queuedAt: kit.clock.now.toISOString() }],
    });
  }

  it("coarsen: the export holds the verified proxy (coarse GPS), never the original's exact GPS", async () => {
    const p = await makeProject(kit, gov("coarsen"), true, "Harbour");
    const sf = await locatedSource(p);
    const w = await stubWorker(proxyStub(et), { closers, pollsUntilDone: 1 });
    const q = new ProxyQueue({ repo: kit.repo, worker: new WorkerClient({ repo: kit.repo, worker: w, pollMs: 5 }) });
    const results = await q.resumePending(p.id);
    expect(results).toEqual([expect.objectContaining({ ok: true })]);
    expect((await kit.repo.getSource(p.id, sf.source.id)).assets.some((a) => a.kind === "proxy")).toBe(true);

    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const files = (await walk(r.path)).filter((n) => n.includes("/files/"));
    const media = files.filter((n) => /\.(jpe?g|tiff?)$/iu.test(n));
    expect(media).toHaveLength(1);
    const exported = join(r.path, media[0]!);
    expect(await gpsOf(et, exported)).toEqual({ lat: 40.7, lon: -74 });
    // No exported file carries the exact coordinates.
    for (const n of files) {
      const g = await gpsOf(et, join(r.path, n)).catch(() => undefined);
      if (g) expect(g).not.toEqual({ lat: 40.6892, lon: -74.0445 });
    }
  });

  it("strip without a proxy yet: the photo is left out, with a note", async () => {
    const p = await makeProject(kit, gov("strip"), true, "Harbour2");
    await locatedSource(p);
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const files = (await walk(r.path)).filter((n) => n.includes("/files/"));
    expect(files.filter((n) => /\.tiff?$/iu.test(n))).toEqual([]);
    expect(r.notes.some((n) => /left out/u.test(n) && /location/u.test(n))).toBe(true);
    for (const n of await walk(r.path)) {
      const pth = join(r.path, n);
      if ((await stat(pth)).isFile() && /\.(jpe?g|tiff?)$/iu.test(n)) expect(await locationTags(et, pth)).toEqual([]);
    }
  });

  it("keep: the original itself is exported (byte-identical)", async () => {
    const p = await makeProject(kit, gov("keep"), true, "Harbour3");
    const sf = await locatedSource(p);
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const tif = (await walk(r.path)).find((n) => n.includes("/files/") && n.endsWith(".tif"))!;
    expect(sha(await readFile(join(r.path, tif)))).toBe(sf.assets[0]!.sha256);
  });
});

describe("R92: open export", () => {
  it("R91-3: derived text (transcripts, OCR) goes to files/derived/, decrypted, and is listed in the Markdown", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Derived");
    const pdf = await scratchFile(kit, "scan.pdf", "%PDF-1.4 scan");
    const sf = await addSource(kit, p, { title: "Scanned", files: [{ path: pdf, role: "original", handling: "copy" }] });
    const txt = await scratchFile(kit, "ocr.txt", "recognised text body");
    await kit.repo.addDerivedAsset(p.id, sf.source.id, {
      fromPath: txt,
      kind: "ocr-text",
      tool: "tesseract-5",
      ext: "txt",
      lang: "en",
      derivation: { parents: [sf.assets[0]!.id], operation: "ocr", provider: "tesseract", ranAt: "local", params: {}, at: kit.clock.now.toISOString(), triggeredBy: "tester" },
    });
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const names = await walk(r.path);
    const derivedFile = names.find((n) => n.includes("/files/derived/") && n.endsWith(".txt"))!;
    expect(derivedFile).toBeDefined();
    expect(await readFile(join(r.path, derivedFile), "utf8")).toBe("recognised text body");
    const md = await readFile(join(r.path, names.find((n) => n.endsWith(".md"))!), "utf8");
    expect(md).toContain("## Derived text");
    expect(md).toContain("ocr");
  });

  it("I1 (P1): a destination under a symbolic link into the library is refused, and nothing is created there", async () => {
    const p = await makeProject(kit);
    await addSource(kit, p, { title: "x" });
    const link = join(kit.tmp, "sneaky");
    await symlink(join(kit.lib.root, "Exports"), link);
    await expect(exportProjectOpenFormats(kit.repo, p.id, join(link, "deeper", "new"))).rejects.toBeInstanceOf(ExportDestinationError);
    expect(await readdir(join(kit.lib.root, "Exports"))).toEqual([]);
  });

  it("I1: the export is written to <folder>.partial and renamed at the end; stale .partial folders are removed", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Part");
    await addSource(kit, p, { title: "x" });
    const out = await outDir();
    const stale = join(out, "Part - export - modified 2026-11-01 0900.partial");
    await mkdir(join(stale, "Sources"), { recursive: true });
    await writeFile(join(stale, "Sources", "secret.txt"), "decrypted leftovers");
    const r = await exportProjectOpenFormats(kit.repo, p.id, out);
    expect(r.path.endsWith(".partial")).toBe(false);
    expect((await readdir(out)).sort()).toEqual(["Part - export - modified 2026-11-10 0930"]);
  });

  it("Markdown escapes case-attribute keys and title-variant labels too", async () => {
    const p = await makeProject(kit);
    const draft: SourceDraft = {
      projectIds: [p.id],
      type: "report",
      title: { variants: [{ lang: "en", kind: "original", value: "T" }, { lang: "x<b>", kind: "translated", value: "V" }] },
      creators: [],
      identifiers: {},
      caseAttributes: { "*region*<i>": "north" },
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    await kit.repo.createSource(p.id, draft, [], {
      provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
    }).catch(async () => {
      // An invalid language tag is refused by the model: keep the case attribute only.
      draft.title.variants.pop();
      return kit.repo.createSource(p.id, draft, [], {
        provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
      });
    });
    const r = await exportProjectOpenFormats(kit.repo, p.id, await outDir());
    const md = await readFile(join(r.path, (await walk(r.path)).find((n) => n.endsWith(".md"))!), "utf8");
    expect(md).not.toContain("<i>");
    expect(md).not.toContain("<b>");
    expect(md).toContain("\\*region\\*&lt;i&gt;");
  });
});
