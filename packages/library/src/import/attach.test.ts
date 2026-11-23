import { createHash } from "node:crypto";
import fs, { readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent, SourceFile } from "@ao/core";
import { MockAgent } from "undici";
import { DEFAULT_GOVERNANCE, LOCATION_NEEDS_ENCRYPTION, findDuplicate, parseGovernanceWithWarnings } from "@ao/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ExifTool } from "exiftool-vendored";
import { FIXTURE_DOI, buildCameraTiff, buildDoiPdf, buildPdf, tinyPng } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import { shutdownExtractors } from "../extract/index.js";
import { extractExif, setExifReaderForTests } from "../extract/exif.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient, lookupContextFor } from "../lookup/index.js";
import { parseReviewFile, REVIEW_FILE, type ReviewEntry } from "../repo/review.js";
import { kindFor, mimeFor, openLine } from "../repo/io.js";
import type { Repo } from "../repo/repo.js";
import { projectDataKey } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { WorkerClient } from "../worker-client.js";
import { stubWorker } from "../worker-testing.js";
import { decryptBytes } from "../repo/io.js";
import { ACCEPTED_EXTENSIONS, LOCATION_REASON, NOT_DOWNLOADED_REASON, acceptedType, createAttach, type Attach } from "./attach.js";
import { findSidecars } from "./sidecar.js";
import { ProxyQueue } from "./proxies.js";
import { gpsOf, locationTags, proxyStub } from "./proxy-testing.js";
import { AUTO_ACCEPT_THRESHOLD, LOOKED_UP_FROM_TEXT, mayHaveLocation, resolveItem } from "./resolve.js";

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

