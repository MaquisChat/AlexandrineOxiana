/**
 * Workspace tags: rename and delete (R118 b). A workspace tag can be on sources of every project,
 * so each change is governed and audited in every project (one governed change per project, with
 * the R26 write-ahead marker), and the workspace file `tags.json` changes last, change-logged.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditEvent, type Provenance, type SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { NotFoundError, ProjectLockedError, RecoveryPendingError, type Repo } from "./index.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let pdf: string;

function mkDeps(): Deps {
  return {
    clock: () => new Date(NOW),
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

const repoFor = (): Promise<Repo> => openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });

const draft = (title: string): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [{ family: "Smith", given: "Jane", role: "author" }],
  issued: "2025",
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});
const provenance = (): Provenance => ({
  captureMethod: "manual_upload",
  capturedAt: NOW,
  tool: { name: "ao", version: "0.0.0" },
  fileHashes: {},
  legal: { status: "public" },
  identifiable: false,
});

async function auditEvents(repo: Repo, projectId: string): Promise<AuditEvent[]> {
  const folder = repo.listProjects().find((p) => p.id === projectId)!.folder;
  const dir = join(lib.root, folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

const workspaceFile = async () => JSON.parse(await readFile(join(lib.root, "tags.json"), "utf8")) as { tags: Array<{ id: string; name: string; color?: string }> };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-wstags-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  pdf = join(tmp, "input.pdf");
  await writeFile(pdf, "%PDF-1.7\nhello\n%%EOF\n");
});
afterEach(async () => {
  seams.crashAt = undefined;
  seams.failAuditAppendFor = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function twoProjectsWithTag(repo: Repo) {
  const a = (await repo.createProject({ name: "A", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const b = (await repo.createProject({ name: "B", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const tag = await repo.createTag("workspace", "to-read", "#112233");
  const other = await repo.createTag("workspace", "later");
  const sa = await repo.createSource(a, draft("One"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  const sb = await repo.createSource(b, draft("Two"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  await repo.setMembership(a, sa.source.id, { tagIds: [tag.id, other.id] });
  await repo.setMembership(b, sb.source.id, { tagIds: [tag.id] });
  return { a, b, tag, other, sa: sa.source.id, sb: sb.source.id };
}

describe("workspace tags: rename (R118 b)", () => {
  it("renames (and recolours) in tags.json, audited in every project, change-logged", async () => {
    const repo = await repoFor();
    const { a, b, tag } = await twoProjectsWithTag(repo);
    const renamed = await repo.renameWorkspaceTag(tag.id, "reading list", "#445566");
    expect(renamed).toMatchObject({ id: tag.id, scope: "workspace", name: "reading list", color: "#445566" });
    expect((await workspaceFile()).tags.find((t) => t.id === tag.id)).toMatchObject({ name: "reading list", color: "#445566" });
    expect((await repo.listWorkspaceTags()).map((t) => t.name).sort()).toEqual(["later", "reading list"]);
    for (const pid of [a, b]) {
      const ev = (await auditEvents(repo, pid)).filter((e) => (e.details as { op?: string })?.op === "workspace-tag.rename");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.entity).toEqual({ type: "tag", id: tag.id });
      // The tag's names are free text: never in the audit log.
      expect(JSON.stringify(ev[0])).not.toContain("reading list");
    }
    const log = (await readdir(join(lib.root, "changes"))).sort();
    const lines = (await Promise.all(log.map((f) => readFile(join(lib.root, "changes", f), "utf8")))).join("");
    expect(lines).toContain("reading list");
  });

  it("refuses a name another workspace tag has, an empty name, and an unknown tag; nothing is audited", async () => {
    const repo = await repoFor();
    const { a, tag } = await twoProjectsWithTag(repo);
    const before = (await auditEvents(repo, a)).length;
    await expect(repo.renameWorkspaceTag(tag.id, "Later")).rejects.toThrow(/already exists/);
    await expect(repo.renameWorkspaceTag(tag.id, "  ")).rejects.toThrow(/name/);
    await expect(repo.renameWorkspaceTag("0190a0a0-0000-7000-8000-000000000000", "x")).rejects.toBeInstanceOf(NotFoundError);
    expect((await auditEvents(repo, a)).length).toBe(before);
    expect((await workspaceFile()).tags.find((t) => t.id === tag.id)?.name).toBe("to-read");
  });

  it("M7: two renames to the same name at once: the one that loses is refused before anything is audited", async () => {
    const repo = await repoFor();
    const { a, b, tag, other } = await twoProjectsWithTag(repo);
    const r = await Promise.allSettled([repo.renameWorkspaceTag(tag.id, "same"), repo.renameWorkspaceTag(other.id, "Same"), repo.createTag("workspace", "SAME")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r) if (x.status === "rejected") expect(String(x.reason)).toMatch(/already exists/);
    expect((await repo.listWorkspaceTags()).filter((t) => t.name.toLowerCase() === "same")).toHaveLength(1);
    for (const pid of [a, b]) {
      expect((await auditEvents(repo, pid)).filter((e) => (e.details as { op?: string })?.op === "workspace-tag.rename").length).toBeLessThanOrEqual(1);
    }
  });

  it("is refused before anything is written while an encrypted project is locked", async () => {
    const repo = await repoFor();
    const { a, tag } = await twoProjectsWithTag(repo);
    const enc = (await repo.createProject({ name: "Secret", governanceYaml: OPEN_GOV, encryption: { enabled: true, passphrase: "correct horse battery staple" } })).project.id;
    repo.lockProject(enc);
    const before = (await auditEvents(repo, a)).length;
    await expect(repo.renameWorkspaceTag(tag.id, "renamed")).rejects.toBeInstanceOf(ProjectLockedError);
    expect((await auditEvents(repo, a)).length).toBe(before);
    expect((await workspaceFile()).tags.find((t) => t.id === tag.id)?.name).toBe("to-read");
  });
});

describe("workspace tags: delete (R118 b)", () => {
  it("removes the tag from every project's sources (governed, audited per project) and then from tags.json", async () => {
    const repo = await repoFor();
    const { a, b, tag, other, sa, sb } = await twoProjectsWithTag(repo);
    await repo.deleteWorkspaceTag(tag.id);
    expect((await repo.getSource(a, sa)).source.tagIds).toEqual([other.id]);
    expect((await repo.getSource(b, sb)).source.tagIds).toEqual([]);
    expect((await workspaceFile()).tags.map((t) => t.id)).toEqual([other.id]);
    for (const pid of [a, b]) {
      const ev = (await auditEvents(repo, pid)).filter((e) => (e.details as { op?: string })?.op === "workspace-tag.delete");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.entity).toEqual({ type: "tag", id: tag.id });
    }
    await expect(repo.deleteWorkspaceTag(tag.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a crash inside a project's change rolls that project back on reopen and leaves tags.json as it was", async () => {
    let repo = await repoFor();
    const { a, b, tag, sa, sb } = await twoProjectsWithTag(repo);
    seams.crashAt = "before-audit";
    await expect(repo.deleteWorkspaceTag(tag.id)).rejects.toBeInstanceOf(SimulatedCrash);
    await lib.close();
    lib = await openLibrary(lib.root, mkDeps());
    repo = await repoFor();
    expect(repo.integrityWarnings.map((w) => w.kind)).toContain("rolled-back-incomplete-write");
    expect((await workspaceFile()).tags.some((t) => t.id === tag.id)).toBe(true);
    expect((await repo.getSource(a, sa)).source.tagIds).toContain(tag.id);
    expect((await repo.getSource(b, sb)).source.tagIds).toContain(tag.id);
    await repo.deleteWorkspaceTag(tag.id);
    expect((await workspaceFile()).tags.some((t) => t.id === tag.id)).toBe(false);
  });

  it("a failure in one project after another committed keeps the tag; deleting again finishes the job", async () => {
    const repo = await repoFor();
    const { a, b, tag, sa, sb } = await twoProjectsWithTag(repo);
    seams.failAuditAppendFor = b;
    await expect(repo.deleteWorkspaceTag(tag.id)).rejects.toThrow();
    seams.failAuditAppendFor = undefined;
    expect((await workspaceFile()).tags.some((t) => t.id === tag.id)).toBe(true);
    expect((await repo.getSource(b, sb)).source.tagIds).toContain(tag.id);
    await repo.deleteWorkspaceTag(tag.id);
    expect((await repo.getSource(a, sa)).source.tagIds).not.toContain(tag.id);
    expect((await repo.getSource(b, sb)).source.tagIds).not.toContain(tag.id);
    expect((await workspaceFile()).tags.some((t) => t.id === tag.id)).toBe(false);
  });

  it("I2: membership changes running alongside the delete, at every step, never leave a source tagged with the deleted tag", async () => {
    const repo = await repoFor();
    const { a, b, sa, sb } = await twoProjectsWithTag(repo);
    for (let round = 0; round < 3; round++) {
      const tag = await repo.createTag("workspace", `round ${round}`);
      await repo.setMembership(a, sa, { tagIds: [tag.id] });
      await repo.setMembership(b, sb, { tagIds: [tag.id] });
      let done = false;
      const del = repo.deleteWorkspaceTag(tag.id).finally(() => {
        done = true;
      });
      // Keep putting the tag back on a source in each project, one change after another, until the delete ends.
      const outcomes: string[] = [];
      let i = 0;
      while (!done) {
        const [pid, sid] = i++ % 2 === 0 ? [a, sa] : [b, sb];
        outcomes.push(await repo.setMembership(pid, sid, { tagIds: [tag.id] }).then(
          () => "ok",
          (e: unknown) => (e instanceof NotFoundError ? "not-found" : String(e)),
        ));
      }
      await del;
      expect(outcomes.every((o) => o === "ok" || o === "not-found"), outcomes.join()).toBe(true);
      expect((await workspaceFile()).tags.some((t) => t.id === tag.id)).toBe(false);
      expect((await repo.getSource(a, sa)).source.tagIds).not.toContain(tag.id);
      expect((await repo.getSource(b, sb)).source.tagIds).not.toContain(tag.id);
    }
  });

  it("I2: while a delete is unfinished the tag cannot be put on a source, it stays listed, and deleting again finishes it", async () => {
    const repo = await repoFor();
    const { a, b, tag, sa, sb } = await twoProjectsWithTag(repo);
    seams.failAuditAppendFor = b;
    await expect(repo.deleteWorkspaceTag(tag.id)).rejects.toThrow();
    seams.failAuditAppendFor = undefined;
    await expect(repo.setMembership(a, sa, { tagIds: [tag.id] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.updateSource(a, sa, { tagIds: [tag.id] })).rejects.toBeInstanceOf(NotFoundError);
    expect((await repo.listWorkspaceTags()).map((t) => t.id)).toContain(tag.id);
    await expect(repo.renameWorkspaceTag(tag.id, "something else")).rejects.toThrow(/being deleted/);
    await repo.deleteWorkspaceTag(tag.id);
    expect((await workspaceFile()).tags.some((t) => t.id === tag.id)).toBe(false);
    expect((await repo.getSource(b, sb)).source.tagIds).not.toContain(tag.id);
  });

  it("is refused before anything is written while a project has an unresolved interrupted change", async () => {
    const repo = await repoFor();
    const { a, b, tag, sb } = await twoProjectsWithTag(repo);
    (repo as unknown as { core: { projects: Map<string, { recoveryPending: boolean }> } }).core.projects.get(b)!.recoveryPending = true;
    const before = (await auditEvents(repo, a)).length;
    await expect(repo.deleteWorkspaceTag(tag.id)).rejects.toBeInstanceOf(RecoveryPendingError);
    expect((await auditEvents(repo, a)).length).toBe(before);
    expect((await repo.getSource(b, sb)).source.tagIds).toContain(tag.id);
  });
});
