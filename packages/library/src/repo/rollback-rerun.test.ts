/**
 * R493: a step already undone is never undone again. A roll-back runs from the marker more than once when an earlier
 * run did not finish (a step failed in the running app, or a crash cut the reopen's own roll-back off); for a "trashed"
 * line whose trash copy is gone (it was put back), the later lines of that marker at the same path are skipped, so the
 * original put back is never removed or overwritten. Proven by the reviewer's probe Q1, the crash-in-reopen case, and
 * an enumeration of every two- and three-step sequence at one path, each first roll-back cut after each of its steps.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import type { Tx } from "./mutate.js";
import { importChange } from "./repo.js";
import { AuditStore } from "./audit-store.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { MIXED_WRITE, fromRel, undoEntries, type MarkerEntry, type TxnMarker } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const PDF = "%PDF-1.7\nhello\n%%EOF\n";
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

/** One library with a project and a source holding two notes. */
interface World {
  tmp: string;
  lib: Library;
  ring: KeyRing;
  repo: Repo;
  pid: string;
  sid: string;
  folder: string;
}

const mkDeps = (tmp: string): Deps => ({
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
const repoFor = (w: Pick<World, "lib" | "ring">): Promise<Repo> => openTestRepo(w.lib, w.ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
const draft = (title: string): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: title }] },
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});
const provenance = (): Provenance => ({ captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "ao", version: "0" }, fileHashes: {}, legal: { status: "public" }, identifiable: false });
const note = (sourceId: string, body: string): Annotation => ({ id: newId(), sourceId, kind: "note", anchors: [], body, author: "tester", createdAt: NOW });
const withNotes = (sf: SourceFile, bodies: string[]): SourceFile => ({ ...sf, annotations: bodies.map((b) => note(sf.source.id, b)) });