/** A plaintext copy of a stored asset (decrypted with the project key in encrypted projects). */
async function plainCopy(p: { id: string }, rel: string): Promise<string> {
  const abs = join(lib.root, ...rel.split("/"));
  const out = join(tmp, "plain", `${Math.random().toString(36).slice(2)}.${rel.replace(/\.enc$/u, "").split(".").pop()}`);
  await mkdir(dirname(out), { recursive: true });
  const k = projectDataKey(repo, p.id);
  if (!k) await copyFile(abs, out);
  else await writeFile(out, await decryptBytes((id) => (id === k.keyId ? k.key : undefined), await readFile(abs)));
  return out;
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
        referenceMetadata: {
          type: "presentation",
          title: { variants: [{ lang: "en", kind: "original", value: "Field Notes on Market Days" }] },
          creators: [{ family: "Okafor", given: "Amara", role: "author" }],
          issued: "2021",
          publisherPlace: "Lagos",
          genre: "Conference slides",
        },
      },
      { projectId: p.id, patterns: [], lookup },
    );
    expect(ref.evidence.method).toBe("reference-metadata");
    expect(ref.confidence).toBe(0.9);
    expect(ref.draft.type).toBe("presentation");
    expect(ref.draft).toMatchObject({ publisherPlace: "Lagos", genre: "Conference slides" });
    expect(ref.fieldEvidence.find((e) => e.field === "/publisherPlace")).toMatchObject({ value: "Lagos", source: { kind: "refman" } });
    agent.assertNoPendingInterceptors();
  });

  it("with no local title, a grounded text identifier is still only a hint: capped at 0.6, no DOI (R57)", async () => {
    const p = await project();
    const lookup = await lookupContextFor(repo, p.id, http);
    crossref().intercept({ path: `/works/${MISMATCH_DOI}`, method: "GET" }).reply(200, crossrefFor(MISMATCH_DOI), JSON_HEADERS).times(1);
    const path = await put("scan0002.pdf", await buildPdf({ lines: ["Rivers and Memory in Upland Villages", "Amara Okafor and Henrik Lindqvist", `doi:${MISMATCH_DOI}`] }));
    const r = await resolveItem({ path, mime: "application/pdf" }, { projectId: p.id, patterns: [], lookup });
    expect(r.evidence.method).toBe("identifier+lookup");
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect(r.draft.identifiers.doi).toBeUndefined();
    expect(r.identifierHints).toEqual([`doi:${MISMATCH_DOI}`]);
    // The lookup's values are still offered for review.
    expect(r.draft.title.variants[0]!.value).toBe("Rivers and Memory in Upland Villages");
    expect(r.candidates[0]).toMatchObject({ provider: "crossref" });
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

describe("R83: location-conditioned media are stored; their viewing proxies follow the project's location rule", () => {
  const gov = (mode: string) => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
sharing:
  locationMetadata: ${mode}
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
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

  async function withWorker(opts: { lie?: boolean } = {}) {
    const w = await stubWorker(proxyStub(et, opts), { closers, pollsUntilDone: 1 });
    const proxies = new ProxyQueue({ repo, worker: new WorkerClient({ repo, worker: w, pollMs: 5 }) });
    return { attach: createAttach({ repo, http, proxies }), proxies };
  }

  for (const mode of ["coarsen", "strip"] as const) {
    it(`locationMetadata ${mode}: a dropped photo with GPS is stored encrypted with its GPS; its proxy follows the rule (re-read)`, async () => {
      const { attach, proxies } = await withWorker();
      const p = await project(gov(mode), true);
      const tif = join(files, "IMG_0001.tif");
      await buildCameraTiff(tif);
      const [r] = await attach.attachFiles(p.id, [tif]);
      expect(["created", "needs-review"]).toContain(r!.outcome);
      expect(r!.note).toBeUndefined();
      await proxies.idle();
      const sf = await repo.getSource(p.id, r!.sourceId!);
      const original = sf.assets.find((a) => a.role === "original")!;
      expect(original.encrypted).toBe(true);
      expect(await gpsOf(et, await plainCopy(p, original.path))).toEqual({ lat: 40.6892, lon: -74.0445 });
      const proxy = sf.assets.find((a) => a.role === "derived")!;
      expect(proxy).toMatchObject({ kind: "proxy", encrypted: true, derivation: { operation: "image.proxy", parents: [original.id], params: { location: mode } } });
      const plain = await plainCopy(p, proxy.path);
      if (mode === "coarsen") expect(await gpsOf(et, plain)).toEqual({ lat: 40.7, lon: -74 });
      else expect(await locationTags(et, plain)).toEqual([]);
      expect(sf.pendingProxies ?? []).toEqual([]);
      const events = await auditEvents(p.folder);
      expect(events.filter((e) => e.decision?.result === "deny")).toEqual([]);
      const store = events.find((e) => e.action === "store" && e.entity?.id === sf.source.id)!;
      expect(store.decision?.conditions).toContainEqual({ type: "location", mode });
    });
  }

  it("no media worker: the photo is stored, the source is flagged proxy pending (LOCATION_REASON) and the job is kept with it", async () => {
    const p = await project(gov("coarsen"), true);
    const tif = join(files, "IMG_0001.tif");
    await buildCameraTiff(tif);
    const [r] = await attach.attachFiles(p.id, [tif]);
    expect(["created", "needs-review"]).toContain(r!.outcome);
    expect(r!.note).toBe(LOCATION_REASON);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.assets.filter((a) => a.role === "original")).toHaveLength(1);
    expect(sf.pendingProxies?.map((j) => [j.type, j.location, j.assetId])).toEqual([["image.proxy", "coarsen", sf.assets[0]!.id]]);
  });

  it("locationMetadata coarsen: a photo with GPS dropped onto a source is added as an original, and its proxy is made", async () => {
    const { attach, proxies } = await withWorker();
    const p = await project(gov("coarsen"), true);
    const [made] = await attach.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    const tif = join(files, "IMG_0002.tif");
    await buildCameraTiff(tif);
    expect(await attach.attachFiles(p.id, [tif], { toSourceId: made!.sourceId! })).toEqual([{ path: tif, outcome: "attached", sourceId: made!.sourceId }]);
    await proxies.idle();
    const sf = await repo.getSource(p.id, made!.sourceId!);
    expect(sf.assets.filter((a) => a.role === "original")).toHaveLength(2);
    const proxy = sf.assets.find((a) => a.role === "derived")!;
    expect(await gpsOf(et, await plainCopy(p, proxy.path))).toEqual({ lat: 40.7, lon: -74 });
  });

  it("a proxy whose GPS does not match the rule is discarded; no derived asset is recorded", async () => {
    const { attach, proxies } = await withWorker({ lie: true });
    const p = await project(gov("coarsen"), true);
    const tif = join(files, "IMG_0001.tif");
    await buildCameraTiff(tif);
    const [r] = await attach.attachFiles(p.id, [tif]);
    const results = await proxies.idle();
    expect(results).toEqual([expect.objectContaining({ ok: false, code: "LOCATION_MISMATCH" })]);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.assets.filter((a) => a.role === "derived")).toEqual([]);
    expect(sf.pendingProxies?.[0]?.failed?.code).toBe("LOCATION_MISMATCH");
  });

  for (const mode of ["coarsen", "strip"] as const) {
    it(`R85 M5: locationMetadata ${mode} in a project that is not encrypted: a photo with a location is refused with a plain reason`, async () => {
      const p = await project(gov(mode).replace("atRest: required", "atRest: optional"), false);
      const tif = join(files, "IMG_0001.tif");
      await buildCameraTiff(tif);
      expect(await attach.attachFiles(p.id, [tif])).toEqual([{ path: tif, outcome: "failed", reason: LOCATION_NEEDS_ENCRYPTION }]);
      expect(repo.listSourceIds(p.id)).toEqual([]);
      const denies = (await auditEvents(p.folder)).filter((e) => e.decision?.result === "deny");
      expect(denies.map((e) => [e.action, e.decision?.reason])).toEqual([["store", LOCATION_NEEDS_ENCRYPTION]]);
    });
  }

  it("R85: a place name alone (IPTC/XMP City, Sub-location, LocationCreated) counts as a location", async () => {
    const enc = await project(gov("coarsen"), true);
    const plain = await project(gov("coarsen").replace("atRest: required", "atRest: optional"), false);
    for (const tags of [{ City: "Gotham" }, { "Sub-location": "Main Street" }, { LocationCreatedCity: "Gotham" }]) {
      setExifReaderForTests(() => Promise.resolve({ Make: "Apple", ...tags }));
      try {
        const unique = () => Buffer.concat([tinyPng(), Buffer.from(Math.random().toString(36))]);
        const [r] = await attach.attachFiles(enc.id, [await put(`p-${Object.keys(tags)[0]}.png`, unique())]);
        expect(r).toMatchObject({ note: LOCATION_REASON });
        expect((await repo.getSource(enc.id, r!.sourceId!)).pendingProxies?.map((j) => j.location)).toEqual(["coarsen"]);
        const [d] = await attach.attachFiles(plain.id, [await put(`q-${Object.keys(tags)[0]}.png`, unique())]);
        expect(d).toMatchObject({ outcome: "failed", reason: LOCATION_NEEDS_ENCRYPTION });
      } finally {
        setExifReaderForTests(undefined);
      }
    }
  });

  it("locationMetadata keep: the photo is stored, no proxy is needed", async () => {
    const p = await project(gov("keep"), true);
    const tif = join(files, "IMG_0003.tif");
    await buildCameraTiff(tif);
    const [r] = await attach.attachFiles(p.id, [tif]);
    // No title or creator in the photo: stored, and queued for review.
    expect(["created", "needs-review"]).toContain(r!.outcome);
    expect(r!.note).toBeUndefined();
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.assets[0]!.encrypted).toBe(true);
    expect(sf.pendingProxies ?? []).toEqual([]);
  });
});

