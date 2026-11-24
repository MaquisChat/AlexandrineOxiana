/**
 * FR-749, R555 1 and 2: "a change may not close its own library" (R551 M2) is told truly.
 * 1. It is checked BEFORE a second close is handed the first one's promise (R551 M1): a change that calls `close()`
 *    while an outside close waits for that very change is refused, instead of the two waiting on each other for ever.
 * 2. Only the turn that is RUNNING counts: a callback set up inside a change and run after that change ended carries
 *    the change's context, yet it is not inside a change; its `close()` goes through.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { isClosed } from "../library.js";
import { makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { CloseInsideChangeError } from "./errors.js";
import { importChange } from "./repo.js";

const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

let kit: Kit | undefined;
afterEach(async () => {
  await kit?.close().catch(() => {});
  kit = undefined;
});

/** A gate the test opens (also when the test ends, whatever its end). */
function gate(): { p: Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  onTestFinished(() => open());
  return { p, open };
}

describe("a change may not close its own library, told truly (FR-749, R555 1, 2)", () => {
  it("1: an outside close waits for a change; that change then calls close(): refused with the named error; the change ends, the outside close resolves, the lock is gone", async () => {
    kit = await makeKit("ao-close-inside-1-");
    const p = await makeProject(kit);
    const lib = kit.lib;
    const inTurn = gate();
    const outsideStarted = gate();
    let inner: unknown;
    let answered!: () => void;
    const innerAnswered = new Promise<void>((r) => (answered = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const change = importChange(kit.repo, p.id, STORE, async () => {
      entered();
      await outsideStarted.p;
      // The fault is a promise that never settles: the race makes it fail the test instead of hanging it.
      let t: NodeJS.Timeout | undefined;
      inner = await Promise.race([lib.close().then(() => "closed", (err: unknown) => err), new Promise((r) => (t = setTimeout(() => r("still waiting after 1 s"), 1000)))]);
      clearTimeout(t);
      answered();
      await inTurn.p;
    }, { op: "test.close-inside-while-closing" });
    await inside;
    const outside = lib.close();
    outsideStarted.open();
    await innerAnswered;
    expect(inner).toBeInstanceOf(CloseInsideChangeError);
    inTurn.open();
    await change;
    await outside;
    expect(isClosed(lib)).toBe(true);
    expect(existsSync(join(lib.root, ".lock"))).toBe(false);
  });

  it("2: close() from a callback set up inside a change and run after it ended goes through: closed, the lock gone", async () => {
    kit = await makeKit("ao-close-inside-2-");
    const p = await makeProject(kit);
    const lib = kit.lib;
    const g = gate();
    let later!: Promise<unknown>;
    await importChange(kit.repo, p.id, STORE, async () => {
      later = g.p.then(() => lib.close()).then(() => "closed", (err: unknown) => err);
    }, { op: "test.callback-closes-later" });
    g.open();
    expect(await later).toBe("closed");
    expect(isClosed(lib)).toBe(true);
    expect(existsSync(join(lib.root, ".lock"))).toBe(false);
  });

  it("2, the true case: close() inside the running change is still refused, and the library stays open", async () => {
    kit = await makeKit("ao-close-inside-3-");
    const p = await makeProject(kit);
    const lib = kit.lib;
    let refused: unknown;
    await importChange(kit.repo, p.id, STORE, async () => {
      refused = await lib.close().then(() => "closed", (err: unknown) => err);
    }, { op: "test.self-close-again" });
    expect(refused).toBeInstanceOf(CloseInsideChangeError);
    expect(isClosed(lib)).toBe(false);
    expect(existsSync(join(lib.root, ".lock"))).toBe(true);
  });
});
