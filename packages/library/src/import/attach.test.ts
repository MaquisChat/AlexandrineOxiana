import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent, SourceFile } from "@ao/core";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_DOI, buildCameraTiff, buildDoiPdf, buildPdf, tinyPng } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import { shutdownExtractors } from "../extract/index.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient, lookupContextFor } from "../lookup/index.js";
import { parseReviewFile, REVIEW_FILE, type ReviewEntry } from "../repo/review.js";
import { kindFor, mimeFor, openLine } from "../repo/io.js";
import type { Repo } from "../repo/repo.js";
import { projectDataKey } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { ACCEPTED_EXTENSIONS, createAttach, type Attach } from "./attach.js";
import { AUTO_ACCEPT_THRESHOLD, resolveItem } from "./resolve.js";

const FAST = 2 ** 10;
const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures/lookup");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");
const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const MISMATCH_DOI = "10.5555/ao.fixture.mismatch.007";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
`;
const NO_LOOKUP_GOV = `${GOV}processing:
  metadata_lookup: []
`;
const NO_UPLOAD_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [downloader]
`;
const ENC_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
captureMethods: [manual_upload]
`;

let tmp: string;
let files: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let agent: MockAgent;
let http: HttpClient;
let attach: Attach;

function deps(): Deps {
  return {
    clock: () => new Date(),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

async function project(gov = GOV, encrypted = false) {
  const { project } = await repo.createProject({
    name: `P${Math.random().toString(36).slice(2, 7)}`,
    governanceYaml: gov,
    encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
  });
  return project;
}

async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, projectFolder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

async function reviewEntries(projectId: string, projectFolder: string): Promise<ReviewEntry[]> {
  let text: string;
  try {
    text = await readFile(join(lib.root, projectFolder, ...REVIEW_FILE.split("/")), "utf8");
  } catch {
    return [];
  }
  const k = projectDataKey(repo, projectId);
  return parseReviewFile(text, projectId, k ? k.key : null).entries;
}

async function put(name: string, data: Buffer | string): Promise<string> {
  const p = join(files, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
  return p;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const crossref = () => agent.get("https://api.crossref.org");
const openalex = () => agent.get("https://api.openalex.org");
const searchPath = (p: string) => p.startsWith("/works?");

function crossrefFor(doi: string): string {
  const j = JSON.parse(fixture("crossref-work.json")) as { message: Record<string, unknown> };
  j.message.DOI = doi;
  return JSON.stringify(j);
}

function searchResults(titles: string[]): string {
  return JSON.stringify({
    results: titles.map((t, i) => ({ title: t, publication_year: 2000 + i, type: "article", authorships: [{ author: { display_name: "Some Author" } }] })),
  });
}

const slidesPdf = () =>
  buildPdf({
    title: "Field Notes on Market Days",
    lines: ["Field Notes on Market Days", "Slides for the panel on informal economies.", "Thank you for listening, questions welcome."],
  });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-attach-"));
  files = join(tmp, "Desktop");
  await mkdir(files);
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
  agent = new MockAgent();
  agent.disableNetConnect();
  http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  attach = createAttach({ repo, http });
});

afterAll(async () => {
  await shutdownExtractors();
});

afterEach(async () => {
  await agent.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("attachFiles: drop on the library", () => {
  it("creates a source from a PDF whose DOI resolves (Crossref), confidence ≥ 0.9, title from Crossref", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const bytes = await buildDoiPdf();
    const path = await put("doi-article.pdf", bytes);

    const [r] = await attach.attachFiles(p.id, [path]);
    expect(r).toMatchObject({ path, outcome: "created" });
    agent.assertNoPendingInterceptors();

    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Rivers and Memory in Upland Villages");
    expect(sf.source.type).toBe("article-journal");
    expect(sf.source.container?.variants[0]?.value).toBe("Journal of Upland Studies");
    expect(sf.source.identifiers.doi).toBe(FIXTURE_DOI);
    expect(sf.source.provenance.captureMethod).toBe("manual_upload");
    expect(sf.source.provenance.identification?.method).toBe("identifier+lookup");
    expect(sf.source.provenance.identification!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(JSON.stringify(sf.source.provenance)).not.toContain(tmp);
    // Every filled field has evidence; the title's includes the Crossref lookup.
    expect(sf.fieldEvidence.some((e) => e.field === "/title" && e.source.kind === "lookup" && e.source.provider === "crossref")).toBe(true);
    for (const f of ["/title", "/creators", "/issued", "/container", "/identifiers/doi"]) {
      expect(sf.fieldEvidence.some((e) => e.field === f), f).toBe(true);
    }
    // The file is copied (never moved) into original/, hash recorded.
    const pdf = sf.assets.find((a) => a.role === "original")!;
    expect(pdf.path).toMatch(/\/original\/[^/]+\.pdf$/);
    expect(pdf.sha256).toBe(sha256(bytes));
    expect(pdf.mime).toBe("application/pdf");
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(join(lib.root, ...pdf.path.split("/")))).toEqual(bytes);

    // One governed mutation: capture (manual_upload) and store, each allowed and carrying the txn.
    const events = (await auditEvents(p.folder)).filter((e) => e.details?.op === "source.create");
    expect(events.map((e) => e.action).sort()).toEqual(["capture", "store"]);
    expect(new Set(events.map((e) => e.details?.txn)).size).toBe(1);
    expect(events.every((e) => e.decision?.result !== "deny" && typeof e.details?.txn === "string")).toBe(true);
    expect(await reviewEntries(p.id, p.folder)).toEqual([]);
  });

  it("dropping the same PDF again (any name) is a duplicate of the first source, with no new lookup", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const path = await put("doi-article.pdf", await buildDoiPdf());
    const [first] = await attach.attachFiles(p.id, [path]);
    expect(first!.outcome).toBe("created");

    const again = await attach.attachFiles(p.id, [path]);
    expect(again).toEqual([{ path, outcome: "duplicate", sourceId: first!.sourceId }]);
    const renamed = join(files, "copy of it.pdf");
    await copyFile(path, renamed);
    expect((await attach.attachFiles(p.id, [renamed]))[0]).toMatchObject({ outcome: "duplicate", sourceId: first!.sourceId });
    expect(repo.listSourceIds(p.id)).toHaveLength(1);
  });

  it("the same DOI in a different file is a (certain) duplicate", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const [first] = await attach.attachFiles(p.id, [await put("doi-article.pdf", await buildDoiPdf())]);
    const other = await put(
      "other.pdf",
      await buildPdf({ title: "Rivers and Memory in Upland Villages", author: "Amara Okafor", lines: ["Rivers and Memory in Upland Villages", `doi:${FIXTURE_DOI}`] }),
    );
    // Served from the lookup cache.
    expect((await attach.attachFiles(p.id, [other]))[0]).toMatchObject({ outcome: "duplicate", sourceId: first!.sourceId });
  });

  it("conference_slides.pdf with only an embedded title goes to review (persisted in review/pending.jsonl)", async () => {
    const p = await project();
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).times(1);
    const path = await put("conference_slides.pdf", await slidesPdf());
    const [r] = await attach.attachFiles(p.id, [path]);
    expect(r).toMatchObject({ outcome: "needs-review" });
    expect(r!.sourceId).toBeDefined();
    agent.assertNoPendingInterceptors();

    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Field Notes on Market Days");
    expect(sf.source.provenance.identification!.method).toBe("embedded");
    expect(sf.source.provenance.identification!.confidence).toBeLessThan(AUTO_ACCEPT_THRESHOLD);
    expect(sf.fieldEvidence).toContainEqual(expect.objectContaining({ field: "/title", source: expect.objectContaining({ kind: "embedded" }) }));

    const pending = await reviewEntries(p.id, p.folder);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sourceId: r!.sourceId, kind: "import", status: "pending" });
    expect(pending[0]!.confidence).toBeLessThan(AUTO_ACCEPT_THRESHOLD);
    const raw = await readFile(join(lib.root, p.folder, ...REVIEW_FILE.split("/")), "utf8");
    expect(raw).not.toContain(tmp);
    expect(raw).not.toContain(files);
  });

  it("a DOI that resolves to a different title than the document goes to review with a /title conflict (R49e)", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${MISMATCH_DOI}`, method: "GET" }).reply(200, crossrefFor(MISMATCH_DOI), JSON_HEADERS).times(1);
    const path = await put(
      "harvest.pdf",
      await buildPdf({
        title: "Harvest Songs of the Northern Coast",
        author: "Mara Ilunga",
        lines: ["Harvest Songs of the Northern Coast", "Mara Ilunga", `https://doi.org/${MISMATCH_DOI}`, "We recorded work songs sung during the harvest."],
      }),
    );
    const [r] = await attach.attachFiles(p.id, [path]);
    expect(r).toMatchObject({ outcome: "needs-review" });
    agent.assertNoPendingInterceptors();

    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.provenance.identification!.method).toBe("identifier+lookup");
    expect(sf.source.provenance.identification!.confidence).toBeLessThan(AUTO_ACCEPT_THRESHOLD);
    expect(sf.verification["/title"]?.status).toBe("conflict");
    const pending = await reviewEntries(p.id, p.folder);
    expect(pending[0]!.fields["/title"]).toBe("conflict");
    // The lookup's work is kept as a candidate for the review.
    expect(pending[0]!.candidates?.[0]).toMatchObject({ title: "Rivers and Memory in Upland Villages", provider: "crossref" });
  });

  it("a likely (fuzzy) duplicate goes to review with the candidate recorded", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const a = await put(
      "Okafor - 2021 - Songs of the River Delta.pdf",
      await buildPdf({ title: "Songs of the River Delta", author: "Amara Okafor", lines: ["Songs of the River Delta", "Amara Okafor"] }),
    );
    const [first] = await attach.attachFiles(p.id, [a]);
    expect(first!.outcome).toBe("needs-review");
    const b = await put(
      "Okafor - 2021 - Songs of the River Delta (preprint).pdf",
      await buildPdf({ title: "Songs of the River Delta", author: "Amara Okafor", lines: ["Songs of the River Delta", "Amara Okafor", "Preprint version"], extra: "v2" }),
    );
    const [second] = await attach.attachFiles(p.id, [b]);
    expect(second).toMatchObject({ outcome: "needs-review" });
    expect(second!.sourceId).not.toBe(first!.sourceId);
    expect(second!.reason).toMatch(/duplicate/i);
    const entry = (await reviewEntries(p.id, p.folder)).find((e) => e.sourceId === second!.sourceId)!;
    expect(entry.duplicateOf).toEqual({ sourceId: first!.sourceId, reason: "fuzzy" });
  });

  it("uses a sidecar file next to the item (RIS)", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("scan0001.pdf", await buildPdf({ lines: ["Some page text without a title that we could use."] }));
    await put("scan0001.ris", "TY  - JOUR\nTI  - Weaving and Kinship in Highland Markets\nAU  - Adebayo, Ngozi\nPY  - 2009\nJO  - Journal of Craft Studies\nER  - \n");
    const [r] = await attach.attachFiles(p.id, [path]);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Weaving and Kinship in Highland Markets");
    expect(sf.source.creators[0]).toMatchObject({ family: "Adebayo", given: "Ngozi" });
    expect(sf.source.provenance.identification!.method).toBe("sidecar");
    expect(sf.fieldEvidence).toContainEqual(expect.objectContaining({ field: "/title", source: expect.objectContaining({ kind: "refman" }) }));
    // Only the PDF is stored; the sidecar is metadata.
    expect(sf.assets).toHaveLength(1);
  });

  it("a project denying manual_upload → failed with the plain-language policy reason, nothing stored, deny audited", async () => {
    const p = await project(NO_UPLOAD_GOV);
    const path = await put("doi-article.pdf", await buildDoiPdf());
    const out = await attach.attachFiles(p.id, [path]);
    expect(out).toEqual([{ path, outcome: "failed", reason: "Capture method manual_upload is not enabled for this project" }]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    const denies = (await auditEvents(p.folder)).filter((e) => e.decision?.result === "deny");
    expect(denies.map((e) => e.action)).toEqual(["capture"]);
  });

  it("governance changed during the lookup: the store is re-evaluated (R42), nothing saved, deny audited", async () => {
    const p = await project();
    crossref()
      .intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" })
      .reply(() => {
        writeFileSync(join(lib.root, p.folder, "governance.yaml"), NO_UPLOAD_GOV);
        return { statusCode: 200, data: fixture("crossref-work.json"), responseOptions: JSON_HEADERS };
      });
    const path = await put("doi-article.pdf", await buildDoiPdf());
    expect(await attach.attachFiles(p.id, [path])).toEqual([{ path, outcome: "failed", reason: "Capture method manual_upload is not enabled for this project" }]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    const denies = (await auditEvents(p.folder)).filter((e) => e.decision?.result === "deny");
    expect(denies.map((e) => [e.action, e.details?.op])).toEqual([["capture", "source.create"]]);
    expect(await readdir(join(lib.root, p.folder, "Sources")).catch(() => [])).toEqual([]);
  });

  it("a dropped folder is refused: Bulk Import handles folders", async () => {
    const p = await project();
    const dir = join(files, "My papers");
    await mkdir(dir);
    await put("My papers/a.pdf", await slidesPdf());
    expect(await attach.attachFiles(p.id, [dir])).toEqual([{ path: dir, outcome: "failed", reason: "Use Bulk Import for folders" }]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("sniffs the type instead of trusting the extension; unsupported files fail with a clear reason (no path)", async () => {
    const p = await project();
    const fake = await put("not really.pdf", "just some plain text, not a PDF at all");
    const missing = join(files, "gone.pdf");
    const out = await attach.attachFiles(p.id, [fake, missing]);
    expect(out[0]).toMatchObject({ path: fake, outcome: "failed" });
    expect(out[0]!.reason).toMatch(/kind of file cannot be attached/);
    expect(out[1]).toMatchObject({ path: missing, outcome: "failed" });
    for (const o of out) expect(o.reason).not.toContain(files);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a PNG with a wrong extension is stored with its real type", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("photo.dat", tinyPng());
    const [r] = await attach.attachFiles(p.id, [path]);
    expect(["created", "needs-review"]).toContain(r!.outcome);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.type).toBe("image");
    expect(sf.assets[0]!.path).toMatch(/\.png$/);
    expect(sf.assets[0]!.mime).toBe("image/png");
  });

  it("encrypted project: lookup is sensitive (nothing in .cache), files encrypted at rest, review sealed", async () => {
    const p = await project(ENC_GOV, true);
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const bytes = await buildDoiPdf();
    const [r] = await attach.attachFiles(p.id, [await put("doi-article.pdf", bytes)]);
    expect(r!.outcome).toBe("created");
    agent.assertNoPendingInterceptors();
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Rivers and Memory in Upland Villages");
    const asset = sf.assets[0]!;
    expect(asset.encrypted).toBe(true);
    expect(asset.sha256).toBe(sha256(bytes));
    const stored = await readFile(join(lib.root, ...asset.path.split("/")));
    expect(stored.includes(Buffer.from("Rivers and Memory"))).toBe(false);
    const cacheFiles = await readdir(join(lib.root, ".cache", "lookups")).catch(() => [] as string[]);
    expect(cacheFiles).toEqual([]);

    // A needs-review item in an encrypted project is sealed.
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).times(1);
    const [s] = await attach.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    expect(s!.outcome).toBe("needs-review");
    const raw = await readFile(join(lib.root, p.folder, ...REVIEW_FILE.split("/")), "utf8");
    expect(raw).not.toContain("Field Notes");
    const k = projectDataKey(repo, p.id)!;
    expect(JSON.parse(openLine(k.key, p.id, raw.trim().split("\n")[0]!, "ao-review"))).toMatchObject({ sourceId: s!.sourceId });
  });
});

describe("attachFiles: drop onto a source", () => {
  it("adds the file as an original of that source (metadata unchanged); the same file again is a duplicate", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const [made] = await attach.attachFiles(p.id, [await put("doi-article.pdf", await buildDoiPdf())]);
    const before = await repo.getSource(p.id, made!.sourceId!);

    const png = await put("figure 1.png", tinyPng());
    const out = await attach.attachFiles(p.id, [png], { toSourceId: made!.sourceId! });
    expect(out).toEqual([{ path: png, outcome: "attached", sourceId: made!.sourceId }]);
    const after = await repo.getSource(p.id, made!.sourceId!);
    expect(after.assets).toHaveLength(2);
    const added = after.assets.find((a) => a.mime === "image/png")!;
    expect(added.role).toBe("original");
    expect(added.path.startsWith(`${before.source.folder}/original/`)).toBe(true);
    expect(after.source.title).toEqual(before.source.title);
    expect(after.source.creators).toEqual(before.source.creators);
    expect(after.source.provenance).toEqual(before.source.provenance);

    // Governed: capture (manual_upload) and store in one audited transaction.
    const events = (await auditEvents(p.folder)).filter((e) => e.details?.op === "asset.add-original");
    expect(events.map((e) => e.action).sort()).toEqual(["capture", "store"]);
    expect(new Set(events.map((e) => e.details?.txn)).size).toBe(1);

    expect(await attach.attachFiles(p.id, [png], { toSourceId: made!.sourceId! })).toEqual([{ path: png, outcome: "duplicate", sourceId: made!.sourceId }]);
    expect((await repo.getSource(p.id, made!.sourceId!)).assets).toHaveLength(2);
  });

  it("onto a source of a project denying manual_upload → failed with the policy reason", async () => {
    const p = await project(GOV);
    const path = await put("conference_slides.pdf", await slidesPdf());
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).times(1);
    const [made] = await attach.attachFiles(p.id, [path]);
    await writeFile(join(lib.root, p.folder, "governance.yaml"), NO_UPLOAD_GOV);
    const png = await put("figure.png", tinyPng());
    expect(await attach.attachFiles(p.id, [png], { toSourceId: made!.sourceId! })).toEqual([
      { path: png, outcome: "failed", reason: "Capture method manual_upload is not enabled for this project" },
    ]);
  });
});