describe("review round 2 (R57)", () => {
  const scan0008 = () =>
    buildPdf({ lines: ["Minutes of the reading group.", `Background reading: Rivers and Memory in Upland Villages doi:${FIXTURE_DOI}`] });

  it("C1: scan0008 (no metadata, cites a DOI whose title is in its text) → review, no DOI, in an empty project", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).persist();
    const [r] = await attach.attachFiles(p.id, [await put("scan0008.pdf", await scan0008())]);
    expect(r!.outcome).toBe("needs-review");
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.identifiers.doi).toBeUndefined();
    expect(sf.source.provenance.identification!.confidence).toBeLessThanOrEqual(0.6);
    const entry = (await reviewEntries(p.id, p.folder)).find((e) => e.sourceId === r!.sourceId)!;
    expect(entry.hints).toContain(`doi:${FIXTURE_DOI}`);
  });

  it("FR-123: details looked up from a text identifier are said to come from it; no title search is made with the cited work's title", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    // A title search with the cited work's title would find that work again.
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, fixture("openalex-search.json"), JSON_HEADERS).persist();
    const lookup = await lookupContextFor(repo, p.id, http);
    const r = await resolveItem({ path: await put("scan0008.pdf", await scan0008()), mime: "application/pdf" }, { projectId: p.id, patterns: [], lookup });
    expect(r.draft.title.variants[0]!.value).toBe("Rivers and Memory in Upland Villages");
    expect(r.evidence.method).toBe("identifier+lookup");
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect(r.verification.reasons[0]).toBe(LOOKED_UP_FROM_TEXT);
    expect(r.verification.reasons).not.toContain("An identifier found in the file could not be confirmed as this item's own (it may belong to a cited work), so it was not recorded.");
  });

  it("FR-124: a reference DOI whose lookup fails is not mixed with a cited work's details: those are only a candidate", async () => {
    const p = await project();
    const OWN = "10.5555/ao.own.missing";
    crossref().intercept({ path: `/works/${OWN}`, method: "GET" }).reply(404, "Resource not found.").times(1);
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, fixture("openalex-search.json"), JSON_HEADERS).persist();
    const lookup = await lookupContextFor(repo, p.id, http);
    const r = await resolveItem(
      { path: await put("scan0008.pdf", await scan0008()), mime: "application/pdf", referenceMetadata: { identifiers: { doi: OWN } } },
      { projectId: p.id, patterns: [], lookup },
    );
    expect(r.draft.identifiers.doi).toBe(OWN);
    expect(r.draft.title.variants[0]!.value).not.toBe("Rivers and Memory in Upland Villages");
    expect(r.draft.creators).toEqual([]);
    expect(r.candidates[0]).toMatchObject({ provider: "crossref", title: "Rivers and Memory in Upland Villages" });
    expect(r.identifierHints).toEqual([`doi:${FIXTURE_DOI}`]);
    expect(r.verification.overall).toBe("needs-review");
    expect(r.confidence).toBeLessThanOrEqual(0.6);
  });

  it("FR-124 (R473 I3): a sidecar bringing the item's own title takes the cited work's details out of the draft; they stay a candidate", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).persist();
    const lookup = await lookupContextFor(repo, p.id, http);
    const pdf = await put("scan0008.pdf", await scan0008());
    const ris = await put("scan0008.ris", "TY  - RPRT\nTI  - Minutes of the reading group\nAU  - Doe, Jane\nPY  - 2024\nER  - \n");
    const r = await resolveItem({ path: pdf, mime: "application/pdf", sidecarPaths: [ris] }, { projectId: p.id, patterns: [], lookup });
    expect(r.draft.title.variants[0]!.value).toBe("Minutes of the reading group");
    expect(r.draft.creators).toEqual([expect.objectContaining({ family: "Doe", given: "Jane" })]);
    expect(r.draft.issued).toBe("2024");
    // Nothing that only the cited work's lookup gave is left in the item's own record.
    expect(r.draft.container).toBeUndefined();
    expect(r.draft.publisher).toBeUndefined();
    expect(r.draft).not.toHaveProperty("volume");
    expect(r.draft).not.toHaveProperty("issue");
    expect(r.draft).not.toHaveProperty("pages");
    expect(r.draft).not.toHaveProperty("edition");
    expect(r.fieldEvidence.filter((e) => e.source.kind === "lookup").map((e) => e.field)).toEqual(["/title"]);
    expect(r.candidates[0]).toMatchObject({ provider: "crossref", title: "Rivers and Memory in Upland Villages" });
    expect(r.identifierHints).toEqual([`doi:${FIXTURE_DOI}`]);
    expect(r.verification.overall).toBe("needs-review");
    // No value of the lookup is in the draft, so its sentence is not said.
    expect(r.verification.reasons).not.toContain(LOOKED_UP_FROM_TEXT);
  });

  it("C1: scan0008 in a project already holding doi-article.pdf is never its duplicate", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).persist();
    const [first] = await attach.attachFiles(p.id, [await put("doi-article.pdf", await buildDoiPdf())]);
    expect(first!.outcome).toBe("created");
    const [r] = await attach.attachFiles(p.id, [await put("scan0008.pdf", await scan0008())]);
    expect(r!.outcome).toBe("needs-review");
    expect(r!.sourceId).not.toBe(first!.sourceId);
    expect((await repo.getSource(p.id, r!.sourceId!)).source.identifiers.doi).toBeUndefined();
  });

  it("C1: a file named after a work gets no DOI from the title search (step 5)", async () => {
    const p = await project();
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, fixture("openalex-search.json"), JSON_HEADERS).persist();
    const path = await put("Okafor - 2021 - Rivers and Memory in Upland Villages.pdf", await buildPdf({ lines: ["Scanned pages without a usable text layer title."] }));
    const [r] = await attach.attachFiles(p.id, [path]);
    expect(r!.outcome).toBe("needs-review");
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.provenance.identification!.method).toBe("filename+lookup");
    expect(sf.source.identifiers.doi).toBeUndefined();
    expect(sf.source.identifiers.isbn).toBeUndefined();
  });

  it("I2: when exiftool cannot read a photo, it is treated as having location data (fail closed)", async () => {
    const p = await project(
      `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
sharing:
  locationMetadata: coarsen
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`,
      true,
    );
    const [made] = await attach.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    setExifReaderForTests(() => Promise.reject(new Error("spawn exiftool ENOENT")));
    let created: string | undefined;
    try {
      const png = await put("photo.png", tinyPng());
      const [r] = await attach.attachFiles(p.id, [png]);
      expect(r).toMatchObject({ note: LOCATION_REASON });
      created = r!.sourceId;
      expect(await attach.attachFiles(p.id, [await put("photo2.png", tinyPng())], { toSourceId: made!.sourceId! })).toMatchObject([{ outcome: "attached", note: LOCATION_REASON }]);
    } finally {
      setExifReaderForTests(undefined);
    }
    // Stored (the decision allows it), with location-safe proxies pending (coarsen).
    expect((await repo.getSource(p.id, created!)).pendingProxies?.map((j) => j.location)).toEqual(["coarsen"]);
    expect((await repo.getSource(p.id, made!.sourceId!)).pendingProxies?.map((j) => j.location)).toEqual(["coarsen"]);
  });

  it("I3: audio and video types outside the list are accepted by MIME prefix (oga, mts)", async () => {
    const p = await project(`${NO_LOOKUP_GOV}sharing:
  locationMetadata: keep
`);
    const oga = Buffer.alloc(64);
    oga.write("OggS", 0);
    Buffer.from([0x7f, 0x46, 0x4c, 0x41, 0x43]).copy(oga, 28);
    const mts = Buffer.alloc(188 * 3);
    mts[0] = mts[188] = mts[376] = 0x47;
    const out = await attach.attachFiles(p.id, [await put("song.bin", oga), await put("clip.bin", mts)]);
    expect(out.map((o) => o.outcome).every((o) => o === "created" || o === "needs-review")).toBe(true);
    const a = (await repo.getSource(p.id, out[0]!.sourceId!)).assets[0]!;
    const v = (await repo.getSource(p.id, out[1]!.sourceId!)).assets[0]!;
    expect([a.kind, a.mime, a.path.endsWith(".oga")]).toEqual(["audio", "audio/ogg", true]);
    expect([v.kind, v.mime, v.path.endsWith(".mts")]).toEqual(["video", "video/mp2t", true]);
  });

  it("I3: the MIME table knows the further audio, video and image types", () => {
    const cases: Array<[string, string, string]> = [
      ["oga", "audio/ogg", "audio"], ["ogv", "video/ogg", "video"], ["spx", "audio/ogg", "audio"], ["aif", "audio/aiff", "audio"],
      ["amr", "audio/amr", "audio"], ["m4b", "audio/mp4", "audio"], ["mts", "video/mp2t", "video"], ["asf", "video/x-ms-asf", "video"],
      ["3g2", "video/3gpp2", "video"], ["flv", "video/x-flv", "video"], ["apng", "image/apng", "image"], ["jxl", "image/jxl", "image"],
      ["mp2", "audio/mpeg", "audio"],
    ];
    for (const [ext, mime, kind] of cases) expect([ext, mimeFor(ext), kindFor(ext)]).toEqual([ext, mime, kind]);
  });

  it("M3: a legacy defaultLegalBasis.manual_upload is read as manual-upload, with a load warning", async () => {
    const yaml = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    manual_upload: "legitimate interest; legacy key"
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
    const { config, warnings } = parseGovernanceWithWarnings(yaml);
    expect(config.consent.defaultLegalBasis["manual-upload"]).toBe("legitimate interest; legacy key");
    expect(warnings.filter((w) => w.includes("manual_upload"))).toHaveLength(1);
    expect(DEFAULT_GOVERNANCE.consent.defaultLegalBasis).toEqual({});
    const p = await project(yaml);
    const notes: string[] = [];
    const noting = createAttach({ repo, http, debug: (n) => notes.push(n) });
    const [r] = await noting.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    expect((await repo.getSource(p.id, r!.sourceId!)).source.provenance.legal.basis).toBe("legitimate interest; legacy key");
    await noting.attachFiles(p.id, [await put("other slides.pdf", await buildPdf({ title: "Other Slides", lines: ["Other Slides"] }))]);
    expect(notes.filter((n) => n.includes("manual_upload"))).toHaveLength(1);
  });
});

