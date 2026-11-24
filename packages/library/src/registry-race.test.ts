/**
 * FR-721 (R503 n): the libraries list is written by the service and by the command line, two processes with no lock
 * between them. A writer compares the list it read with the list as it is just before it saves; on a difference it
 * merges again (a bounded number of times), so a registration another process saved in between is not lost, and a
 * damaged list another process has already set aside does not make its rename fail. Each save is an atomic rename, so
 * the list is never unreadable in between.
 *
 * The other process is played by `other()`, run just after this writer's read of the list (a whole read-modify-write
 * of its own, written as that process would write it).
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ afterRead: undefined as undefined | (() => Promise<void>), reads: [] as string[] }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const readFile = (async (path: unknown, ...rest: unknown[]) => {
    const text = await (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    if (String(path).endsWith("libraries.json")) {
      io.reads.push(String(text));
      const hook = io.afterRead;
      if (hook) await hook();
    }
    return text;
  }) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

import { deviceNoticesIdle, readDeviceNotices } from "./device-notices.js";
import { writeFileAtomic } from "./fs/atomic.js";
import { listLibraries, registerLibrary, type RegistryEntry } from "./registry.js";

let dir: string;
const at = new Date("2026-11-24T10:15:30.000Z");
const deps = () => ({ appConfigDir: dir, clock: () => at });
const entry = (id: string): RegistryEntry => ({ libraryId: id, name: id, lastKnownPaths: [`/libs/${id}`], lastOpenedAt: "2026-11-20T09:00:00.000Z" });
/** What another process's save leaves: the whole list, written atomically. */
const otherSaves = (list: unknown) => writeFileAtomic(join(dir, "libraries.json"), JSON.stringify(list, null, 2));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-registry-race-"));
  io.afterRead = undefined;
  io.reads = [];
});
afterEach(async () => {
  io.afterRead = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("FR-721: two processes writing the libraries list", () => {
  it("a registration another process saves between this writer's read and its save is kept, with this one", async () => {
    await otherSaves([entry("A")]);
    io.afterRead = async () => {
      io.afterRead = undefined; // once: the other process registers B as this writer has just read [A]
      await otherSaves([entry("A"), entry("B")]);
    };
    await registerLibrary({ libraryId: "C", name: "Fieldwork", path: "/libs/C" }, deps());
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["A", "B", "C"]);
    // Every read of the list, the other process's saves included, was a whole list.
    for (const text of io.reads) expect(Array.isArray(JSON.parse(text))).toBe(true);
  });

  it("a damaged list the other process set aside first does not make this writer fail; both registrations and what was usable are kept", async () => {
    await writeFile(join(dir, "libraries.json"), JSON.stringify([entry("A"), { junk: true }]));
    io.afterRead = async () => {
      io.afterRead = undefined; // the other process sets the damaged list aside and saves its own registration
      const { rename } = await import("node:fs/promises");
      await rename(join(dir, "libraries.json"), join(dir, "libraries.json.corrupt-other"));
      await otherSaves([entry("A"), entry("B")]);
    };
    await registerLibrary({ libraryId: "C", name: "Fieldwork", path: "/libs/C" }, deps());
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["A", "B", "C"]);
    // The damaged list is kept once, by the process that set it aside.
    expect((await readdir(dir)).filter((n) => n.includes(".corrupt-"))).toEqual(["libraries.json.corrupt-other"]);
  });

  it("a list that keeps changing under the writer is saved after a bounded number of tries", async () => {
    await otherSaves([entry("A")]);
    let n = 0;
    io.afterRead = async () => {
      io.afterRead = undefined;
      try {
        await otherSaves([entry("A"), entry(`X${++n}`)]);
      } finally {
        io.afterRead = hook;
      }
    };
    const hook = io.afterRead;
    await registerLibrary({ libraryId: "C", name: "Fieldwork", path: "/libs/C" }, deps());
    io.afterRead = undefined;
    const ids = (await listLibraries(deps())).map((e) => e.libraryId);
    expect(ids).toContain("C");
    expect(n).toBeLessThan(20);
  });

  /** Runs `then` once, just after the n-th read of the list (the text of that read is already taken). */
  function afterNthRead(n: number, then: () => Promise<void>): void {
    let reads = 0;
    io.afterRead = async () => {
      if (++reads !== n) return;
      io.afterRead = undefined;
      await then();
    };
  }

  it("a list damaged when first read but good when read again just before it would be set aside is not set aside (R508 M7)", async () => {
    await writeFile(join(dir, "libraries.json"), JSON.stringify([entry("A"), { junk: true }]));
    // Read 1 finds the list damaged, and so does read 2 (the comparison); right after it the other process saves a good
    // list. The read just before the setting aside finds it good.
    afterNthRead(2, () => otherSaves([entry("A"), entry("B")]));
    await registerLibrary({ libraryId: "C", name: "Fieldwork", path: "/libs/C" }, deps());
    await deviceNoticesIdle();
    expect((await readdir(dir)).filter((n) => n.includes(".corrupt-"))).toEqual([]);
    expect(await readDeviceNotices(dir)).toEqual([]);
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["A", "B", "C"]);
  });

  it("a damaged list the other process sets aside between this writer's last read and its rename: no failure, no second copy (R508 M7)", async () => {
    await writeFile(join(dir, "libraries.json"), JSON.stringify([entry("A"), { junk: true }]));
    // Read 3 is the one just before the setting aside: still damaged; right after it the other process sets the list
    // aside itself (its own save comes later), so this writer's rename finds no list.
    afterNthRead(3, async () => {
      const { rename } = await import("node:fs/promises");
      await rename(join(dir, "libraries.json"), join(dir, "libraries.json.corrupt-other"));
    });
    await registerLibrary({ libraryId: "C", name: "Fieldwork", path: "/libs/C" }, deps());
    await deviceNoticesIdle();
    expect((await readdir(dir)).filter((n) => n.includes(".corrupt-"))).toEqual(["libraries.json.corrupt-other"]);
    // The other process raised its own notice; this writer raised none.
    expect(await readDeviceNotices(dir)).toEqual([]);
    // What was usable of the damaged list is kept, with this registration.
    expect((await listLibraries(deps())).map((e) => e.libraryId).sort()).toEqual(["A", "C"]);
  });
});
