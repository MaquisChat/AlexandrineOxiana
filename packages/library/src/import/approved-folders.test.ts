/**
 * `approved-import-folders.json` (a writer found by Task 68's wider search, fix round 1): the
 * registry's rule. A read error other than "missing" refuses `rememberApprovedFolders` and writes
 * nothing; damaged content is kept aside as `approved-import-folders.json.corrupt-<stamp>` before a
 * fresh store is written, and a device-level notice says so. Reading stays as it was: anything it
 * cannot read approves nothing (an import then asks again), and reading never writes.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ failRead: undefined as string | undefined }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (io.failRead && String(p).endsWith(io.failRead)) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return (real.readFile as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

import { deviceNoticesIdle, readDeviceNotices } from "../device-notices.js";
import { ApprovedFoldersUnreadableError, approvedFolders, rememberApprovedFolders } from "./approved-folders.js";

const FILE = "approved-import-folders.json";
let dir: string;
let a: string;
let b: string;
const lib = () => ({ id: "L1", appConfigDir: join(dir, "config") });
const cfg = (n: string) => join(dir, "config", n);

beforeEach(async () => {
  io.failRead = undefined;
  dir = await mkdtemp(join(tmpdir(), "ao-approved-"));
  await mkdir(join(dir, "config"));
  a = join(dir, "A");
  b = join(dir, "B");
  await mkdir(a);
  await mkdir(b);
});
afterEach(async () => {
  io.failRead = undefined;
  await deviceNoticesIdle();
  await rm(dir, { recursive: true, force: true });
});

async function snapshot(): Promise<Record<string, string>> {
  const failing = io.failRead;
  io.failRead = undefined;
  const out: Record<string, string> = {};
  for (const n of (await readdir(join(dir, "config"))).sort()) out[n] = await readFile(cfg(n), "utf8").catch(() => "<not a file>");
  io.failRead = failing;
  return out;
}

describe("approved-import-folders.json", () => {
  it("missing on a fresh folder: nothing approved yet; remembering works; two at once both land", async () => {
    expect(await approvedFolders(lib())).toEqual([]);
    await Promise.all([rememberApprovedFolders(lib(), [a]), rememberApprovedFolders(lib(), [b])]);
    expect((await approvedFolders(lib())).length).toBe(2);
  });

  const unreadable: Array<[string, () => Promise<void>]> = [
    [
      "a passing I/O error (the file itself is intact)",
      async () => {
        await writeFile(cfg(FILE), JSON.stringify({ Other: ["/x/y"] }));
        io.failRead = FILE;
      },
    ],
    ["a directory in its place", () => mkdir(cfg(FILE))],
    ["a link that cannot be followed (stands in for no permission when the tests run as root)", () => symlink(cfg(FILE), cfg(FILE))],
  ];
  for (const [what, make] of unreadable) {
    it(`${what}: remembering is refused in plain words (no path) and nothing is written; reading approves nothing`, async () => {
      await make();
      const before = await snapshot();
      const err = await rememberApprovedFolders(lib(), [a]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovedFoldersUnreadableError);
      expect((err as Error).message).toMatch(/folders approved for imports/);
      expect((err as Error).message).not.toContain(dir);
      expect(await approvedFolders(lib())).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });
  }

  for (const [what, content] of [
    ["invalid JSON", "{ nope"],
    ["the wrong shape", "[1, 2]"],
    ["an entry this app cannot use", JSON.stringify({ Other: ["relative/folder"] })],
  ] as const) {
    it(`${what}: kept aside as approved-import-folders.json.corrupt-<stamp>, the new folder written, one notice`, async () => {
      await writeFile(cfg(FILE), content);
      expect(await rememberApprovedFolders(lib(), [a])).toBe(1);
      const kept = (await readdir(join(dir, "config"))).filter((n) => n.startsWith(`${FILE}.corrupt-`));
      expect(kept).toHaveLength(1);
      expect(await readFile(cfg(kept[0]!), "utf8")).toBe(content);
      expect((await approvedFolders(lib())).length).toBe(1);
      await deviceNoticesIdle();
      expect((await readDeviceNotices(join(dir, "config"))).map((n) => n.kind)).toEqual(["approved-folders-list-set-aside"]);
    });
  }
});
