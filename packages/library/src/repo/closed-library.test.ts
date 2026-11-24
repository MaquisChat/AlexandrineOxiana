/**
 * FR-749 (R546 1, after R247 c and d): a Library that has been closed refuses every further write with a named error
 * (`LibraryClosedError`), whatever a caller does, and leaves no file and no marker; its `close()` lets a change that is
 * already in its store turn finish and be recorded before the lock is released, and a change that has not begun its
 * turn when `close()` is called never begins it.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { createLibrary, openLibrary, whileOpen, type Library } from "../library.js";
import { auditEvents, addSource, makeKit, makeProject, scratchFile, walk, type Kit } from "../export/test-kit.js";
import { CloseInsideChangeError, LibraryClosedError } from "./errors.js";
import { appendRefusalEvent, importChange } from "./repo.js";
import { pendingMarkers } from "./txn.js";
import { openTestRepo } from "./testing.js";
import { KeyRing } from "../crypto/keys.js";

const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.close().catch(() => {});
  kit = undefined;
});

/** Every file under the library with its bytes' digest (folders by name): equal snapshots mean nothing was written. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${rel} ${digest}`);
  }
  return out;
}

describe("a closed Library refuses every write (FR-749, R546 1)", () => {
  it("each family of write refuses with LibraryClosedError and leaves no file and no marker", async () => {
    kit = await makeKit("ao-closed-");
    const p = await makeProject(kit);
    const sf = await addSource(kit, p, { title: "Harbour ledger" });
    const pdf = await scratchFile(kit, "late.pdf", "%PDF-1.7\nlate\n%%EOF\n");
    const repo = kit.repo;
    const root = kit.lib.root;
    const { sha256: governanceSha } = await repo.getGovernance(p.id);
    await kit.lib.close();
    const before = await snapshot(root);

    const draft = { projectIds: [p.id], type: "article-journal" as const, title: { variants: [{ lang: "en", kind: "original" as const, value: "Late" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" as const }, collectionIds: [], tagIds: [], participantIds: [] };
    const provenance = { captureMethod: "manual_upload" as const, capturedAt: kit.clock.now.toISOString(), tool: { name: "test", version: "1" }, fileHashes: {}, legal: { status: "public" as const, basis: "test" }, identifiable: false };
    const writes: Array<[string, () => Promise<unknown>]> = [
      // records and imports (a capture and an attach store through the same change), the review queue with them
      ["a new source, with a review entry", () => repo.createSource(p.id, draft, [{ path: pdf, role: "original", handling: "copy" }], { provenance, reviewItem: { fields: { title: "Late" }, reasons: ["check"] } })],
      ["a record's fields", () => repo.updateSource(p.id, sf.source.id, { title: { variants: [{ lang: "en", kind: "original", value: "Changed" }] } })],
      ["an import's own change", () => importChange(repo, p.id, STORE, async () => undefined, { op: "test.late" })],
      // annotations
      ["an annotation", () => repo.createAnnotation(p.id, sf.source.id, { kind: "note", anchors: [], body: "late note" } as never)],
      // the project's settings files (project.json, governance.yaml)
      ["a collection", () => repo.createCollection(p.id, "Late")],
      ["the project's rules", () => repo.setGovernance(p.id, "identifiability:\n  containsIdentifiable: false\n", { baseSha256: governanceSha, reason: "late" })],
      // the audit log on its own
      ["a refusal's audit entry", () => appendRefusalEvent(repo, p.id, "capture", "late", {})],
      // a watched folder's register
      ["a watched folder's register", () => repo.recordWatchedFiles(p.id, "w1", [{ key: "k", file: "a.pdf", sourceId: sf.source.id, sha256: "0".repeat(64), size: 1, mtimeNs: "1", state: "in-library", at: kit!.clock.now.toISOString() }])],
      // the kept recovery warnings
      ["a recovery warning's dismissal", () => repo.dismissRecoveryWarning("none")],
    ];
    for (const [what, write] of writes) {
      await expect(Promise.resolve().then(write), what).rejects.toBeInstanceOf(LibraryClosedError);
    }
    expect(await snapshot(root)).toEqual(before);
    expect(await pendingMarkers(root)).toBe(0);
  });

  it("close() during a change in its store turn resolves only after that change is recorded; the lock goes last", async () => {
    kit = await makeKit("ao-closed-turn-");
    const p = await makeProject(kit);
    const repo = kit.repo;
    const root = kit.lib.root;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const change = importChange(repo, p.id, STORE, async (ops) => {
      entered();
      await gate;
      ops.tx.record("project", p.id, { note: "" }, { note: "recorded before the lock went" });
    }, { op: "test.held" });
    await inside;
    // A change asked for after the turn began, still waiting for its own turn when close() is called: it never begins.
    const queued = importChange(repo, p.id, STORE, async () => undefined, { op: "test.queued" }).then(
      () => "ran",
      (err: unknown) => err,
    );
    let closed = false;
    const closing = kit.lib.close().then(() => (closed = true));
    // A change asked for once close() was called: refused at once.
    await expect(Promise.resolve().then(() => importChange(repo, p.id, STORE, async () => undefined, { op: "test.after" }))).rejects.toBeInstanceOf(LibraryClosedError);
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false);
    expect(existsSync(join(root, ".lock"))).toBe(true);
    release();
    await change;
    await closing;
    expect(await queued).toBeInstanceOf(LibraryClosedError);
    expect(closed).toBe(true);
    expect(existsSync(join(root, ".lock"))).toBe(false);
    const ops = (await auditEvents(kit, p)).map((e) => e.details?.op);
    expect(ops).toContain("test.held");
    expect(ops).not.toContain("test.queued");
    expect(ops).not.toContain("test.after");
    expect(await pendingMarkers(root)).toBe(0);
    // A second Library object opens the folder read-write and finds it clean.
    const again = await openLibrary(root, { clock: () => new Date(), deviceId: "dev-B", hostname: "host-B", pid: process.pid, isPidAlive: () => true, appConfigDir: join(kit.tmp, "config"), settleMs: 0, setInterval: () => ({}), clearInterval: () => {} });
    onTestFinished(() => again.close());
    expect(again.mode).toBe("read-write");
    const ring = new KeyRing();
    const repo2 = await openTestRepo(again, ring, { tz: "UTC", scryptN: 2 ** 10 });
    expect(repo2.integrityWarnings).toEqual([]);
    await again.close();
  });
});

/** A change held inside its store turn until `release`; `inside` resolves once it is there; `log` records its end. */
function heldChange(k: Kit, projectId: string, log: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const change = importChange(k.repo, projectId, STORE, async (ops) => {
    entered();
    await gate;
    ops.tx.record("project", projectId, { note: "" }, { note: "recorded before the lock went" });
    log.push("turn ended");
  }, { op: "test.held" });
  return { change, inside, release };
}

