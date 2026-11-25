/**
 * FR-769 (R641 A1): a project's lock stop — the signal a project's running imports and attaches carry in their lookup
 * context (`LookupContext.signal`). It is aborted at that project's lock (an encrypted project), with the lock's own
 * refusal as its reason; another project's is untouched; once the project is unlocked again, a new one is given.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PASS, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { importChange } from "./repo.js";
import { ProjectLockedError } from "./errors.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-lock-stop-");
});
afterEach(async () => {
  await kit.close();
});

describe("FR-769: a project's lock stop", () => {
  it("is aborted at the lock of its encrypted project, with ProjectLockedError; another project's is not", async () => {
    const a = await makeProject(kit, undefined, true, "A");
    const b = await makeProject(kit, undefined, true, "B");
    const stopA = kit.repo.lockStopOf(a.id);
    const stopB = kit.repo.lockStopOf(b.id);
    expect(stopA.aborted).toBe(false);
    await kit.repo.lockProject(a.id);
    expect(stopA.aborted).toBe(true);
    expect(stopA.reason).toBeInstanceOf(ProjectLockedError);
    expect((stopA.reason as ProjectLockedError).projectId).toBe(a.id);
    expect(stopB.aborted).toBe(false);
  });

  it("is already aborted while the project is locked, and a fresh one is given once it is unlocked", async () => {
    const a = await makeProject(kit, undefined, true, "A");
    await kit.repo.lockProject(a.id);
    const whileLocked = kit.repo.lockStopOf(a.id);
    expect(whileLocked.aborted).toBe(true);
    expect(whileLocked.reason).toBeInstanceOf(ProjectLockedError);
    await kit.repo.unlockProject(a.id, PASS);
    const after = kit.repo.lockStopOf(a.id);
    expect(after.aborted).toBe(false);
    await kit.repo.lockProject(a.id);
    expect(after.aborted).toBe(true);
  });

  it("is never aborted for a project that is not encrypted (it has nothing to lock)", async () => {
    const p = await makeProject(kit);
    const stop = kit.repo.lockStopOf(p.id);
    await kit.repo.lockProject(p.id).catch(() => {});
    expect(stop.aborted).toBe(false);
  });

  async function askedInsidePendingLock(encrypted: boolean): Promise<AbortSignal | undefined> {
    const a = await makeProject(kit, undefined, encrypted, "A");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let stopInside: AbortSignal | undefined;
    const done = importChange(kit.repo, a.id, { action: "store", store: { identifiable: false, hasLocation: false } }, async () => {
      entered();
      await gate;
      stopInside = kit.repo.lockStopOf(a.id); // the lock below is pending: it waits for this turn
    }, { op: "test.lock-stop" });
    await inside;
    const locked = kit.repo.lockProject(a.id);
    release();
    await done;
    await locked.catch(() => {});
    return stopInside;
  }

  it("asked inside the write turn a pending lock waits for (the key still visible there): already aborted, no stop is made that the lock never aborts", async () => {
    const stop = await askedInsidePendingLock(true);
    expect(stop?.aborted).toBe(true);
    expect(stop?.reason).toBeInstanceOf(ProjectLockedError);
  });

  it("the same for a project that is not encrypted: its stop is not aborted", async () => {
    expect((await askedInsidePendingLock(false))?.aborted).toBe(false);
  });
});
