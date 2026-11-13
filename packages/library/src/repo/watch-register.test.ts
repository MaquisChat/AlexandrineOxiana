import fsp, { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type AuditEvent, type Project } from "@ao/core";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { createAttach } from "../import/attach.js";
import { watchFolder, type FolderWatch } from "../import/watch.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import { InvalidInputError, ProjectLockedError, ReadOnlyLibraryError } from "./errors.js";
import type { Repo } from "./repo.js";
import { SimulatedCrash, openTestRepo, seams, type CrashPoint } from "./testing.js";
import { WATCH_REGISTER_OP, WatchRegisterUnreadableError, WatchRegisterUnwritableError, type WatchRegisterEntry } from "./watch-register.js";

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
const watches: FolderWatch[] = [];

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
  tmp = await mkdtemp(join(tmpdir(), "ao-watch-register-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await repoFor();
});
afterEach(async () => {
  seams.crashAt = undefined;
  await Promise.all(watches.splice(0).map((w) => w.stop()));
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});
afterAll(async () => {
  await shutdownExtractors();
});

const project = async (encrypted = false): Promise<Project> =>
  (
    await repo.createProject({
      name: `P${Math.random().toString(36).slice(2, 7)}`,
      governanceYaml: GOV,
      encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
    })
  ).project;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const entry = (key: string, extra: Partial<WatchRegisterEntry> = {}): WatchRegisterEntry => ({
  key,
  file: key,
  sourceId: newId(),
  sha256: SHA_A,
  size: 1234,
  mtimeNs: "1763000000123456789",
  state: "in-library",
  at: new Date().toISOString(),
  ...extra,
});

const registerFile = (p: Project, watchId: string) => join(lib.root, p.folder, "watched", `${watchId}.jsonl`);
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
const txnMarkers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));

