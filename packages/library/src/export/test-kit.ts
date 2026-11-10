/**
 * Test-only (not exported from the package): a library, key ring and repository with a settable
 * clock, plus helpers to make projects and sources, shared by the export, backup and retention suites.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AuditEvent, Creator, Project, Provenance, SourceDraft, SourceFile, SourceType } from "@ao/core";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { decryptBytes } from "../repo/io.js";
import { projectDataKey, type Repo } from "../repo/repo.js";
import { openTestRepo, type InternalOptions } from "../repo/testing.js";
import type { RepoOptions } from "../repo/state.js";
import type { SourceInputFile } from "../repo/sources.js";

export const FAST = 2 ** 10;
export const PASS = "correct horse battery staple";

export interface Kit {
  tmp: string;
  lib: Library;
  ring: KeyRing;
  repo: Repo;
  clock: { now: Date };
  reopen(over?: RepoOptions & InternalOptions): Promise<Repo>;
  close(): Promise<void>;
}

export async function makeKit(prefix = "ao-kit-"): Promise<Kit> {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  const clock = { now: new Date("2026-11-10T09:30:00.000Z") };
  const deps: Deps = {
    clock: () => clock.now,
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
  const ring = new KeyRing();
  const lib = await createLibrary(join(tmp, "Lib"), "Lib", deps);
  const open = (over: RepoOptions & InternalOptions = {}) =>
    openTestRepo(lib, ring, { clock: () => clock.now, tz: "UTC", actor: "tester", scryptN: FAST, ...over });
  const kit: Kit = {
    tmp,
    lib,
    ring,
    repo: await open(),
    clock,
    async reopen(over = {}) {
      kit.repo = await open(over);
      return kit.repo;
    },
    async close() {
      await lib.close();
      ring.clear();
      await rm(tmp, { recursive: true, force: true });
    },
  };
  return kit;
}

/** Not identifying, unencrypted. */
export const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import, downloader]
`;

/** Identifiable sources allowed, but exports de-identified only; unencrypted (no pseudonymized names). */
export const DEID_GOV = `identifiability:
  containsIdentifiable: true
  deidentifiedExportsOnly: true
  pseudonymizeFileNames: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import, downloader]
`;

/** Identifiable, pseudonymized names, encryption required; identifiable exports allowed. */
export const PSEUDO_GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: true
  deidentifiedExportsOnly: false
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import, downloader]
`;

export async function makeProject(kit: Kit, gov = OPEN_GOV, encrypted = false, name?: string): Promise<Project> {
  const r = await kit.repo.createProject({
    name: name ?? `P${Math.random().toString(36).slice(2, 7)}`,
    governanceYaml: gov,
    encryption: encrypted ? { enabled: true, passphrase: PASS } : { enabled: false },
  });
  return r.project;
}

export interface SourceSpec {
  type?: SourceType;
  title: string;
  creators?: Creator[];
  issued?: string;
  container?: string;
  citationKey?: string;
  identifiable?: boolean;
  collectionIds?: string[];
  tagIds?: string[];
  files?: SourceInputFile[];
  identifiers?: SourceDraft["identifiers"];
}

const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });

export async function addSource(kit: Kit, p: Project, s: SourceSpec): Promise<SourceFile> {
  const draft: SourceDraft = {
    projectIds: [p.id],
    type: s.type ?? "article-journal",
    title: mt(s.title),
    creators: s.creators ?? [{ family: "Smith", given: "Jane", role: "author" }],
    ...(s.container ? { container: mt(s.container) } : {}),
    ...(s.issued ? { issued: s.issued } : {}),
    identifiers: s.identifiers ?? {},
    ...(s.citationKey ? { citationKey: s.citationKey } : {}),
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: s.collectionIds ?? [],
    tagIds: s.tagIds ?? [],
    participantIds: [],
  };
  const provenance: Provenance = {
    captureMethod: "manual_upload",
    capturedAt: kit.clock.now.toISOString(),
    tool: { name: "test", version: "1" },
    fileHashes: {},
    legal: { status: s.identifiable ? "consented" : "public", basis: "test basis" },
    identifiable: s.identifiable ?? false,
  };
  return kit.repo.createSource(p.id, draft, s.files ?? [], { provenance });
}

/** Writes a file under the kit's scratch folder and returns its path. */
export async function scratchFile(kit: Kit, name: string, data: string | Uint8Array): Promise<string> {
  const path = join(kit.tmp, "in", `${Math.random().toString(36).slice(2, 8)}`, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}

export async function auditEvents(kit: Kit, p: Project): Promise<AuditEvent[]> {
  const dir = join(kit.lib.root, kit.repo.getProject(p.id).folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

/** Every file and folder under `dir`, "/"-separated and relative to it. */
export async function walk(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(rel);
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
  }
  return out;
}

/** The plaintext of a library file (decrypted with the project key when it is encrypted). */
export async function plainOf(kit: Kit, p: Project, rel: string): Promise<Buffer> {
  const raw = await readFile(join(kit.lib.root, ...rel.split("/")));
  const k = projectDataKey(kit.repo, p.id);
  if (!k || !rel.endsWith(".enc")) return raw;
  return decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
}
