/**
 * R493: a step already undone is never undone again. A roll-back runs from the marker more than once when an earlier
 * run did not finish (a step failed in the running app, or a crash cut the reopen's own roll-back off); for a "trashed"
 * line whose trash copy is gone (it was put back), the later lines of that marker at the same path are skipped, so the
 * original put back is never removed or overwritten. Proven by the reviewer's probe Q1, the crash-in-reopen case, and
 * an enumeration of every two- and three-step sequence at one path, each first roll-back cut after each of its steps.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
      expect(await undoEntries(tmpdir(), [])).toBe(true);
      expect(seams.stopUndoAfter).toBe(0);
      process.env.NODE_ENV = "test";
      expect(await undoEntries(tmpdir(), [])).toBe(false);
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
            const ok = await undoEntries(root, entries);
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
      expect(mine, `${run} reopen`).not.toContain("changed-outside-before-rollback");
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
      expect((refused as Error).message).toBe("A change must not both append to a file and rewrite that same file (R503 a).");
      expect((await bytesAt(w, rel))?.toString()).toBe(ORIGINAL);
      expect(await markerNames(w)).toEqual([]);
    });
  }
});

// ---- the enumeration ---------------------------------------------------------------------------------------------

type Op = "trash" | "create" | "replace" | "append";
const OPS: Op[] = ["trash", "create", "replace", "append"];
const ORIGINAL = "the researcher's original\n";

/**
 * Whether the transaction API takes the sequence from this start: a trash or a replace needs the file there, a create
 * needs it absent (writeFile records "created" only for a missing file, "replaced" for one there); an append is
 * always taken (every content here ends a line).
 */
function takes(seq: Op[], startExists: boolean): boolean {
  let there = startExists;
  for (const op of seq) {
    if ((op === "trash" || op === "replace") && !there) return false;
    if (op === "create" && there) return false;
    there = op !== "trash";
  }
  return true;
}
/** R503 a: a change that both appends to the file and writes it whole (created or replaced) is refused by the transaction. */
const mixed = (seq: Op[]): boolean => seq.includes("append") && seq.some((op) => op === "create" || op === "replace");
const sequences = (n: number): Op[][] => (n === 0 ? [[]] : sequences(n - 1).flatMap((s) => OPS.map((op) => [...s, op])));

/**
 * One case: the change takes its steps at one path and fails; its in-process roll-back is cut after `cut` steps; a
 * second roll-back (a reopen) runs to the end, then a third. Returns the failures found, each naming the case.
 */
async function runCase(seq: Op[], startExists: boolean, cut: number): Promise<{ failures: string[]; lines: number }> {
  const v = await makeWorld();
  const failures: string[] = [];
  const name = `[${seq.join(", ")}] from ${startExists ? "a file with original bytes" : "no file"}, first roll-back cut after ${cut} step(s)`;
  try {
    const rel = `${v.folder}/rerun.txt`;
    if (startExists) await writeFile(fromRel(v.lib.root, rel), ORIGINAL);
    const before = await bytesAt(v, rel);
    seams.stopUndoAfter = cut;
    await expect(
      v.repo.mutate(v.pid, STORE, async (tx) => {
        for (const [i, op] of seq.entries()) {
          if (op === "trash") await tx.trash(rel);
          else if (op === "append") await tx.appendLine(rel, `step ${i} appended`);
          else await tx.writeFile(rel, `step ${i} wrote (${op})\n`);
        }
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");
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
    await reopen(v);
    await judge("second");
    await reopen(v);
    await judge("third");
    return { failures, lines: m.entries.length };
  } finally {
    await dropWorld(v);
  }
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
 * Cases per group: the sum, over the sequences the API takes, of the marker's lines + 1 (a cut after 0 … all its steps).
 * Every step records one line, except an append to a file already appended to since its last trash (covered by the
 * first). A sequence that both appends and writes the file whole is refused by the transaction (R503 a) and is checked
 * as refused instead. Two steps: 6 sequences (17 cases) from a file, 4 (11) from none, and 2 + 2 refused; three: 10 (36)
 * and 6 (21), and 12 + 10 refused. 26 sequences and 85 cases rolled back, 26 sequences refused.
 */
const EXPECTED_CASES: Record<string, number> = { "2-true": 17, "2-false": 11, "3-true": 36, "3-false": 21 };
const EXPECTED_REFUSED: Record<string, number> = { "2-true": 2, "2-false": 2, "3-true": 12, "3-false": 10 };

describe("R493: every two- and three-step sequence at one path, every cut of the first roll-back", () => {
  for (const length of [2, 3]) {
    for (const startExists of [true, false]) {
      it(`${length} steps, ${startExists ? "the file there with original bytes" : "no file"} at the start`, async () => {
        const failures: string[] = [];
        const taken = sequences(length).filter((s) => takes(s, startExists));
        let cases = 0;
        let refused = 0;
        for (const seq of taken.filter(mixed)) {
          failures.push(...(await refusedCase(seq, startExists)));
          refused++;
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
        expect(failures, `${failures.length} of ${cases} case(s) failed`).toEqual([]);
      }, 600_000);
    }
  }
});
