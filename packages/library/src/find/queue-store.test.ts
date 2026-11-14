import { appendFile, mkdir as mkdirp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type AuditEvent, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { InvalidInputError, ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { openLine, sealLine } from "../repo/io.js";
import type { Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { SimulatedCrash, openTestRepo, seams, type CrashPoint } from "../repo/testing.js";
import type { WorkCandidate } from "./candidates.js";
import {
  FindEntryTooLargeError,
  FindQueueFullError,
  FindQueueUnreadableError,
  appendFindEntries,
  compactFindQueue,
  compactionSeams,
  readFindQueue,
  readFindQueueDetailed,
} from "./queue-store.js";
import { FIND_LINE_MAX_BYTES, FIND_QUEUE_MAX, FIND_QUEUE_OPS, type FindEntry } from "./types.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;

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
const coreOf = (r: Repo = repo) => (r as unknown as { core: RepoCore }).core;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-queue-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await repoFor();
});
afterEach(async () => {
  seams.crashAt = undefined;
  seams.failAuditAppendFor = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

const project = async (encrypted = false): Promise<Project> =>
  (
    await repo.createProject({
      name: `P${Math.random().toString(36).slice(2, 7)}`,
      governanceYaml: GOV,
      encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
    })
  ).project;

const MB4 = 4 * 1024 * 1024;
const hist = (e: FindEntry, n: number, from = 0): FindEntry[] => Array.from({ length: n }, (_, i) => ({ ...e, attempts: from + i }));
const NOW = "2026-11-13T10:00:00.000Z";
const candidate = (extra: Partial<WorkCandidate> = {}): WorkCandidate => ({
  id: "cand-1",
  title: "Zorblatt Grammar of Habitus",
  creators: [{ role: "author", family: "Quillfeather", given: "Mirabel" } as WorkCandidate["creators"][number]],
  type: "book",
  identifiers: { doi: "10.9999/zorblatt" },
  providers: ["crossref"],
  ...extra,
});
const entry = (p: Project, extra: Partial<FindEntry> = {}): FindEntry => ({
  id: newId(),
  projectId: p.id,
  typed: "Quillfeather, Zorblatt Grammar",
  state: "looking-up",
  createdAt: NOW,
  updatedAt: NOW,
  attempts: 0,
  ...extra,
});

const queueFile = (p: Project) => join(lib.root, p.folder, "find", "queue.jsonl");
const rawLines = async (p: Project) =>
  (await readFile(queueFile(p), "utf8"))
    .split("\n")
    .filter((l) => l.trim());
async function auditText(p: Project): Promise<string> {
  const dir = join(lib.root, p.folder, "audit");
  let out = "";
  for (const f of (await readdir(dir)).sort()) out += await readFile(join(dir, f), "utf8");
  return out;
}
const auditEvents = async (p: Project) =>
  (await auditText(p))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEvent);
const findEvents = async (p: Project, op?: string) =>
  (await auditEvents(p)).filter((e) => typeof e.details?.op === "string" && (e.details.op as string).startsWith("project.find.") && (op === undefined || e.details.op === op));
const txnMarkers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));

async function everythingUnder(dir: string): Promise<string> {
  let out = "";
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    out += d.name + "\n";
    if (d.isDirectory()) out += await everythingUnder(full);
    else out += (await readFile(full)).toString("latin1") + "\n";
  }
  return out;
}

const read = (p: Project, r: Repo = repo) => readFindQueue(coreOf(r), p.id);
const append = (p: Project, es: FindEntry[], op: "add" | "update" | "remove" = "add", r: Repo = repo) => appendFindEntries(coreOf(r), p.id, es, op);
/** Lines written behind the store's back, sealed as the store seals them (to put a file in a state a long history would). */
async function rawAppend(p: Project, es: FindEntry[]): Promise<void> {
  const core = coreOf();
  const st = core.state(p.id);
  const sealed = core.encrypted(st);
  const k = sealed ? core.key(st) : undefined;
  const text = es.map((e) => (k ? sealLine(k.key, k.keyId, p.id, JSON.stringify(e), "ao-find-queue") : JSON.stringify(e)) + "\n").join("");
  await appendFile(queueFile(p), text);
}

