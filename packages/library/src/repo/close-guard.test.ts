/**
 * R532 I1: the guard on closing an interrupted change (`keptCopiesLeft`) answers "kept" wherever anything of the
 * researcher's (bytes that were in the library before the change) is held ONLY in a copy the app keeps, and may answer
 * "not kept" only where nothing is. A rewrite's backup counts as kept only when it holds bytes that are not the change's
 * own: the backup of the FIRST rewrite of a path that no earlier line of the change created. Trashed copies count as
 * before.
 *
 * A table over every two- and three-step sequence of create, rewrite and trash at ONE path (as the transaction can take
 * them), with and without an original at that path, the change cut after each step, plus an original at ANOTHER path
 * trashed by the change whose kept copy is then deleted (so a close is what the list would offer). Each case is judged
 * twice: as the crash left it (the opening's undo cut off before its first step), and after the opening's undo. The
 * test works out from the bytes whether the researcher's original is held only in a kept copy; the guard must say so.
 * Then every case the guard lets through is closed for real, and every case it holds is refused with nothing changed.
 *
 * R533 (4): a create may also be made BY COPYING a file of the library (the researcher's q, which the change then trashes
 * after its steps, its kept copy deleted as before). A backup of a path the change created by copying holds the
 * researcher's bytes, and counts as kept; only a path the change wrote from bytes of its own making is "its own".
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import type { Tx } from "./mutate.js";
import { PendingWriteIncompleteError } from "./errors.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, keptCopiesLeft, type TxnMarker } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const ORIGINAL = "the researcher's original at p\n";
const OTHER = "the researcher's original at q\n";
const COPIES_LEFT_TEXT =
  "This change cannot be closed: the app still keeps a copy of a file it could not put back, and closing would let that copy go. Restoring the project from a backup made before the change is the way to undo it.";

type Step = "create" | "copy" | "rewrite" | "trash";
/** C create (bytes of the change's own), K create by copying q, R rewrite, T trash. */
const LETTER: Record<Step, string> = { create: "C", copy: "K", rewrite: "R", trash: "T" };

/** Every sequence of `n` steps at one path that the transaction can take: a create (of either kind) only where nothing is, a rewrite or a trash only where a file is. */
function sequences(n: number, original: boolean): Step[][] {
  const out: Step[][] = [];
  const grow = (seq: Step[], present: boolean) => {
    if (seq.length === n) return void out.push(seq);
    if (!present) {
      grow([...seq, "create"], true);
      grow([...seq, "copy"], true);
    } else {
      grow([...seq, "rewrite"], true);
      grow([...seq, "trash"], false);
    }
  };
  grow([], original);
  return out;
}

interface Case {
  name: string;
  original: boolean;
  steps: Step[];
}
/** Each sequence cut after each of its steps (the crash comes after that step). Named "orig"/"none" (an original at p or not), the steps (`LETTER`), and the cut. */
const CASES: Case[] = [];
for (const original of [true, false]) {
  for (const n of [2, 3]) {
    for (const seq of sequences(n, original)) {
      for (let cut = 1; cut <= n; cut++) {
        CASES.push({ name: `${original ? "orig" : "none"} ${seq.map((x) => LETTER[x]).join("")} cut ${cut}`, original, steps: seq.slice(0, cut) });
      }
    }
  }
}