describe("resolveItem", () => {
  it("auto-accept threshold is 0.9", () => {
    expect(AUTO_ACCEPT_THRESHOLD).toBe(0.9);
  });

  it("keeps at most 3 candidates from the title search; reference metadata (0.9) stops before any lookup", async () => {
    const p = await project();
    const lookup = await lookupContextFor(repo, p.id, http);
    openalex()
      .intercept({ path: searchPath, method: "GET" })
      .reply(200, searchResults(["Field Notes on Market Days", "Field Notes", "Market Days", "Notes on Markets", "Days"]), JSON_HEADERS)
      .times(1);
    const path = await put("conference_slides.pdf", await slidesPdf());
    const r = await resolveItem({ path, mime: "application/pdf" }, { projectId: p.id, patterns: [], lookup });
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates[0]!.title).toBe("Field Notes on Market Days");
    expect(r.evidence.method).toBe("lookup-title-match");
    expect(r.confidence).toBeLessThan(0.9);
    expect(r.needsOcr).toBe(false);

    const ref = await resolveItem(
      {
        path,
        mime: "application/pdf",
        referenceMetadata: { type: "presentation", title: { variants: [{ lang: "en", kind: "original", value: "Field Notes on Market Days" }] }, creators: [{ family: "Okafor", given: "Amara", role: "author" }], issued: "2021" },
      },
      { projectId: p.id, patterns: [], lookup },
    );
    expect(ref.evidence.method).toBe("reference-metadata");
    expect(ref.confidence).toBe(0.9);
    expect(ref.draft.type).toBe("presentation");
    agent.assertNoPendingInterceptors();
  });

  it("identifier+lookup scores 0.97 when no local title evidence exists", async () => {
    const p = await project();
    const lookup = await lookupContextFor(repo, p.id, http);
    crossref().intercept({ path: `/works/${MISMATCH_DOI}`, method: "GET" }).reply(200, crossrefFor(MISMATCH_DOI), JSON_HEADERS).times(1);
    const path = await put("scan0002.pdf", await buildPdf({ lines: ["Rivers and Memory in Upland Villages", "Amara Okafor and Henrik Lindqvist", `doi:${MISMATCH_DOI}`] }));
    const r = await resolveItem({ path, mime: "application/pdf" }, { projectId: p.id, patterns: [], lookup });
    expect(r.evidence.method).toBe("identifier+lookup");
    expect(r.confidence).toBe(0.97);
    expect(r.draft.identifiers.doi).toBe(MISMATCH_DOI);
  });
});

