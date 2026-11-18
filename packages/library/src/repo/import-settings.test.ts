/**
 * A watched folder's options in project.json (cloud-drive watched folders, Task W7 round 2, Ruling R227): one
 * governed, audited, crash-safe change (R26); the audit holds the watch's id and which fields changed, never the
 * label's text (R177, R69); in an encrypted project the change log holds it only sealed.
 */
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditEvent, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { InvalidInputError, NotFoundError, ProjectLockedError, ReadOnlyLibraryError } from "./errors.js";
import { addWatchedFolderEntry, updateWatchedFolderEntry, type Repo } from "./repo.js";
import { SimulatedCrash, openTestRepo, seams, type CrashPoint } from "./testing.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;
const OP = "project.watched-folder.options";
const LABEL = "Zyxwvut Interviews Rosário";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

const mkDeps = (): Deps => ({
  clock: () => new Date(),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});
const repoFor = (l: Library = lib) => openTestRepo(l, ring, { scryptN: 2 ** 10, actor: "tester" });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-import-settings-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await repoFor();
});
afterEach(async () => {
  seams.crashAt = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

const project = async (encrypted = false): Promise<Project> =>
  (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } })).project;

async function dirText(p: Project, sub: string): Promise<string> {
  const dir = join(lib.root, p.folder, sub);
  let out = "";
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) out += await readFile(join(dir, f), "utf8");
  return out;
}
const events = async (p: Project) =>
  (await dirText(p, "audit"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEvent)
    .filter((e) => e.details?.op === OP);
const txnMarkers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
const watchOf = (p: Project, id: string) => repo.getProject(p.id).watchedFolders?.find((w) => w.id === id);

describe("a watched folder's options (W7 round 2, R227)", () => {
  it("label and collection are set and cleared as one governed change; the audit names the fields, never the label", async () => {
    for (const encrypted of [false, true]) {
      const p = await project(encrypted);
      const c = await repo.createCollection(p.id, "Interviews");
      const w = await addWatchedFolderEntry(repo, p.id, { recursive: true });
      const out = await updateWatchedFolderEntry(repo, p.id, w.id, { label: LABEL, collectionId: c.id });
      expect(out).toEqual({ ...w, options: { recursive: true, label: LABEL, collectionId: c.id } });
      expect(watchOf(p, w.id)?.options).toEqual({ recursive: true, label: LABEL, collectionId: c.id });
      await updateWatchedFolderEntry(repo, p.id, w.id, { label: null });
      expect(watchOf(p, w.id)?.options).toEqual({ recursive: true, collectionId: c.id });
      await updateWatchedFolderEntry(repo, p.id, w.id, { collectionId: null });
      expect(watchOf(p, w.id)?.options).toEqual({ recursive: true });
      const ev = await events(p);
      expect(ev.map((e) => e.details)).toEqual([
        expect.objectContaining({ op: OP, watch: w.id, fields: ["label", "collectionId"] }),
        expect.objectContaining({ op: OP, watch: w.id, fields: ["label"] }),
        expect.objectContaining({ op: OP, watch: w.id, fields: ["collectionId"] }),
      ]);
      // The label's text: never in the audit; in an encrypted project, never in the clear in the change log either.
      expect(await dirText(p, "audit")).not.toContain("Zyxwvut");
      if (encrypted) expect(await dirText(p, "changes")).not.toContain("Zyxwvut");
    }
  });

  it("an empty patch, or one that changes nothing, writes and audits nothing", async () => {
    const p = await project();
    const w = await addWatchedFolderEntry(repo, p.id, { label: "Same" });
    const before = await dirText(p, "audit");
    expect(await updateWatchedFolderEntry(repo, p.id, w.id, {})).toEqual(w);
    expect(await updateWatchedFolderEntry(repo, p.id, w.id, { label: "Same", collectionId: null })).toEqual(w);
    expect(await dirText(p, "audit")).toBe(before);
  });

  it("an unknown watch, a collection not in the project and a bad value are refused, writing nothing", async () => {
    const p = await project();
    const other = await project();
    const foreign = await repo.createCollection(other.id, "Elsewhere");
    const w = await addWatchedFolderEntry(repo, p.id, {});
    const before = await readFile(join(lib.root, p.folder, "project.json"), "utf8");
    await expect(updateWatchedFolderEntry(repo, p.id, "0193a1f2-7c4e-7b11-9d2a-5e6f7a8b9c0d", { label: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateWatchedFolderEntry(repo, p.id, w.id, { collectionId: foreign.id })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateWatchedFolderEntry(repo, p.id, w.id, { label: "x".repeat(201) })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateWatchedFolderEntry(repo, p.id, w.id, { label: 3 as unknown as string })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(updateWatchedFolderEntry(repo, p.id, w.id, { recursive: true } as never)).rejects.toBeInstanceOf(InvalidInputError);
    expect(await readFile(join(lib.root, p.folder, "project.json"), "utf8")).toBe(before);
    expect(await events(p)).toEqual([]);
  });

  it("a locked project and a read-only library refuse before anything is written", async () => {
    const p = await project(true);
    const w = await addWatchedFolderEntry(repo, p.id, {});
    repo.lockProject(p.id);
    await expect(updateWatchedFolderEntry(repo, p.id, w.id, { label: LABEL })).rejects.toBeInstanceOf(ProjectLockedError);
    await repo.unlockProject(p.id, "pw");
    const ro = await repoFor({ ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    await expect(updateWatchedFolderEntry(ro, p.id, w.id, { label: LABEL })).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(watchOf(p, w.id)?.options.label).toBeUndefined();
    expect(await events(p)).toEqual([]);
  });

  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as CrashPoint[]) {
    it(`a crash at ${point} leaves the old project.json or the new one, and an audit entry only for a change that happened`, async () => {
      const p = await project(true);
      const w = await addWatchedFolderEntry(repo, p.id, { label: "Old" });
      seams.crashAt = point;
      await expect(updateWatchedFolderEntry(repo, p.id, w.id, { label: LABEL })).rejects.toBeInstanceOf(SimulatedCrash);
      seams.crashAt = undefined;
      await lib.close();
      lib = await openLibrary(lib.root, mkDeps());
      repo = await repoFor();
      await repo.unlockProject(p.id, "pw");
      const committed = point === "before-marker-delete";
      expect(repo.getProject(p.id).watchedFolders?.find((x) => x.id === w.id)?.options.label).toBe(committed ? LABEL : "Old");
      expect(await events(p)).toHaveLength(committed ? 1 : 0);
      expect(await txnMarkers()).toEqual([]);
    });
  }
});
