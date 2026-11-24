/**
 * R503 c 1, R519 (2) (FR-723): a file the change wrote by copying, and a file it wrote inside a folder it created, get a
 * completion line once their bytes are durable: a second `created` line for the same path with the hash of the bytes
 * AS STORED and `complete: true` (no new line kind, no format version: the reader of an older build refuses a marker
 * with a kind it does not know, and ignores fields it does not know). A `trashed` line records the original's identity
 * (R519 (3)). Marker lines are read from the marker a crash before the audit entry leaves.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import type { Tx } from "./mutate.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, markerProblem, type MarkerEntry, type TxnMarker } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const SRC = "the bytes of a file to copy\n";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

const mkDeps = (): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-r519-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
  await writeFile(join(tmp, "src.txt"), SRC);
});
afterEach(async () => {
  seams.crashAt = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

const project = async (encrypted: boolean) =>
  (await repo.createProject({ name: encrypted ? "Sealed" : "P", governanceYaml: OPEN_GOV, encryption: encrypted ? { enabled: true, passphrase: "pw-r519" } : { enabled: false } })).project;

/** Runs `fn` in a change that a crash cuts off before its audit entry; returns the marker it left. */
async function crashed(pid: string, fn: (tx: Tx) => Promise<void>): Promise<TxnMarker> {
  seams.crashAt = "before-audit";
  await expect(repo.mutate(pid, STORE, fn)).rejects.toBeInstanceOf(SimulatedCrash);
  const names = (await readdir(join(lib.root, ".tmp"))).filter((n) => /^txn-.*\.json$/u.test(n));
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(lib.root, ".tmp", names[0]!), "utf8")) as TxnMarker;
}

describe("R519 (2): the completion line of a copied file", () => {
  for (const encrypted of [false, true]) {
    it(`${encrypted ? "an encrypted project" : "a plain project"}: a created line, then a second created line with the hash of the bytes as stored and complete: true`, async () => {
      const p = await project(encrypted);
      const rel = `${p.folder}/copied.bin`;
      const m = await crashed(p.id, async (tx) => {
        await tx.copyFile(join(tmp, "src.txt"), rel, { encrypt: encrypted });
      });
      const stored = await readFile(fromRel(lib.root, rel));
      expect(m.entries).toEqual([
        { kind: "created", path: rel },
        { kind: "created", path: rel, sha256: sha(stored), complete: true },
      ]);
      // Encrypted: the stored bytes are not the source's, and the completion hash is of the stored ones.
      if (encrypted) expect(sha(stored)).not.toBe(sha(SRC));
      expect(markerProblem(m, m.txn)).toBeNull();
    });
  }

  it("a copy that fails leaves the created line and no completion line (the half-written file is the change's own)", async () => {
    const p = await project(false);
    const rel = `${p.folder}/never.bin`;
    seams.crashAt = undefined;
    const marker: { m?: TxnMarker } = {};
    await expect(
      repo.mutate(p.id, STORE, async (tx) => {
        await tx.copyFile(join(tmp, "missing.txt"), rel).catch(async () => {
          const names = (await readdir(join(lib.root, ".tmp"))).filter((n) => /^txn-.*\.json$/u.test(n));
          marker.m = JSON.parse(await readFile(join(lib.root, ".tmp", names[0]!), "utf8")) as TxnMarker;
        });
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    expect(marker.m!.entries).toEqual([{ kind: "created", path: rel }]);
  });
});

describe("R519 (2): files written inside a folder the change created", () => {
  it("a written file and a copied file each get only a completion line, after the folder's line", async () => {
    const p = await project(false);
    const dir = `${p.folder}/made`;
    const m = await crashed(p.id, async (tx) => {
      await tx.mkdir(dir);
      await tx.writeFile(`${dir}/written.txt`, "written inside\n");
      await tx.copyFile(join(tmp, "src.txt"), `${dir}/copied.txt`);
    });
    expect(m.entries).toEqual([
      { kind: "dir", path: dir },
      { kind: "created", path: `${dir}/written.txt`, sha256: sha("written inside\n"), complete: true },
      { kind: "created", path: `${dir}/copied.txt`, sha256: sha(SRC), complete: true },
    ]);
    expect(markerProblem(m, m.txn)).toBeNull();
  });

  it("a file written whole outside a created folder keeps its one line with the hash (atomic: no completion line)", async () => {
    const p = await project(false);
    const rel = `${p.folder}/whole.txt`;
    const m = await crashed(p.id, async (tx) => {
      await tx.writeFile(rel, "whole\n");
    });
    expect(m.entries).toEqual([{ kind: "created", path: rel, sha256: sha("whole\n") }]);
  });
});

describe("R519 (3): a trashed line records the original's identity as the file system gives it", () => {
  it("file number (bigint as a string), size, and time of last modification in nanoseconds (as a string)", async () => {
    const p = await project(false);
    const rel = `${p.folder}/kept.txt`;
    await writeFile(fromRel(lib.root, rel), "the original\n");
    const st = await stat(fromRel(lib.root, rel), { bigint: true });
    const m = await crashed(p.id, async (tx) => {
      await tx.trash(rel);
    });
    const t = m.entries[0] as Extract<MarkerEntry, { kind: "trashed" }>;
    expect(t).toMatchObject({ kind: "trashed", from: rel, ino: st.ino.toString(), size: Number(st.size), mtimeNs: st.mtimeNs.toString() });
    expect(markerProblem(m, m.txn)).toBeNull();
  });
});

describe("the reader checks the new fields (an older build ignores them)", () => {
  const head = { formatVersion: 1, txn: newId(), projectId: newId(), projectFolder: "Projects/P", auditEvents: 1, auditSeqBefore: 0 };
  const H = "a".repeat(64);
  const at = (entries: unknown[]) => markerProblem({ ...head, entries }, head.txn);
  it("accepts a completion line and a trashed line with an identity", () => {
    expect(at([{ kind: "created", path: "Projects/P/a", sha256: H, complete: true }])).toBeNull();
    expect(at([{ kind: "trashed", from: "Projects/P/a", to: `.tmp/trash-${head.txn}-00`, ino: "12345678901234567890", size: 3, mtimeNs: "1795511903096443559" }])).toBeNull();
  });
  it("a marker with only the known fields is accepted (the control for the refusals below)", () => {
    expect(at([{ kind: "created", path: "Projects/P/a", sha256: H }])).toBeNull();
  });
  it("refuses a completion line without a hash, or one whose flag is not true; an identity that is not whole numbers", () => {
    expect(at([{ kind: "created", path: "Projects/P/a", complete: true }])).not.toBeNull();
    expect(at([{ kind: "created", path: "Projects/P/a", sha256: H, complete: "yes" }])).not.toBeNull();
    expect(at([{ kind: "trashed", from: "Projects/P/a", to: `.tmp/trash-${head.txn}-00`, ino: 5, size: 3, mtimeNs: "1" }])).not.toBeNull();
    expect(at([{ kind: "trashed", from: "Projects/P/a", to: `.tmp/trash-${head.txn}-00`, ino: "5", size: -1, mtimeNs: "1" }])).not.toBeNull();
    expect(at([{ kind: "trashed", from: "Projects/P/a", to: `.tmp/trash-${head.txn}-00`, ino: "5", size: 3, mtimeNs: "1.5" }])).not.toBeNull();
  });
});