describe("the register of a watched folder (Task W3)", () => {
  it("entries are sealed in an encrypted project and the audit holds counts only", async () => {
    const p = await project(true);
    const watchId = newId();
    const names = ["Interview with Ana Pérez.pdf", "Fieldnotes/Café Lumière 2026.pdf"];
    const a = entry(names[0]!);
    const b = entry(names[1]!, { state: "changed", newSha256: SHA_B, newSize: 99 });
    await repo.recordWatchedFiles(p.id, watchId, [a, b]);
    const raw = await readFile(registerFile(p, watchId), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    for (const n of [...names, "Ana", "Lumière", SHA_A, SHA_B, a.sourceId]) expect(raw).not.toContain(n);
    const reg = await repo.watchRegister(p.id, watchId);
    expect([...reg.values()]).toEqual([a, b]);
    // The audit: the watch's id and counts, never a key, a name or a hash.
    const audit = await auditText(p);
    for (const n of [...names, "Ana", "Fieldnotes", SHA_A, SHA_B]) expect(audit).not.toContain(n);
    const ev = (await auditEvents(p)).filter((e) => e.details?.op === WATCH_REGISTER_OP);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({
      watch: watchId,
      entries: 2,
      states: { "in-library": 1, changed: 1, "may-have-changed": 0, gone: 0, settled: 0 },
      txn: expect.any(String),
    });
    expect(Object.keys(ev[0]!.details!).sort()).toEqual(["changes", "entries", "op", "states", "txn", "watch"]);
    // The origins of a source: which watch and which entry.
    expect(await repo.watchOrigins(p.id, a.sourceId)).toEqual([{ watchId, entry: a }]);
    expect(await repo.watchOrigins(p.id, newId())).toEqual([]);
  });

  it("in a project that is not encrypted the lines are plain and the file is owner-only", async () => {
    const p = await project();
    const watchId = newId();
    const a = entry("Report (1).pdf");
    await repo.recordWatchedFiles(p.id, watchId, [a]);
    const raw = await readFile(registerFile(p, watchId), "utf8");
    expect(JSON.parse(raw.trim())).toEqual(a);
    if (process.platform !== "win32") expect((await stat(registerFile(p, watchId))).mode & 0o777).toBe(0o600);
  });

  it("the later line for a key wins", async () => {
    const p = await project();
    const watchId = newId();
    const a = entry("a.pdf");
    const b = entry("b.pdf");
    await repo.recordWatchedFiles(p.id, watchId, [a, b]);
    const a2 = { ...a, state: "changed" as const, newSha256: SHA_B, newSize: 10 };
    await repo.recordWatchedFiles(p.id, watchId, [a2]);
    const a3 = { ...a, state: "settled" as const, newSha256: SHA_B, newSize: 10 };
    await repo.recordWatchedFiles(p.id, watchId, [a3]);
    let reg = await repo.watchRegister(p.id, watchId);
    expect(reg.size).toBe(2);
    expect(reg.get("a.pdf")).toEqual(a3);
    expect(reg.get("b.pdf")).toEqual(b);
    // A rename: the new key's line names the old key, whose entry is dropped.
    await repo.recordWatchedFiles(p.id, watchId, [{ ...b, key: "Sub/b.pdf", file: "Sub/b.pdf", renamedFrom: "b.pdf" }]);
    reg = await repo.watchRegister(p.id, watchId);
    expect([...reg.keys()].sort()).toEqual(["Sub/b.pdf", "a.pdf"]);
    // Lines are only appended.
    expect((await readFile(registerFile(p, watchId), "utf8")).trim().split("\n")).toHaveLength(5);
  });

  it("a malformed entry, an absolute name or a watch id that is not an id is refused before anything is written", async () => {
    const p = await project();
    const watchId = newId();
    await expect(repo.recordWatchedFiles(p.id, "../../etc", [entry("a.pdf")])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.recordWatchedFiles(p.id, watchId, [entry("/Users/ana/a.pdf")])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.recordWatchedFiles(p.id, watchId, [entry("../a.pdf")])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.recordWatchedFiles(p.id, watchId, [{ ...entry("a.pdf"), mtimeNs: 12 as unknown as string }])).rejects.toBeInstanceOf(InvalidInputError);
    await expect(repo.watchRegister(p.id, "x/../y")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(stat(join(lib.root, p.folder, "watched"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await auditEvents(p)).filter((e) => e.details?.op === WATCH_REGISTER_OP)).toEqual([]);
  });

  it("no entries write nothing", async () => {
    const p = await project();
    await repo.recordWatchedFiles(p.id, newId(), []);
    expect((await auditEvents(p)).filter((e) => e.details?.op === WATCH_REGISTER_OP)).toEqual([]);
  });

  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as CrashPoint[]) {
    it(`a crash at ${point} of the register write leaves the old or the new register`, async () => {
      const p = await project(true);
      const watchId = newId();
      const old = entry("old.pdf");
      await repo.recordWatchedFiles(p.id, watchId, [old]);
      const before = await readFile(registerFile(p, watchId));
      seams.crashAt = point;
      const fresh = [entry("new-1.pdf"), entry("old.pdf", { state: "gone", sourceId: old.sourceId })];
      await expect(repo.recordWatchedFiles(p.id, watchId, fresh)).rejects.toBeInstanceOf(SimulatedCrash);
      await lib.close();
      lib = await openLibrary(lib.root, mkDeps());
      repo = await repoFor();
      await repo.unlockProject(p.id, "pw");
      const reg = await repo.watchRegister(p.id, watchId);
      const committed = point === "before-marker-delete";
      if (committed) {
        expect(reg.get("old.pdf")?.state).toBe("gone");
        expect(reg.get("new-1.pdf")).toEqual(fresh[0]);
      } else {
        expect([...reg.values()]).toEqual([old]);
        expect(await readFile(registerFile(p, watchId))).toEqual(before);
      }
      expect((await auditEvents(p)).filter((e) => e.details?.op === WATCH_REGISTER_OP)).toHaveLength(committed ? 2 : 1);
      expect(await txnMarkers()).toEqual([]);
    });
  }

  it("a locked project's register is not read and not written", async () => {
    const p = await project(true);
    const watchId = newId();
    await repo.recordWatchedFiles(p.id, watchId, [entry("a.pdf")]);
    repo.lockProject(p.id);
    await expect(repo.watchRegister(p.id, watchId)).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(repo.watchOrigins(p.id, newId())).rejects.toBeInstanceOf(ProjectLockedError);
    await expect(repo.recordWatchedFiles(p.id, watchId, [entry("b.pdf")])).rejects.toBeInstanceOf(ProjectLockedError);
    await repo.unlockProject(p.id, "pw");
    expect([...(await repo.watchRegister(p.id, watchId)).keys()]).toEqual(["a.pdf"]);
  });

  it("a read-only library writes no register line", async () => {
    const p = await project();
    const watchId = newId();
    await repo.recordWatchedFiles(p.id, watchId, [entry("a.pdf")]);
    const before = await readFile(registerFile(p, watchId));
    const ro = await repoFor({ ...lib, mode: "read-only", readOnlyReason: "locked-by-other-device" });
    await expect(ro.recordWatchedFiles(p.id, watchId, [entry("b.pdf")])).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(await readFile(registerFile(p, watchId))).toEqual(before);
    expect([...(await ro.watchRegister(p.id, watchId)).keys()]).toEqual(["a.pdf"]);
  });

  for (const encrypted of [false, true]) {
    it(`a torn last line is survived: read without it, removed by the next governed write (${encrypted ? "sealed" : "plain"})`, async () => {
      const p = await project(encrypted);
      const watchId = newId();
      const a = entry("a.pdf");
      await repo.recordWatchedFiles(p.id, watchId, [a]);
      await appendFile(registerFile(p, watchId), '{"key":"half'); // an unclean stop by something else (no newline)
      expect([...(await repo.watchRegister(p.id, watchId)).values()]).toEqual([a]);
      const b = entry("b.pdf");
      await repo.recordWatchedFiles(p.id, watchId, [b]);
      const raw = await readFile(registerFile(p, watchId), "utf8");
      expect(raw).not.toContain("half");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.trim().split("\n")).toHaveLength(2);
      expect([...(await repo.watchRegister(p.id, watchId)).values()]).toEqual([a, b]);
    });
  }

  it("a register that cannot be read or written says so in plain words, never with a path", async () => {
    const p = await project();
    const watchId = newId();
    await mkdir(registerFile(p, watchId), { recursive: true }); // a folder where the file should be
    const read = await repo.watchRegister(p.id, watchId).catch((e: unknown) => e as Error);
    expect(read).toBeInstanceOf(WatchRegisterUnreadableError);
    const write = await repo.recordWatchedFiles(p.id, watchId, [entry("a.pdf")]).catch((e: unknown) => e as Error);
    expect(write).toBeInstanceOf(WatchRegisterUnwritableError);
    for (const e of [read as Error, write as Error]) {
      expect(e.message).not.toContain(tmp);
      expect(e.message).not.toContain("/");
    }
    expect(await txnMarkers()).toEqual([]);
  });

  it("the register is not read whole again and again: kept folded, refreshed by its own writes", async () => {
    const p = await project(true);
    const watchId = newId();
    const a = entry("a.pdf");
    await repo.recordWatchedFiles(p.id, watchId, [a]);
    const opens = vi.spyOn(fsp, "open");
    syncBuiltinESMExports();
    try {
      const file = registerFile(p, watchId);
      const reads = () => opens.mock.calls.filter((c) => String(c[0]) === file).length;
      for (let i = 0; i < 3; i++) expect([...(await repo.watchRegister(p.id, watchId)).keys()]).toEqual(["a.pdf"]);
      for (let i = 0; i < 2; i++) expect(await repo.watchOrigins(p.id, a.sourceId)).toEqual([{ watchId, entry: a }]);
      expect(reads()).toBeLessThanOrEqual(1);
      const n = reads();
      const b = entry("b.pdf");
      await repo.recordWatchedFiles(p.id, watchId, [b]);
      expect([...(await repo.watchRegister(p.id, watchId)).keys()]).toEqual(["a.pdf", "b.pdf"]);
      expect(await repo.watchOrigins(p.id, b.sourceId)).toEqual([{ watchId, entry: b }]);
      expect(reads()).toBe(n);
      // A change made by something else is seen (the file's identity changed): read once more.
      await appendFile(file, "\n");
      expect([...(await repo.watchRegister(p.id, watchId)).keys()]).toEqual(["a.pdf", "b.pdf"]);
      expect(reads()).toBe(n + 1);
      // The caller's map is its own.
      const m = await repo.watchRegister(p.id, watchId);
      m.delete("a.pdf");
      expect((await repo.watchRegister(p.id, watchId)).has("a.pdf")).toBe(true);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
});

describe("the register and the engine (Task W3)", () => {
  it("a crash after the source and before the entry is healed without a second source", async () => {
    const p = await project();
    const inbox = join(tmp, "Inbox");
    await (await import("node:fs/promises")).mkdir(inbox);
    const watchId = newId();
    const file = join(inbox, "paper.pdf");
    await writeFile(file, await buildPdf({ title: "Adopted", extra: "adopted" }));
    const agent = new MockAgent();
    agent.disableNetConnect();
    const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
    // The source was created by the watch (its provenance names the watch) and the process died before the
    // register's line was written.
    const [o] = await createAttach({ repo, http }).attachFiles(p.id, [file], { origin: { watchId } });
    expect(o).toMatchObject({ outcome: expect.stringMatching(/created|needs-review/u) });
    const sf = await repo.getSource(p.id, o!.sourceId!);
    expect(sf.source.provenance.tool.name).toBe("watched-folder");
    expect(sf.source.provenance.externalKeys).toEqual({ "watched-folder": watchId });
    expect((await repo.watchRegister(p.id, watchId)).size).toBe(0);
    // The next start adopts the file: an entry for that source, no second source, nothing announced.
    const w = watchFolder({ repo, http, lib, stabilityMs: 200, pollMs: 50 }, p.id, inbox, {}, watchId);
    watches.push(w);
    await w.ready;
    const deadline = Date.now() + 15_000;
    while ((await repo.watchRegister(p.id, watchId)).size === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const reg = await repo.watchRegister(p.id, watchId);
    expect(reg.get("paper.pdf")).toMatchObject({ key: "paper.pdf", file: "paper.pdf", sourceId: o!.sourceId, state: "in-library", sha256: sf.assets[0]!.sha256 });
    expect(repo.listSourceIds(p.id)).toEqual([o!.sourceId]);
    expect(w.status().counts).toMatchObject({ cameIn: 1, alreadyInLibrary: 0 });
    // A source of another watch (or of drag-and-drop) with the same content is not adopted: it is "already in the library".
    await agent.close();
  }, 30_000);
});