/**
 * While `held()` is true, for a bounded time: the lock file stays and nothing in `log` happened. The time is the
 * bound on how long a close that does NOT wait would take to release the lock (an unlink: well under it).
 */
async function stillHeld(root: string, log: string[], ms = 300): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect(existsSync(join(root, ".lock")), "the lock is still there while the change is in its turn").toBe(true);
    expect(log).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the order of a close (FR-749, R551 I3, M1, M2)", () => {
  it("I3: the lock is released only after the change in its turn has ended, and close() resolves after that", async () => {
    kit = await makeKit("ao-closed-order-");
    const p = await makeProject(kit);
    const root = kit.lib.root;
    const log: string[] = [];
    const held = heldChange(kit, p.id, log);
    await held.inside;
    const closing = kit.lib.close().then(() => log.push(`close resolved, lock ${existsSync(join(root, ".lock")) ? "still there" : "gone"}`));
    await stillHeld(root, log);
    held.release();
    await held.change;
    await closing;
    expect(log).toEqual(["turn ended", "close resolved, lock gone"]);
    expect(await pendingMarkers(root)).toBe(0);
  });

  it("M1: a second close() while the first waits is the first one: it never resolves before the lock is released", async () => {
    kit = await makeKit("ao-closed-twice-");
    const p = await makeProject(kit);
    const root = kit.lib.root;
    const log: string[] = [];
    const held = heldChange(kit, p.id, log);
    await held.inside;
    const first = kit.lib.close();
    const second = kit.lib.close();
    expect(second).toBe(first);
    const settled = second.then(() => log.push(`second resolved, lock ${existsSync(join(root, ".lock")) ? "still there" : "gone"}`));
    await stillHeld(root, log);
    held.release();
    await held.change;
    await settled;
    expect(log).toEqual(["turn ended", "second resolved, lock gone"]);
  });

  it("M2: a change that closes its own library is refused with a named error; its turn ends normally and the library stays open", async () => {
    kit = await makeKit("ao-closed-self-");
    const p = await makeProject(kit);
    const lib = kit.lib;
    let refused: unknown;
    await importChange(kit.repo, p.id, STORE, async (ops) => {
      refused = await lib.close().then(
        () => "closed",
        (err: unknown) => err,
      );
      ops.tx.record("project", p.id, { note: "" }, { note: "after the refused close" });
    }, { op: "test.self-close" });
    expect(refused).toBeInstanceOf(CloseInsideChangeError);
    expect(existsSync(join(lib.root, ".lock"))).toBe(true);
    // Still open: a later change is made, and a close from outside works.
    await kit.repo.createCollection(p.id, "Still open");
    const ops = (await auditEvents(kit, p)).map((e) => e.details?.op);
    expect(ops).toContain("test.self-close");
    await lib.close();
    expect(existsSync(join(lib.root, ".lock"))).toBe(false);
  });
});

describe("the closing scope belongs to its library (FR-749, R551 M3)", () => {
  it("under the aborted closing signal of ANOTHER library's session, this library's change goes through; under its own, it is refused", async () => {
    kit = await makeKit("ao-closed-scope-");
    const p = await makeProject(kit);
    const other: Library = await createLibrary(join(kit.tmp, "Other"), "Other", { clock: () => new Date(), deviceId: "dev-A", hostname: "host-A", pid: process.pid, isPidAlive: () => true, appConfigDir: join(kit.tmp, "config"), settleMs: 0, setInterval: () => ({}), clearInterval: () => {} });
    onTestFinished(() => other.close());
    const closing = new AbortController();
    closing.abort();
    await whileOpen(other, closing.signal, () => kit!.repo.createCollection(p.id, "Goes through"));
    await expect(whileOpen(other, closing.signal, () => importChange(kit!.repo, p.id, STORE, async () => undefined, { op: "test.other-scope" }))).resolves.toBeUndefined();
    await expect(whileOpen(kit.lib, closing.signal, () => Promise.resolve().then(() => kit!.repo.createCollection(p.id, "Refused")))).rejects.toBeInstanceOf(LibraryClosedError);
    const ops = (await auditEvents(kit, p)).map((e) => e.details?.op);
    expect(ops).toContain("test.other-scope");
  });
});