describe("review round 3 (R58)", () => {
  const reviewPdf = () =>
    buildPdf({
      title: "Review: Rivers and Memory in Upland Villages",
      lines: ["Book reviews", `Rivers and Memory in Upland Villages doi:${FIXTURE_DOI}`, "Reviewed by Sana Mirza"],
    });
  const COARSEN = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
sharing:
  locationMetadata: coarsen
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
  const oggBytes = () => {
    const oga = Buffer.alloc(64);
    oga.write("OggS", 0);
    Buffer.from([0x7f, 0x46, 0x4c, 0x41, 0x43]).copy(oga, 28);
    return oga;
  };

  it("I-1: a review PDF whose embedded title only nearly matches the cited DOI's → review, no DOI, capped at 0.6 (empty project)", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).persist();
    const [r] = await attach.attachFiles(p.id, [await put("review.pdf", await reviewPdf())]);
    expect(r!.outcome).toBe("needs-review");
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.identifiers.doi).toBeUndefined();
    expect(sf.source.title.variants[0]!.value).toBe("Review: Rivers and Memory in Upland Villages");
    expect(sf.source.provenance.identification!.confidence).toBeLessThanOrEqual(0.6);
    const entry = (await reviewEntries(p.id, p.folder)).find((e) => e.sourceId === r!.sourceId)!;
    expect(entry.hints).toContain(`doi:${FIXTURE_DOI}`);
    expect(sf.assets.filter((a) => a.role === "original")).toHaveLength(1);
  });

  it("I-1: the review PDF in a project already holding doi-article.pdf is stored, never its duplicate", async () => {
    const p = await project();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    openalex().intercept({ path: searchPath, method: "GET" }).reply(200, JSON.stringify({ results: [] }), JSON_HEADERS).persist();
    const [first] = await attach.attachFiles(p.id, [await put("doi-article.pdf", await buildDoiPdf())]);
    expect(first!.outcome).toBe("created");
    const [r] = await attach.attachFiles(p.id, [await put("review.pdf", await reviewPdf())]);
    expect(r!.outcome).toBe("needs-review");
    expect(r!.sourceId).toBeDefined();
    expect(r!.sourceId).not.toBe(first!.sourceId);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.identifiers.doi).toBeUndefined();
    expect(sf.assets.filter((a) => a.role === "original")).toHaveLength(1);
    expect(repo.listSourceIds(p.id)).toHaveLength(2);
  });

  it("I-1 regression: doi-article.pdf gets its DOI at 0.97; another PDF with a normalized-equal title and the same DOI is a same-doi duplicate", async () => {
    const p = await project();
    const lookup = await lookupContextFor(repo, p.id, http);
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const path = await put("doi-article.pdf", await buildDoiPdf());
    const res = await resolveItem({ path, mime: "application/pdf" }, { projectId: p.id, patterns: [], lookup });
    expect(res.draft.identifiers.doi).toBe(FIXTURE_DOI);
    expect(res.confidence).toBe(0.97);
    // R87: the lookup's volume, issue and pages reach the draft, with their evidence.
    expect(res.draft).toMatchObject({ volume: "12", issue: "3", page: "201-219" });
    expect(res.fieldEvidence.filter((e) => ["/volume", "/issue", "/page"].includes(e.field)).map((e) => [e.field, e.value, e.source.provider])).toEqual([
      ["/volume", "12", "crossref"],
      ["/issue", "3", "crossref"],
      ["/page", "201-219", "crossref"],
    ]);
    const [first] = await attach.attachFiles(p.id, [path]);
    expect(first!.outcome).toBe("created");
    expect((await repo.getSource(p.id, first!.sourceId!)).source.identifiers.doi).toBe(FIXTURE_DOI);
    const other = await put(
      "other.pdf",
      await buildPdf({ title: "RIVERS AND MEMORY in upland villages.", author: "Amara Okafor", lines: ["Rivers and Memory in Upland Villages", `doi:${FIXTURE_DOI}`] }),
    );
    const res2 = await resolveItem({ path: other, mime: "application/pdf" }, { projectId: p.id, patterns: [], lookup });
    expect(res2.draft.identifiers.doi).toBe(FIXTURE_DOI);
    const keys = [{ sourceId: first!.sourceId!, sha256s: [], doi: FIXTURE_DOI }];
    expect(findDuplicate({ sha256s: ["x"], doi: res2.draft.identifiers.doi!, title: "t" }, keys)).toMatchObject({ certainty: "certain", reason: "same-doi" });
    expect((await attach.attachFiles(p.id, [other]))[0]).toMatchObject({ outcome: "duplicate", sourceId: first!.sourceId });
  });

  it("I-2: an exiftool result carrying an Error counts as unreadable: a PNG gets a coarsened proxy pending in a coarsen project (library and source)", async () => {
    const p = await project(COARSEN, true);
    const [made] = await attach.attachFiles(p.id, [await put("conference_slides.pdf", await slidesPdf())]);
    setExifReaderForTests(() => Promise.resolve({ Error: "File format error", errors: ["File format error"] }));
    let created: string | undefined;
    try {
      const png = await put("photo.png", tinyPng());
      const [r] = await attach.attachFiles(p.id, [png]);
      expect(r).toMatchObject({ note: LOCATION_REASON });
      created = r!.sourceId;
      expect(await attach.attachFiles(p.id, [await put("photo2.png", tinyPng())], { toSourceId: made!.sourceId! })).toMatchObject([{ outcome: "attached", note: LOCATION_REASON }]);
    } finally {
      setExifReaderForTests(undefined);
    }
    expect((await repo.getSource(p.id, created!)).pendingProxies).toHaveLength(1);
    expect((await repo.getSource(p.id, made!.sourceId!)).assets).toHaveLength(2);
  });

  it("I-2: errors alone count too; warnings alone do not", async () => {
    setExifReaderForTests(() => Promise.resolve({ errors: ["Truncated"] }));
    try {
      expect((await extractExif("x.png")).media).toEqual({ readFailed: true });
      setExifReaderForTests(() => Promise.resolve({ Error: "", errors: [], warnings: ["Minor issue"], ImageWidth: 4 }));
      expect((await extractExif("x.png")).media).toEqual({ width: 4 });
    } finally {
      setExifReaderForTests(undefined);
    }
  });

  it("audio is checked for location like images and video: stored under the location condition (encrypted), no proxy (audio has none)", async () => {
    const p = await project(COARSEN, true);
    const memo = await put("memo.bin", oggBytes());
    try {
      setExifReaderForTests(() => Promise.resolve({ GPSLatitude: 51.5, GPSLongitude: -0.12 }));
      const [r] = await attach.attachFiles(p.id, [memo]);
      expect(r!.note).toBeUndefined();
      const sf = await repo.getSource(p.id, r!.sourceId!);
      expect(sf.assets[0]!.encrypted).toBe(true);
      expect(sf.pendingProxies ?? []).toEqual([]);
      const store = (await auditEvents(p.folder)).find((e) => e.action === "store" && e.entity?.id === sf.source.id)!;
      expect(store.decision?.conditions).toContainEqual({ type: "location", mode: "coarsen" });
    } finally {
      setExifReaderForTests(undefined);
    }
    expect(mayHaveLocation("audio/mp4", { media: { readFailed: true } })).toBe(true);
  });

  it("the MIME-prefix fallback refuses SVG as unsupported", () => {
    expect(acceptedType({ ext: "svg", mime: "image/svg+xml" })).toBeUndefined();
    expect(acceptedType({ ext: "oga", mime: "audio/ogg" })).toEqual({ ext: "oga", mime: "audio/ogg", kind: "audio" });
    expect(acceptedType({ ext: "png", mime: "image/png" })).toEqual({ ext: "png", mime: "image/png", kind: "image" });
    expect(acceptedType({ ext: "xml", mime: "application/xml" })).toBeUndefined();
  });
});