interface World {
  tmp: string;
  lib: Library;
  ring: KeyRing;
  repo: Repo;
  pid: string;
  project: string;
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

let w: World | undefined;
afterEach(async () => {
  seams.crashAt = undefined;
  seams.stopUndoAfter = undefined;
  if (!w) return;
  await w.lib.close();
  w.ring.clear();
  await rm(w.tmp, { recursive: true, force: true });
  w = undefined;
});

async function makeWorld(): Promise<World> {
  const tmp = await mkdtemp(join(tmpdir(), "ao-r532-"));
  const ring = new KeyRing();
  const lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps(tmp));
  const repo = await repoFor({ lib, ring });
  const pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const [name] = (await readdir(join(lib.root, "Projects"))).filter((n) => !n.startsWith("."));
  return { tmp, lib, ring, repo, pid, project: `Projects/${name!}` };
}
const reopen = async (x: World, beforeOpen: () => void = () => {}): Promise<void> => {
  await x.lib.close();
  beforeOpen();
  x.lib = await openLibrary(x.lib.root, mkDeps(x.tmp));
  x.repo = await repoFor(x);
};
const tmpFiles = async (x: World): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const n of await readdir(join(x.lib.root, ".tmp")).catch(() => [] as string[])) {
    if (!/^txn-.*\.orig-\d+$|^trash-/u.test(n)) continue;
    out.set(n, await readFile(join(x.lib.root, ".tmp", n), "utf8").catch(() => "(not a file)"));
  }
  return out;
};
const markers = async (x: World) => (await readdir(join(x.lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
const text = (x: World, rel: string) => readFile(fromRel(x.lib.root, rel), "utf8").catch(() => null);
/** Every file of the library outside its work folder, its audit logs and the kept warnings' record, with its bytes. */
async function snapshot(x: World): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(x.lib.root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === ".tmp" || r === ".lock" || r.startsWith(".cache") || r.endsWith("/audit") || r === "recovery-warnings.json") continue;
      if (e.isDirectory()) await walk(r);
      else out.set(r, await readFile(join(x.lib.root, r), "utf8"));
    }
  };
  await walk("");
  return out;
}

/**
 * The case's change, crashed before its audit: the original at q trashed first, then the steps at p, each rewrite
 * and create writing bytes of its own; then the kept copy of q deleted (q is lost before any close). Where the steps
 * create p by copying q (R533 (4)), q is trashed after the steps instead (a copy is made of it first).
 */
async function crashedCase(x: World, c: Case): Promise<{ m: TxnMarker; p: string; q: string; before: Map<string, string> }> {
  const p = `${x.project}/p.txt`;
  const q = `${x.project}/q.txt`;
  await writeFile(fromRel(x.lib.root, q), OTHER);
  if (c.original) await writeFile(fromRel(x.lib.root, p), ORIGINAL);
  const before = await snapshot(x);
  seams.crashAt = "before-audit";
  await expect(
    x.repo.mutate(x.pid, STORE, async (tx: Tx) => {
      const copies = c.steps.includes("copy");
      if (!copies) await tx.trash(q);
      for (const [k, s] of c.steps.entries()) {
        if (s === "trash") await tx.trash(p);
        else if (s === "copy") await tx.copyFile(fromRel(x.lib.root, q), p);
        else await tx.writeFile(p, `the change's write ${k + 1}\n`);
      }
      if (copies) await tx.trash(q);
    }),
  ).rejects.toBeInstanceOf(SimulatedCrash);
  seams.crashAt = undefined;
  const [name] = await markers(x);
  const m = JSON.parse(await readFile(join(x.lib.root, ".tmp", name!), "utf8")) as TxnMarker;
  const qCopy = m.entries.find((e) => e.kind === "trashed" && e.from === q) as { to: string };
  await rm(fromRel(x.lib.root, qCopy.to), { recursive: true, force: true });
  return { m, p, q, before };
}

/**
 * Worked out from the bytes: something of the researcher's is held ONLY in a copy the app keeps — the original at p
 * (not at p), or q's bytes (lost from q; R533 (4): a copy the change made of q may hold them) in no file of the library.
 */
async function originalOnlyKept(x: World, c: Case, p: string): Promise<boolean> {
  const kept = [...(await tmpFiles(x)).values()];
  if (kept.includes(OTHER) && ![...(await snapshot(x)).values()].includes(OTHER)) return true;
  if (!c.original || (await text(x, p)) === ORIGINAL) return false;
  return kept.includes(ORIGINAL);
}
/** Trashed copies count as before: any of this change's trash copies still there. */
const trashLeft = async (x: World): Promise<boolean> => [...(await tmpFiles(x)).keys()].some((n) => n.startsWith("trash-"));

