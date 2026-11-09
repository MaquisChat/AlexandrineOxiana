import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LibraryRelativePath,
  SourceFile,
  newId,
  sealEvent,
  verifyChain,
  type AuditEvent,
  type Provenance,
  type SourceDraft,
} from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptStream } from "../crypto/format.js";
import { KeyRing, WrongPassphraseError } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import {
  GovernanceViolationError,
  ImmutableProvenanceError,
  PolicyDeniedError,
  ProjectLockedError,
  ReadOnlyLibraryError,
  RecoveryPendingError,
  type IndexSink,
  type Repo,
} from "./index.js";
import { SimulatedCrash, openTestRepo, seams, type InternalOptions } from "./testing.js";
import { AnchorStore } from "./audit-store.js";
import type { RepoOptions } from "./state.js";

const FAST = 2 ** 10;
const NOW = "2026-11-09T14:30:00.000Z";

/** Unencrypted, non-identifying project. */
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
/** Unencrypted project holding identifiable data without pseudonymized names. */
const IDENT_PLAIN_GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
captureMethods: [manual_upload, downloader]
`;
/** Defaults: identifiable, pseudonymized names, encryption required. */
const STRICT_GOV = `captureMethods: [manual_upload, downloader]
`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let now: Date;
let pdf: string;
let pdfBytes: Buffer;

function mkDeps(): Deps {
  return {
    clock: () => now,
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

type Opts = RepoOptions & InternalOptions;
async function repoFor(over: Opts = {}, library: Library = lib): Promise<Repo> {
  return openTestRepo(library, ring, { clock: () => now, tz: "UTC", actor: "tester", scryptN: FAST, ...over });
}

function draft(over: Partial<SourceDraft> = {}): SourceDraft {
  return {
    projectIds: [],
    type: "article-journal",
    title: { variants: [{ lang: "en", kind: "original", value: "Title of Article" }] },
    creators: [{ family: "Smith", given: "Jane", role: "author" }],
    issued: "2025",
    identifiers: {},
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
    ...over,
  };
}

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    captureMethod: "manual_upload",
    capturedAt: NOW,
    tool: { name: "ao", version: "0.0.0" },
    fileHashes: {},
    legal: { status: "public" },
    identifiable: false,
    ...over,
  };
}

const pdfFile = () => [{ path: pdf, role: "original" as const, handling: "copy" as const }];

async function walk(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(rel);
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
  }
  return out;
}

async function auditEvents(projectDir: string): Promise<AuditEvent[]> {
  const dir = join(projectDir, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    const text = await readFile(join(dir, f), "utf8");
    for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

async function changeLines(projectDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(projectDir, "changes");
  const out: Array<Record<string, unknown>> = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

async function decrypt(path: string): Promise<Buffer> {
  const d = decryptStream((id) => ring.get(id));
  const parts: Buffer[] = [];
  const input = await readFile(path);
  d.on("data", (c: Buffer) => parts.push(c));
  await new Promise<void>((resolve, reject) => {
    d.on("end", resolve).on("error", reject);
    d.end(input);
  });
  return Buffer.concat(parts);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-repo-"));
  now = new Date(NOW);
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  pdf = join(tmp, "input.pdf");
  pdfBytes = Buffer.from("%PDF-1.7\nhello research\n%%EOF\n");
  await writeFile(pdf, pdfBytes);
});

afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("unencrypted project + source", () => {
  it("creates the project layout", async () => {
    const repo = await repoFor();
    const { project, recoveryCode } = await repo.createProject({
      name: "Instagram Discourse 2026",
      governanceYaml: OPEN_GOV,
      encryption: { enabled: false },
    });
    expect(recoveryCode).toBeUndefined();
    expect(project.folder).toBe("Projects/Instagram Discourse 2026");
    const dir = join(lib.root, project.folder);
    const files = await walk(dir);
    expect(files).toEqual(
      expect.arrayContaining(["project.json", "governance.yaml", "audit/0001.jsonl", "changes/2026-11.jsonl", "Sources"]),
    );
    expect(files).not.toContain("keys");
    expect(await readFile(join(dir, "governance.yaml"), "utf8")).toBe(OPEN_GOV);
    expect(verifyChain(await auditEvents(dir)).ok).toBe(true);
    expect(repo.listProjects().map((p) => p.id)).toEqual([project.id]);
  });

  it("stores a PDF under a readable folder, with source.json, audit chain and change log", async () => {
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const sf = await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });

    const short = /\[([0-9a-z]{4,})\]$/.exec(sf.source.folder)![1]!;
    const folder = `Projects/P/Sources/2025 Smith - Title of Article [${short}]`;
    expect(sf.source.folder).toBe(folder);
    const original = `${folder}/original/2025 Smith - Title of Article.pdf`;
    expect(sf.assets.map((a) => a.path)).toEqual([original]);
    expect((await readFile(join(lib.root, original))).equals(pdfBytes)).toBe(true);

    const onDisk = SourceFile.parse(JSON.parse(await readFile(join(lib.root, folder, "source.json"), "utf8")));
    expect(onDisk.source.id).toBe(sf.source.id);
    expect(onDisk.source.projectIds).toEqual([project.id]);
    expect(onDisk.source.provenance.fileHashes[sf.assets[0]!.id]).toBe(sf.assets[0]!.sha256);
    expect(onDisk.source.citationKey).toBe("smith2025title");

    const dir = join(lib.root, project.folder);
    const events = await auditEvents(dir);
    expect(verifyChain(events).ok).toBe(true);
    const forSource = events.filter((e) => e.entity?.id === sf.source.id);
    expect(forSource.map((e) => e.action)).toEqual(["capture", "store"]);
    expect(forSource.every((e) => e.decision?.result !== "deny")).toBe(true);

    const changes = await changeLines(dir);
    const creates = changes.filter((c) => c.op === "create").map((c) => (c.entity as { type: string; id: string }));
    expect(creates).toEqual(
      expect.arrayContaining([
        { type: "source", id: sf.source.id },
        { type: "asset", id: sf.assets[0]!.id },
      ]),
    );
    expect(await repo.getSource(project.id, sf.source.id)).toEqual(onDisk);
  });

  it("every path stored in source.json passes LibraryRelativePath", async () => {
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const sf = await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    await repo.addDerivedAsset(project.id, sf.source.id, derivedInput(sf.assets[0]!.id));
    const json = JSON.parse(await readFile(join(lib.root, sf.source.folder, "source.json"), "utf8"));
    const paths = [json.source.folder, ...json.assets.map((a: { path: string }) => a.path)];
    expect(paths).toHaveLength(3);
    for (const p of paths) {
      expect(LibraryRelativePath.safeParse(p).success, p).toBe(true);
      expect(p.startsWith("Projects/P/")).toBe(true);
    }
  });

  it("calls the index sink last, after files, change log and audit are written", async () => {
    const seen: string[] = [];
    let sourceJsonExisted = false;
    let auditLen = 0;
    const index: IndexSink = {
      indexProject: (p) => {
        seen.push(`project:${p.name}`);
      },
      indexSource: async (sf) => {
        seen.push(`source:${sf.source.id}`);
        sourceJsonExisted = (await stat(join(lib.root, sf.source.folder, "source.json")).catch(() => null)) !== null;
        auditLen = (await auditEvents(join(lib.root, "Projects/P"))).length;
      },
      removeSource: (id) => {
        seen.push(`remove:${id}`);
      },
    };
    const repo = await repoFor({ index });
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const before = (await auditEvents(join(lib.root, project.folder))).length;
    const sf = await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    expect(sourceJsonExisted).toBe(true);
    expect(auditLen).toBe(before + 2);
    await repo.deleteSource(project.id, sf.source.id);
    expect(seen).toEqual(["project:P", `source:${sf.source.id}`, `remove:${sf.source.id}`]);
  });
});

function derivedInput(parent: string) {
  return {
    fromPath: pdf,
    kind: "ocr",
    lang: "en",
    tool: "tesseract-5",
    ext: "txt",
    derivation: {
      parents: [parent],
      operation: "ocr",
      provider: "tesseract",
      ranAt: "local",
      params: {},
      at: NOW,
      triggeredBy: "tester",
    },
  };
}

describe("encrypted project", () => {
  async function setup(over: Opts = {}) {
    const repo = await repoFor(over);
    const created = await repo.createProject({
      name: "Secret",
      governanceYaml: STRICT_GOV,
      encryption: { enabled: true, passphrase: "correct horse" },
    });
    return { repo, ...created, dir: join(lib.root, created.project.folder) };
  }

  it("encrypts source.json and originals and keeps a non-identifying manifest", async () => {
    const { repo, project, recoveryCode, dir } = await setup();
    expect(recoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    const keyFile = JSON.parse(await readFile(join(dir, "keys/project-key.json"), "utf8"));
    expect(Object.keys(keyFile).sort()).toEqual(["keyId", "passphrase", "recovery"]);
    expect(JSON.stringify(keyFile)).not.toContain(recoveryCode!.replace(/-/g, ""));

    const d = draft({
      title: {
        variants: [
          { lang: "en", kind: "original", value: "Title of Article" },
          { lang: "fr", kind: "translated", value: "Titre de l'article" },
        ],
      },
      container: { variants: [{ lang: "en", kind: "original", value: "Journal of Hidden Things" }] },
    });
    const sf = await repo.createSource(project.id, d, pdfFile(), { provenance: provenance() });
    const folder = join(lib.root, sf.source.folder);
    expect(await readdir(folder)).toEqual(expect.arrayContaining(["source.json.enc", "original"]));
    expect(await readdir(folder)).not.toContain("source.json");
    const asset = sf.assets[0]!;
    expect(asset.path.endsWith(".pdf.enc")).toBe(true);
    expect(asset.encrypted).toBe(true);
    expect((await decrypt(join(lib.root, asset.path))).equals(pdfBytes)).toBe(true);

    const manifestText = await readFile(join(dir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toEqual({
      formatVersion: 1,
      sources: [{ id: sf.source.id, type: "article-journal", issuedYear: "2025", folder: sf.source.folder, files: [asset.path] }],
    });
    expect(manifestText).not.toMatch(/"title"|Titre|Hidden Things|Jane/);

    const back = SourceFile.parse(JSON.parse((await decrypt(join(folder, "source.json.enc"))).toString("utf8")));
    expect(back).toEqual(sf);
    // Change log lines carry no plaintext entity data.
    const changes = await readFile(join(dir, "changes/2026-11.jsonl"), "utf8");
    expect(changes).not.toMatch(/Title of Article|Smith/);
  });

  it("writes key files with mode 0600", async () => {
    if (process.platform === "win32") return;
    const { dir } = await setup();
    expect((await stat(join(dir, "keys/project-key.json"))).mode & 0o777).toBe(0o600);
  });

  it("pseudonymizes handles in every file and folder name", async () => {
    const { repo, project, dir } = await setup();
    const mp4 = join(tmp, "@maria.cocina reel.mp4");
    await writeFile(mp4, "video");
    const sf = await repo.createSource(
      project.id,
      draft({
        type: "social-post",
        title: { variants: [{ lang: "es", kind: "original", value: "Cocinando con @maria.cocina" }] },
        creators: [{ literal: "@maria.cocina", handle: "@maria.cocina", role: "uploader" }],
        issued: "2026-03-14",
        identifiers: { platform: "instagram" },
      }),
      [{ path: mp4, role: "original", handling: "copy" }],
      { provenance: provenance({ captureMethod: "downloader", identifiable: true, legal: { status: "consented", basis: "consent" } }) },
    );
    await repo.addDerivedAsset(project.id, sf.source.id, { ...derivedInput(sf.assets[0]!.id), fromPath: mp4 });
    // Given name alone, and a researcher (interviewer) who is not a participant.
    const interview = await repo.createSource(
      project.id,
      draft({
        type: "interview",
        title: { variants: [{ lang: "es", kind: "original", value: "Entrevista con Maria" }] },
        creators: [
          { given: "Ana", family: "Ruiz", role: "interviewer" },
          { given: "Maria", family: "Lopez", role: "interviewee" },
        ],
        issued: "2026-03-20",
      }),
      pdfFile(),
      { provenance: provenance({ identifiable: true, legal: { status: "consented", basis: "consent" } }) },
    );
    expect(interview.source.folder).toMatch(/Sources\/2026-03-20 P-002 - Entrevista con P-002 \[[0-9a-z]{4,}\]$/);
    const names = await walk(join(lib.root, "Projects"));
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) expect(n.toLowerCase()).not.toContain("maria");
    expect(sf.source.folder).toMatch(/Sources\/2026-03-14 P-001 - Cocinando con P-001 \[[0-9a-z]{4,}\]$/);
    // Plaintext files under the project mention no handle either.
    for (const n of names) {
      const p = join(lib.root, "Projects", n);
      if ((await stat(p)).isDirectory() || n.endsWith(".enc")) continue;
      expect((await readFile(p, "utf8")).toLowerCase(), n).not.toContain("maria");
    }
    // The pseudonym map is encrypted and maps the handle to the participant code.
    const map = JSON.parse((await decrypt(join(dir, "keys/pseudonyms.json.enc"))).toString("utf8"));
    expect(map).toEqual({ formatVersion: 1, map: { "@maria.cocina": "P-001", "Maria Lopez": "P-002" } });
    const fw = await repo.getFieldwork(project.id);
    expect(fw.participants.map((p) => p.code)).toEqual(["P-001", "P-002"]);
    expect(interview.source.participantIds).toEqual([fw.participants[1]!.id]);
    expect(sf.source.participantIds).toEqual([fw.participants[0]!.id]);
  });

  it("locks and unlocks with the passphrase or the recovery code", async () => {
    const { repo, project, recoveryCode } = await setup();
    const sf = await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    expect(repo.isUnlocked(project.id)).toBe(true);
    repo.lockProject(project.id);
    expect(repo.isUnlocked(project.id)).toBe(false);
    await expect(repo.getSource(project.id, sf.source.id)).rejects.toBeInstanceOf(ProjectLockedError);
    const before = await walk(join(lib.root, "Projects"));
    await expect(repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(
      ProjectLockedError,
    );
    expect(await walk(join(lib.root, "Projects"))).toEqual(before);

    await expect(repo.unlockProject(project.id, "wrong")).rejects.toBeInstanceOf(WrongPassphraseError);
    await repo.unlockProject(project.id, "correct horse");
    expect((await repo.getSource(project.id, sf.source.id)).source.id).toBe(sf.source.id);
    repo.lockProject(project.id);
    await repo.unlockProject(project.id, recoveryCode!.toLowerCase());
    expect(repo.isUnlocked(project.id)).toBe(true);
  });

  it("stores identifying participant details only in fieldwork.json.enc", async () => {
    const { repo, project, dir } = await setup();
    const p1 = await repo.createParticipant(project.id, { details: { name: "Rosa Quispe" }, legalBasis: "consent" });
    const p2 = await repo.createParticipant(project.id, {});
    expect([p1.code, p2.code]).toEqual(["P-001", "P-002"]);
    expect(await readFile(join(dir, "project.json"), "utf8")).not.toContain("Rosa");
    const fw = JSON.parse((await decrypt(join(dir, "fieldwork.json.enc"))).toString("utf8"));
    expect(fw.participants[p1.id]).toEqual({ name: "Rosa Quispe" });
    expect((await repo.getFieldwork(project.id)).participants[0]!.details).toEqual({ name: "Rosa Quispe" });
    // Session place/notes are identifying: governed as such and kept out of project.json.
    await expect(repo.createSession(project.id, { date: "2026-03-14", place: "Calle Ocho 12" })).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    const s = await repo.createSession(project.id, { date: "2026-03-14", place: "Calle Ocho 12", notes: "met Rosa", legalBasis: "consent" });
    const pj = await readFile(join(dir, "project.json"), "utf8");
    expect(pj).not.toMatch(/Calle Ocho|met Rosa/);
    const fw2 = JSON.parse((await decrypt(join(dir, "fieldwork.json.enc"))).toString("utf8"));
    expect(fw2.sessions[s.id]).toEqual({ place: "Calle Ocho 12", notes: "met Rosa" });
    expect((await repo.getFieldwork(project.id)).sessions[0]).toMatchObject({ place: "Calle Ocho 12", notes: "met Rosa" });
  });
});

describe("governance", () => {
  it("denied capture throws PolicyDeniedError, writes nothing but a deny audit event", async () => {
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const dir = join(lib.root, project.folder);
    const before = await walk(dir);
    const err = await repo
      .createSource(project.id, draft(), pdfFile(), { provenance: provenance({ captureMethod: "downloader" }) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect((err as PolicyDeniedError).reason).toMatch(/downloader is not enabled/);
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
    expect(await walk(dir)).toEqual(before);
    const events = await auditEvents(dir);
    expect(verifyChain(events).ok).toBe(true);
    const last = events[events.length - 1]!;
    expect(last.action).toBe("capture");
    expect(last.decision).toMatchObject({ result: "deny", reason: expect.stringMatching(/downloader/) });
  });

  it("passes the researcher's time zone to the policy engine (R17)", async () => {
    const gov = `${OPEN_GOV}protocol:
  number: "IRB-1"
  expires: "2026-11-09"
