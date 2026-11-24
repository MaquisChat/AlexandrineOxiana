/**
 * R509 (FR-736): an interrupted change whose undo can never complete (the copy the app kept of a file it removed is
 * gone) can be CLOSED as it is from the list of interrupted changes: decided by the policy engine, audited in the
 * project's log as the list's other choice is (`txn.resolve`), the marker retired, the project taking changes again,
 * nothing deleted, and a warning saying what was lost. Never for a cause that may pass or that the researcher can
 * remove; nothing in a read-only library.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, Provenance, SourceDraft } from "@ao/core";
import { INCOMPLETE_ROLLBACK_BANNER } from "@ao/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import type { Tx } from "./mutate.js";
import { NotFoundError, PendingWriteChoiceError, PendingWriteIncompleteError, PolicyDeniedError, ReadOnlyLibraryError } from "./errors.js";
import { SimulatedCrash, openTestRepo, seams } from "./testing.js";
import { fromRel, type TxnMarker } from "./txn.js";

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";
const PDF = "%PDF-1.7\nhello\n%%EOF\n";
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const HAND = "a file put here by hand\n";
const ORIGINAL = "the researcher's original\n";
const OWN = "the change's own file\n";
/** Sentence 25 (R528 M2: no circle back to "Roll it back"): the refusal to close while the app still keeps a copy of the change. */
const COPIES_LEFT_TEXT =
  "This change cannot be closed: the app still keeps a copy of a file it could not put back, and closing would let that copy go. Restoring the project from a backup made before the change is the way to undo it.";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let pid: string;
let sid: string;
let folder: string;

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

const markers = async () => (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => /^txn-.*\.json$/u.test(n));
const readMarker = async (): Promise<TxnMarker> => JSON.parse(await readFile(join(lib.root, ".tmp", (await markers())[0]!), "utf8")) as TxnMarker;
const text = (rel: string) => readFile(fromRel(lib.root, rel), "utf8").catch(() => null);
const reopen = async () => {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
};
async function auditOf(): Promise<AuditEvent[]> {
  const dir = join(lib.root, folder.split("/").slice(0, 2).join("/"), "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) if (l.trim()) out.push(JSON.parse(l) as AuditEvent);
  return out;
}
/** Every file under the library but its work folder, with its bytes: what closing must leave as it is. */
async function snapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(lib.root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      // The kept warnings' record (R527: at the library's root) is written by closing: it says what was closed.
      if (r === ".tmp" || r === ".lock" || r.startsWith(".cache") || r.endsWith("/audit") || r === "audit" || r === "recovery-warnings.json") continue;
      if (e.isDirectory()) await walk(r);
      else out.set(r, await readFile(join(lib.root, r), "utf8").catch(() => "?"));
    }
  };
  await walk("");
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-r509close-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  await writeFile(join(tmp, "in.pdf"), PDF);
  await writeFile(join(tmp, "src.txt"), ORIGINAL);
  repo = await repoFor();
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
  const sf = await repo.createSource(pid, draft("Annotated"), [{ path: join(tmp, "in.pdf"), role: "original", handling: "copy" }], { provenance: provenance() });
  sid = sf.source.id;
  folder = sf.source.folder;
});
afterEach(async () => {
  seams.crashAt = undefined;
  seams.failUndo = undefined;
  seams.failLook = undefined;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function crashed(fn: (tx: Tx) => Promise<void>): Promise<TxnMarker> {
  seams.crashAt = "before-audit";
  await expect(repo.mutate(pid, STORE, fn)).rejects.toBeInstanceOf(SimulatedCrash);
  seams.crashAt = undefined;
  return readMarker();
}

/** The original trashed, the change's own file written at its place, the kept copy deleted by hand; reopened. */
async function lost(after?: () => Promise<void>): Promise<{ m: TxnMarker; rel: string }> {
  const rel = `${folder}/kept.txt`;
  await writeFile(fromRel(lib.root, rel), ORIGINAL);
  const m = await crashed(async (tx) => {
    await tx.trash(rel);
    await tx.writeFile(rel, OWN);
  });
  await rm(fromRel(lib.root, (m.entries[0] as { to: string }).to), { recursive: true, force: true });
  await after?.();
  await reopen();
  return { m, rel };
}

describe("R509: which acts the list offers, by cause", () => {
  it("the kept copy gone (never completable): roll back AND close, with what is lost and what is at its place now, and the source", async () => {
    const { m, rel } = await lost();
    expect(await repo.pendingWrites()).toEqual([
      expect.objectContaining({ txn: m.txn, canRollBack: true, canClose: true, rollback: "unconfirmed", lost: [{ path: rel, now: "a file", sourceId: sid }] }),
    ]);
  });

  it("nothing at its place now: said so", async () => {
    const { rel } = await lost(async () => rm(fromRel(lib.root, `${folder}/kept.txt`)));
    expect((await repo.pendingWrites())[0]).toMatchObject({ canClose: true, rollback: "lost", lost: [{ path: rel, now: "nothing", sourceId: sid }] });
  });

  it("a file in the way (removable) or a step that may pass: no close", async () => {
    const rel = `${folder}/copied.txt`;
    await crashed(async (tx) => {
      await tx.copyFile(join(tmp, "src.txt"), rel);
    });
    await writeFile(fromRel(lib.root, rel), HAND);
    await reopen();
    expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: "in-the-way", canRollBack: true, canClose: false });
    // The hand file moved away, and a step of the undo failing for no named cause: it may pass when tried again.
    await rm(fromRel(lib.root, rel));
    seams.failUndo = "created";
    await reopen();
    expect((await repo.pendingWrites())[0]).toMatchObject({ rollback: "try-again", canClose: false });
  });

  it("a read-only library offers nothing, and refuses a close", async () => {
    const { m } = await lost();
    // Opened on another computer while this one holds it: read-only there.
    const roLib = await openLibrary(lib.root, mkDeps({ deviceId: "dev-B", hostname: "host-B", pid: 99 }));
    const ro = await openTestRepo(roLib, ring, { clock: () => new Date(NOW), tz: "UTC" });
    expect((await ro.pendingWrites())[0]).toMatchObject({ canRollBack: false, canClose: false });
    await expect(ro.closePendingWrite(m.txn, pid)).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    await roLib.close();
    expect(await markers()).toEqual([`txn-${m.txn}.json`]);
  });
});