const counts = { undone: { kept: 0, notKept: 0 }, asCrashed: { kept: 0, notKept: 0 }, onlyKept: 0, closed: 0, refused: 0 };

describe("R532 I1: the close guard", () => {
  it("the table has its cases", () => {
    // With an original: RR, RT, TC, TK (2 steps), RRR, RRT, RTC, RTK, TCR, TCT, TKR, TKT (3 steps); without: CR, CT, KR,
    // KT, CRR, CRT, CTC, CTK, KRR, KRT, KTC, KTK.
    expect(CASES).toHaveLength(4 * 2 + 8 * 3 + 4 * 2 + 8 * 3);
  });

  for (const moment of ["undone", "asCrashed"] as const) {
    describe(moment === "undone" ? "undone" : "as crashed", () => {
      it.each(CASES)("$name", async (c) => {
        w = await makeWorld();
        const { m, p, q, before } = await crashedCase(w, c);
        const x = w;
        await reopen(x, () => void (moment === "asCrashed" ? (seams.stopUndoAfter = 0) : undefined));
        expect(seams.stopUndoAfter).toBeUndefined();
        expect(await markers(x)).toEqual([`txn-${m.txn}.json`]);
        expect(await text(x, q)).toBeNull();

        const onlyKept = await originalOnlyKept(x, c, p);
        const expected = onlyKept || (await trashLeft(x));
        const guard = await keptCopiesLeft(x.lib.root, m);
        // Never fewer: one miss is a researcher's file destroyed by a close.
        if (onlyKept) expect(guard).toBe(true);
        // And exactly the ruled rule: a backup of the change's own bytes is not "kept".
        expect(guard).toBe(expected);
        counts[moment][guard ? "kept" : "notKept"]++;
        if (onlyKept) counts.onlyKept++;

        const [listed] = await x.repo.pendingWrites();
        expect(listed).toMatchObject({ txn: m.txn, rollback: guard ? "lost-copy-stuck" : "lost", canClose: !guard });

        const markerBytes = await readFile(join(x.lib.root, ".tmp", `txn-${m.txn}.json`), "utf8");
        const keptBefore = await tmpFiles(x);
        const libBefore = await snapshot(x);
        const err = await x.repo.closePendingWrite(m.txn, x.pid).then(
          () => null,
          (e: unknown) => e,
        );
        if (guard) {
          // Held: refused, and nothing changed (the marker, every kept copy, every file of the library).
          counts.refused++;
          expect(err).toBeInstanceOf(PendingWriteIncompleteError);
          expect((err as Error).message).toBe(COPIES_LEFT_TEXT);
          expect(await readFile(join(x.lib.root, ".tmp", `txn-${m.txn}.json`), "utf8")).toBe(markerBytes);
          expect(await tmpFiles(x)).toEqual(keptBefore);
          expect(await snapshot(x)).toEqual(libBefore);
          return;
        }
        // Closed for real: everything of the researcher's that was there before the change is at its path, byte for
        // byte, but the one original already lost before the close (q); nothing of the change is left at p.
        counts.closed++;
        expect(err).toBeNull();
        expect(await markers(x)).toEqual([]);
        const expectedAfter = new Map(before);
        expectedAfter.delete(q);
        expect(await snapshot(x)).toEqual(expectedAfter);
        expect(await text(x, p)).toBe(c.original ? ORIGINAL : null);
        expect([...(await tmpFiles(x)).values()]).not.toContain(ORIGINAL);
      });
    });
  }

  it("the counts (for the report)", () => {
    // Printed for the report; the assertions above are what hold the rule.
    console.log(`R532 I1 table: ${JSON.stringify(counts)}`);
    expect(counts.undone.kept + counts.undone.notKept).toBe(CASES.length);
    expect(counts.asCrashed.kept + counts.asCrashed.notKept).toBe(CASES.length);
  });
});