`;
    now = new Date("2026-11-10T03:00:00.000Z"); // still 9 Nov in Los Angeles
    const la = await repoFor({ tz: "America/Los_Angeles" });
    const { project } = await la.createProject({ name: "P", governanceYaml: gov, encryption: { enabled: false } });
    await expect(la.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).resolves.toBeDefined();
    const utc = await repoFor({ tz: "UTC" });
    await expect(utc.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).rejects.toThrow(
      /Protocol expired on 2026-11-09/,
    );
  });

  it("fails closed when governance.yaml is edited to need encryption, or becomes invalid", async () => {
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const dir = join(lib.root, project.folder);
    await writeFile(join(dir, "governance.yaml"), "identifiability:\n  containsIdentifiable: false\n");
    await expect(repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).rejects.toThrow(
      /requires encryption at rest/,
    );
    await writeFile(join(dir, "governance.yaml"), "nonsense: [");
    await expect(repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).rejects.toThrow(
      /Policy could not be evaluated/,
    );
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
    const denies = (await auditEvents(dir)).filter((e) => e.decision?.result === "deny");
    expect(denies.map((e) => e.action)).toEqual(["store", "capture"]);
  });

  it("refuses an identifiable, pseudonymized project without encryption", async () => {
    const repo = await repoFor();
    await expect(
      repo.createProject({
        name: "P",
        governanceYaml: "encryption:\n  atRest: optional\n",
        encryption: { enabled: false },
      }),
    ).rejects.toThrow(GovernanceViolationError);
    await expect(
      repo.createProject({ name: "Q", governanceYaml: "identifiability:\n  containsIdentifiable: false\n", encryption: { enabled: false } }),
    ).rejects.toThrow(/encryption/i);
    expect(await readdir(join(lib.root, "Projects"))).toEqual([]);
  });

  it("writes unencrypted identifiable files with mode 0600", async () => {
    if (process.platform === "win32") return;
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: IDENT_PLAIN_GOV, encryption: { enabled: false } });
    const sf = await repo.createSource(project.id, draft(), pdfFile(), {
      provenance: provenance({ identifiable: true, legal: { status: "consented", basis: "consent" } }),
    });
    expect((await stat(join(lib.root, sf.assets[0]!.path))).mode & 0o777).toBe(0o600);
    expect((await stat(join(lib.root, sf.source.folder, "source.json"))).mode & 0o777).toBe(0o600);
    const d = await repo.addDerivedAsset(project.id, sf.source.id, derivedInput(sf.assets[0]!.id));
    expect((await stat(join(lib.root, d.path))).mode & 0o777).toBe(0o600);
    expect((await stat(join(lib.root, project.folder, "changes/2026-11.jsonl"))).mode & 0o777).toBe(0o600);
    // Sessions with a place make project.json identifying (0600).
    expect((await stat(join(lib.root, project.folder, "project.json"))).mode & 0o777).not.toBe(0o600);
    await repo.createSession(project.id, { date: "2026-03-14", place: "Lima", legalBasis: "consent" });
    expect((await stat(join(lib.root, project.folder, "project.json"))).mode & 0o777).toBe(0o600);
  });

  it("writes every unencrypted change log 0600, even without identifiable data (R19)", async () => {
    if (process.platform === "win32") return;
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const changes = join(lib.root, project.folder, "changes/2026-11.jsonl");
    expect((await stat(changes)).mode & 0o777).toBe(0o600);
    await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    expect((await stat(changes)).mode & 0o777).toBe(0o600);
    now = new Date("2026-12-01T10:00:00.000Z"); // a new month file, created by a mutation
    await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    expect((await stat(join(lib.root, project.folder, "changes/2026-12.jsonl"))).mode & 0o777).toBe(0o600);
    await repo.createTag("workspace", "x");
    expect((await stat(join(lib.root, "changes/2026-12.jsonl"))).mode & 0o777).toBe(0o600);
  });
});

describe("sources", () => {
  let repo: Repo;
  let pid: string;
  beforeEach(async () => {
    repo = await repoFor();
    pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  });

  it("updateSource rejects provenance changes and applies other edits with change entries", async () => {
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    const changed = { ...sf.source.provenance, capturedAt: "2026-01-01T00:00:00.000Z" };
    await expect(repo.updateSource(pid, sf.source.id, { provenance: changed })).rejects.toBeInstanceOf(ImmutableProvenanceError);
    // Same provenance (deep-equal copy) is fine.
    now = new Date("2026-11-09T15:00:00.000Z");
    const up = await repo.updateSource(pid, sf.source.id, {
      provenance: structuredClone(sf.source.provenance),
      publisher: "Acme Press",
    });
    expect(up.source.publisher).toBe("Acme Press");
    expect(up.source.modifiedAt).toBe("2026-11-09T15:00:00.000Z");
    expect(up.source.provenance).toEqual(sf.source.provenance);
    const changes = await changeLines(join(lib.root, "Projects/P"));
    expect(changes.some((c) => c.op === "update" && c.field === "/publisher" && c.value === "Acme Press")).toBe(true);
  });

  it("two derived assets in the same minute never overwrite each other", async () => {
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    const a = await repo.addDerivedAsset(pid, sf.source.id, derivedInput(sf.assets[0]!.id));
    const firstBytes = await readFile(join(lib.root, a.path));
    await writeFile(pdf, "second version");
    const b = await repo.addDerivedAsset(pid, sf.source.id, derivedInput(sf.assets[0]!.id));
    expect(a.path).toBe(
      `${sf.source.folder}/derived/2025 Smith - Title of Article - ocr - en - tesseract-5 - modified 2026-11-09 1430.txt`,
    );
    expect(b.path).toBe(
      `${sf.source.folder}/derived/2025 Smith - Title of Article - ocr - en - tesseract-5 - modified 2026-11-09 1430 (2).txt`,
    );
    expect((await readFile(join(lib.root, a.path))).equals(firstBytes)).toBe(true);
    expect(await readFile(join(lib.root, b.path), "utf8")).toBe("second version");
    const back = await repo.getSource(pid, sf.source.id);
    expect(back.assets.map((x) => x.id)).toEqual([sf.assets[0]!.id, a.id, b.id]);
  });

  it("deleteSource removes the folder and logs a delete", async () => {
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    await repo.deleteSource(pid, sf.source.id);
    expect(await readdir(join(lib.root, "Projects/P/Sources"))).toEqual([]);
    expect(await readdir(join(lib.root, ".tmp"))).toEqual([]);
    const changes = await changeLines(join(lib.root, "Projects/P"));
    expect(changes.some((c) => c.op === "delete" && (c.entity as { id: string }).id === sf.source.id)).toBe(true);
    await expect(repo.getSource(pid, sf.source.id)).rejects.toThrow(/not found/);
  });

  it("rolls back every file when the change log append fails", async () => {
    const dir = join(lib.root, "Projects/P");
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    const sourcesBefore = await readdir(join(dir, "Sources"));
    const sourceJsonBefore = await readFile(join(lib.root, sf.source.folder, "source.json"), "utf8");
    const auditBefore = (await auditEvents(dir)).length;
    // Make the month's change log unappendable.
    await rm(join(dir, "changes/2026-11.jsonl"));
    await mkdir(join(dir, "changes/2026-11.jsonl"));

    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toThrow();
    expect(await readdir(join(dir, "Sources"))).toEqual(sourcesBefore);
    await expect(repo.addDerivedAsset(pid, sf.source.id, derivedInput(sf.assets[0]!.id))).rejects.toThrow();
    expect(await readdir(join(lib.root, sf.source.folder))).toEqual(["original", "source.json"]);
    expect(await readFile(join(lib.root, sf.source.folder, "source.json"), "utf8")).toBe(sourceJsonBefore);
    await expect(repo.deleteSource(pid, sf.source.id)).rejects.toThrow();
    expect(await readFile(join(lib.root, sf.source.folder, "source.json"), "utf8")).toBe(sourceJsonBefore);
    expect(await readdir(join(lib.root, ".tmp"))).toEqual([]);

    const events = await auditEvents(dir);
    expect(events).toHaveLength(auditBefore);
    expect(verifyChain(events).ok).toBe(true);
    // Repairing the change log lets the next mutation through.
    await rm(join(dir, "changes/2026-11.jsonl"), { recursive: true });
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).resolves.toBeDefined();
  });

  it("removes already-appended audit and change lines when a later audit append fails", async () => {
    // Two events per segment: project.create is #1, the source's capture #2 (0001), its store #3 (0002).
    const r = await repoFor({ auditSegmentSize: 2 });
    const { project } = await r.createProject({ name: "Q", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const dir = join(lib.root, project.folder);
    await mkdir(join(dir, "audit/0002.jsonl"));
    const changesBefore = await readFile(join(dir, "changes/2026-11.jsonl"), "utf8");
    await expect(r.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).rejects.toThrow();
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
    expect(await readFile(join(dir, "changes/2026-11.jsonl"), "utf8")).toBe(changesBefore);
    await rm(join(dir, "audit/0002.jsonl"), { recursive: true });
    const events = await auditEvents(dir);
    expect(events).toHaveLength(1);
    expect((await repoFor({ auditSegmentSize: 2 })).integrityWarnings).toEqual([]);
    await expect(r.createSource(project.id, draft(), pdfFile(), { provenance: provenance() })).resolves.toBeDefined();
    expect(verifyChain(await auditEvents(dir)).ok).toBe(true);
  });

  it("read-only library: createSource throws ReadOnlyLibraryError and writes nothing", async () => {
    const ro: Library = { ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" };
    const roRepo = await repoFor({}, ro);
    const before = await walk(lib.root);
    const anchorsBefore = await readFile(join(tmp, "config/audit-anchors.json"), "utf8");
    await expect(roRepo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(
      ReadOnlyLibraryError,
    );
    await expect(
      roRepo.createProject({ name: "X", governanceYaml: OPEN_GOV, encryption: { enabled: false } }),
    ).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    // A denied method would also be refused before policy evaluation (no deny event).
    await expect(
      roRepo.createSource(pid, draft(), pdfFile(), { provenance: provenance({ captureMethod: "downloader" }) }),
    ).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(await walk(lib.root)).toEqual(before);
    expect(await readFile(join(tmp, "config/audit-anchors.json"), "utf8")).toBe(anchorsBefore);
  });
});

describe("collections, tags, fieldwork", () => {
  let repo: Repo;
  let pid: string;
  beforeEach(async () => {
    repo = await repoFor();
    pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  });

  it("creates nested collections, prevents cycles, and deleting removes membership only", async () => {
    const a = await repo.createCollection(pid, "Theory");
    const b = await repo.createCollection(pid, "Methods", a.id);
    const c = await repo.createCollection(pid, "Interviews", b.id);
    await expect(repo.moveCollection(pid, a.id, c.id)).rejects.toThrow(/cycle/);
    await expect(repo.createCollection(pid, "x", newId())).rejects.toThrow(/not found/);
    await repo.moveCollection(pid, c.id, null);
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    const tag = await repo.createTag(pid, "important", "#ff0000");
    const wtag = await repo.createTag("workspace", "to-read");
    await repo.setMembership(pid, sf.source.id, { collectionIds: [b.id, c.id], tagIds: [tag.id, wtag.id] });
    await expect(repo.setMembership(pid, sf.source.id, { tagIds: [newId()] })).rejects.toThrow(/not found/);

    await repo.deleteCollection(pid, b.id);
    const back = await repo.getSource(pid, sf.source.id);
    expect(back.source.collectionIds).toEqual([c.id]);
    expect(back.source.tagIds).toEqual([tag.id, wtag.id]);
    const pj = JSON.parse(await readFile(join(lib.root, "Projects/P/project.json"), "utf8"));
    expect(pj.collections.map((x: { name: string }) => x.name).sort()).toEqual(["Interviews", "Theory"]);
    expect(pj.tags).toEqual([{ id: tag.id, scope: pid, name: "important", color: "#ff0000" }]);
    const ws = JSON.parse(await readFile(join(lib.root, "tags.json"), "utf8"));
    expect(ws.tags).toEqual([{ id: wtag.id, scope: "workspace", name: "to-read" }]);
  });

  it("creates participants, sessions and consent, and links sources", async () => {
    // Session place/notes are identifying, so use a project governed for identifiable data.
    pid = (await repo.createProject({ name: "Field", governanceYaml: IDENT_PLAIN_GOV, encryption: { enabled: false } })).project.id;
    const p = await repo.createParticipant(pid, {});
    const q = await repo.createParticipant(pid, { code: "P-010" });
    const r = await repo.createParticipant(pid, {});
    expect([p.code, q.code, r.code]).toEqual(["P-001", "P-010", "P-011"]);
    await expect(repo.createParticipant(pid, { code: "P-010" })).rejects.toThrow(/already/);
    const s = await repo.createSession(pid, { date: "2026-03-14", place: "Lima", participantIds: [p.id], legalBasis: "consent" });
    const c = await repo.createConsent(pid, { participantId: p.id, scope: "audio", date: "2026-03-14" });
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    const linked = await repo.linkSourceToFieldwork(pid, sf.source.id, { participantIds: [p.id], sessionId: s.id });
    expect(linked.source.participantIds).toEqual([p.id]);
    expect(linked.source.sessionId).toBe(s.id);
    const fw = await repo.getFieldwork(pid);
    expect(fw.participants.find((x) => x.id === p.id)!.consentIds).toEqual([c.id]);
    expect(fw.sessions).toEqual([s]);
    expect(fw.consents).toEqual([c]);
  });
});

describe("external audit anchor (R12)", () => {
  async function seeded() {
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    const dir = join(lib.root, project.folder);
    const file = join(dir, "audit/0001.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    return { project, dir, file, lines };
  }

  it("records the head outside the library and stays quiet on a clean reopen", async () => {
    const { project, dir } = await seeded();
    const anchors = JSON.parse(await readFile(join(tmp, "config/audit-anchors.json"), "utf8"));
    const events = await auditEvents(dir);
    const head = events[events.length - 1]!;
    expect(anchors.anchors[`${lib.id}/${project.id}`]).toMatchObject({ seq: head.seq, hash: head.hash });
    const again = await repoFor();
    expect(again.integrityWarnings).toEqual([]);
  });

  it("flags a tampered audit file as chain-broken and audits the mismatch", async () => {
    const { project, dir, file, lines } = await seeded();
    const ev = JSON.parse(lines[1]!);
    ev.actor = "mallory";
    lines[1] = JSON.stringify(ev);
    await writeFile(file, `${lines.join("\n")}\n`);
    const again = await repoFor();
    expect(again.integrityWarnings).toEqual([{ projectId: project.id, kind: "chain-broken", detail: expect.any(String) }]);
    const events = await auditEvents(dir);
    expect(events[events.length - 1]!.action).toBe("audit.anchor-mismatch");
  });

  it("flags a rewritten (re-hashed) tail as head-mismatch", async () => {
    const { project, file, lines, dir } = await seeded();
    const evs = lines.map((l) => JSON.parse(l) as AuditEvent);
    const last = evs[evs.length - 1]!;
    const prev = evs[evs.length - 2]!;
    const { seq: _s, hash: _h, prevHash: _p, ...body } = last;
    const forged = sealEvent({ ...body, actor: "mallory" }, { seq: prev.seq, hash: prev.hash });
    lines[lines.length - 1] = JSON.stringify(forged);
    await writeFile(file, `${lines.join("\n")}\n`);
    expect(verifyChain(await auditEvents(dir)).ok).toBe(true);
    const again = await repoFor();
    expect(again.integrityWarnings.map((w) => [w.projectId, w.kind])).toEqual([[project.id, "head-mismatch"]]);
    const events = await auditEvents(dir);
    expect(events[events.length - 1]!.action).toBe("audit.anchor-mismatch");
    expect(verifyChain(events).ok).toBe(true);
  });

  it("flags a truncated audit log", async () => {
    const { project, file, lines } = await seeded();
    await writeFile(file, `${lines.slice(0, -1).join("\n")}\n`);
    const again = await repoFor();
    expect(again.integrityWarnings.map((w) => [w.projectId, w.kind])).toEqual([[project.id, "truncated"]]);
  });

  it("rotates audit segments", async () => {
    const repo = await repoFor({ auditSegmentSize: 3 });
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    await repo.createSource(project.id, draft(), pdfFile(), { provenance: provenance() });
    const dir = join(lib.root, project.folder);
    expect((await readdir(join(dir, "audit"))).sort()).toEqual(["0001.jsonl", "0002.jsonl"]);
    expect(verifyChain(await auditEvents(dir)).ok).toBe(true);
    const again = await repoFor({ auditSegmentSize: 3 });
    expect(again.integrityWarnings).toEqual([]);
  });
});

describe("crash recovery (write-ahead marker)", () => {
  let repo: Repo;
  let pid: string;
  let dir: string;
  beforeEach(async () => {
    repo = await repoFor();
    pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    dir = join(lib.root, "Projects/P");
  });
  afterEach(() => {
    seams.crashAt = undefined;
  });

  const markers = async () => (await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("txn-"));

  it("rolls back a create interrupted after the change log, before the audit append", async () => {
    const changesBefore = await readFile(join(dir, "changes/2026-11.jsonl"), "utf8");
    const auditBefore = await auditEvents(dir);
    seams.crashAt = "before-audit";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(SimulatedCrash);
    // The "dead" process left unaudited data live, plus its marker.
    expect(await readdir(join(dir, "Sources"))).toHaveLength(1);
    expect(await markers()).toHaveLength(1);

    const again = await repoFor();
    expect(again.integrityWarnings).toEqual([{ projectId: pid, kind: "rolled-back-incomplete-write", detail: expect.any(String) }]);
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
    expect(again.listSourceIds(pid)).toEqual([]);
    expect(await readFile(join(dir, "changes/2026-11.jsonl"), "utf8")).toBe(changesBefore);
    expect(await auditEvents(dir)).toEqual(auditBefore);
    expect(await readdir(join(lib.root, ".tmp"))).toEqual([]);
  });

  it("truncates a partially appended audit (between the capture and store events)", async () => {
    const auditBefore = await auditEvents(dir);
    seams.crashAt = "between-audit";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await auditEvents(dir)).toHaveLength(auditBefore.length + 1);
    const again = await repoFor();
    expect(again.integrityWarnings.map((w) => w.kind)).toEqual(["rolled-back-incomplete-write"]);
    const events = await auditEvents(dir);
    expect(events).toEqual(auditBefore);
    expect(verifyChain(events).ok).toBe(true);
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
  });

  it("restores replaced and trashed files of interrupted updates and deletes", async () => {
    const sf = await repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() });
    const jsonPath = join(lib.root, sf.source.folder, "source.json");
    const before = await readFile(jsonPath, "utf8");
    seams.crashAt = "before-audit";
    await expect(repo.updateSource(pid, sf.source.id, { publisher: "X" })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await readFile(jsonPath, "utf8")).not.toBe(before);
    await repoFor();
    expect(await readFile(jsonPath, "utf8")).toBe(before);

    const r2 = await repoFor();
    seams.crashAt = "before-changes";
    await expect(r2.deleteSource(pid, sf.source.id)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
    const r3 = await repoFor();
    expect(r3.integrityWarnings.map((w) => w.kind)).toEqual(["rolled-back-incomplete-write"]);
    expect(await readFile(jsonPath, "utf8")).toBe(before);
    expect((await r3.getSource(pid, sf.source.id)).source.id).toBe(sf.source.id);
    expect(await readdir(join(lib.root, ".tmp"))).toEqual([]);
  });

  it("keeps a committed change whose marker was not yet deleted", async () => {
    seams.crashAt = "before-marker-delete";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(SimulatedCrash);
    const again = await repoFor();
    expect(again.integrityWarnings).toEqual([]);
    expect(again.listSourceIds(pid)).toHaveLength(1);
    expect(await markers()).toEqual([]);
    const allows = (await auditEvents(dir)).filter((e) => (e.details as { txn?: string }).txn);
    expect(allows.map((e) => e.action)).toEqual(["capture", "store"]);
    expect(new Set(allows.map((e) => (e.details as { txn: string }).txn)).size).toBe(1);
  });
});

describe("anchors file corruption (R12)", () => {
  it("warns, keeps the corrupt file aside and re-records the anchors", async () => {
    const repo = await repoFor();
    const { project } = await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } });
    const path = join(tmp, "config/audit-anchors.json");
    await writeFile(path, "{ not json");
    const again = await repoFor();
    expect(again.integrityWarnings).toEqual([{ projectId: "*", kind: "anchors-unreadable", detail: expect.any(String) }]);
    const aside = (await readdir(join(tmp, "config"))).filter((n) => n.startsWith("audit-anchors.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(tmp, "config", aside[0]!), "utf8")).toBe("{ not json");
    const fresh = JSON.parse(await readFile(path, "utf8"));
    expect(fresh.anchors[`${lib.id}/${project.id}`].seq).toBe(1);
  });

  it("never overwrites an unparseable or wrong-shape anchors file", async () => {
    const store = AnchorStore.forConfigDir(join(tmp, "config2"));
    await mkdir(join(tmp, "config2"));
    for (const bad of ["garbage", JSON.stringify({ formatVersion: 1, anchors: { k: { seq: "x" } } })]) {
      await writeFile(store.path, bad);
      await expect(store.set("k", { seq: 1, hash: "a".repeat(64) }, NOW)).rejects.toThrow(/anchors/);
      expect(await readFile(store.path, "utf8")).toBe(bad);
    }
  });
});

describe("recovery safety (fix round 2)", () => {
  let repo: Repo;
  let pid: string;
  let dir: string;
  beforeEach(async () => {
    repo = await repoFor();
    pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
    dir = join(lib.root, "Projects/P");
  });
  afterEach(() => {
    seams.crashAt = undefined;
    seams.failUndo = undefined;
  });

  const tmpNames = async () => (await readdir(join(lib.root, ".tmp"))).sort();
  async function plantMarker(over: Record<string, unknown>, entries: unknown[]): Promise<string> {
    const txn = newId();
    const m = { formatVersion: 1, txn, projectId: pid, projectFolder: "Projects/P", auditEvents: 2, auditSeqBefore: 1, entries, ...over };
    await writeFile(join(lib.root, ".tmp", `txn-${txn}.json`), JSON.stringify(m));
    return txn;
  }
  const kinds = (r: Repo) => r.integrityWarnings.map((w) => w.kind);

  it("N1: never acts on a marker whose paths escape the library, its project or .tmp", async () => {
    const outside = join(tmp, "outside.txt");
    await writeFile(outside, "keep");
    const q = (await repo.createProject({ name: "Q", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project;
    const qJson = join(lib.root, q.folder, "project.json");
    const qBefore = await readFile(qJson, "utf8");
    const pJsonBefore = await readFile(join(dir, "project.json"), "utf8");
    const govBefore = await readFile(join(dir, "governance.yaml"), "utf8");
    await plantMarker({}, [{ kind: "created", path: "Projects/P/../../../outside.txt" }]);
    await plantMarker({}, [{ kind: "created", path: `${q.folder}/project.json` }]);
    await plantMarker({ projectFolder: q.folder.replace("Q", "../Q") }, [{ kind: "created", path: `${q.folder}/project.json` }]);
    await plantMarker({}, [{ kind: "replaced", path: "Projects/P/project.json", backup: "Projects/P/governance.yaml", mode: 0o644 }]);
    await plantMarker({}, [{ kind: "trashed", from: "Projects/P/Sources", to: "../elsewhere" }]);
    const before = await tmpNames();

    const again = await repoFor();
    expect(kinds(again)).toEqual(Array(5).fill("invalid-txn-marker"));
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(await readFile(qJson, "utf8")).toBe(qBefore);
    expect(await readFile(join(dir, "project.json"), "utf8")).toBe(pJsonBefore);
    expect(await readFile(join(dir, "governance.yaml"), "utf8")).toBe(govBefore);
    expect(await tmpNames()).toEqual(before); // markers kept
  });

  it("N2: backups of 0600 files are 0600", async () => {
    if (process.platform === "win32") return;
    const r = await repoFor();
    const p2 = (await r.createProject({ name: "I", governanceYaml: IDENT_PLAIN_GOV, encryption: { enabled: false } })).project.id;
    const sf = await r.createSource(p2, draft(), pdfFile(), {
      provenance: provenance({ identifiable: true, legal: { status: "consented", basis: "consent" } }),
    });
    seams.crashAt = "before-audit";
    await expect(r.updateSource(p2, sf.source.id, { publisher: "X" })).rejects.toBeInstanceOf(SimulatedCrash);
    const backups = (await tmpNames()).filter((n) => /\.orig-\d+$/.test(n));
    expect(backups).toHaveLength(1);
    expect((await stat(join(lib.root, ".tmp", backups[0]!))).mode & 0o777).toBe(0o600);
  });

  it("N3: a read-only open reports pending markers and touches nothing", async () => {
    seams.crashAt = "before-audit";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(SimulatedCrash);
    const before = await walk(lib.root);
    const ro: Library = { ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" };
    const roRepo = await repoFor({}, ro);
    expect(roRepo.integrityWarnings).toEqual([{ projectId: "*", kind: "incomplete-write-pending", detail: expect.any(String) }]);
    expect(await walk(lib.root)).toEqual(before);
    // Read-write recovery still works afterwards.
    expect(kinds(await repoFor())).toEqual(["rolled-back-incomplete-write"]);
  });

  it("N4: keeps the marker and blocks writes when an in-process undo step fails", async () => {
    await rm(join(dir, "changes/2026-11.jsonl"));
    await mkdir(join(dir, "changes/2026-11.jsonl"));
    seams.failUndo = "created";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toThrow();
    expect((await tmpNames()).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    await expect(repo.createCollection(pid, "x")).rejects.toBeInstanceOf(RecoveryPendingError);
    seams.failUndo = undefined;
    await rm(join(dir, "changes/2026-11.jsonl"), { recursive: true });

    const again = await repoFor();
    expect(kinds(again)).toEqual(["rolled-back-incomplete-write"]);
    expect(await readdir(join(dir, "Sources"))).toEqual([]);
    expect(await tmpNames()).toEqual([]);
    await expect(again.createCollection(pid, "x")).resolves.toBeDefined();
  });

  it("N5: keeps backups of an unreadable marker, reports it, and removes orphan backups", async () => {
    const txn = newId();
    await writeFile(join(lib.root, ".tmp", `txn-${txn}.json`), "{ torn");
    await writeFile(join(lib.root, ".tmp", `txn-${txn}.orig-0`), "original bytes");
    const orphan = newId();
    await writeFile(join(lib.root, ".tmp", `txn-${orphan}.orig-0`), "stale");
    const again = await repoFor();
    expect(again.integrityWarnings).toEqual([{ projectId: "*", kind: "invalid-txn-marker", detail: expect.any(String) }]);
    expect(await tmpNames()).toEqual([`txn-${txn}.json`, `txn-${txn}.orig-0`].sort());
  });

  it("does not roll back when the audit chain does not verify", async () => {
    seams.crashAt = "before-audit";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(SimulatedCrash);
    const file = join(dir, "audit/0001.jsonl");
    const ev = JSON.parse((await readFile(file, "utf8")).trim());
    ev.actor = "mallory";
    await writeFile(file, `${JSON.stringify(ev)}\n`);
    const again = await repoFor();
    expect(kinds(again)).toContain("txn-recovery-skipped-audit-unverifiable");
    expect(kinds(again)).not.toContain("rolled-back-incomplete-write");
    expect(await readdir(join(dir, "Sources"))).toHaveLength(1);
    expect((await tmpNames()).filter((n) => n.startsWith("txn-"))).toHaveLength(1);
  });

  it("does not roll back when the anchor is past the transaction's start", async () => {
    seams.crashAt = "before-audit";
    await expect(repo.createSource(pid, draft(), pdfFile(), { provenance: provenance() })).rejects.toBeInstanceOf(SimulatedCrash);
    const path = join(tmp, "config/audit-anchors.json");
    const j = JSON.parse(await readFile(path, "utf8"));
    j.anchors[`${lib.id}/${pid}`] = { seq: 2, hash: "f".repeat(64), at: NOW };
    await writeFile(path, JSON.stringify(j));
    const again = await repoFor();
    expect(kinds(again)).toContain("txn-recovery-skipped-audit-unverifiable");
    expect(await readdir(join(dir, "Sources"))).toHaveLength(1);
    expect((await tmpNames()).filter((n) => n.startsWith("txn-"))).toHaveLength(1);
  });
});