async function makeWorld(): Promise<World> {
  const tmp = await mkdtemp(join(tmpdir(), "ao-r493-"));
  const ring = new KeyRing();
  const lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps(tmp));
  const pdf = join(tmp, "in.pdf");
  await writeFile(pdf, PDF);
  const repo = await repoFor({ lib, ring });
  const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const sf = await repo.createSource(pid, draft("Annotated"), [{ path: pdf, role: "original", handling: "copy" }], { provenance: provenance() });
  const w: World = { tmp, lib, ring, repo, pid, sid: sf.source.id, folder: sf.source.folder };
  await importChange(repo, pid, STORE, async (ops) => {
    const cur = await ops.readSource(w.sid);
    await ops.writeSource(cur, withNotes(cur, ["first", "second"]));
  }, { op: "test.annotations" });
  return w;
}
async function dropWorld(w: World): Promise<void> {
  await w.lib.close();
  w.ring.clear();
  await rm(w.tmp, { recursive: true, force: true });
}
const markerNames = async (w: World) => (await readdir(join(w.lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
const readMarker = async (w: World): Promise<TxnMarker> => {
  const [name] = await markerNames(w);
  return JSON.parse(await readFile(join(w.lib.root, ".tmp", name!), "utf8")) as TxnMarker;
};
const bytesAt = (w: World, rel: string) => readFile(fromRel(w.lib.root, rel)).catch(() => null);
/** Closes and opens the library again: the open rolls back what a marker left (recoverTransactions). */
const reopen = async (w: World, beforeOpen: () => void = () => {}): Promise<void> => {
  await w.lib.close();
  beforeOpen();
  w.lib = await openLibrary(w.lib.root, mkDeps(w.tmp));
  w.repo = await repoFor(w);
};

let w: World;
afterEach(() => {
  seams.failUndo = undefined;
  seams.crashAt = undefined;
  seams.stopUndoAfter = undefined;
});

describe("R493: the reviewer's probe Q1 and the crash during the reopen's own roll-back", () => {
  beforeEach(async () => {
    w = await makeWorld();
  });
  afterEach(async () => {
    await dropWorld(w);
  });

  /** One change empties the annotations (the file is trashed), writes them again (created), writes the source again. */
  const emptiedThenWrittenAgain = async (): Promise<void> => {
    await importChange(w.repo, w.pid, STORE, async (ops) => {
      const cur = await ops.readSource(w.sid);
      const empty = withNotes(cur, []);
      await ops.writeSource(cur, empty);
      await ops.writeSource(empty, withNotes(empty, ["written again"]));
      throw new Error("the change failed");
    }, { op: "test.q1" });
  };
  /** The annotations file is the researcher's original, byte for byte, and the source reads it. */
  const originalAnnotationsBack = async (ann: Buffer | null, sourceJson: Buffer | null): Promise<void> => {
    expect(ann).not.toBeNull();
    expect(await bytesAt(w, `${w.folder}/annotations.json`)).toEqual(ann);
    expect(await bytesAt(w, `${w.folder}/source.json`)).toEqual(sourceJson);
    expect((await w.repo.getSource(w.pid, w.sid)).annotations.map((a) => a.body)).toEqual(["first", "second"]);
    expect(await markerNames(w)).toEqual([]);
  };

  it("Q1: the in-process undo fails at a later step after putting the original back; the reopen keeps the original annotations", async () => {
    const ann = await bytesAt(w, `${w.folder}/annotations.json`);
    const src = await bytesAt(w, `${w.folder}/source.json`);
    seams.failUndo = "replaced";
    await expect(emptiedThenWrittenAgain()).rejects.toThrow("the change failed");
    seams.failUndo = undefined;
    // The in-process undo removed the change's new file and moved the original back; the marker is kept.
    expect(await bytesAt(w, `${w.folder}/annotations.json`)).toEqual(ann);
    expect(await markerNames(w)).toHaveLength(1);
    await reopen(w);
    await originalAnnotationsBack(ann, src);
    await reopen(w);
    await originalAnnotationsBack(ann, src);
  });

  it("a crash cuts the reopen's roll-back right after the trashed step was undone; the second reopen keeps the original annotations", async () => {
    const ann = await bytesAt(w, `${w.folder}/annotations.json`);
    const src = await bytesAt(w, `${w.folder}/source.json`);
    seams.crashAt = "before-audit";
    await expect(
      importChange(w.repo, w.pid, STORE, async (ops) => {
        const cur = await ops.readSource(w.sid);
        const empty = withNotes(cur, []);
        await ops.writeSource(cur, empty);
        await ops.writeSource(empty, withNotes(empty, ["written again"]));
      }, { op: "test.q1-crash" }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    const m = await readMarker(w);
    const trashedAt = m.entries.findIndex((e) => e.kind === "trashed" && e.from === `${w.folder}/annotations.json`);
    expect(trashedAt).toBeGreaterThanOrEqual(0);
    expect(m.entries.slice(trashedAt + 1).some((e) => e.kind === "created" && e.path === `${w.folder}/annotations.json`)).toBe(true);
    // The roll-back undoes in reverse: the trashed step is its (length - index)th.
    await reopen(w, () => void (seams.stopUndoAfter = m.entries.length - trashedAt));
    expect(seams.stopUndoAfter).toBeUndefined(); // the cut happened
    expect(await bytesAt(w, `${w.folder}/annotations.json`)).toEqual(ann);
    expect(await markerNames(w)).toHaveLength(1);
    await reopen(w);
    await originalAnnotationsBack(ann, src);
    await reopen(w);
    await originalAnnotationsBack(ann, src);
  });
});

describe("R493: the cut seam is inert outside NODE_ENV=test (R47)", () => {
  it("cuts an empty roll-back off under test, never under production", async () => {
    const env = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      seams.stopUndoAfter = 0;
      expect((await undoEntries(tmpdir(), [])).ok).toBe(true);
      expect(seams.stopUndoAfter).toBe(0);
      process.env.NODE_ENV = "test";
      expect((await undoEntries(tmpdir(), [])).ok).toBe(false);
      expect(seams.stopUndoAfter).toBeUndefined();
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

describe("R503 b 1 (FR-737): a step at or UNDER a trashed path that was put back is not undone again", () => {
  /**
   * A folder the change trashed and made again, with a file written inside (each step recorded, as the marker records
   * steps). The first roll-back is cut after each of its steps; a second runs to its end, then a third. The marker lines
   * are built by hand: no change the app makes today records a line under a folder it made again (R495).
   */
  const SHAPES: Array<{ name: string; inside: string[] }> = [
    { name: "a file created inside", inside: ["a.txt"] },
    { name: "a file created in a folder inside", inside: ["sub/b.txt"] },
    { name: "two files created inside", inside: ["a.txt", "sub/b.txt"] },
  ];
  for (const shape of SHAPES) {
    it(`a folder trashed, made again, ${shape.name}: the original folder and its files come back, byte for byte, at every cut`, async () => {
      const failures: string[] = [];
      const sha = (t: string) => createHash("sha256").update(t).digest("hex");
      for (let cut = 0; cut <= 2 + shape.inside.length; cut++) {
        const root = await mkdtemp(join(tmpdir(), "ao-r503b1-"));
        try {
          const F = "Projects/P/F";
          await mkdir(fromRel(root, `${F}/sub`), { recursive: true });
          for (const f of ["a.txt", "sub/b.txt"]) await writeFile(fromRel(root, `${F}/${f}`), `${ORIGINAL}(${f})`);
          await mkdir(fromRel(root, ".tmp"), { recursive: true });
          const to = ".tmp/trash-0-0";
          const entries: MarkerEntry[] = [{ kind: "trashed", from: F, to }, { kind: "dir", path: F }];
          await rename(fromRel(root, F), fromRel(root, to));
          await mkdir(fromRel(root, F));
          for (const f of shape.inside) {
            entries.push({ kind: "created", path: `${F}/${f}`, sha256: sha(`new ${f}`) });
            await mkdir(fromRel(root, `${F}/${f}`.slice(0, `${F}/${f}`.lastIndexOf("/"))), { recursive: true });
            await writeFile(fromRel(root, `${F}/${f}`), `new ${f}`);
          }
          seams.stopUndoAfter = cut;
          await undoEntries(root, entries);
          seams.stopUndoAfter = undefined;
          for (const run of ["second", "third"]) {
            const { ok } = await undoEntries(root, entries);
            const name = `${shape.name}, first roll-back cut after ${cut} step(s), the ${run} roll-back`;
            if (!ok) failures.push(`${name}: reported incomplete`);
            for (const f of ["a.txt", "sub/b.txt"]) {
              const now = await readFile(fromRel(root, `${F}/${f}`), "utf8").catch(() => null);
              if (now !== `${ORIGINAL}(${f})`) failures.push(`${name}: ${f} is ${now === null ? "gone" : JSON.stringify(now)}`);
            }
          }
        } finally {
          seams.stopUndoAfter = undefined;
          await rm(root, { recursive: true, force: true });
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("R503 b 2 (FR-737): the app's kept copy of a trashed original deleted by hand, the change's own file still at the path", () => {
  beforeEach(async () => {
    w = await makeWorld();
  });
  afterEach(async () => {
    await dropWorld(w);
  });

  it("the roll-back is NOT reported as done: incomplete, the marker kept, nothing deleted, the could-not-be-undone warning; so at every reopen", async () => {
    const rel = `${w.folder}/kept.txt`;
    await writeFile(fromRel(w.lib.root, rel), ORIGINAL);
    seams.crashAt = "before-audit";
    await expect(
      w.repo.mutate(w.pid, STORE, async (tx) => {
        await tx.trash(rel);
        await tx.writeFile(rel, "the change's own new file\n");
      }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    const m = await readMarker(w);
    const t = m.entries.find((e): e is Extract<MarkerEntry, { kind: "trashed" }> => e.kind === "trashed")!;
    await rm(fromRel(w.lib.root, t.to), { recursive: true, force: true }); // someone deleted the app's kept copy by hand
    for (const run of ["first", "second"]) {
      await reopen(w);
      expect((await bytesAt(w, rel))?.toString(), `${run} reopen`).toBe("the change's own new file\n");
      expect(await markerNames(w), `${run} reopen`).toEqual([`txn-${m.txn}.json`]);
      const mine = w.repo.integrityWarnings.filter((x) => x.projectId === w.pid).map((x) => x.kind);
      expect(mine, `${run} reopen`).toContain("rolled-back-incomplete-write");
      expect(w.repo.integrityWarnings.find((x) => x.kind === "rolled-back-incomplete-write")!.detail).toMatch(/could only be partly rolled back/u);
      expect((await w.repo.pendingWrites()).map((x) => x.txn)).toEqual([m.txn]);
    }
  });

  it("a copy put back by an earlier roll-back (the original at the path) is still done: the R493 case is unchanged", async () => {
    const rel = `${w.folder}/kept.txt`;
    await writeFile(fromRel(w.lib.root, rel), ORIGINAL);
    seams.crashAt = "before-audit";
    await expect(
      w.repo.mutate(w.pid, STORE, async (tx) => {
        await tx.trash(rel);
        await tx.writeFile(rel, "the change's own new file\n");
      }),
    ).rejects.toBeInstanceOf(SimulatedCrash);
    const m = await readMarker(w);
    // The first reopen's roll-back undoes both steps and is cut just before the marker goes.
    await reopen(w, () => void (seams.stopUndoAfter = m.entries.length));
    expect((await bytesAt(w, rel))?.toString()).toBe(ORIGINAL);
    await reopen(w);
    expect((await bytesAt(w, rel))?.toString()).toBe(ORIGINAL);
    expect(await markerNames(w)).toEqual([]);
  });
});

describe("R503 a: a change that would both append to a file and rewrite it is refused before that step writes anything", () => {
  beforeEach(async () => {
    w = await makeWorld();
  });
  afterEach(async () => {
    await dropWorld(w);
  });

  for (const order of [
    ["rewrite", "append"],
    ["append", "rewrite"],
  ] as const) {
    it(`${order.join(", then ")}: a programming error; the file, the marker and the kept copies are as the first step left them; the change is undone`, async () => {
      const rel = `${w.folder}/mixed.txt`;
      await writeFile(fromRel(w.lib.root, rel), ORIGINAL);
      const step = (tx: Tx, kind: "rewrite" | "append") =>
        kind === "rewrite" ? tx.writeFile(rel, "rewritten whole\n") : tx.appendLine(rel, "added at the end");
      let refused: unknown = null;
      const failed = await w.repo
        .mutate(w.pid, STORE, async (tx) => {
          await step(tx, order[0]);
          const bytes = await bytesAt(w, rel);
          const marker = await readMarker(w);
          const tmp = (await readdir(join(w.lib.root, ".tmp"))).sort();
          refused = await step(tx, order[1]).then(
            () => null,
            (err: unknown) => err,
          );
          expect(await bytesAt(w, rel)).toEqual(bytes);
          expect(await readMarker(w)).toEqual(marker);
          expect((await readdir(join(w.lib.root, ".tmp"))).sort()).toEqual(tmp);
          throw refused ?? new Error("not refused");
        })
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(failed).toBe(refused);
      expect(refused).toBeInstanceOf(Error);
      // A developer's error in plain words: what is wrong and why, naming no ruling (R509 M4).
      expect((refused as Error).message).toBe(
        "A change must not both append to a file and rewrite that same file: if it were interrupted, it could not always be undone. Cut a torn last line in a change of its own, then append in the next.",
      );
      expect((refused as Error).message).not.toMatch(/\bR\d+/u);
      expect((await bytesAt(w, rel))?.toString()).toBe(ORIGINAL);
      expect(await markerNames(w)).toEqual([]);
    });
  }
});

// ---- the enumeration ---------------------------------------------------------------------------------------------

/** `copy` (R526 M6): the file copied into place (`tx.copyFile`), with its completion line; not in OPS (the R493 enumeration). */
type Op = "trash" | "create" | "replace" | "append" | "copy";
const OPS: Op[] = ["trash", "create", "replace", "append"];
const ORIGINAL = "the researcher's original\n";

/**
 * Whether the transaction API takes the sequence from this start: a trash or a replace needs the file there, a create
 * or a copy needs it absent (writeFile records "created" only for a missing file, "replaced" for one there); an append is
 * always taken (every content here ends a line).
 */
function takes(seq: Op[], startExists: boolean): boolean {
  let there = startExists;
  for (const op of seq) {
    if ((op === "trash" || op === "replace") && !there) return false;
    if ((op === "create" || op === "copy") && there) return false;
    there = op !== "trash";
  }
  return true;
}
/** R503 a: a change that both appends to the file and writes it whole (created or replaced) is refused by the transaction. */
const mixed = (seq: Op[]): boolean => seq.includes("append") && seq.some((op) => op === "create" || op === "replace" || op === "copy");
const sequences = (n: number, ops: Op[] = OPS): Op[][] => (n === 0 ? [[]] : sequences(n - 1, ops).flatMap((s) => ops.map((op) => [...s, op])));

/** Step `i` of a sequence at `rel` in the change (a copy copies a file of its own bytes from outside the library). */
async function step(tx: Tx, v: World, rel: string, op: Op, i: number): Promise<void> {
  if (op === "trash") await tx.trash(rel);
  else if (op === "append") await tx.appendLine(rel, `step ${i} appended`);
  else if (op === "copy") {
    const src = join(v.tmp, `copy-src-${i}.txt`);
    await writeFile(src, `step ${i} copied\n`);
    await tx.copyFile(src, rel);
  } else await tx.writeFile(rel, `step ${i} wrote (${op})\n`);
}

/**
 * One case: the change takes its steps at one path and fails; its in-process roll-back is cut after `cut` steps; a
 * second roll-back (a reopen) runs to the end, then a third. Returns the failures found, each naming the case.
 */
async function runCase(seq: Op[], startExists: boolean, cut: number, legacy = false, strict = false): Promise<{ failures: string[]; lines: number }> {
  const v = await makeWorld();
  const failures: string[] = [];
  const name = `${legacy ? "an older build's marker " : ""}[${seq.join(", ")}] from ${startExists ? "a file with original bytes" : "no file"}, first roll-back cut after ${cut} step(s)`;
  try {
    const rel = `${v.folder}/rerun.txt`;
    if (startExists) await writeFile(fromRel(v.lib.root, rel), ORIGINAL);
    const before = await bytesAt(v, rel);
    seams.stopUndoAfter = cut;
    if (legacy) {
      // The steps and the marker as an older build left them (it took the shape the transaction now refuses), then
      // its in-process roll-back, cut as by a crash.
      const entries = await legacySteps(v, rel, seq);
      if ((await undoEntries(v.lib.root, entries)).ok) failures.push(`${name}: the cut roll-back reported complete`);
    } else {
      await expect(
        v.repo.mutate(v.pid, STORE, async (tx) => {
          for (const [i, op] of seq.entries()) await step(tx, v, rel, op, i);
          throw new Error("the change failed");
        }),
      ).rejects.toThrow("the change failed");
    }
    if (seams.stopUndoAfter !== undefined) failures.push(`${name}: the cut did not happen`);
    seams.stopUndoAfter = undefined;
    if ((await markerNames(v)).length !== 1) return { failures: [...failures, `${name}: no marker after the cut roll-back`], lines: 0 };
    const m = await readMarker(v);
    if (m.entries.some((e) => (e.kind === "trashed" ? e.from : e.path) !== rel)) failures.push(`${name}: a marker line at another path`);
    const judge = async (run: string): Promise<void> => {
      if ((await markerNames(v)).length === 0) {
        // Reported complete: the path must be as it was before the change.
        const now = await bytesAt(v, rel);
        if (!(now === null ? before === null : before !== null && now.equals(before))) {
          failures.push(`${name}: after the ${run} roll-back, reported complete with the path ${now === null ? "gone" : `holding ${JSON.stringify(now.toString())}`}`);
        }
        return;
      }
      // R526 M6: an ordinary crash (no hand anywhere) is undone completely.
      if (strict) failures.push(`${name}: after the ${run} roll-back, an ordinary crash left incomplete`);
      // Reported incomplete: the marker and every copy it names are kept; a trash copy only as put back at its path by
      // the first roll-back (an incomplete re-run is refused as a whole when the R131 b append offsets no longer hold).
      const kept = await readMarker(v);
      for (const e of kept.entries) {
        const copy = e.kind === "replaced" ? e.backup : e.kind === "trashed" ? e.to : null;
        if (copy === null || (await bytesAt(v, copy)) !== null) continue;
        if (e.kind === "trashed" && (await bytesAt(v, e.from)) !== null) continue;
        failures.push(`${name}: after the ${run} roll-back, incomplete with ${e.kind} copy ${copy} gone${e.kind === "trashed" ? " and nothing at its path" : ""}`);
      }
    };
    const invalid = () => {
      if (v.repo.integrityWarnings.some((x) => x.kind === "invalid-txn-marker")) failures.push(`${name}: the marker was found invalid`);
    };
    await reopen(v);
    invalid();
    await judge("second");
    await reopen(v);
    invalid();
    await judge("third");
    return { failures, lines: m.entries.length };
  } finally {
    await dropWorld(v);
  }
}

/** The marker's head, as the transaction writes it for one `store` request at the project's audit head now. */
async function markerHead(v: World): Promise<Omit<TxnMarker, "entries">> {
  const projectFolder = v.repo.getProject(v.pid).folder;
  const auditSeqBefore = (await AuditStore.read(fromRel(v.lib.root, `${projectFolder}/audit`))).length;
  return { formatVersion: 1, txn: newId(), projectId: v.pid, projectFolder, auditEvents: 1, auditSeqBefore };
}

/**
 * R509 (M3): what an older build (before R503 a) did for a change that both appends to a file and rewrites it, written
 * directly to disk: each step recorded in the marker as its transaction recorded it, then taken; the marker as it left
 * it. A trash moves the file into `.tmp/trash-<txn>-<hex>`; a write records "replaced" (the file copied aside to
 * `.tmp/txn-<txn>.orig-<n>`, with its mode) or "created", each with the hash of what it wrote; an append records the
 * size before it, once per file until a trash of that file.
 */
async function legacySteps(v: World, rel: string, seq: Op[]): Promise<MarkerEntry[]> {
  const root = v.lib.root;
  const head = await markerHead(v);
  const entries: MarkerEntry[] = [];
  const abs = fromRel(root, rel);
  const tmp = join(root, ".tmp");
  await mkdir(tmp, { recursive: true });
  let backups = 0;
  let appended = false;
  for (const [i, op] of seq.entries()) {
    const there = (await bytesAt(v, rel)) !== null;
    if (op === "trash") {
      const to = `.tmp/trash-${head.txn}-${randomBytes(8).toString("hex")}`;
      entries.push({ kind: "trashed", from: rel, to });
      await rename(abs, fromRel(root, to));
      appended = false;
    } else if (op === "append") {
      const prevSize = there ? (await stat(abs)).size : 0;
      if (!appended) entries.push({ kind: "append", path: rel, prevSize, created: !there });
      appended = true;
      await appendFile(abs, `step ${i} appended\n`);
    } else {
      const bytes = `step ${i} wrote (${op})\n`;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (there) {
        const backup = `.tmp/txn-${head.txn}.orig-${backups++}`;
        const mode = (await stat(abs)).mode & 0o777;
        await copyFile(abs, fromRel(root, backup));
        entries.push({ kind: "replaced", path: rel, backup, mode, sha256 });
      } else entries.push({ kind: "created", path: rel, sha256 });
      await writeFile(abs, bytes);
    }
  }
  await writeFile(join(tmp, `txn-${head.txn}.json`), JSON.stringify({ ...head, entries } satisfies TxnMarker));
  return entries;
}

/** A sequence the transaction refuses (R503 a): refused at its first step that mixes, nothing of it is left, no marker. */
async function refusedCase(seq: Op[], startExists: boolean): Promise<string[]> {
  const v = await makeWorld();
  const name = `[${seq.join(", ")}] from ${startExists ? "a file with original bytes" : "no file"}`;
  try {
    const rel = `${v.folder}/rerun.txt`;
    if (startExists) await writeFile(fromRel(v.lib.root, rel), ORIGINAL);
    const before = await bytesAt(v, rel);
    const failed = await v.repo
      .mutate(v.pid, STORE, async (tx) => {
        for (const [i, op] of seq.entries()) {
          if (op === "trash") await tx.trash(rel);
          else if (op === "append") await tx.appendLine(rel, `step ${i} appended`);
          else await tx.writeFile(rel, `step ${i} wrote (${op})\n`);
        }
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    const out: string[] = [];
    if (!(failed instanceof Error) || failed.message !== MIXED_WRITE) out.push(`${name}: not refused (${failed === null ? "it was written" : String(failed)})`);
    const now = await bytesAt(v, rel);
    if (!(now === null ? before === null : before !== null && now.equals(before))) out.push(`${name}: the path is not as before the change`);
    if ((await markerNames(v)).length) out.push(`${name}: a marker is left`);
    return out;
  } finally {
    await dropWorld(v);
  }
}

/**
 * The enumeration: every two- and three-step sequence at one path that the transaction API took before R503 a, 52
 * sequences, in three groups.
 * - Taken now (26 sequences, 85 cases): the change runs through the transaction and fails; its roll-back is cut after
 *   each of its steps (a case per cut: the marker's lines + 1), then undone at a reopen, and again at a second.
 * - Refused now (the 26 that both append to the file and write it whole, R503 a): the transaction refuses each at its
 *   first step that mixes, writing nothing, and no marker is left (26 checks).
 * - Left by an older build (the same 26, 94 cases; R509 M3): a library may still hold such a marker. It is written
 *   directly to disk as that build left it, its roll-back cut after each of its steps, then undone at a reopen, and
 *   again at a second, with the assertions these sequences had when the API still took them.
 * Every step records one line, except an append to a file already appended to since its last trash (covered by the
 * first). Taken now: two steps, 6 sequences (17 cases) from a file, 4 (11) from none; three, 10 (36) and 6 (21).
 * Refused now and left by an older build: two steps, 2 sequences (6 cases) from a file, 2 (6) from none; three, 12 (45)
 * and 10 (37). In all 179 roll-back cases (85 + 94), as before R503 a, and 26 refusals.
 */
const EXPECTED_CASES: Record<string, number> = { "2-true": 17, "2-false": 11, "3-true": 36, "3-false": 21 };
const EXPECTED_REFUSED: Record<string, number> = { "2-true": 2, "2-false": 2, "3-true": 12, "3-false": 10 };
const EXPECTED_LEGACY: Record<string, number> = { "2-true": 6, "2-false": 6, "3-true": 45, "3-false": 37 };

describe("R509 (M3): the head of a marker written by hand is the transaction's own", () => {
  it("formatVersion, project, its folder, the audit events of one store request, and the audit head at its start", async () => {
    const v = await makeWorld();
    try {
      const rel = `${v.folder}/rerun.txt`;
      const head = await markerHead(v);
      seams.stopUndoAfter = 0;
      await expect(
        v.repo.mutate(v.pid, STORE, async (tx) => {
          await tx.writeFile(rel, "x\n");
          throw new Error("the change failed");
        }),
      ).rejects.toThrow("the change failed");
      seams.stopUndoAfter = undefined;
      const { entries: _e, txn: _t, ...real } = await readMarker(v);
      const { txn: _h, ...mine } = head;
      expect(mine).toEqual(real);
    } finally {
      await dropWorld(v);
    }
  });
});

describe("R493: every two- and three-step sequence at one path, every cut of the first roll-back", () => {
  for (const length of [2, 3]) {
    for (const startExists of [true, false]) {
      it(`${length} steps, ${startExists ? "the file there with original bytes" : "no file"} at the start`, async () => {
        const failures: string[] = [];
        const taken = sequences(length).filter((s) => takes(s, startExists));
        let cases = 0;
        let refused = 0;
        let legacy = 0;
        for (const seq of taken.filter(mixed)) {
          failures.push(...(await refusedCase(seq, startExists)));
          refused++;
          // The same shape, as a marker an older build left: every cut of its roll-back, then undone and undone again.
          const first = await runCase(seq, startExists, 0, true);
          failures.push(...first.failures);
          legacy++;
          for (let cut = 1; cut <= first.lines; cut++) {
            failures.push(...(await runCase(seq, startExists, cut, true)).failures);
            legacy++;
          }
        }
        for (const seq of taken.filter((s) => !mixed(s))) {
          // The first case (no step undone) shows how many lines the marker holds: then one cut after each step, the last
          // included (every step undone, the marker not yet removed: a crash just before it is).
          const first = await runCase(seq, startExists, 0);
          failures.push(...first.failures);
          cases++;
          for (let cut = 1; cut <= first.lines; cut++) {
            failures.push(...(await runCase(seq, startExists, cut)).failures);
            cases++;
          }
        }
        expect(cases).toBe(EXPECTED_CASES[`${length}-${startExists}`]);
        expect(refused).toBe(EXPECTED_REFUSED[`${length}-${startExists}`]);
        expect(legacy).toBe(EXPECTED_LEGACY[`${length}-${startExists}`]);
        expect(failures, `${failures.length} of ${cases + legacy} case(s) failed`).toEqual([]);
      }, 600_000);
    }
  }
});

// ---- R519: the same enumeration with a file put there by hand ------------------------------------------------------

const HAND = "a file a person put here by hand\n";
type HandPut = "a new file put in its place" | "written over in place";
/**
 * When the person acts (R526 M6): between the first roll-back (in the running app, cut after `cut` steps) and the
 * reopen's; or before the first roll-back (the change cut off by a crash, no undo yet), whose reopen is then cut.
 */
type Moment = "between two undos" | "before the first undo";

/**
 * What is at `abs`, byte for byte: null for nothing, a file's bytes (base64), or a folder's every entry with the bytes
 * of each file, in order (R526 M6: a trashed folder's kept copy, a person's folder).
 */
async function treeOf(abs: string): Promise<string | null> {
  const st = await stat(abs).catch(() => null);
  if (st === null) return null;
  if (!st.isDirectory()) return (await readFile(abs)).toString("base64");
  const out: string[] = [];
  const walk = async (dir: string, pre: string): Promise<void> => {
    for (const n of (await readdir(dir)).sort()) {
      const q = join(dir, n);
      if ((await stat(q)).isDirectory()) {
        out.push(`${pre}${n}/`);
        await walk(q, `${pre}${n}/`);
      } else out.push(`${pre}${n}:${(await readFile(q)).toString("base64")}`);
    }
  };
  await walk(abs, "");
  return `folder[${out.join(",")}]`;
}

/** The copies a marker names that exist now (a replaced line's backup, a trashed line's copy), with their bytes. */
async function keptCopies(v: World, m: TxnMarker): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of m.entries) {
    const copy = e.kind === "replaced" ? e.backup : e.kind === "trashed" ? e.to : null;
    if (copy === null) continue;
    const b = await treeOf(fromRel(v.lib.root, copy));
    if (b !== null) out.set(copy, b);
  }
  return out;
}

/**
 * One case: the change takes its steps at one path and fails; its in-process roll-back is cut after `cut` steps (0:
 * before its first undo); a person then puts a file at the path; the library is reopened (a second roll-back) and
 * reopened again (a third). R519: the hand-put bytes are at the path, unchanged, after each; the roll-back is incomplete
 * (the bytes are not the earlier state) with causes at that path, every copy the app kept before the second roll-back
 * still there, unchanged; the third changes nothing the second left.
 */
async function handPutCase(seq: Op[], startExists: boolean, cut: number, how: HandPut, moment: Moment = "between two undos"): Promise<{ failures: string[]; lines: number }> {
  const v = await makeWorld();
  const failures: string[] = [];
  const name =
    moment === "between two undos"
      ? `[${seq.join(", ")}] from ${startExists ? "a file with original bytes" : "no file"}, first roll-back cut after ${cut} step(s), then ${how}`
      : `[${seq.join(", ")}] from ${startExists ? "a file with original bytes" : "no file"}, cut off by a crash, then ${how}, then the first roll-back cut after ${cut} step(s)`;
  try {
    const rel = `${v.folder}/rerun.txt`;
    if (startExists) await writeFile(fromRel(v.lib.root, rel), ORIGINAL);
    if (moment === "between two undos") {
      seams.stopUndoAfter = cut;
      await expect(
        v.repo.mutate(v.pid, STORE, async (tx) => {
          for (const [i, op] of seq.entries()) await step(tx, v, rel, op, i);
          throw new Error("the change failed");
        }),
      ).rejects.toThrow("the change failed");
      if (seams.stopUndoAfter !== undefined) failures.push(`${name}: the cut did not happen`);
      seams.stopUndoAfter = undefined;
    } else {
      seams.crashAt = "before-audit";
      await expect(
        v.repo.mutate(v.pid, STORE, async (tx) => {
          for (const [i, op] of seq.entries()) await step(tx, v, rel, op, i);
        }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
    }
    if ((await markerNames(v)).length !== 1) return { failures: [...failures, `${name}: no marker after the cut roll-back`], lines: 0 };
    const m = await readMarker(v);
    // The person's act: a new file renamed into place (a new file number), or the file there written over in place.
    const abs = fromRel(v.lib.root, rel);
    if (how === "written over in place") await writeFile(abs, HAND);
    else {
      await writeFile(join(v.tmp, "hand.txt"), HAND);
      await rename(join(v.tmp, "hand.txt"), abs);
    }
    const copies = await keptCopies(v, m);
    if (moment === "before the first undo") {
      // The first roll-back, at a reopen, cut after `cut` steps: the hand-put file is untouched by it too.
      await reopen(v, () => void (seams.stopUndoAfter = cut));
      if (seams.stopUndoAfter !== undefined) failures.push(`${name}: the cut did not happen`);
      seams.stopUndoAfter = undefined;
      if ((await bytesAt(v, rel))?.toString() !== HAND) failures.push(`${name}: after the cut roll-back, the hand-put file is not at the path`);
      const left = await keptCopies(v, m);
      for (const [copy, b] of copies) if (left.get(copy) !== b) failures.push(`${name}: after the cut roll-back, the kept copy ${copy} is ${left.has(copy) ? "changed" : "gone"}`);
    }
    // R526: the first roll-back put the researcher's original back (only a first line trashing the original, undone
    // last, does), and the person wrote over it in place: it is still the original (same file number and time of
    // birth), edited. The roll-back is then complete, with the edit at the path.
    const editedOriginal = moment === "between two undos" && how === "written over in place" && startExists && seq[0] === "trash" && cut === m.entries.length;
    let second: { copies: Map<string, string>; causes: string } | undefined;
    for (const run of ["second", "third"]) {
      await reopen(v);
      const where = `${name}: after the ${run} roll-back`;
      const now = await bytesAt(v, rel);
      if (now?.toString() !== HAND) failures.push(`${where}, the hand-put file is ${now === null ? "gone" : `now ${JSON.stringify(now.toString())}`}`);
      if (v.repo.integrityWarnings.some((x) => x.kind === "invalid-txn-marker")) failures.push(`${where}, the marker was found invalid`);
      if (editedOriginal) {
        if ((await markerNames(v)).length !== 0) failures.push(`${where}, the original edited in place is not taken for the original (incomplete)`);
        continue;
      }
      if ((await markerNames(v)).length !== 1) {
        failures.push(`${where}, reported complete with the hand-put file at the path`);
        continue;
      }
      const left = await keptCopies(v, m);
      for (const [copy, b] of copies) if (left.get(copy) !== b) failures.push(`${where}, the kept copy ${copy} is ${left.has(copy) ? "changed" : "gone"}`);
      const why = v.repo.integrityWarnings.filter((x) => x.kind === "rolled-back-incomplete-write").flatMap((x) => x.causes ?? []);
      const known = why.length > 0 && why.every((c) => c.path === rel && ["hand-changed-file", "path-occupied", "kept-copy-gone"].includes(c.kind));
      // An incomplete re-run is refused as a whole when the R131 b append offsets no longer hold (nothing touched).
      const refused = v.repo.integrityWarnings.some((x) => x.kind === "txn-recovery-skipped-audit-unverifiable");
      if (!known && !refused) failures.push(`${where}, incomplete without its cause at the path (${JSON.stringify(why)})`);
      const state = { copies: left, causes: JSON.stringify(why) };
      if (second && (second.causes !== state.causes || [...second.copies].join() !== [...state.copies].join())) failures.push(`${where}, it changed what the second left`);
      second = state;
    }
    return { failures, lines: m.entries.length };
  } finally {
    await dropWorld(v);
  }
}

/**
 * R509 M1, by enumeration: every write of the change puts the original's very bytes back. The first roll-back is cut
 * after each of its steps; the second must complete (never "incomplete for ever" because the bytes are equal), the path
 * as it was before the change, and a third finds nothing left to do.
 */
async function equalBytesCase(seq: Op[], startExists: boolean, cut: number): Promise<{ failures: string[]; lines: number }> {
  const v = await makeWorld();
  const failures: string[] = [];
  const name = `[${seq.join(", ")}] writing the original's bytes, from ${startExists ? "the original" : "no file"}, first roll-back cut after ${cut} step(s)`;
  try {
    const rel = `${v.folder}/rerun.txt`;
    if (startExists) await writeFile(fromRel(v.lib.root, rel), ORIGINAL);
    const before = await bytesAt(v, rel);
    seams.stopUndoAfter = cut;
    await expect(
      v.repo.mutate(v.pid, STORE, async (tx) => {
        for (const op of seq) {
          if (op === "trash") await tx.trash(rel);
          else await tx.writeFile(rel, ORIGINAL);
        }
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
    seams.stopUndoAfter = undefined;
    const lines = (await markerNames(v)).length ? (await readMarker(v)).entries.length : 0;
    for (const run of ["second", "third"]) {
      await reopen(v);
      const now = await bytesAt(v, rel);
      if ((await markerNames(v)).length) failures.push(`${name}: after the ${run} roll-back, still incomplete`);
      if (!(now === null ? before === null : before !== null && now.equals(before))) failures.push(`${name}: after the ${run} roll-back, the path is not as before`);
    }
    return { failures, lines };
  } finally {
    await dropWorld(v);
  }
}

/**
 * The hand-put enumeration covers every sequence of trash, create and replace that the transaction takes (two steps:
 * 3 from a file, 2 from none; three steps: 5 and 3). Sequences with an append are left out: an "append" line records
 * only the size before it, so a file put by hand at a path the change only appended to cannot be told from the
 * change's own (R519 rules the files the undo can tell). Cases: each sequence, each cut of its first roll-back (0 to
 * its lines: 0 is before its first undo), each of the two ways of putting the file there: 94 in all. Beside each
 * sequence, R509 M1's equal bytes at every cut.
 */
const EXPECTED_HAND: Record<string, number> = { "2-true": 18, "2-false": 12, "3-true": 40, "3-false": 24 };
const WRITES: Op[] = ["trash", "create", "replace"];

describe("R519: with a file put there by hand at every point, every sequence of trash, create and replace at one path", () => {
  for (const length of [2, 3]) {
    for (const startExists of [true, false]) {
      it(`${length} steps, ${startExists ? "the file there with original bytes" : "no file"} at the start`, async () => {
        const failures: string[] = [];
        let cases = 0;
        const taken = sequences(length).filter((s) => s.every((op) => WRITES.includes(op)) && takes(s, startExists));
        for (const seq of taken) {
          for (const how of ["a new file put in its place", "written over in place"] as const) {
            const first = await handPutCase(seq, startExists, 0, how);
            failures.push(...first.failures);
            cases++;
            for (let cut = 1; cut <= first.lines; cut++) {
              failures.push(...(await handPutCase(seq, startExists, cut, how)).failures);
              cases++;
            }
          }
          // R509 M1: the same sequence writing the original's own bytes.
          const first = await equalBytesCase(seq, startExists, 0);
          failures.push(...first.failures);
          for (let cut = 1; cut <= first.lines; cut++) failures.push(...(await equalBytesCase(seq, startExists, cut)).failures);
        }
        expect(failures, `${failures.length} failure(s) in ${cases} case(s)`).toEqual([]);
        expect(cases).toBe(EXPECTED_HAND[`${length}-${startExists}`]);
      }, 600_000);
    }
  }
});

// ---- R526 M6: what the enumeration lacked ------------------------------------------------------------------------

/** Every sequence of `length` steps of trash, copy, create and replace at one path that the transaction takes. */
const writeSequences = (length: number, startExists: boolean): Op[][] => sequences(length, ["trash", "copy", "create", "replace"]).filter((s) => takes(s, startExists));

/**
 * Copies with their completion lines (the reviewer's probe H): every two- and three-step sequence of trash, copy, create
 * and replace at one path that contains a copy, every cut of the first roll-back (in the running app), once as an
 * ordinary crash (undone completely at the next reopen and the one after, the path as before) and once with a new file
 * put at the path by hand between the two roll-backs (kept, byte for byte; incomplete with its cause; every kept copy
 * there; the third roll-back changes nothing). Sequences: two steps, 1 from a file and 2 from none; three, 3 and 5. A
 * copy records two lines (its line and its completion line), the others one: cuts 4, 8, 15 and 26; 106 cases.
 */
const EXPECTED_COPY: Record<string, number> = { "2-true": 8, "2-false": 16, "3-true": 30, "3-false": 52 };

describe("R526 M6: copies with their completion lines, every sequence and cut, ordinary and with a file put there by hand", () => {
  for (const length of [2, 3]) {
    for (const startExists of [true, false]) {
      it(`${length} steps, ${startExists ? "the file there with original bytes" : "no file"} at the start`, async () => {
        const failures: string[] = [];
        let cases = 0;
        for (const seq of writeSequences(length, startExists).filter((s) => s.includes("copy"))) {
          const first = await runCase(seq, startExists, 0, false, true);
          failures.push(...first.failures, ...(await handPutCase(seq, startExists, 0, "a new file put in its place")).failures);
          cases += 2;
          for (let cut = 1; cut <= first.lines; cut++) {
            failures.push(...(await runCase(seq, startExists, cut, false, true)).failures);
            failures.push(...(await handPutCase(seq, startExists, cut, "a new file put in its place")).failures);
            cases += 2;
          }
        }
        expect(failures, `${failures.length} failure(s) in ${cases} case(s)`).toEqual([]);
        expect(cases).toBe(EXPECTED_COPY[`${length}-${startExists}`]);
      }, 600_000);
    }
  }
});

/**
 * A file put there by hand BEFORE the first roll-back: the change is cut off by a crash (no undo yet), a person puts a
 * new file at the path, the reopen's roll-back is cut after each of its steps, then the library is reopened twice more.
 * Every sequence of two and three steps of trash, copy, create and replace the transaction takes; cuts per group: two
 * steps 9 + 4 (without, with a copy) from a file and 6 + 8 from none; three, 20 + 15 and 12 + 26: 100 cases.
 */
const EXPECTED_BEFORE: Record<string, number> = { "2-true": 13, "2-false": 14, "3-true": 35, "3-false": 38 };

describe("R526 M6: a file put there by hand before the first roll-back, every sequence of trash, copy, create and replace, every cut", () => {
  for (const length of [2, 3]) {
    for (const startExists of [true, false]) {
      it(`${length} steps, ${startExists ? "the file there with original bytes" : "no file"} at the start`, async () => {
        const failures: string[] = [];
        let cases = 0;
        for (const seq of writeSequences(length, startExists)) {
          const first = await handPutCase(seq, startExists, 0, "a new file put in its place", "before the first undo");
          failures.push(...first.failures);
          cases++;
          for (let cut = 1; cut <= first.lines; cut++) {
            failures.push(...(await handPutCase(seq, startExists, cut, "a new file put in its place", "before the first undo")).failures);
            cases++;
          }
        }
        expect(failures, `${failures.length} failure(s) in ${cases} case(s)`).toEqual([]);
        expect(cases).toBe(EXPECTED_BEFORE[`${length}-${startExists}`]);
      }, 600_000);
    }
  }
});

/** A step at a folder's path: trash the folder, or make it (`tx.mkdir`) and write a file in it. */
type FOp = "trash" | "make";
type FolderHand = "none" | Moment;
const MINE = { name: "mine.txt", bytes: "a person's own file in their own folder\n" };

/**
 * One case at a folder's path D: a trashed FOLDER (the original, holding a.txt, at the start) and a folder the change
 * made (with a file in it). The change takes its steps and fails; its first roll-back is cut after `cut` steps (in the
 * running app; or, `before the first undo`, after a crash, at the reopen); a second and a third run at reopens.
 * - `none`, the ordinary crash: complete after the second and the third, D as before (byte for byte, or nothing).
 * - A person's hand: where D is empty at their moment, they move a folder of their own there (made before the change,
 *   so that it never shares a file number and time of birth with one the change made); where D holds the researcher's
 *   original, put back, they add a file inside it (as the Finder does). Where D holds the change's own folder, the case
 *   does not apply (a file a person adds inside it is R525 (3) b, listed on FR-746) and is counted apart. Afterwards:
 *   what the person made is at D byte for byte; the original with a file added is the original (complete); from an
 *   original, a person's own folder at D leaves the roll-back incomplete with its cause, every kept copy there; with no
 *   original, the roll-back may complete (the change's own folder was removed: R526 M2) or stay incomplete with its
 *   cause and every kept copy there; the third changes nothing.
 */
async function folderCase(seq: FOp[], startExists: boolean, cut: number, hand: FolderHand): Promise<{ failures: string[]; lines: number; applies: boolean }> {
  const v = await makeWorld();
  const failures: string[] = [];
  const name = `folder [${seq.join(", ")}] from ${startExists ? "the original folder" : "no folder"}, first roll-back cut after ${cut} step(s)${hand === "none" ? "" : `, a person's hand ${hand}`}`;
  try {
    const D = `${v.folder}/made`;
    const absD = fromRel(v.lib.root, D);
    if (startExists) {
      await mkdir(absD);
      await writeFile(join(absD, "a.txt"), ORIGINAL);
    }
    const before = await treeOf(absD);
    const theirs = join(v.tmp, "theirs");
    await mkdir(theirs);
    await writeFile(join(theirs, MINE.name), MINE.bytes);
    const steps = async (tx: Tx) => {
      for (const [i, op] of seq.entries()) {
        if (op === "trash") await tx.trash(D);
        else {
          await tx.mkdir(D);
          await tx.writeFile(`${D}/f.txt`, `step ${i} made\n`);
        }
      }
    };
    if (hand === "before the first undo") {
      seams.crashAt = "before-audit";
      await expect(v.repo.mutate(v.pid, STORE, steps)).rejects.toBeInstanceOf(SimulatedCrash);
    } else {
      seams.stopUndoAfter = cut;
      await expect(
        v.repo.mutate(v.pid, STORE, async (tx) => {
          await steps(tx);
          throw new Error("the change failed");
        }),
      ).rejects.toThrow("the change failed");
      if (seams.stopUndoAfter !== undefined) failures.push(`${name}: the cut did not happen`);
      seams.stopUndoAfter = undefined;
    }
    if ((await markerNames(v)).length !== 1) return { failures: [...failures, `${name}: no marker after the first roll-back`], lines: 0, applies: true };
    const m = await readMarker(v);
    const lines = m.entries.length;
    let expected: string | null = before;
    let added = false;
    let copies = new Map<string, string>();
    if (hand !== "none") {
      // What is at D at the person's moment: by construction, the original only once the first line (its trash, undone
      // last) is undone in the running app; else nothing, or the change's own folder.
      const original = hand === "between two undos" && startExists && seq[0] === "trash" && cut === lines;
      const there = await treeOf(absD);
      if (there !== null && !original) return { failures, lines, applies: false };
      if (original) {
        if (there !== before) failures.push(`${name}: the original is not at D after the first roll-back`);
        await writeFile(join(absD, MINE.name), MINE.bytes);
        added = true;
      } else await rename(theirs, absD);
      expected = await treeOf(absD);
      copies = await keptCopies(v, m);
      if (hand === "before the first undo") {
        await reopen(v, () => void (seams.stopUndoAfter = cut));
        if (seams.stopUndoAfter !== undefined) failures.push(`${name}: the cut did not happen`);
        seams.stopUndoAfter = undefined;
        if ((await treeOf(absD)) !== expected) failures.push(`${name}: after the cut roll-back, what the person made is not at D as they made it`);
      }
    }
    let second: string | undefined;
    for (const run of ["second", "third"]) {
      await reopen(v);
      const where = `${name}: after the ${run} roll-back`;
      if (v.repo.integrityWarnings.some((x) => x.kind === "invalid-txn-marker")) failures.push(`${where}, the marker was found invalid`);
      const now = await treeOf(absD);
      if (now !== expected) failures.push(`${where}, D is ${now} where ${expected} was expected`);
      const complete = (await markerNames(v)).length === 0;
      if (hand === "none" || added) {
        if (!complete) failures.push(`${where}, incomplete (${JSON.stringify(v.repo.integrityWarnings.flatMap((x) => x.causes ?? []))})`);
        continue;
      }
      if (complete) {
        if (startExists) failures.push(`${where}, reported complete with the researcher's original folder not at D`);
        continue;
      }
      const left = await keptCopies(v, m);
      for (const [copy, b] of copies) if (left.get(copy) !== b) failures.push(`${where}, the kept copy ${copy} is ${left.has(copy) ? "changed" : "gone"}`);
      const why = v.repo.integrityWarnings.filter((x) => x.kind === "rolled-back-incomplete-write").flatMap((x) => x.causes ?? []);
      const known = why.length > 0 && why.every((c) => (c.path === D || c.path.startsWith(`${D}/`)) && ["hand-changed-file", "path-occupied", "kept-copy-gone"].includes(c.kind));
      if (!known) failures.push(`${where}, incomplete without its cause at D (${JSON.stringify(why)})`);
      const state = JSON.stringify([why, [...left]]);
      if (second !== undefined && second !== state) failures.push(`${where}, it changed what the second left`);
      second = state;
    }
    return { failures, lines, applies: true };
  } finally {
    await dropWorld(v);
  }
}

/**
 * The folder sequences: from the original folder, [trash], [trash, make], [trash, make, trash]; from none, [make],
 * [make, trash], [make, trash, make]. A trash records one line, a make three (the folder's line, its completion line
 * with its identity, the file's completion line): cuts 2, 5, 6 and 4, 5, 8, 30 in all. Each cut is an ordinary crash
 * (30 cases), and a person's hand between the two roll-backs (12 apply: 3 adding a file inside the original put back,
 * 9 a person's folder where D is empty; 18 find the change's own folder at D) and before the first (13 apply, 17 not).
 */
const FOLDER_SEQS: Array<{ seq: FOp[]; startExists: boolean }> = [
  { seq: ["trash"], startExists: true },
  { seq: ["trash", "make"], startExists: true },
  { seq: ["trash", "make", "trash"], startExists: true },
  { seq: ["make"], startExists: false },
  { seq: ["make", "trash"], startExists: false },
  { seq: ["make", "trash", "make"], startExists: false },
];
const EXPECTED_FOLDER: Record<FolderHand, { applies: number; not: number }> = {
  none: { applies: 30, not: 0 },
  "between two undos": { applies: 12, not: 18 },
  "before the first undo": { applies: 13, not: 17 },
};

describe("R526 M6: a trashed folder and a folder the change made (with a file in it), every cut, ordinary and with a person's hand at two moments", () => {
  for (const hand of ["none", "between two undos", "before the first undo"] as const) {
    it(hand === "none" ? "the ordinary crash" : `a person's hand ${hand}`, async () => {
      const failures: string[] = [];
      let applies = 0;
      let not = 0;
      for (const { seq, startExists } of FOLDER_SEQS) {
        const lines = seq.reduce((n, op) => n + (op === "trash" ? 1 : 3), 0);
        for (let cut = 0; cut <= lines; cut++) {
          const r = await folderCase(seq, startExists, cut, hand);
          failures.push(...r.failures);
          if (r.lines !== lines) failures.push(`folder [${seq.join(", ")}]: ${r.lines} marker lines where ${lines} were counted`);
          if (r.applies) applies++;
          else not++;
        }
      }
      expect(failures, `${failures.length} failure(s)`).toEqual([]);
      expect({ applies, not }).toEqual(EXPECTED_FOLDER[hand]);
    }, 600_000);
  }
});
