/**
 * R493: a step already undone is never undone again. A roll-back runs from the marker more than once when an earlier
 * run did not finish (a step failed in the running app, or a crash cut the reopen's own roll-back off); for a "trashed"
 * line whose trash copy is gone (it was put back), the later lines of that marker at the same path are skipped, so the
 * original put back is never removed or overwritten. Proven by the reviewer's probe Q1, the crash-in-reopen case, and
 * an enumeration of every two- and three-step sequence at one path, each first roll-back cut after each of its steps.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import { importChange } from "./repo.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, undoEntries, type TxnMarker } from "./txn.js";

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

/**
 * Cases per group: the sum, over the sequences the API takes, of the marker's lines + 1 (a cut after 0 … all its steps).
 * Every step records one line, except an append to a file already appended to since its last trash (covered by the
 * first). Two steps: 8 sequences (23 cases) from a file, 6 (17) from none; three: 22 (81) and 16 (58). 52 sequences, 179 cases.
 */
const EXPECTED_CASES: Record<string, number> = { "2-true": 23, "2-false": 17, "3-true": 81, "3-false": 58 };

describe("R493: every two- and three-step sequence at one path, every cut of the first roll-back", () => {
  for (const length of [2, 3]) {
    for (const startExists of [true, false]) {
      it(`${length} steps, ${startExists ? "the file there with original bytes" : "no file"} at the start`, async () => {
        const failures: string[] = [];
        const taken = sequences(length).filter((s) => takes(s, startExists));
        let cases = 0;
        for (const seq of taken) {
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
        expect(failures, `${failures.length} of ${cases} case(s) failed`).toEqual([]);
      }, 600_000);
    }
  }
});