describe("cloud-drive folders: attach reads only what `readable` allows (Task W2)", () => {
  /** Every call that opens or reads a file's bytes, through each module's own binding (syncBuiltinESMExports). */
  function readSpies(): (path: string) => unknown[][] {
    const spies = [
      vi.spyOn(fsp, "open"),
      vi.spyOn(fsp, "readFile"),
      vi.spyOn(fsp, "copyFile"),
      vi.spyOn(fsp, "cp"),
      vi.spyOn(fs, "createReadStream"),
      vi.spyOn(fs, "open"),
      vi.spyOn(fs, "readFile"),
      vi.spyOn(fs, "openSync"),
      vi.spyOn(fs, "readFileSync"),
      vi.spyOn(fs, "copyFile"),
      vi.spyOn(fs, "copyFileSync"),
    ];
    syncBuiltinESMExports();
    return (path) => spies.flatMap((s) => s.mock.calls as unknown[][]).filter((args) => String(args[0]) === path);
  }
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it("attach refuses a non-local file before reading it", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("online.pdf", await buildPdf({ title: "Online only", extra: "online" }));
    const asked: string[] = [];
    const opened = readSpies();
    const guarded = createAttach({ repo, http, readable: async (q) => (asked.push(q), false) });
    const [r] = await guarded.attachFiles(p.id, [path]);
    expect(r).toEqual({ path, outcome: "failed", reason: NOT_DOWNLOADED_REASON });
    expect(NOT_DOWNLOADED_REASON).toBe("Not downloaded to this Mac. It comes in once it is downloaded.");
    expect(asked).toEqual([path]);
    expect(opened(path)).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("a non-local sidecar is not read; the item comes in without it", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("scan0002.pdf", await buildPdf({ lines: ["Some page text without a title that we could use."], extra: "w2" }));
    const ris = await put("scan0002.ris", "TY  - JOUR\nTI  - Weaving and Kinship in Highland Markets\nER  - \n");
    const opened = readSpies();
    const guarded = createAttach({ repo, http, readable: async (q) => q !== ris });
    const [r] = await guarded.attachFiles(p.id, [path]);
    expect(r!.sourceId).toEqual(expect.any(String));
    expect(opened(path).length).toBeGreaterThan(0); // the spies see this module's reads
    expect(opened(ris)).toEqual([]);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.title.variants[0]?.value ?? "").not.toBe("Weaving and Kinship in Highland Markets");
  });

  it("readable is asked again immediately before each open: the sniff, the hash, the metadata, the copy (A6)", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("each.pdf", await buildPdf({ title: "Each open", extra: "each" }));
    const asked: string[] = [];
    const opened = readSpies();
    const [ok] = await createAttach({ repo, http, readable: async (q) => (asked.push(q), true) }).attachFiles(p.id, [path]);
    const fullReads = opened(path).length;
    expect(ok!.sourceId).toEqual(expect.any(String));
    expect(asked.filter((q) => q === path).length).toBeGreaterThanOrEqual(4);
    // Evicted after the sniff and the hash: refused at the next open, nothing stored.
    const p2 = await project(NO_LOOKUP_GOV);
    const path2 = await put("evicted.pdf", await buildPdf({ title: "Evicted later", extra: "evicted2" }));
    let n = 0;
    const [r] = await createAttach({ repo, http, readable: async (q) => q !== path2 || ++n <= 2 }).attachFiles(p2.id, [path2]);
    expect(r).toEqual({ path: path2, outcome: "failed", reason: NOT_DOWNLOADED_REASON });
    expect(repo.listSourceIds(p2.id)).toEqual([]);
    const reads = opened(path2).length;
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(fullReads); // the sniff and the hash happened; the copy never opened the file
  });

  it("attach and findSidecars without `readable` behave as before", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("scan0003.pdf", await buildPdf({ lines: ["Some page text without a title that we could use."], extra: "w2b" }));
    const ris = await put("scan0003.ris", "TY  - JOUR\nTI  - Weaving and Kinship in Highland Markets\nER  - \n");
    expect(await findSidecars(path)).toEqual([ris]);
    expect(await findSidecars(path, async () => true)).toEqual([ris]);
    expect(await findSidecars(path, async () => false)).toEqual([]);
    const [r] = await createAttach({ repo, http }).attachFiles(p.id, [path]);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.title.variants[0]!.value).toBe("Weaving and Kinship in Highland Markets");
    expect(sf.source.provenance.identification!.method).toBe("sidecar");
  });
});

