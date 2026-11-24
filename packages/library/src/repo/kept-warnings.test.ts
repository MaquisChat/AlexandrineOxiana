/**
 * FR-729 (R503 e): recovery's warnings are kept with the library until the researcher dismisses them: shown again after a
 * close and reopen; dismissed, gone for good; written atomically beside the markers; a damaged record never stops the
 * library from opening; a read-only library shows them and writes nothing; a locked project's warning holds nothing a
 * lock hides; the integrity check does not report the file.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { checkIntegrity } from "../reconnect.js";
import type { Repo } from "./index.js";
import { NotFoundError, ReadOnlyLibraryError } from "./errors.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, type TxnMarker } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const FILE = ".tmp/recovery-warnings.json";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

const mkDeps = (over: Partial<Deps> = {}): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
  ...over,
});
const repoFor = (): Promise<Repo> => openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
const reopen = async () => {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
};
/** The kept warnings as shown: kind, project and id. */
const kept = () => repo.integrityWarnings.filter((w) => w.keptId !== undefined).map((w) => ({ kind: w.kind, projectId: w.projectId, keptId: w.keptId }));
const fileText = () => readFile(fromRel(lib.root, FILE), "utf8").catch(() => null);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-fr729-"));
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

async function project(name: string, encrypted = false): Promise<{ pid: string; folder: string }> {
  const { project } = await repo.createProject({ name, governanceYaml: OPEN_GOV, encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } });
  return { pid: project.id, folder: project.folder };
}
/** A change cut off before its audit entry: the next opening undoes it completely and says so. */
async function crashed(pid: string, folder: string): Promise<void> {
  seams.crashAt = "before-audit";
  await expect(repo.mutate(pid, STORE, async (tx) => tx.writeFile(`${folder}/half.txt`, "half\n"))).rejects.toBeInstanceOf(SimulatedCrash);
  seams.crashAt = undefined;
}

describe("FR-729: a change undone when the library opened is said until dismissed", () => {
  it("kept across a close and reopen, and after a dismissal gone for good", async () => {
    const { pid, folder } = await project("P");
    await crashed(pid, folder);
    await reopen();
    const first = kept();
    expect(first).toEqual([{ kind: "rolled-back-incomplete-write", projectId: pid, keptId: expect.any(String) }]);
    await reopen();
    expect(kept()).toEqual(first);
    await reopen();
    expect(kept()).toEqual(first);
    await repo.dismissRecoveryWarning(first[0]!.keptId!);
    expect(kept()).toEqual([]);
    await reopen();
    expect(kept()).toEqual([]);
    await expect(repo.dismissRecoveryWarning(first[0]!.keptId!)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("two warnings of one kind for two projects: each kept, each dismissed on its own", async () => {
    const a = await project("A");
    const b = await project("B");
    await crashed(a.pid, a.folder);
    await reopen();
    await crashed(b.pid, b.folder);
    await reopen();
    const both = kept();
    expect(both.map((w) => [w.kind, w.projectId])).toEqual([
      ["rolled-back-incomplete-write", a.pid],
      ["rolled-back-incomplete-write", b.pid],
    ]);
    await repo.dismissRecoveryWarning(both[0]!.keptId!);
    await reopen();
    expect(kept()).toEqual([both[1]]);
  });

  it("the record holds no name, title or path; written whole, owner-only", async () => {
    const { pid, folder } = await project("Secret name", true);
    await crashed(pid, folder);
    await reopen();
    const text = (await fileText())!;
    expect(JSON.parse(text)).toEqual({ formatVersion: 1, warnings: [{ id: expect.any(String), kind: "rolled-back-incomplete-write", projectId: pid, at: NOW }] });
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("half");
    expect((await stat(fromRel(lib.root, FILE))).mode & 0o777).toBe(0o600);
    // Shown by its project's id, as every warning is (a locked project's name is shown as the library lists it).
    expect(kept().map((w) => w.projectId)).toEqual([pid]);
    expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("FR-729: a damaged record never stops the library from opening", () => {
  it("set aside under its own name, said once; the next opening starts a new record", async () => {
    const { pid, folder } = await project("P");
    await crashed(pid, folder);
    await writeFile(fromRel(lib.root, FILE), "{ torn");
    await reopen();
    expect(repo.integrityWarnings.filter((w) => w.kind === "recovery-warnings-set-aside")).toHaveLength(1);
    const aside = (await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("recovery-warnings.damaged-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(lib.root, ".tmp", aside[0]!), "utf8")).toBe("{ torn");
    // This opening's own warning is kept in the new record.
    expect(kept().map((w) => w.projectId)).toEqual([pid]);
    await reopen();
    expect(repo.integrityWarnings.filter((w) => w.kind === "recovery-warnings-set-aside")).toEqual([]);
    expect(kept().map((w) => w.projectId)).toEqual([pid]);
  });
});

describe("FR-729: a library open read-only", () => {
  it("shows the kept warnings, writes nothing, offers no dismissal; a damaged record is said and left as it is", async () => {
    const { pid, folder } = await project("P");
    await crashed(pid, folder);
    await reopen();
    const text = await fileText();
    const roLib = await openLibrary(lib.root, mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 99 }));
    try {
      const ro = await openTestRepo(roLib, ring, { clock: () => new Date(NOW), tz: "UTC" });
      const shown = ro.integrityWarnings.filter((w) => w.keptId !== undefined);
      expect(shown.map((w) => [w.kind, w.projectId])).toEqual([["rolled-back-incomplete-write", pid]]);
      await expect(ro.dismissRecoveryWarning(shown[0]!.keptId!)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
      expect(await fileText()).toBe(text);
      await writeFile(fromRel(lib.root, FILE), "{ torn");
      const ro2 = await openTestRepo(roLib, ring, { clock: () => new Date(NOW), tz: "UTC" });
      expect(ro2.integrityWarnings.filter((w) => w.kind === "recovery-warnings-set-aside")).toHaveLength(1);
      expect(await fileText()).toBe("{ torn");
      expect((await readdir(join(lib.root, ".tmp"))).filter((n) => n.startsWith("recovery-warnings.damaged-"))).toEqual([]);
    } finally {
      await roLib.close();
    }
  });
});

describe("FR-729: the integrity check", () => {
  it("is quiet about the record", async () => {
    const { pid, folder } = await project("P");
    await crashed(pid, folder);
    await reopen();
    expect(await fileText()).not.toBeNull();
    const report = await checkIntegrity(lib, "full");
    expect(JSON.stringify(report)).not.toContain("recovery-warnings");
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.errors).toEqual([]);
  });
});

describe("FR-729 with R509: a change closed as it was is said until dismissed", () => {
  it("kept across a reopen", async () => {
    const { pid, folder } = await project("P");
    const rel = `${folder}/kept.txt`;
    await writeFile(fromRel(lib.root, rel), "original\n");
    seams.crashAt = "before-audit";
    await expect(
      repo.mutate(pid, STORE, async (tx) => {
        await tx.trash(rel);
        await tx.writeFile(rel, "own\n");
      }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    seams.crashAt = undefined;
    const m = JSON.parse(await readFile(join(lib.root, ".tmp", (await readdir(join(lib.root, ".tmp"))).find((n) => /^txn-.*\.json$/u.test(n))!), "utf8")) as TxnMarker;
    await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
    await reopen();
    await repo.closePendingWrite(m.txn, pid);
    const closed = kept().filter((w) => w.kind === "interrupted-change-closed");
    expect(closed).toHaveLength(1);
    await reopen();
    expect(kept().filter((w) => w.kind === "interrupted-change-closed")).toEqual(closed);
  });
});
