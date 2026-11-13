import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type AuditEvent, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { InvalidInputError, ProjectLockedError, ReadOnlyLibraryError } from "../repo/errors.js";
import { sealLine } from "../repo/io.js";
import type { Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { SimulatedCrash, openTestRepo, seams, type CrashPoint } from "../repo/testing.js";
import type { WorkCandidate } from "./candidates.js";
import {
  FIND_COMPACT_BYTES,
  FindEntryTooLargeError,
  FindQueueFullError,
  appendFindEntries,
  compactFindQueue,
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
    const b = entry(p, { typed: "Mirabel Quillfeather", people: [{ id: "A123", name: "Mirabel Quillfeather", affiliation: "Zorblatt University", worksCount: 3, sampleTitles: ["Zorblatt Grammar"] }] });
    await append(p, [a, b], "add"); // add
    await append(p, [{ ...a, state: "choose", updatedAt: "2026-11-13T10:01:00.000Z" }], "update"); // update
    await append(p, [b], "remove"); // remove
    // Lines of a compaction (lines are 4 for 1 live entry: none due yet; force a history, then compact).
    for (let i = 0; i < 6; i++) await append(p, [{ ...a, attempts: i + 1 }], "update");
    await compactFindQueue(coreOf(), p.id);
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
    expect(q.get(a.id)).toMatchObject({ typed: a.typed, attempts: 6, candidates: [candidate()] });
    expect(q.has(b.id)).toBe(false);
  });

  it("the audit entry holds ids, counts and states only, never the typed text, a title, a name or a host", async () => {
    const p = await project();
    const a = entry(p, { candidates: [candidate()], offers: [{ label: "Publisher's page", url: "https://doi.org/10.9999/zorblatt", host: "doi.org" }], reason: { code: "unreachable" } });
    const b = entry(p, { state: "choose" });
    await append(p, [a, b], "add");
    await append(p, [{ ...a, state: "not-found" }], "update");
    await append(p, [b], "remove");
    const evs = await findEvents(p);
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
      const big = (n: number) => entry(p, { candidates: [candidate({ title: "t".repeat(n) })] });
      let over: Error | undefined;
      try {
        await append(p, [big(FIND_LINE_MAX_BYTES)]);
      } catch (e) {
        over = e as Error;
      }
      expect(over).toBeInstanceOf(FindEntryTooLargeError);
      expect(over!.message).toMatch(/too large/iu);
      expect(over!.message).not.toContain("ttttt");
      await expect(stat(join(lib.root, p.folder, "find"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await findEvents(p)).toEqual([]);
      const ok = big(FIND_LINE_MAX_BYTES - 1_000);
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
      expect(detail.skipped).toBe(junk.length);
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
        await rawAppend(p, Array.from({ length: 40 }, (_, i) => ({ ...live[0]!, attempts: i })));
        const folded = [...(await read(p)).values()];
        expect(folded.map((e) => e.id)).toEqual([live[1]!.id, live[0]!.id]);
        const linesBefore = (await rawLines(p)).length;
        await compactFindQueue(coreOf(), p.id);
        const lines = await rawLines(p);
        expect(lines).toHaveLength(2);
        expect([...(await read(p)).values()]).toEqual(folded);
        expect(await readFile(queueFile(p), "utf8")).not.toContain("removed Zorblatt");
        const ev = (await findEvents(p, FIND_QUEUE_OPS.compact)).at(-1)!;
        expect(ev.details).toMatchObject({ op: "project.find.compact", count: 2, linesBefore, linesAfter: 2, txn: expect.any(String) });
        expect(JSON.stringify(ev)).not.toContain("Quillfeather");
        expect(JSON.stringify(ev)).not.toContain("Zorblatt");
        expect(await txnMarkers()).toEqual([]);
        if (!encrypted && process.platform !== "win32") expect((await stat(queueFile(p))).mode & 0o777).toBe(0o600);
        // A queue with nothing live is compacted to an empty file, which can be appended to again.
        await append(p, live, "remove");
        await rawAppend(p, Array.from({ length: 5 }, (_, i) => ({ ...live[0]!, attempts: i, removed: true as const })));
        await compactFindQueue(coreOf(), p.id);
        expect(await readFile(queueFile(p))).toHaveLength(0);
        const again = entry(p);
        await append(p, [again]);
        expect([...(await read(p)).keys()]).toEqual([again.id]);
      }
    });

    it("runs only when the file passes 4 MB or holds more than 5 lines per live entry; otherwise it changes nothing and audits nothing", async () => {
      const p = await project();
      const a = entry(p);
      const b = entry(p);
      await append(p, [a, b]);
      for (let i = 0; i < 4; i++) await append(p, [{ ...a, attempts: i + 1 }], "update"); // 6 lines for 2 live entries
      const before = await readFile(queueFile(p));
      await compactFindQueue(coreOf(), p.id);
      expect(await readFile(queueFile(p))).toEqual(before);
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
      // 10 lines for 2 live entries is still not more than 5 per entry.
      for (let i = 0; i < 4; i++) await append(p, [{ ...a, attempts: 10 + i }], "update");
      expect(await rawLines(p)).toHaveLength(10);
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toEqual([]);
      // The 11th line passes the rule: the append that wrote it compacts the file.
      await append(p, [{ ...a, attempts: 99 }], "update");
      expect(await rawLines(p)).toHaveLength(2);
      expect((await read(p)).get(a.id)?.attempts).toBe(99);
      expect(await findEvents(p, FIND_QUEUE_OPS.compact)).toHaveLength(1);
    });

    it("a file with tens of thousands of lines of history and few live entries stays readable, and the next write compacts it", async () => {
      const p = await project();
      const a = entry(p);
      const b = entry(p);
      await append(p, [a, b]);
      const history = Array.from({ length: 60_000 }, (_, i) => JSON.stringify({ ...a, attempts: i, updatedAt: `2026-11-13T10:${String(i % 60).padStart(2, "0")}:00.000Z` })).join("\n") + "\n";
      await appendFile(queueFile(p), history);
      expect((await stat(queueFile(p))).size).toBeGreaterThan(FIND_COMPACT_BYTES);
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
      expect(maxLines).toBeLessThanOrEqual(FIND_QUEUE_MAX * 5 + 50);
      expect((await stat(queueFile(p))).size).toBeLessThan(FIND_COMPACT_BYTES + FIND_LINE_MAX_BYTES * 50);
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
          await rawAppend(p, Array.from({ length: 30 }, (_, i) => ({ ...a, attempts: i })));
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