describe("cloud-drive folders: attach's collection and origin (Task W3)", () => {
  it("attach without the new options behaves as before: drag-and-drop provenance, no external key, no collection", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const path = await put("plain.pdf", await buildPdf({ title: "Dropped as before", extra: "w3-plain" }));
    const [r] = await attach.attachFiles(p.id, [path]);
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.provenance.tool.name).toBe("drag-and-drop");
    expect(sf.source.provenance.externalKeys).toBeUndefined();
    expect(sf.source.collectionIds).toEqual([]);
    expect(r).not.toHaveProperty("noCollection");
  });

  it("origin names the watch in the provenance, set when the source is created; the collection comes in the same change", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const c = await repo.createCollection(p.id, "From the drive");
    const watchId = "01900000-0000-7000-8000-000000000001";
    const path = await put("watched.pdf", await buildPdf({ title: "From a watched folder", extra: "w3-origin" }));
    const before = (await auditEvents(p.folder)).length;
    const [r] = await attach.attachFiles(p.id, [path], { collectionId: c.id, origin: { watchId } });
    const sf = await repo.getSource(p.id, r!.sourceId!);
    expect(sf.source.provenance.tool).toEqual({ name: "watched-folder", version: expect.any(String) });
    expect(sf.source.provenance.externalKeys).toEqual({ "watched-folder": watchId });
    expect(sf.source.provenance.captureMethod).toBe("manual_upload");
    expect(sf.source.collectionIds).toEqual([c.id]);
    // One change: the source's creation (no separate membership change).
    const after = (await auditEvents(p.folder)).slice(before);
    expect(after.map((e) => e.details?.op).filter((o) => o !== "source.create")).toEqual([]);
    expect(new Set(after.map((e) => e.details?.txn)).size).toBe(1);
  });

  it("a collection that no longer exists: the source comes in without one and the outcome says so", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const c = await repo.createCollection(p.id, "Soon gone");
    await repo.deleteCollection(p.id, c.id);
    const path = await put("nocoll.pdf", await buildPdf({ title: "No collection", extra: "w3-nocoll" }));
    const [r] = await attach.attachFiles(p.id, [path], { collectionId: c.id });
    expect(r).toMatchObject({ outcome: expect.stringMatching(/created|needs-review/u), noCollection: true });
    expect((await repo.getSource(p.id, r!.sourceId!)).source.collectionIds).toEqual([]);
  });

  it("onto a source (a further file), origin and collection change nothing about the source's record", async () => {
    const p = await project(NO_LOOKUP_GOV);
    const watchId = "01900000-0000-7000-8000-000000000002";
    const first = await put("v1.pdf", await buildPdf({ title: "Version one", extra: "w3-v1" }));
    const [r] = await attach.attachFiles(p.id, [first], { origin: { watchId } });
    const before = await repo.getSource(p.id, r!.sourceId!);
    const second = await put("v2.pdf", await buildPdf({ title: "Version two", extra: "w3-v2" }));
    const [r2] = await attach.attachFiles(p.id, [second], { toSourceId: r!.sourceId!, origin: { watchId } });
    expect(r2).toMatchObject({ outcome: "attached", sourceId: r!.sourceId });
    const after = await repo.getSource(p.id, r!.sourceId!);
    expect(after.assets.filter((a) => a.role === "original")).toHaveLength(2);
    expect(after.source.provenance).toEqual(before.source.provenance);
    expect(after.source.collectionIds).toEqual(before.source.collectionIds);
  });
});