describe("review round 1 (R55)", () => {
  const harvestCiting = () =>
    buildPdf({
      title: "Harvest Songs of the Northern Coast",
      author: "Mara Ilunga",
      lines: ["Harvest Songs of the Northern Coast", "Mara Ilunga", `As shown by Okafor (https://doi.org/${FIXTURE_DOI}), rivers matter.`],
    });

  it("1: a paper citing a DOI already in the library is not its duplicate (lookups on); the cited DOI is only a hint", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const [first] = await attach.attachFiles(p.id, [await put("doi-article.pdf", await buildDoiPdf())]);
    expect(first!.outcome).toBe("created");
    const [second] = await attach.attachFiles(p.id, [await put("harvest.pdf", await harvestCiting())]);
    expect(["needs-review", "created"]).toContain(second!.outcome);
    expect(second!.sourceId).toBeDefined();
    expect(second!.sourceId).not.toBe(first!.sourceId);
    const sf = await repo.getSource(p.id, second!.sourceId!);
    expect(sf.source.identifiers.doi).toBeUndefined();
    expect(sf.source.title.variants[0]!.value).toBe("Harvest Songs of the Northern Coast");
    const entry = (await reviewEntries(p.id, p.folder)).find((e) => e.sourceId === second!.sourceId)!;
    expect(entry.hints).toContain(`doi:${FIXTURE_DOI}`);
  });

  it("1: the same with metadata_lookup off: never a duplicate, no unconfirmed DOI in the draft, sent to review", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const [first] = await attach.attachFiles(p.id, [await put("doi-article.pdf", await buildDoiPdf())]);
    expect(first!.outcome).toBe("needs-review");
    expect((await repo.getSource(p.id, first!.sourceId!)).source.identifiers.doi).toBeUndefined();
    const [second] = await attach.attachFiles(p.id, [await put("harvest.pdf", await harvestCiting())]);
    expect(second!.outcome).toBe("needs-review");
    expect(second!.sourceId).not.toBe(first!.sourceId);
    expect((await repo.getSource(p.id, second!.sourceId!)).source.identifiers.doi).toBeUndefined();
    const entry = (await reviewEntries(p.id, p.folder)).find((e) => e.sourceId === second!.sourceId)!;
    expect(entry.hints).toContain(`doi:${FIXTURE_DOI}`);
    expect(repo.listSourceIds(p.id)).toHaveLength(2);
  });

  it("2: a lookup title not grounded in the document text (no local title) goes to review", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${MISMATCH_DOI}`, method: "GET" }).reply(200, crossrefFor(MISMATCH_DOI), JSON_HEADERS).times(1);
    const path = await put("scan0003.pdf", await buildPdf({ lines: ["Minutes of the village water committee, spring meeting.", `Background reading: doi:${MISMATCH_DOI}`] }));
    const [r] = await attach.attachFiles(p.id, [path]);
    expect(r!.outcome).toBe("needs-review");
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.provenance.identification!.confidence).toBeLessThanOrEqual(0.6);
    expect(sf.source.identifiers.doi).toBeUndefined();
  });

  it("2: an image (no text) identified only by a lookup goes to review", async () => {
    const p = await project();
    const lookup = await lookupContextFor(repo, p.id, http);
    crossref().intercept({ path: `/works/${MISMATCH_DOI}`, method: "GET" }).reply(200, crossrefFor(MISMATCH_DOI), JSON_HEADERS).times(1);
    const path = await put("figure.png", tinyPng());
    const r = await resolveItem(
      { path, mime: "image/png", referenceMetadata: { identifiers: { doi: MISMATCH_DOI } } },
      { projectId: p.id, patterns: [], lookup },
    );
    expect(r.confidence).toBeLessThanOrEqual(0.6);
  });

  it("4: dropping onto an identifiable source uses the source's own legal basis (GDPR, no manual-upload default)", async () => {
    const p = await project(
      `profiles: [gdpr]
identifiability:
  containsIdentifiable: true
encryption:
  atRest: required
captureMethods: [manual_upload]
`,
      true,
    );
    const pdf = await put("interview notes.pdf", await slidesPdf());
    const sf = await repo.createSource(
      p.id,
      {
        projectIds: [],
        type: "other",
        title: { variants: [{ lang: "en", kind: "original", value: "Interview notes" }] },
        creators: [],
        identifiers: {},
        caseAttributes: {},
        collectionIds: [],
        tagIds: [],
        participantIds: [],
        availability: { status: "available" },
      },
      [{ path: pdf, role: "original", handling: "copy" }],
      {
        provenance: {
          captureMethod: "manual_upload",
          capturedAt: new Date().toISOString(),
          tool: { name: "test", version: "0" },
          fileHashes: {},
          legal: { status: "consented", basis: "consent (GDPR Art. 6(1)(a))" },
          identifiable: true,
        },
      },
    );
    const png = await put("figure.png", tinyPng());
    expect(await attach.attachFiles(p.id, [png], { toSourceId: sf.source.id })).toEqual([{ path: png, outcome: "attached", sourceId: sf.source.id }]);
  });

  it("5 (R54a): dropped media with GPS sends hasLocation: denied where location must be stripped without encryption", async () => {
    const p = await project(`identifiability:
  containsIdentifiable: false
encryption:
  atRest: "off"
sharing:
  locationMetadata: strip
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`);
    const tif = join(files, "IMG_0001.tif");
    await buildCameraTiff(tif);
    expect(await attach.attachFiles(p.id, [tif])).toEqual([
      { path: tif, outcome: "failed", reason: "Location data requires encryption or locationMetadata: keep" },
    ]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    const denies = (await auditEvents(p.folder)).filter((e) => e.decision?.result === "deny");
    expect(denies.map((e) => e.action)).toEqual(["store"]);
  });

  it("6 (R54b): file dates never fill issued", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const [r] = await attach.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.issued).toBeUndefined();
    expect(sf.fieldEvidence.some((e) => e.field === "/issued")).toBe(false);
  });

  it("7: the default legal basis category is 'manual-upload'", async () => {
    const p = await project(`identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    manual-upload: "legitimate interest; ethics approval 2026-01"
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`);
    const [r] = await attach.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    expect(r!.outcome).toBe("needs-review");
    expect((await repo.getSource(p.id, r!.sourceId!)).source.provenance.legal.basis).toBe("legitimate interest; ethics approval 2026-01");
  });

  it("8: every accepted media type has its MIME type and kind", () => {
    const cases: Array<[string, string, string]> = [
      ["mobi", "application/x-mobipocket-ebook", "ebook"],
      ["azw", "application/vnd.amazon.ebook", "ebook"],
      ["azw3", "application/vnd.amazon.mobi8-ebook", "ebook"],
      ["cr3", "image/x-canon-cr3", "image"],
      ["dng", "image/x-adobe-dng", "image"],
      ["nef", "image/x-nikon-nef", "image"],
      ["heif", "image/heif", "image"],
      ["heic", "image/heic", "image"],
      ["avif", "image/avif", "image"],
      ["mkv", "video/x-matroska", "video"],
      ["avi", "video/vnd.avi", "video"],
      ["m4v", "video/x-m4v", "video"],
      ["3gp", "video/3gpp", "video"],
      ["flac", "audio/flac", "audio"],
      ["aac", "audio/aac", "audio"],
    ];
    for (const [ext, mime, kind] of cases) expect([ext, mimeFor(ext), kindFor(ext)]).toEqual([ext, mime, kind]);
    for (const ext of ACCEPTED_EXTENSIONS) expect([ext, mimeFor(ext)]).not.toEqual([ext, "application/octet-stream"]);
  });
});
