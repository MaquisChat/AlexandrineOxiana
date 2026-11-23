/**
 * FR-420 (Ruling R469 b i): the integrity check the service's route makes reads outside the write queue, so a change
 * in progress (a destruction between moving a file away and writing source.json) can make a file look missing.
 * Given a way into the write queue (`confirm`), each FLAGGED entry is read again in the queue's turn against a fresh
 * read of its source, and only what is still wrong is reported. Changes are held open with the NODE_ENV=test seam in
 * writeSourceFile (R47); nothing here sleeps.
 */
import { createReadStream } from "node:fs";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project, SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PSEUDO_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { checkIntegrity, type IntegrityReport } from "./reconnect.js";
import { writeQueueTurn } from "./repo/repo.js";
import { pauseBetweenSourceFilesForTests } from "./repo/sources.js";
import { destroyRaw } from "./retention.js";

const RETAIN = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;
const RETAIN_SEALED = `${PSEUDO_GOV}retention:
  rawDataDestroyAfter: 2026-12-01
`;

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-fr420-");
});
afterEach(async () => {
  pauseBetweenSourceFilesForTests(undefined);
  await kit.close();
});

async function rawSource(p: Project, title: string): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", `RAW interview audio bytes of ${title}`);
  return addSource(kit, p, { type: "interview", title, identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

/** Holds the next source write between its annotations file and source.json (the first one only). */
function holdNextSourceWrite() {
  let release!: () => void;
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const open = new Promise<void>((r) => (release = r));
  let first = true;
  pauseBetweenSourceFilesForTests(async () => {
    if (!first) return;
    first = false;
    reach();
    await open;
  });
  return { reached, release };
}

/** The repo's way into the write queue, noting when the check first asks for a turn. */
function confirmNoting() {
  const turn = writeQueueTurn(kit.repo);
  let asked!: () => void;
  const askedOnce = new Promise<void>((r) => (asked = r));
  let asks = 0;
  return {
    askedOnce,
    asks: () => asks,
    confirm: <T,>(fn: () => Promise<T>): Promise<T> => {
      asks++;
      asked();
      return turn(fn);
    },
  };
}

/** Lets every callback already due run (no timer: the queue's turn is still held, so nothing else can finish). */
const drain = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const ids = (entries: IntegrityReport["missing"]) => entries.map((e) => e.assetId).sort();

describe("FR-420: a finding of the integrity check is confirmed in the write queue's turn", () => {
  it("a destruction in progress at the moment of the check gives no false finding; the check waits for the turn, then answers", async () => {
    const p = await makeProject(kit, RETAIN);
    const sf = await rawSource(p, "Interview one");
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    const hold = holdNextSourceWrite();
    const destruction = destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    await hold.reached;
    // The file is gone; source.json still lists it. Read outside the queue, that looks missing.
    expect(ids((await checkIntegrity(kit.lib, "full", { keyRing: kit.ring })).missing)).toEqual([sf.assets[0]!.id]);
    const c = confirmNoting();
    let settled = false;
    const check = checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm }).finally(() => (settled = true));
    await Promise.race([c.askedOnce, check]);
    expect(c.asks()).toBe(1);
    await drain();
    expect(settled).toBe(false); // waiting for the turn the destruction holds
    hold.release();
    await destruction;
    const report = await check;
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(c.asks()).toBe(1);
  });

  it("a real finding is still reported, beside a passing one and a false one, in one check; unflagged entries are not read again", async () => {
    const p = await makeProject(kit, RETAIN);
    const gone = await rawSource(p, "Removed outside the app");
    const changed = await rawSource(p, "Changed outside the app");
    const fine = await rawSource(p, "Untouched");
    const destroyed = await rawSource(p, "Being destroyed");
    // Two real problems made outside the app: a file removed, and a file changed in place (same size, other bytes).
    await rm(join(kit.lib.root, gone.assets[0]!.path));
    const changedAbs = join(kit.lib.root, changed.assets[0]!.path);
    const bytes = await readFile(changedAbs);
    bytes[0] = bytes[0]! ^ 0xff;
    await writeFile(changedAbs, bytes);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    const hold = holdNextSourceWrite();
    const destruction = destroyRaw(kit.repo, p.id, [destroyed.assets[0]!.id], "tester");
    await hold.reached;
    const c = confirmNoting();
    let stats = 0;
    let opened = 0;
    const check = checkIntegrity(kit.lib, "full", {
      keyRing: kit.ring,
      confirm: c.confirm,
      stat: (p) => (stats++, lstat(p)),
      openRead: (p) => (opened++, createReadStream(p)),
    });
    await Promise.race([c.askedOnce, check]);
    expect(c.asks()).toBe(1);
    hold.release();
    await destruction;
    const report = await check;
    expect(ids(report.missing)).toEqual([gone.assets[0]!.id]);
    expect(ids(report.mismatched)).toEqual([changed.assets[0]!.id]);
    expect(report.hashedAssetIds.sort()).toEqual([changed.assets[0]!.id, fine.assets[0]!.id].sort());
    expect(c.asks()).toBe(1);
    // Each of the four files looked at once; in the turn only the flagged ones are looked at again (the destroyed one
    // not even that: its fresh record no longer expects a file); nothing is hashed twice.
    expect(report.checked).toBe(4);
    expect(stats).toBe(4 + 2);
    expect(opened).toBe(report.hashed);
  });

  it("with nothing flagged the queue is not entered; without `confirm` the check is as before", async () => {
    const p = await makeProject(kit, RETAIN);
    await rawSource(p, "Untouched");
    const c = confirmNoting();
    const report = await checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm });
    expect(report.missing).toEqual([]);
    expect(c.asks()).toBe(0);
  });

  it("a lock landing while the check waits for the turn ends it as a locked project's check: no hang, no finding", async () => {
    const p = await makeProject(kit, RETAIN_SEALED, true);
    const sf = await rawSource(p, "Sealed interview");
    await rawSource(p, "Another");
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    const hold = holdNextSourceWrite();
    const destruction = destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    await hold.reached;
    const c = confirmNoting();
    const check = checkIntegrity(kit.lib, "full", { keyRing: kit.ring, confirm: c.confirm });
    await Promise.race([c.askedOnce, check]);
    expect(c.asks()).toBe(1);
    const lock = kit.repo.lockProject(p.id); // goes next, ahead of the check's turn (R379)
    hold.release();
    await destruction;
    await lock;
    const report = await check;
    expect(report.missing).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.errors).toEqual([]);
    // What a check of the project locked from the start gives: presence only.
    expect(report).toEqual(await checkIntegrity(kit.lib, "full", { keyRing: kit.ring }));
    expect(report.presenceOnly).toBeGreaterThan(0);
  });
});