describe("R379 (FR-A12): a title search never carries what may be a participant's data", () => {
  const RECORDING = "Gonzalez 2024 Interview about her eviction";
  /**
   * A project under the default rules (it says it holds identifiable data; encryption required), with a
   * default legal basis for dropped files so that attach can store them.
   */
  const defaultProject = async () =>
    (
      await repo.createProject({
        name: `D${Math.random().toString(36).slice(2, 7)}`,
        governanceYaml: 'consent:\n  defaultLegalBasis:\n    manual-upload: "legitimate interest; ethics approval 2026-01"\n',
        encryption: { enabled: true, passphrase: "pw" },
      })
    ).project;
  /** Every request to OpenAlex's search endpoint (answered with no results). */
  const recordSearches = (): string[] => {
    const seen: string[] = [];
    openalex()
      .intercept({ path: searchPath, method: "GET" })
      .reply(200, (o) => (seen.push(String(o.path)), JSON.stringify({ results: [] })), JSON_HEADERS)
      .persist();
    return seen;
  };
  const m4a = () => {
    const b = Buffer.alloc(64);
    b.writeUInt32BE(32, 0);
    b.write("ftypM4A ", 4, "latin1");
    return b;
  };
  const resolveIn = async (p: { id: string }, input: Parameters<typeof resolveItem>[0]) =>
    resolveItem(input, { projectId: p.id, patterns: [], lookup: await lookupContextFor(repo, p.id, http) });
  const expectNameOnDevice = (r: Awaited<ReturnType<typeof resolveItem>>) => {
    expect(r.draft.title.variants[0]!.value).toBe("Interview about her eviction");
    expect(r.draft.creators[0]).toMatchObject({ literal: "Gonzalez" });
    expect(r.draft.issued).toBe("2024");
    expect(r.evidence.method).toBe("filename");
    for (const f of ["/title", "/creators", "/issued"]) expect(r.fieldEvidence).toContainEqual(expect.objectContaining({ field: f, source: { kind: "filename" } }));
  };

  it("the reviewer's probe: a recording under the default rules is never searched for; its name still fills the record", async () => {
    const p = await defaultProject();
    const seen = recordSearches();
    const r = await resolveIn(p, { path: await put(`${RECORDING}.m4a`, m4a()), mime: "audio/mp4" });
    expect(seen).toEqual([]);
    expectNameOnDevice(r);
  });

  it("audio, video and image files are never searched for, even where the project holds no identifiable data", async () => {
    const p = await project();
    const seen = recordSearches();
    for (const [name, mime, bytes] of [
      [`${RECORDING}.m4a`, "audio/mp4", m4a()],
      [`${RECORDING}.mp4`, "video/mp4", m4a()],
      [`${RECORDING}.png`, "image/png", tinyPng()],
    ] as const) {
      const r = await resolveIn(p, { path: await put(name, bytes), mime });
      expect(seen, mime).toEqual([]);
      expectNameOnDevice(r);
    }
  });

  it("a PDF named after the interview: no search in a default project; searched as before where the project holds no identifiable data", async () => {
    const pdf = await buildPdf({ lines: ["Scanned pages without a usable text layer title."] });
    const d = await defaultProject();
    const seen = recordSearches();
    expectNameOnDevice(await resolveIn(d, { path: await put(`${RECORDING}.pdf`, pdf), mime: "application/pdf" }));
    expect(seen).toEqual([]);

    const open = await project();
    await resolveIn(open, { path: await put(`open/${RECORDING}.pdf`, pdf), mime: "application/pdf" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("search=Interview+about+her+eviction+Gonzalez");
  });

  it("a PDF with a DOI in a default project: the DOI is still looked up", async () => {
    const p = await defaultProject();
    const seen = recordSearches();
    crossref().intercept({ path: `/works/${FIXTURE_DOI}`, method: "GET" }).reply(200, fixture("crossref-work.json"), JSON_HEADERS).times(1);
    const r = await resolveIn(p, { path: await put("doi-article.pdf", await buildDoiPdf()), mime: "application/pdf" });
    expect(r.draft.identifiers.doi).toBe(FIXTURE_DOI);
    expect(r.evidence.method).toBe("identifier+lookup");
    expect(r.fieldEvidence).toContainEqual(expect.objectContaining({ field: "/title", source: { kind: "lookup", provider: "crossref" } }));
    expect(seen).toEqual([]);
  });

  it("an embedded title (step 6) and a reference manager's title in a default project are not searched for", async () => {
    const p = await defaultProject();
    const seen = recordSearches();
    const slides = await resolveIn(p, { path: await put("conference_slides.pdf", await slidesPdf()), mime: "application/pdf" });
    expect(slides.draft.title.variants[0]!.value).toBe("Field Notes on Market Days");
    const pdf = await put("scan0001.pdf", await buildPdf({ lines: ["Some page text without a title that we could use."] }));
    const ris = await put("scan0001.ris", "TY  - JOUR\nTI  - Weaving and Kinship in Highland Markets\nAU  - Adebayo, Ngozi\nPY  - 2009\nER  - \n");
    const side = await resolveIn(p, { path: pdf, mime: "application/pdf", sidecarPaths: [ris] });
    expect(side.draft.title.variants[0]!.value).toBe("Weaving and Kinship in Highland Markets");
    expect(side.evidence.method).toBe("sidecar");
    // A record with no file (a reference manager's sidecar alone).
    await resolveIn(p, { sidecarPaths: [ris] });
    expect(seen).toEqual([]);
  });

  it("R385 c: a look-up context built by hand without titleSearchAllowed makes no title search (fail-closed)", async () => {
    const p = await project();
    const seen = recordSearches();
    // The context of a project with no identifiable data, but without the flag.
    const { titleSearchAllowed: _flag, ...byHand } = await lookupContextFor(repo, p.id, http);
    expect(byHand.policy?.identifiability.containsIdentifiable).toBe(false);
    const r = await resolveItem(
      { path: await put(`${RECORDING}.pdf`, await buildPdf({ lines: ["Scanned pages without a usable text layer title."] })), mime: "application/pdf" },
      { projectId: p.id, patterns: [], lookup: byHand },
    );
    expect(seen).toEqual([]);
    expectNameOnDevice(r);
  });

  it("an item with no file is not a media file: where the project holds no identifiable data, its title is searched for", async () => {
    const p = await project();
    const seen = recordSearches();
    const ris = await put("record.ris", "TY  - JOUR\nTI  - Weaving and Kinship in Highland Markets\nAU  - Adebayo, Ngozi\nPY  - 2009\nER  - \n");
    await resolveIn(p, { sidecarPaths: [ris] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("search=Weaving+and+Kinship+in+Highland+Markets");
  });

  it("through attach (drop on the library) in a default project: the recording's and the PDF's names never leave", async () => {
    const p = await defaultProject();
    const seen = recordSearches();
    const rs = await attach.attachFiles(p.id, [await put(`${RECORDING}.m4a`, m4a()), await put(`${RECORDING}.pdf`, await buildPdf({ lines: ["Transcript pages."] }))]);
    for (const r of rs) {
      expect(r.sourceId, r.reason).toBeDefined();
      expect((await repo.getSource(p.id, r.sourceId!)).source.title.variants[0]!.value).toBe("Interview about her eviction");
    }
    expect(seen).toEqual([]);
  });
});