describe("R509: closing a change whose undo can never complete", () => {
  it("retires the marker, is audited with what could not be put back, unblocks writes, deletes nothing, and says what was lost", async () => {
    const { m, rel } = await lost();
    const before = await snapshot();
    await expect(repo.mutate(pid, STORE, async () => undefined)).rejects.toThrow(/refuses changes/u);
    expect(await repo.closePendingWrite(m.txn, pid)).toEqual({ txn: m.txn, projectId: pid });
    expect(await markers()).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await text(rel)).toBe(OWN);
    const resolve = (await auditOf()).filter((e) => e.action === "txn.resolve");
    expect(resolve).toHaveLength(1);
    expect(resolve[0]!.details).toMatchObject({ txn: m.txn, choice: "close", notPutBack: [rel] });
    expect(resolve[0]!.decision).toEqual({ result: "allow" });
    const mine = repo.integrityWarnings.filter((w) => w.projectId === pid);
    expect(mine.map((w) => w.kind)).toEqual(["interrupted-change-closed"]);
    // R527: a file stood at the place: the warning never says the file is lost (its state), now and at the next opening.
    expect(mine[0]!.rollback).toBe("unconfirmed");
    expect(await repo.pendingWrites()).toEqual([]);
    // The project takes changes again, now and after a reopen.
    await repo.mutate(pid, STORE, async (tx) => tx.writeFile(`${folder}/after.txt`, "a later change\n"));
    await reopen();
    expect(await markers()).toEqual([]);
    expect(await text(rel)).toBe(OWN);
    expect(repo.integrityWarnings.filter((w) => w.projectId === pid).map((w) => [w.kind, w.rollback])).toEqual([["interrupted-change-closed", "unconfirmed"]]);
    await repo.mutate(pid, STORE, async (tx) => tx.writeFile(`${folder}/after-2.txt`, "and another\n"));
  });

  it("R527: nothing at the place: closed, and its warning says the file is lost (no state), now and at the next opening", async () => {
    const { m } = await lost(async () => rm(fromRel(lib.root, `${folder}/kept.txt`)));
    await repo.closePendingWrite(m.txn, pid);
    const closed = () => repo.integrityWarnings.filter((w) => w.projectId === pid && w.kind === "interrupted-change-closed");
    expect(closed().map((w) => w.rollback)).toEqual([undefined]);
    await reopen();
    expect(closed().map((w) => w.rollback)).toEqual([undefined]);
  });

  it("refused by the project's rules (they cannot be read: fail closed): everything as it was, the refusal in the library's log", async () => {
    const { m } = await lost();
    await writeFile(join(lib.root, folder.split("/").slice(0, 2).join("/"), "governance.yaml"), "identifiability: [not: valid");
    const marker = await readFile(join(lib.root, ".tmp", `txn-${m.txn}.json`), "utf8");
    const before = await snapshot();
    const projectAudit = await auditOf();
    await expect(repo.closePendingWrite(m.txn, pid)).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await readFile(join(lib.root, ".tmp", `txn-${m.txn}.json`), "utf8")).toBe(marker);
    expect(await snapshot()).toEqual(before);
    expect(await auditOf()).toEqual(projectAudit);
    const library = (await repo.libraryAudit()).events.filter((e) => e.action === "close-change");
    expect(library).toHaveLength(1);
    expect(library[0]!.decision?.result).toBe("deny");
    expect((await repo.pendingWrites())[0]).toMatchObject({ txn: m.txn, canClose: true });
    await expect(repo.mutate(pid, STORE, async () => undefined)).rejects.toThrow(/refuses changes/u);
  });

  it("refused for a cause that may pass or that the researcher can remove: nothing changes", async () => {
    const rel = `${folder}/copied.txt`;
    const m = await crashed(async (tx) => {
      await tx.copyFile(join(tmp, "src.txt"), rel);
    });
    await writeFile(fromRel(lib.root, rel), HAND);
    await reopen();
    const marker = await readFile(join(lib.root, ".tmp", `txn-${m.txn}.json`), "utf8");
    const err = await repo.closePendingWrite(m.txn, pid).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PendingWriteChoiceError);
    expect((err as Error).message).toBe("Only a change that can never be undone completely can be closed as it is; this one can still be rolled back.");
    expect(await readFile(join(lib.root, ".tmp", `txn-${m.txn}.json`), "utf8")).toBe(marker);
    expect(await text(rel)).toBe(HAND);
  });

  it("R528 I3 (probe P5): a folder whose kept copy is gone while a file inside it keeps its copy: never closed, and the inner copy outlives a reopen", async () => {
    const dir = `${folder}/D`;
    const inner = `${dir}/x.txt`;
    const INNER = "inner original\n";
    await mkdir(fromRel(lib.root, dir));
    await writeFile(fromRel(lib.root, inner), INNER);
    const m = await crashed(async (tx) => {
      await tx.trash(inner);
      await tx.trash(dir);
    });
    const innerCopy = (m.entries[0] as { to: string }).to;
    await rm(fromRel(lib.root, (m.entries[1] as { to: string }).to), { recursive: true, force: true });
    await reopen();
    // The causes name only the folder; the file inside it keeps its copy, which cannot be put back without the folder.
    expect((await repo.pendingWrites())[0]).toMatchObject({ txn: m.txn, canRollBack: true, canClose: false, rollback: "lost-copy-stuck", causes: [{ kind: "kept-copy-gone", path: dir }] });
    // R528 M2: the banner says what is true and points at no act that is not offered: a backup is the way.
    const w = repo.integrityWarnings.filter((x) => x.projectId === pid && x.kind === "rolled-back-incomplete-write");
    expect(w.map((x) => x.rollback)).toEqual(["lost-copy-stuck"]);
    expect(INCOMPLETE_ROLLBACK_BANNER[w[0]!.rollback!]("P")).toBe(
      "An interrupted change in P cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. The app still keeps a copy of another file of the change, which it cannot put back either, and closing the change would let that copy go, so it cannot be closed. Changes to P are off. Restoring the project from a backup made before the change is the way to undo it.",
    );
    // "Roll it back" answers the same, without sending the researcher round again.
    const back = await repo.resolvePendingWrite(m.txn, "roll-back").then(
      () => null,
      (e: unknown) => e,
    );
    expect((back as Error).message).toBe(
      "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and the app keeps a copy of another file of the change, which it cannot put back either. Restoring the project from a backup made before the change is the way to undo it.",
    );
    const marker = await readFile(join(lib.root, ".tmp", `txn-${m.txn}.json`), "utf8");
    const err = await repo.closePendingWrite(m.txn, pid).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PendingWriteIncompleteError);
    expect((err as Error).message).toBe(COPIES_LEFT_TEXT);
    expect(await readFile(join(lib.root, ".tmp", `txn-${m.txn}.json`), "utf8")).toBe(marker);
    expect(await readFile(fromRel(lib.root, innerCopy), "utf8")).toBe(INNER);
    await reopen();
    expect(await markers()).toEqual([`txn-${m.txn}.json`]);
    expect(await readFile(fromRel(lib.root, innerCopy), "utf8")).toBe(INNER);
    expect((await repo.pendingWrites())[0]).toMatchObject({ canClose: false });
  });

  it("named with another project, or an unknown change: not found", async () => {
    const { m } = await lost();
    const other = (await repo.createProject({ name: "Q", governanceYaml: OPEN_GOV, encryption: { enabled: false } }).catch(() => null))?.project.id ?? "019a7000-0000-7000-8000-0000000000ee";
    await expect(repo.closePendingWrite(m.txn, other)).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.closePendingWrite("019a7000-0000-7000-8000-0000000000ff", pid)).rejects.toBeInstanceOf(NotFoundError);
    expect(await markers()).toEqual([`txn-${m.txn}.json`]);
  });
});