describe("the queue in the project (Task F3)", () => {
  it("the later line for an id wins; the file is append-only, plain and owner-only in a project that is not encrypted", async () => {
    const p = await project();
    const a = entry(p);
    const b = entry(p, { typed: "Another typed line" });
    await append(p, [a, b], "add");
    await append(p, [{ ...a, state: "record-complete", sourceId: newId(), updatedAt: "2026-11-13T10:05:00.000Z", attempts: 1 }], "update");
    const q = await read(p);
    expect([...q.keys()]).toEqual([b.id, a.id]); // the order of the latest lines
    expect(q.get(a.id)).toMatchObject({ state: "record-complete", attempts: 1 });
    expect(q.get(b.id)).toEqual(b);
    const lines = await rawLines(p);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: a.id, typed: a.typed });
    if (process.platform !== "win32") expect((await stat(queueFile(p))).mode & 0o777).toBe(0o600);
    expect((await findEvents(p)).map((e) => e.details!.op)).toEqual([FIND_QUEUE_OPS.add, FIND_QUEUE_OPS.update]);
  });

  it("an entry that does not hold what the type says, or belongs to another project, is refused before anything is written", async () => {
    const p = await project();
    const other = await project();
    const bad: Array<[string, FindEntry]> = [
      ["state", { ...entry(p), state: "dancing" as never }],
      ["id", { ...entry(p), id: "../../etc" }],
      ["typed", { ...entry(p), typed: "x".repeat(501) }],
      ["attempts", { ...entry(p), attempts: -1 }],
      ["another project", entry(other)],
      ["candidates", { ...entry(p), candidates: "yes" as never }],
      ["reason", { ...entry(p), reason: { code: 7 } as never }],
    ];
    for (const [, e] of bad) await expect(append(p, [e])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(append(p, [entry(p), entry(p)].map((e, i, a) => ({ ...e, id: a[0]!.id })))).rejects.toBeInstanceOf(InvalidInputError); // twice in one add
    await expect(append(p, [entry(p)], "burn" as never)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(stat(join(lib.root, p.folder, "find"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await findEvents(p)).toEqual([]);
    // Fields the type does not know are not written.
    const e = { ...entry(p), secretNote: "Quillfeather's diary" } as FindEntry;
    await append(p, [e]);
    expect(await readFile(queueFile(p), "utf8")).not.toContain("diary");
  });

  it("no entries write nothing", async () => {
    const p = await project();
    await append(p, [], "add");
    expect(await findEvents(p)).toEqual([]);
  });

  it("an add of an id already in the queue is refused; an update or a remove of one that is not there, or is removed, writes nothing and brings nothing back", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    await expect(append(p, [{ ...a, typed: "again" }], "add")).rejects.toBeInstanceOf(InvalidInputError);
    await append(p, [a], "remove");
    expect((await read(p)).size).toBe(0);
    const before = await readFile(queueFile(p));
    // The runner finishing work on an entry the researcher has removed meanwhile: not resurrected.
    await append(p, [{ ...a, state: "record-complete" }], "update");
    await append(p, [entry(p)], "update"); // never added
    await append(p, [a], "remove"); // already removed
    expect(await readFile(queueFile(p))).toEqual(before);
    expect((await read(p)).size).toBe(0);
    expect(await findEvents(p, FIND_QUEUE_OPS.update)).toEqual([]);
    // An update cannot remove, and an add or an update cannot carry `removed`.
    const b = entry(p);
    await append(p, [{ ...b, removed: true }], "add");
    expect((await read(p)).has(b.id)).toBe(true);
    await append(p, [{ ...b, removed: true, state: "failed" }], "update");
    expect((await read(p)).get(b.id)?.state).toBe("failed");
  });

  it("in an encrypted project every line is sealed, and no typed word, title or name is in any file in the clear (raw bytes)", async () => {
    const p = await project(true);
    const a = entry(p, { candidates: [candidate()], offers: [{ label: "Publisher's page", url: "https://doi.org/10.9999/zorblatt", host: "doi.org" }] });
    const b = entry(p, { typed: "Mirabel Quillfeather", people: [{ id: "A123", name: "Mirabel Quillfeather", affiliation: "Zorblatt University", worksCount: 3, subjects: ["Zorblatt Grammar"] }] });
    await append(p, [a, b], "add"); // add
    await append(p, [{ ...a, state: "choose", updatedAt: "2026-11-13T10:01:00.000Z" }], "update"); // update
    await append(p, [b], "remove"); // remove
    // Lines of a compaction: a history of 70 superseded lines, then the compaction.
    await rawAppend(p, hist(a, 70, 1));
    await compactFindQueue(coreOf(), p.id);
    expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
    const lines = await rawLines(p);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const o = JSON.parse(l) as Record<string, unknown>;
      expect(Object.keys(o).sort()).toEqual(["alg", "ct", "keyId", "nonce", "v"]);
    }
    const everything = await everythingUnder(lib.root);
    for (const w of ["Quillfeather", "Zorblatt", "Mirabel", "Grammar", "doi.org", "habitus", "Habitus", a.id, b.id]) {
      // (ids are not secret, but the audit may hold them; only the file itself must hold no typed word)
      if (w === a.id || w === b.id) continue;
      expect(everything).not.toContain(w);
    }
    expect((await readFile(queueFile(p), "utf8")).includes(a.id)).toBe(false);
    const q = await read(p);
    expect(q.get(a.id)).toMatchObject({ typed: a.typed, attempts: 70, candidates: [candidate()] });
    expect(q.has(b.id)).toBe(false);
  });

  it("the audit entry holds ids, counts and states only, never the typed text, a title, a name or a host", async () => {
    const p = await project();
    const a = entry(p, { candidates: [candidate()], offers: [{ label: "Publisher's page", url: "https://doi.org/10.9999/zorblatt", host: "doi.org" }], reason: { code: "unreachable" } });
    const b = entry(p, { state: "choose" });
    await append(p, [a, b], "add");
    await append(p, [{ ...a, state: "not-found" }], "update");
    await append(p, [b], "remove");
    const evs = (await findEvents(p)).filter((e) => e.details!.op !== FIND_QUEUE_OPS.compact);
    expect(evs).toHaveLength(3);
    expect(evs[0]!.details).toMatchObject({ op: "project.find.add", entries: [a.id, b.id], count: 2, txn: expect.any(String) });
    expect((evs[0]!.details as { states: Record<string, number> }).states).toMatchObject({ "looking-up": 1, choose: 1, "not-found": 0 });
    expect(Object.keys((evs[0]!.details as { states: object }).states).length).toBe(15);
    expect(Object.keys(evs[0]!.details!).sort()).toEqual(["changes", "count", "entries", "op", "states", "txn"]);
    expect((evs[1]!.details as { states: Record<string, number> }).states["not-found"]).toBe(1);
    expect(evs[2]!.details).toMatchObject({ op: "project.find.remove", entries: [b.id], count: 1 });
    const whole = JSON.stringify(evs);
    for (const w of ["Quillfeather", "Zorblatt", "Mirabel", "Grammar", "doi.org", "unreachable", "10.9999"]) expect(whole).not.toContain(w);
    // The whole audit file too.
    const audit = await auditText(p);
    for (const w of ["Quillfeather", "Zorblatt", "Mirabel", "Grammar", "doi.org"]) expect(audit).not.toContain(w);
    // The policy request is a store with nothing identifying in it: allowed with no condition.
    expect(evs.every((e) => e.decision?.result === "allow")).toBe(true);
  });

  it("the 501st entry is refused, in one add or over several; entries that are removed are not counted", async () => {
    const p = await project();
    const batch = (n: number) => Array.from({ length: n }, () => entry(p));
    const first = batch(FIND_QUEUE_MAX - 1);
    for (let i = 0; i < first.length; i += 50) await append(p, first.slice(i, i + 50));
    expect((await read(p)).size).toBe(FIND_QUEUE_MAX - 1);
    // Two more would make 501: the whole batch is refused and nothing of it is written.
    const before = await readFile(queueFile(p));
    const auditBefore = (await findEvents(p)).length;
    await expect(append(p, batch(2))).rejects.toBeInstanceOf(FindQueueFullError);
    expect(await readFile(queueFile(p))).toEqual(before);
    expect((await findEvents(p)).length).toBe(auditBefore);
    expect(await txnMarkers()).toEqual([]);
    await append(p, batch(1)); // the 500th
    await expect(append(p, batch(1))).rejects.toBeInstanceOf(FindQueueFullError);
    expect((await read(p)).size).toBe(FIND_QUEUE_MAX);
    // An update does not grow the queue, so it is allowed when full.
    await append(p, [{ ...first[0]!, state: "failed" }], "update");
    // A removed entry is not counted.
    await append(p, [first[1]!, first[2]!], "remove");
    await append(p, batch(2));
    expect((await read(p)).size).toBe(FIND_QUEUE_MAX);
    await expect(append(p, batch(1))).rejects.toBeInstanceOf(FindQueueFullError);
    expect(new FindQueueFullError().message).toMatch(/500 entries/u);
  }, 60_000);

  it("two appends at once cannot both pass the 500", async () => {
    const p = await project();
    const first = Array.from({ length: FIND_QUEUE_MAX - 1 }, () => entry(p));
    for (let i = 0; i < first.length; i += 50) await append(p, first.slice(i, i + 50));
    const results = await Promise.allSettled([append(p, [entry(p)]), append(p, [entry(p)]), append(p, [entry(p)])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(FindQueueFullError);
    expect((await read(p)).size).toBe(FIND_QUEUE_MAX);
  }, 60_000);

  it("a line over 64 KiB is refused before anything is written, in words that say what to do; one just under is kept", async () => {
    for (const encrypted of [false, true]) {
      const p = await project(encrypted);
      const big = (n: number) => entry(p, { state: "choose-works", works: Array.from({ length: n }, (_, i) => candidate({ id: `w${i}`, title: "t".repeat(1000) })) });
      let over: Error | undefined;
      try {
        await append(p, [big(60)]);
      } catch (e) {
        over = e as Error;
      }
      expect(over).toBeInstanceOf(FindEntryTooLargeError);
      expect(over!.message).toMatch(/too large/iu);
      expect(over!.message).not.toContain("ttttt");
      expect(JSON.stringify(big(60)).length).toBeGreaterThan(FIND_LINE_MAX_BYTES);
      expect(JSON.stringify(big(50)).length).toBeLessThan(FIND_LINE_MAX_BYTES);
      await expect(stat(join(lib.root, p.folder, "find"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await findEvents(p)).toEqual([]);
      const ok = big(50);
      await append(p, [ok]);
      expect((await read(p)).get(ok.id)).toEqual(ok);
    }
  });

  it("a torn last line is read past, and removed by the next governed write (plain and sealed), and a last line without its newline is cut as well", async () => {
    for (const encrypted of [false, true]) {
      const p = await project(encrypted);
      const a = entry(p);
      await append(p, [a]);
      await appendFile(queueFile(p), '{"id":"half'); // an unclean stop by something else (no newline)
      expect([...(await read(p)).keys()]).toEqual([a.id]);
      const b = entry(p);
      await append(p, [b]);
      const raw = await readFile(queueFile(p), "utf8");
      expect(raw).not.toContain("half");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.trim().split("\n")).toHaveLength(2);
      expect([...(await read(p)).keys()]).toEqual([a.id, b.id]);
      // A whole line but for its newline is not a committed line either.
      if (!encrypted) {
        await appendFile(queueFile(p), JSON.stringify(entry(p)));
        expect([...(await read(p)).keys()]).toEqual([a.id, b.id]);
        await append(p, [{ ...a, state: "failed" }], "update");
        expect((await rawLines(p)).length).toBe(3);
      }
    }
  });

  it("a line that does not parse, has an unknown state, is of another project or is too long is skipped and counted; nothing is deleted by reading, or by a write", async () => {
    for (const encrypted of [false, true]) {
      const p = await project(encrypted);
      const a = entry(p);
      await append(p, [a]);
      const other = await project(encrypted);
      const st = coreOf().state(p.id);
      const k = encrypted ? coreOf().key(st) : undefined;
      const sealed = (obj: unknown, purpose = "ao-find-queue", pid = p.id) => (k ? sealLine(k.key, k.keyId, pid, JSON.stringify(obj), purpose) : JSON.stringify(obj));
      const junk = [
        "this is not json",
        sealed({ ...entry(p), state: "dancing" }),
        sealed({ ...entry(p), projectId: other.id }),
        ...(encrypted ? [sealed({ ...entry(p) }, "ao-watch-register")] : []), // sealed for another file
        sealed({ id: "x" }),
        "x".repeat(FIND_LINE_MAX_BYTES * 3), // far too long
      ];
      const b = entry(p);
      await appendFile(queueFile(p), junk.map((j) => `${j}\n`).join(""));
      await append(p, [b]);
      const before = await readFile(queueFile(p));
      const detail = await readFindQueueDetailed(coreOf(), p.id);
      expect([...detail.entries.keys()]).toEqual([a.id, b.id]);
      expect(detail.unreadableLines).toBe(junk.length);
      expect(await readFile(queueFile(p))).toEqual(before); // reading deletes nothing
      expect([...(await read(p)).keys()]).toEqual([a.id, b.id]);
      await append(p, [{ ...b, state: "failed" }], "update");
      const lines = await rawLines(p);
      for (const j of junk) expect(lines).toContain(j); // nor does a write
    }
  });

  it("a locked project's queue is not read, not written and not compacted; unlocked it is as it was", async () => {
    const p = await project(true);
    const a = entry(p);
    await append(p, [a]);
    repo.lockProject(p.id);
    await expect(read(p)).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(readFindQueueDetailed(coreOf(), p.id)).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(append(p, [entry(p)])).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(compactFindQueue(coreOf(), p.id)).rejects.toBeInstanceOf(ProjectLockedError);
    await repo.unlockProject(p.id, "pw");
    expect([...(await read(p)).keys()]).toEqual([a.id]);
    expect(await rawLines(p)).toHaveLength(1);
  });

  it("a read-only library writes nothing, and the queue can still be read", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    const before = await readFile(queueFile(p));
    const ro = await repoFor({ ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    await expect(append(p, [entry(p)], "add", ro)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await expect(append(p, [{ ...a, state: "failed" }], "update", ro)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await expect(append(p, [a], "remove", ro)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await expect(compactFindQueue(coreOf(ro), p.id)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(await readFile(queueFile(p))).toEqual(before);
    expect([...(await read(p, ro)).keys()]).toEqual([a.id]);
    expect(await txnMarkers()).toEqual([]);
  });

  describe("compaction", () => {
    it("keeps exactly the live entries, in their order, and is one governed change whose audit holds counts only", async () => {
      for (const encrypted of [false, true]) {
        const p = await project(encrypted);
        const live = [entry(p), entry(p, { typed: "second Quillfeather" })];
        const gone = entry(p, { typed: "removed Zorblatt" });
        await append(p, [...live, gone]);
        await append(p, [gone], "remove");
        await rawAppend(p, hist(live[0]!, 70));
        const folded = [...(await read(p)).values()];
        expect(folded.map((e) => e.id)).toEqual([live[1]!.id, live[0]!.id]);
        const linesBefore = (await rawLines(p)).length;
        await compactFindQueue(coreOf(), p.id);
        const lines = await rawLines(p);
        expect(lines).toHaveLength(2);
        expect([...(await read(p)).values()]).toEqual(folded);
        expect(await readFile(queueFile(p), "utf8")).not.toContain("removed Zorblatt");
        const ev = (await findEvents(p, FIND_QUEUE_OPS.compact)).at(-1)!;
        expect(ev.details).toMatchObject({ op: "project.find.compact", count: 2, linesBefore, linesAfter: 2, unreadable: 0, txn: expect.any(String) });
        expect(JSON.stringify(ev)).not.toContain("Quillfeather");
        expect(JSON.stringify(ev)).not.toContain("Zorblatt");
        expect(await txnMarkers()).toEqual([]);
        if (!encrypted && process.platform !== "win32") expect((await stat(queueFile(p))).mode & 0o777).toBe(0o600);
        // A queue with nothing live is compacted to an empty file, which can be appended to again.
        await append(p, live, "remove");
        await rawAppend(p, hist(live[0]!, 70).map((e) => ({ ...e, removed: true as const })));
        await compactFindQueue(coreOf(), p.id);
        expect(await readFile(queueFile(p))).toHaveLength(0);
        const again = entry(p);
        await append(p, [again]);
        expect([...(await read(p)).keys()]).toEqual([again.id]);
      }
    });

    it("is due when the superseded and removed lines outnumber the live entries and number at least 64 (dead > live && dead >= 64); otherwise it changes nothing and audits nothing", async () => {
      const p = await project();
      const a = entry(p);
      const b = entry(p);
      await append(p, [a, b]); // 2 lines, none dead
      await rawAppend(p, hist(a, 63)); // 65 lines, 63 dead
      const before = await readFile(queueFile(p));
      await compactFindQueue(coreOf(), p.id);
      expect(await readFile(queueFile(p))).toEqual(before);
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
      await append(p, [{ ...a, attempts: 99 }], "update"); // 66 lines, 64 dead: the append that makes it due compacts
      expect(await rawLines(p)).toHaveLength(2);
      expect((await read(p)).get(a.id)?.attempts).toBe(99);
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toHaveLength(1);
    });

    it("a small queue is not compacted at every second change: one entry changed 30 times compacts at most once", async () => {
      const p = await project();
      const a = entry(p);
      await append(p, [a]);
      for (let i = 1; i <= 30; i++) await append(p, [{ ...a, attempts: i }], "update");
      expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBeLessThanOrEqual(1);
      const q = await project();
      for (let i = 0; i < 30; i++) {
        const e = entry(q);
        await append(q, [e]);
        await append(q, [e], "remove");
      }
      expect((await findEvents(q, FIND_QUEUE_OPS.compact)).length).toBeLessThanOrEqual(1);
    }, 60_000);

    it("a large file of live entries is not rewritten at every update: 4.7 MB of 90 live entries, five updates, no compaction, one audit event per update", async () => {
      const p = await project();
      const works = (i: number) => Array.from({ length: 150 }, (_, k) => candidate({ id: `w${i}-${k}`, title: `Work ${i} ${k} ${"x".repeat(150)}` }));
      const es = Array.from({ length: 90 }, (_, i) => entry(p, { state: "choose-works", works: works(i) }));
      for (let i = 0; i < es.length; i += 10) await append(p, es.slice(i, i + 10));
      expect((await stat(queueFile(p))).size).toBeGreaterThan(MB4);
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
      for (let i = 0; i < 5; i++) await append(p, [{ ...es[i]!, attempts: i + 1 }], "update");
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
      expect(await findEvents(p, FIND_QUEUE_OPS.update)).toHaveLength(5);
      expect((await rawLines(p)).length).toBe(95);
    }, 60_000);

    it("a file with tens of thousands of lines of history and few live entries stays readable, and the next write compacts it", async () => {
      const p = await project();
      const a = entry(p);
      const b = entry(p);
      await append(p, [a, b]);
      const history = Array.from({ length: 60_000 }, (_, i) => JSON.stringify({ ...a, attempts: i, updatedAt: `2026-11-13T10:${String(i % 60).padStart(2, "0")}:00.000Z` })).join("\n") + "\n";
      await appendFile(queueFile(p), history);
      expect((await stat(queueFile(p))).size).toBeGreaterThan(MB4);
      const q = await read(p); // readable meanwhile
      expect(q.size).toBe(2);
      expect(q.get(a.id)?.attempts).toBe(59_999);
      await append(p, [{ ...b, state: "failed" }], "update");
      const lines = await rawLines(p);
      expect(lines).toHaveLength(2);
      expect((await read(p)).get(a.id)?.attempts).toBe(59_999);
      expect((await read(p)).get(b.id)?.state).toBe("failed");
    }, 60_000);

    it("500 entries each changed ten times: the file stays within the rule", async () => {
      const p = await project();
      const es = Array.from({ length: FIND_QUEUE_MAX }, () => entry(p, { candidates: [candidate()] }));
      for (let i = 0; i < es.length; i += 50) await append(p, es.slice(i, i + 50));
      let maxLines = 0;
      for (let round = 1; round <= 10; round++) {
        for (let i = 0; i < es.length; i += 50) {
          await append(p, es.slice(i, i + 50).map((e) => ({ ...e, attempts: round })), "update");
          maxLines = Math.max(maxLines, (await rawLines(p)).length);
        }
      }
      expect(maxLines).toBeLessThanOrEqual(FIND_QUEUE_MAX * 2 + 50);
      expect((await stat(queueFile(p))).size).toBeLessThan(MB4);
      const q = await read(p);
      expect(q.size).toBe(FIND_QUEUE_MAX);
      expect([...q.values()].every((e) => e.attempts === 10)).toBe(true);
    }, 120_000);
  });

  describe("R26: a crash in a write leaves the old queue or the new one, never a half", () => {
    const reopen = async (p: Project, encrypted: boolean) => {
      await lib.close();
      lib = await openLibrary(lib.root, mkDeps());
      repo = await repoFor();
      if (encrypted) await repo.unlockProject(p.id, "pw");
    };
    for (const encrypted of [false, true]) {
      for (const point of ["before-changes", "before-audit", "before-marker-delete"] as CrashPoint[]) {
        for (const op of ["add", "update", "remove"] as const) {
          it(`a crash at ${point} of an ${op} (${encrypted ? "sealed" : "plain"}) leaves the old queue or the new one`, async () => {
            const p = await project(encrypted);
            const old = entry(p);
            const other = entry(p, { typed: "another line" });
            await append(p, [old, other]);
            const before = await readFile(queueFile(p));
            const auditBefore = (await findEvents(p)).length;
            const fresh = entry(p);
            const batch = op === "add" ? [fresh] : op === "update" ? [{ ...old, state: "record-complete" as const }] : [old];
            seams.crashAt = point;
            await expect(append(p, batch, op)).rejects.toBeInstanceOf(SimulatedCrash);
            // The process "died" with the new line already on the disk and the marker still there: the crash really happened in the middle.
            expect((await readFile(queueFile(p))).length).toBeGreaterThan(before.length);
            expect(await txnMarkers()).toHaveLength(1);
            await reopen(p, encrypted);
            const committed = point === "before-marker-delete";
            const q = await read(p);
            if (committed) {
              expect(q.has(fresh.id)).toBe(op === "add");
              expect(q.get(old.id)?.state).toBe(op === "update" ? "record-complete" : op === "remove" ? undefined : "looking-up");
              expect(q.has(old.id)).toBe(op !== "remove");
              expect((await rawLines(p)).length).toBe(3);
            } else {
              expect([...q.values()]).toEqual([old, other]);
              expect(await readFile(queueFile(p))).toEqual(before);
            }
            expect((await findEvents(p)).length).toBe(auditBefore + (committed ? 1 : 0));
            expect(await txnMarkers()).toEqual([]);
            // The queue is usable again.
            await append(p, [entry(p)]);
            expect((await read(p)).size).toBe(committed && op === "remove" ? 2 : committed && op === "add" ? 4 : 3);
          });
        }
      }
    }

    for (const encrypted of [false, true]) {
      for (const point of ["before-changes", "before-audit", "before-marker-delete"] as CrashPoint[]) {
        it(`a crash in the middle of a compaction at ${point} (${encrypted ? "sealed" : "plain"}) leaves the old queue or the new one, never a half`, async () => {
          const p = await project(encrypted);
          const a = entry(p);
          const b = entry(p);
          const gone = entry(p);
          await append(p, [a, b, gone]);
          await append(p, [gone], "remove");
          await rawAppend(p, hist(a, 70));
          const before = await readFile(queueFile(p));
          const folded = [...(await read(p)).values()];
          const compactsBefore = (await findEvents(p, FIND_QUEUE_OPS.compact)).length;
          seams.crashAt = point;
          await expect(compactFindQueue(coreOf(), p.id)).rejects.toBeInstanceOf(SimulatedCrash);
          // The rewrite had really been made when the process "died": the file is already the new one, and the marker is there.
          const mid = await readFile(queueFile(p));
          expect(mid.equals(before)).toBe(false);
          expect(mid.length).toBeLessThan(before.length);
          expect(await txnMarkers()).toHaveLength(1);
          await reopen(p, encrypted);
          const committed = point === "before-marker-delete";
          if (committed) {
            expect(await rawLines(p)).toHaveLength(2);
          } else {
            expect(await readFile(queueFile(p))).toEqual(before);
          }
          // Either way the queue means the same, entry for entry.
          expect([...(await read(p)).values()]).toEqual(folded);
          expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(compactsBefore + (committed ? 1 : 0));
          expect(await txnMarkers()).toEqual([]);
          if (!committed) {
            // And the compaction can be done again.
            await compactFindQueue(coreOf(), p.id);
            expect(await rawLines(p)).toHaveLength(2);
            expect([...(await read(p)).values()]).toEqual(folded);
          }
        });
      }
    }

    it("a write that fails in-process (the audit cannot be written) is undone: the old queue is there and the cache says so", async () => {
      const p = await project();
      const a = entry(p);
      await append(p, [a]);
      const before = await readFile(queueFile(p));
      seams.failAuditAppendFor = p.id;
      await expect(append(p, [entry(p)])).rejects.toBeDefined();
      seams.failAuditAppendFor = undefined;
      expect(await readFile(queueFile(p))).toEqual(before);
      expect([...(await read(p)).keys()]).toEqual([a.id]);
      expect(await txnMarkers()).toEqual([]);
      await append(p, [entry(p)]);
      expect((await read(p)).size).toBe(2);
    });
  });
});

describe("fix round 1 (R226): nothing unreadable is destroyed, a caller cannot change the library, bounds and rules", () => {
  const futureLine = (p: Project, sealed: boolean, extra: Record<string, unknown> = {}) => {
    const core = coreOf();
    const st = core.state(p.id);
    const o = { ...entry(p), state: "translated-later", ...extra };
    if (!sealed) return JSON.stringify(o);
    const k = core.key(st);
    return sealLine(k.key, k.keyId, p.id, JSON.stringify(o), "ao-find-queue");
  };

  for (const encrypted of [false, true]) {
    it(`a newer build's line (an unknown state) survives a compaction, verbatim and in order (${encrypted ? "sealed" : "plain"})`, async () => {
      const p = await project(encrypted);
      const a = entry(p);
      const b = entry(p);
      await append(p, [a, b]);
      const f1 = futureLine(p, encrypted, { typed: "first future" });
      await appendFile(queueFile(p), `${f1}\n`);
      await append(p, [{ ...a, attempts: 1 }], "update");
      const f2 = futureLine(p, encrypted, { typed: "second future" });
      await appendFile(queueFile(p), `${f2}\n`);
      await rawAppend(p, hist(a, 70, 100));
      await append(p, [{ ...a, attempts: 6 }], "update"); // the append that makes it due compacts
      expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
      const lines = await rawLines(p);
      expect(lines.filter((l) => l === f1 || l === f2)).toEqual([f1, f2]); // verbatim, in order
      expect(lines.length).toBe(4); // two entries and the two lines nobody could read
      const d = await readFindQueueDetailed(coreOf(), p.id);
      expect(d.unreadableLines).toBe(2);
      expect(d.entries.get(a.id)?.attempts).toBe(6);
      expect([...d.entries.keys()].sort()).toEqual([a.id, b.id].sort());
      // The lines carried over do not count towards "due": nothing compacts again until real history builds up.
      const n = (await findEvents(p, FIND_QUEUE_OPS.compact)).length;
      await append(p, [{ ...b, attempts: 1 }], "update");
      expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(n);
    });
  }

  it("a torn line in the middle of the file (cut by a bad disk, ended by a later newline) survives a compaction", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    await appendFile(queueFile(p), '{"id":"01a1d5de-c95e-7508-a8a2-ace1aaa9259a","typed":"cut off here\n');
    await rawAppend(p, hist(a, 70, 100));
    await append(p, [{ ...a, attempts: 4 }], "update");
    expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
    const lines = await rawLines(p);
    expect(lines).toContain('{"id":"01a1d5de-c95e-7508-a8a2-ace1aaa9259a","typed":"cut off here');
    expect((await read(p)).get(a.id)?.attempts).toBe(4);
  });

  for (const encrypted of [false, true]) {
    it(`a file in which no line can be read is refused, read and write alike, and left byte for byte (${encrypted ? "sealed" : "plain"})`, async () => {
      const p = await project(encrypted);
      const core = coreOf();
      const st = core.state(p.id);
      const k = encrypted ? core.key(st) : undefined;
      // Every line fails to open: sealed for another file, or not JSON at all.
      const other = k ? [1, 2, 3].map((i) => sealLine(k.key, k.keyId, p.id, JSON.stringify({ ...entry(p), typed: `n${i}` }), "ao-watch-register")) : ["{nope", "also not", "[1,2]"];
      await mkdirp(join(lib.root, p.folder, "find"));
      await writeFile(queueFile(p), other.map((l) => `${l}\n`).join(""), { mode: 0o600 });
      const before = await readFile(queueFile(p));
      const auditBefore = (await auditEvents(p)).length;
      const msg = "The Find and acquire queue of this project could not be read. Nothing has been changed.";
      for (const op of [() => read(p), () => readFindQueueDetailed(coreOf(), p.id), () => append(p, [entry(p)], "add"), () => append(p, [entry(p)], "update"), () => compactFindQueue(coreOf(), p.id)]) {
        const err = await op().catch((e: unknown) => e as Error);
        expect(err).toBeInstanceOf(FindQueueUnreadableError);
        expect((err as Error).message).toBe(msg);
      }
      expect(await readFile(queueFile(p))).toEqual(before);
      expect((await auditEvents(p)).length).toBe(auditBefore);
      expect(await txnMarkers()).toEqual([]);
    });
  }

  it("when more than half of the file's lines cannot be read, compaction does not run (and says so once); reads and appends go on", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    await appendFile(queueFile(p), Array.from({ length: 200 }, (_, i) => `junk ${i}\n`).join(""));
    await rawAppend(p, hist(a, 70, 100));
    const notes = () => coreOf().indexErrors.filter((e) => e.op === FIND_QUEUE_OPS.compact);
    for (let i = 1; i <= 3; i++) await append(p, [{ ...a, attempts: i }], "update");
    expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
    expect((await rawLines(p)).length).toBe(1 + 200 + 70 + 3);
    expect((await read(p)).get(a.id)?.attempts).toBe(3);
    expect(notes()).toHaveLength(1);
    expect(String((notes()[0]!.error as Error).message)).toMatch(/could not be read/u);
    await compactFindQueue(coreOf(), p.id);
    expect(notes()).toHaveLength(1);
    expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
  });

  it("what a caller holds cannot change the library: entries from a read are frozen all the way down, and what was handed in is copied", async () => {
    const p = await project();
    const a = entry(p, { candidates: [candidate()] });
    const b = entry(p);
    await append(p, [a, b]);
    const e = (await read(p)).get(a.id)!;
    expect(() => {
      e.candidates![0]!.title = "POISONED";
    }).toThrow(TypeError);
    expect(() => e.candidates!.push(candidate({ id: "x" }))).toThrow(TypeError);
    expect(() => (e.candidates![0]!.creators as unknown[]).pop()).toThrow(TypeError);
    // What the caller handed in is its own: changing it afterwards changes nothing in the library.
    const mine = entry(p, { candidates: [candidate()] });
    await append(p, [mine]);
    mine.candidates![0]!.title = "POISONED TOO";
    mine.candidates!.push(candidate({ id: "y" }));
    await rawAppend(p, hist(b, 70, 100));
    await append(p, [{ ...b, attempts: 12 }], "update"); // a compaction runs
    expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
    expect(await readFile(queueFile(p), "utf8")).not.toContain("POISONED");
    expect((await read(p)).get(a.id)?.candidates).toEqual([candidate()]);
    expect((await read(p)).get(mine.id)?.candidates).toEqual([candidate()]);
    for (const l of await rawLines(p)) expect(JSON.parse(l)).toHaveProperty("projectId", p.id);
  });

  it("M1: one add of 501 entries is a full queue, not a malformed list", async () => {
    const p = await project();
    await expect(append(p, Array.from({ length: FIND_QUEUE_MAX + 1 }, () => entry(p)))).rejects.toBeInstanceOf(FindQueueFullError);
    await expect(stat(join(lib.root, p.folder, "find"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("M2: an id whose latest line is `removed` may be added again, before and after a compaction alike", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    await append(p, [a], "remove");
    await append(p, [{ ...a, typed: "again one" }], "add"); // before any compaction
    expect((await read(p)).get(a.id)?.typed).toBe("again one");
    await append(p, [{ ...a, typed: "again one" }], "remove");
    await rawAppend(p, hist(a, 70).map((e) => ({ ...e, removed: true as const })));
    await compactFindQueue(coreOf(), p.id);
    expect(await readFile(queueFile(p))).toHaveLength(0);
    await append(p, [{ ...a, typed: "again two" }], "add"); // after one
    expect((await read(p)).get(a.id)?.typed).toBe("again two");
    // A live one is still refused.
    await expect(append(p, [a], "add")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("M4: ids are checked as ids; the plan's bounds are enforced by the store (refused with a plain sentence, never cut); unknown nested fields are dropped", async () => {
    const p = await project();
    const refused: Array<[string, Partial<FindEntry>]> = [
      ["sourceId", { sourceId: "not-an-id" }],
      ["duplicateOf", { duplicateOf: "../x" }],
      ["parentId", { parentId: "x" }],
      ["collectionId", { collectionId: "y" }],
      ["title", { candidates: [candidate({ title: "t".repeat(1001) })] }],
      ["name", { candidates: [candidate({ creators: [{ role: "author", family: "f".repeat(201) }] })] }],
      ["creators", { candidates: [candidate({ creators: Array.from({ length: 101 }, () => ({ role: "author" as const, family: "F" })) })] }],
      ["candidates", { candidates: Array.from({ length: 11 }, (_, i) => candidate({ id: `c${i}` })) }],
      ["people", { people: Array.from({ length: 21 }, (_, i) => ({ id: `A${i}`, name: "N", worksCount: 1, subjects: [] })) }],
      ["works", { works: Array.from({ length: 201 }, (_, i) => candidate({ id: `w${i}` })) }],
      ["type", { candidates: [candidate({ type: "spaceship" as never })] }],
    ];
    for (const [, extra] of refused) {
      const err = await append(p, [entry(p, extra)]).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(InvalidInputError);
      expect((err as Error).message).toMatch(/not well formed|more than the queue keeps/u);
      expect((err as Error).message).not.toContain("ttttt");
    }
    await expect(stat(join(lib.root, p.folder, "find"))).rejects.toMatchObject({ code: "ENOENT" });
    // At the bounds: kept as given. Beyond what the type knows: dropped.
    const exact = entry(p, {
      state: "choose-person",
      candidates: [{ ...candidate({ title: "t".repeat(1000), creators: Array.from({ length: 100 }, () => ({ role: "author" as const, family: "f".repeat(200) })) }), secret: "Quillfeather's diary" } as WorkCandidate],
      people: [{ id: "A1", name: "n".repeat(200), worksCount: 3, subjects: ["a", "b", "c"], hidden: "x" } as never],
    });
    await append(p, [exact]);
    const raw = await readFile(queueFile(p), "utf8");
    expect(raw).not.toContain("diary");
    expect(raw).not.toContain('"hidden"');
    expect((await read(p)).get(exact.id)?.candidates?.[0]?.title).toHaveLength(1000);
  });

  it("M5/M8: an automatic compaction that fails leaves ONE note per failure state (the append itself stays committed); the next success clears the way", async () => {
    const p = await project();
    const a = entry(p);
    const b = entry(p);
    await append(p, [a, b]);
    const core = coreOf() as unknown as { clock: () => Date };
    const real = core.clock.bind(core);
    let calls = 0;
    core.clock = () => (calls++, real());
    await append(p, [{ ...a, attempts: 1 }], "update"); // not due
    const perWrite = calls;
    expect(perWrite).toBeGreaterThan(0);
    await rawAppend(p, hist(a, 61, 100)); // 64 lines, 62 dead
    const broken = () => {
      calls = 0;
      core.clock = () => {
        if (++calls > perWrite) throw new Error("the clock broke");
        return real();
      };
    };
    broken();
    await append(p, [{ ...a, attempts: 3 }], "update"); // 63 dead: not due
    broken();
    await append(p, [{ ...a, attempts: 4 }], "update"); // 64 dead: due; the compaction fails after the append
    expect((await read(p)).get(a.id)?.attempts).toBe(4);
    expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
    const notes = () => coreOf().indexErrors.filter((e) => e.op === FIND_QUEUE_OPS.compact);
    expect(notes()).toHaveLength(1);
    broken();
    await append(p, [{ ...a, attempts: 5 }], "update"); // still due, fails again: the same note, not another
    expect(notes()).toHaveLength(1);
    expect(String((notes()[0]!.error as Error).message)).not.toContain(a.typed);
    core.clock = real;
    expect(await txnMarkers()).toEqual([]);
    await append(p, [{ ...a, attempts: 6 }], "update"); // the next write tries again, and now it works
    expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
    expect(await rawLines(p)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix round 2: one routine reads and classifies the lines, for the reader and for compaction

describe("fix round 2: what the reader sees and what compaction keeps cannot differ", () => {
  /** An entry whose plain JSON line is about `bytes` long (works of 1,000-character titles). */
  const sized = (p: Project, bytes: number, extra: Partial<FindEntry> = {}): FindEntry => {
    const mk = (n: number, last: number): FindEntry => entry(p, { state: "choose-works", works: [...Array.from({ length: n }, (_, i) => candidate({ id: `w${i}`, title: "t".repeat(1000) })), candidate({ id: "last", title: "l".repeat(last) })], ...extra });
    const e0 = mk(0, 0);
    for (let n = 1; ; n++) {
      const full = mk(n, 1000);
      if (JSON.stringify(full).length >= bytes) {
        for (let last = 0; last <= 1000; last += 5) {
          const t = mk(n - 1, last);
          if (JSON.stringify(t).length >= bytes) return { ...t, id: e0.id };
        }
        return { ...full, id: e0.id };
      }
    }
  };

  for (const encrypted of [false, true]) {
    it(`the reviewer's probe: two valid lines of about 104 KB survive a compaction (${encrypted ? "sealed" : "plain"})`, async () => {
      const p = await project(encrypted);
      const a = entry(p);
      const b = entry(p);
      await append(p, [a, b]);
      const big1 = sized(p, 104_000, { id: a.id, attempts: 5 }); // supersedes a live entry
      const big2 = sized(p, 104_000); // an id of its own
      expect(JSON.stringify(big1).length).toBeGreaterThan(100_000);
      await rawAppend(p, [big1, big2]);
      await rawAppend(p, hist(b, 70, 100));
      const d = await readFindQueueDetailed(coreOf(), p.id);
      expect(d.unreadableLines).toBe(0); // a valid line is an entry, whatever its length (up to the memory cap)
      expect(d.entries.get(a.id)?.works).toHaveLength(big1.works!.length);
      expect(d.entries.get(big2.id)?.attempts).toBe(0);
      const before = [...(await read(p)).values()];
      await compactFindQueue(coreOf(), p.id);
      expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
      expect([...(await read(p)).values()]).toEqual(before);
      expect(await rawLines(p)).toHaveLength(3);
    });
  }

  it("a line over the 1 MiB memory cap is carried over unparsed, verbatim and in place, whatever it holds", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    const huge = JSON.stringify({ ...entry(p), pad: "x".repeat(1_200_000) }); // looks like an entry, but is over the cap
    const junk = "z".repeat(1_100_000);
    await appendFile(queueFile(p), `${huge}
`);
    await rawAppend(p, hist(a, 70, 100));
    await appendFile(queueFile(p), `${junk}
`);
    expect((await readFindQueueDetailed(coreOf(), p.id)).unreadableLines).toBe(2);
    await compactFindQueue(coreOf(), p.id);
    expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
    const lines = await rawLines(p);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(huge);
    expect(lines[2]).toBe(junk);
    expect((await read(p)).get(a.id)?.attempts).toBe(169);
  });

  it("the 64 KiB bound is on the entry's plain JSON both ways: an entry accepted at 63 KiB plain is read back as an entry after sealing", async () => {
    const p = await project(true);
    const e = sized(p, 64_700);
    const plain = JSON.stringify(e).length;
    expect(plain).toBeGreaterThanOrEqual(63 * 1024);
    expect(plain).toBeLessThan(FIND_LINE_MAX_BYTES);
    await append(p, [e]);
    const raw = (await rawLines(p))[0]!;
    expect(raw.length).toBeGreaterThan(plain); // the sealed line is longer than the entry's JSON
    const d = await readFindQueueDetailed(coreOf(), p.id);
    expect(d.unreadableLines).toBe(0);
    expect(d.entries.get(e.id)).toEqual(e);
    // And it goes through a compaction as an entry.
    await rawAppend(p, hist(e, 70, 1));
    await compactFindQueue(coreOf(), p.id);
    expect((await read(p)).get(e.id)?.attempts).toBe(70);
    expect((await readFindQueueDetailed(coreOf(), p.id)).unreadableLines).toBe(0);
  });

  for (const encrypted of [false, true]) {
    it(`property: in a file of mixed lines every complete line that is not superseded or removed survives a compaction, byte for byte or as its live entry, in order (${encrypted ? "sealed" : "plain"})`, async () => {
      const p = await project(encrypted);
      const core = coreOf();
      const st = core.state(p.id);
      const k = encrypted ? core.key(st) : undefined;
      const seal = (o: unknown) => (k ? sealLine(k.key, k.keyId, p.id, JSON.stringify(o), "ao-find-queue") : JSON.stringify(o));
      let seed = 12345;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
      };
      const ids = Array.from({ length: 6 }, () => newId());
      const mk = (id: string, attempts: number, extra: Partial<FindEntry> = {}): FindEntry => ({ ...entry(p), id, attempts, ...extra });
      type Line = { text: string; id?: string; removed?: boolean; carried: boolean };
      const lines: Line[] = [];
      let big = 0;
      for (let i = 0; i < 300; i++) {
        const r = rnd(100);
        const id = ids[rnd(ids.length)]!;
        if (r < 60) lines.push({ text: seal(mk(id, i)), id, carried: false });
        else if (r < 70) lines.push({ text: seal({ ...mk(id, i), removed: true, typed: "" }), id, removed: true, carried: false });
        else if (r < 78) lines.push({ text: seal({ ...mk(id, i), state: "from-the-future" }), carried: true });
        else if (r < 86) lines.push({ text: `garbage ${i} ${"g".repeat(rnd(50))}`, carried: true });
        else if (r < 89 && big < 2) {
          big++;
          lines.push({ text: seal(sized(p, 90_000 + rnd(30_000), { id, attempts: i })), id, carried: false }); // valid, over 64 KiB
        } else if (r < 91 && big < 3) {
          big++;
          lines.push({ text: "o".repeat(1_100_000 + rnd(1000)), carried: true }); // over the memory cap
        } else lines.push({ text: seal(mk(id, i)), id, carried: false });
      }
      await mkdirp(join(lib.root, p.folder, "find"));
      await writeFile(queueFile(p), lines.map((l) => `${l.text}
`).join(""), { mode: 0o600 });
      // What must be there afterwards, by the test's own reckoning: carried lines verbatim, and the last line of each id unless it removes it.
      const last = new Map<string, number>();
      lines.forEach((l, i) => l.id && last.set(l.id, i));
      const expected = lines.filter((l, i) => l.carried || (l.id !== undefined && last.get(l.id) === i && !l.removed));
      const before = await readFindQueueDetailed(coreOf(), p.id);
      await compactFindQueue(coreOf(), p.id);
      expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
      const after = await rawLines(p);
      expect(after).toHaveLength(expected.length);
      const tokenOf = (text: string, wasLine?: Line) => {
        if (wasLine?.carried || !wasLine) {
          try {
            const o = JSON.parse(k ? openLine(k.key, p.id, text, "ao-find-queue") : text) as { id?: string; attempts?: number; state?: string };
            if (o.state && o.state !== "from-the-future" && o.id) return `E:${o.id}:${o.attempts}`;
          } catch {
            /* not an entry */
          }
          return `U:${text}`;
        }
        const o = JSON.parse(k ? openLine(k.key, p.id, text, "ao-find-queue") : text) as { id: string; attempts: number };
        return `E:${o.id}:${o.attempts}`;
      };
      expect(after.map((t) => tokenOf(t))).toEqual(expected.map((l) => tokenOf(l.text, l)));
      expect([...(await read(p)).values()].map((e) => `${e.id}:${e.attempts}`).sort()).toEqual([...before.entries.values()].map((e) => `${e.id}:${e.attempts}`).sort());
      expect((await readFindQueueDetailed(coreOf(), p.id)).unreadableLines).toBe(before.unreadableLines);
    }, 60_000);
  }
});

describe("fix round 3: one rule for what a line is, and a check before anything is written", () => {
  for (const encrypted of [false, true]) {
    it(`the reviewer's probe: a whitespace-only line over 1 MiB does not make compaction lose the entries after it (${encrypted ? "sealed" : "plain"})`, async () => {
      const p = await project(encrypted);
      const [e1, e2, f, g] = [entry(p), entry(p), entry(p), entry(p)] as [FindEntry, FindEntry, FindEntry, FindEntry];
      await append(p, [e1, e2]);
      await appendFile(queueFile(p), `${" ".repeat(1024 * 1024 + 10)}\n`);
      await append(p, [f, g]);
      await rawAppend(p, hist(g, 70, 100));
      const before = await readFindQueueDetailed(coreOf(), p.id);
      expect(before.entries.size).toBe(4);
      await compactFindQueue(coreOf(), p.id);
      expect((await findEvents(p, FIND_QUEUE_OPS.compact)).length).toBe(1);
      const after = await readFindQueueDetailed(coreOf(), p.id);
      expect([...after.entries.values()]).toEqual([...before.entries.values()]);
      // A blank line is no line at all, however long: it is not even counted.
      expect(after.unreadableLines).toBe(before.unreadableLines);
    });
  }

  it("blank is ONE rule whatever the length: a short whitespace line is not a line either, and a line with a non-blank byte after 2 MiB of spaces is unreadable and carried", async () => {
    const p = await project();
    const a = entry(p);
    await append(p, [a]);
    const odd = `${" ".repeat(2 * 1024 * 1024)}x`;
    await appendFile(queueFile(p), `   \n\t\n${odd}\n`);
    expect((await readFindQueueDetailed(coreOf(), p.id)).unreadableLines).toBe(1);
    await rawAppend(p, hist(a, 70, 1));
    await compactFindQueue(coreOf(), p.id);
    const lines = await rawLines(p);
    expect(lines).toEqual([odd, JSON.stringify({ ...a, attempts: 70 })]);
    expect((await read(p)).get(a.id)?.attempts).toBe(70);
  });

  describe("the invariant: the new content is scanned by the same routine and compared before it is written", () => {
    afterEach(() => {
      compactionSeams.mutateBuilt = undefined;
    });
    for (const drop of ["a live entry", "a carried line", "a swap of two carried lines"]) {
      it(`a disagreement (${drop} lost by the builder) writes NOTHING: the file stays byte for byte, the append that triggered it succeeds, the note is left once`, async () => {
        const p = await project(true);
        const a = entry(p);
        const b = entry(p);
        await append(p, [a, b]);
        const core = coreOf();
        const k = core.key(core.state(p.id));
        const future1 = sealLine(k.key, k.keyId, p.id, JSON.stringify({ ...entry(p), state: "later-1" }), "ao-find-queue");
        const future2 = sealLine(k.key, k.keyId, p.id, JSON.stringify({ ...entry(p), state: "later-2" }), "ao-find-queue");
        await appendFile(queueFile(p), `${future1}\n${future2}\n`);
        await rawAppend(p, hist(a, 62, 100)); // 66 lines readable of 68: dead 62
        compactionSeams.mutateBuilt = (lines) => {
          if (drop === "a live entry") return lines.slice(1);
          if (drop === "a carried line") return lines.filter((l) => l !== future2);
          return lines.map((l) => (l === future1 ? future2 : l === future2 ? future1 : l));
        };
        await append(p, [{ ...a, attempts: 1 }], "update"); // dead 63: not due
        const before = await readFile(queueFile(p));
        await append(p, [{ ...a, attempts: 2 }], "update"); // dead 64: due; the builder is wrong
        const afterAppend = await readFile(queueFile(p));
        expect(afterAppend.length).toBeGreaterThan(before.length); // the append is done
        expect(afterAppend.subarray(0, before.length)).toEqual(before); // and nothing else changed: the file only grew by that line
        expect((await read(p)).get(a.id)?.attempts).toBe(2);
        expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
        expect(await txnMarkers()).toEqual([]);
        const notes = () => coreOf().indexErrors.filter((e) => e.op === FIND_QUEUE_OPS.compact);
        expect(notes()).toHaveLength(1);
        await append(p, [{ ...a, attempts: 3 }], "update"); // still due, still refused: the same note, once
        expect(notes()).toHaveLength(1);
        // With a correct builder the same file compacts.
        compactionSeams.mutateBuilt = undefined;
        await compactFindQueue(coreOf(), p.id);
        const lines = await rawLines(p);
        expect(lines).toHaveLength(4);
        expect(lines).toContain(future1);
        expect(lines).toContain(future2);
        expect(lines.indexOf(future1)).toBeLessThan(lines.indexOf(future2));
      });
    }
  });
});

describe("Task F8 (R267): an author's entry, and works added from it with the entry's own line in one change", () => {
  const reopen = async (p: Project, encrypted: boolean) => {
    await lib.close();
    lib = await openLibrary(lib.root, mkDeps());
    repo = await repoFor();
    if (encrypted) await repo.unlockProject(p.id, "pw");
  };
  const work = (n: number): WorkCandidate => ({ id: `W${n}`, title: `Invented Work ${n}`, creators: [], type: "article-journal", identifiers: {}, providers: ["openalex"] });

  it("morePeople, moreWorks and the work an entry was made from are kept; anything else of theirs is refused; a round-1 list of added works is not read", async () => {
    const p = await project();
    const parent = entry(p, { state: "choose-works", works: [work(1), work(2)], moreWorks: true, morePeople: true });
    const kid = entry(p, { parentId: parent.id, work: "W1" });
    await append(p, [parent, kid]);
    expect((await read(p)).get(parent.id)).toEqual(parent);
    expect((await read(p)).get(kid.id)).toEqual(kid);
    await expect(append(p, [entry(p, { morePeople: false as unknown as true })])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(append(p, [entry(p, { work: "W".repeat(41) })])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(append(p, [entry(p, { work: 12 as unknown as string })])).rejects.toBeInstanceOf(InvalidInputError);
    // A line written in round 1 with a list of added works, and a person with sample titles: read without them.
    const old = { ...entry(p, { state: "choose-person" }), added: ["W1"], people: [{ id: "A1", name: "Ann", worksCount: 1, sampleTitles: ["T"] }] };
    await rawAppend(p, [old as unknown as FindEntry]);
    const got = (await read(p)).get(old.id)!;
    expect(got).not.toHaveProperty("added");
    expect(got.people).toEqual([{ id: "A1", name: "Ann", worksCount: 1, subjects: [] }]);
  });

  it("an add with the parent's own line is ONE change: one audit entry with ids and counts only", async () => {
    const p = await project();
    const parent = entry(p, { state: "choose-works", works: [work(1), work(2)] });
    await append(p, [parent]);
    const kids = [entry(p, { parentId: parent.id, work: "W1" }), entry(p, { parentId: parent.id, work: "W2" })];
    const before = (await findEvents(p)).length;
    await appendFindEntries(coreOf(), p.id, kids, "add", [{ ...parent, moreWorks: true, updatedAt: "2026-11-13T10:00:01.000Z" }]);
    const evs = await findEvents(p);
    expect(evs.length).toBe(before + 1);
    expect(evs.at(-1)!.details).toMatchObject({ op: FIND_QUEUE_OPS.add, entries: [...kids.map((k) => k.id), parent.id], count: 3 });
    const q = await read(p);
    expect(q.get(parent.id)!.moreWorks).toBe(true);
    expect(q.get(kids[1]!.id)!.parentId).toBe(parent.id);
    expect(await auditText(p)).not.toContain("Invented Work");
  });

  it("the parent's line is refused with the whole add when the parent is no longer in the queue; a full queue refuses the whole add", async () => {
    const p = await project();
    const parent = entry(p, { state: "choose-works", works: [work(1)] });
    await append(p, [parent]);
    await append(p, [parent], "remove");
    const before = await readFile(queueFile(p));
    await expect(appendFindEntries(coreOf(), p.id, [entry(p, { parentId: parent.id })], "add", [{ ...parent, moreWorks: true }])).rejects.toBeInstanceOf(InvalidInputError);
    expect(await readFile(queueFile(p))).toEqual(before);
    const q = await project();
    const qp = entry(q, { state: "choose-works", works: [work(1)] });
    await append(q, [qp, ...Array.from({ length: FIND_QUEUE_MAX - 1 }, () => entry(q))]);
    await expect(appendFindEntries(coreOf(), q.id, [entry(q, { parentId: qp.id })], "add", [{ ...qp, moreWorks: true }])).rejects.toBeInstanceOf(FindQueueFullError);
    expect((await read(q)).get(qp.id)!.moreWorks).toBeUndefined();
    // Only with an add.
    await expect(appendFindEntries(coreOf(), q.id, [qp], "update", [qp])).rejects.toBeInstanceOf(InvalidInputError);
  });

  for (const encrypted of [false, true]) {
    for (const point of ["before-changes", "before-audit", "before-marker-delete"] as CrashPoint[]) {
      it(`a crash at ${point} of an add with the parent's line (${encrypted ? "sealed" : "plain"}) leaves all of it or none`, async () => {
        const p = await project(encrypted);
        const parent = entry(p, { state: "choose-works", works: [work(1), work(2), work(3)] });
        await append(p, [parent]);
        const before = await readFile(queueFile(p));
        const kids = [1, 2, 3].map((n) => entry(p, { parentId: parent.id, work: `W${n}` }));
        seams.crashAt = point;
        await expect(appendFindEntries(coreOf(), p.id, kids, "add", [{ ...parent, moreWorks: true }])).rejects.toBeInstanceOf(SimulatedCrash);
        await reopen(p, encrypted);
        const q = await read(p);
        if (point === "before-marker-delete") {
          expect(kids.every((k) => q.has(k.id))).toBe(true);
          expect(q.get(parent.id)!.moreWorks).toBe(true);
        } else {
          expect(kids.some((k) => q.has(k.id))).toBe(false);
          expect(q.get(parent.id)!.moreWorks).toBeUndefined();
          expect(await readFile(queueFile(p))).toEqual(before);
        }
        expect(await txnMarkers()).toEqual([]);
      });
    }
  }
});
