/**
 * `watched-folders.json` follows the registry's rule (Task 68 fix round 1, I1; R178 a): a read
 * error other than "missing" refuses and writes nothing; only damaged CONTENT is kept aside (as
 * `watched-folders.json.corrupt-<stamp>`), and only once that succeeded is a fresh store written;
 * a device-level notice tells the researcher.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ failRead: undefined as string | undefined, failRename: false }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (io.failRead && String(p).endsWith(io.failRead)) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return (real.readFile as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readFile;
  const rename = (async (from: unknown, to: unknown) => {
    if (io.failRename && String(from).endsWith("watched-folders.json")) throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
    return real.rename(from as string, to as string);
  }) as typeof real.rename;
  return { ...real, default: { ...real, readFile, rename }, readFile, rename };
});

import type { Project } from "@ao/core";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { deviceNoticesIdle, readDeviceNotices } from "../device-notices.js";
import { createLibrary, type Library } from "../library.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { WatchedFoldersUnreadableError, addWatchedFolder, listWatchedFolders, removeWatchedFolder, setWatchFolder } from "./watch.js";

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
let repo: Repo;
let ring: KeyRing;
let inbox: string;
const cfg = (n: string) => join(tmp, "config", n);
const FILE = "watched-folders.json";
const OTHER = { otherLib: { p1: { w9: "/some/folder" } } };

const deps = (): Deps => ({
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

beforeEach(async () => {
  io.failRead = undefined;
  io.failRename = false;
  tmp = await mkdtemp(join(tmpdir(), "ao-watch-settings-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
  inbox = join(tmp, "Inbox");
  await mkdir(inbox);
});
afterEach(async () => {
  io.failRead = undefined;
  io.failRename = false;
  await deviceNoticesIdle();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

const project = async (): Promise<Project> => (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } })).project;

async function snapshot(): Promise<Record<string, string>> {
  const failing = io.failRead;
  io.failRead = undefined;
  const out: Record<string, string> = {};
  for (const n of (await readdir(join(tmp, "config"))).sort()) out[n] = await readFile(cfg(n), "utf8").catch(() => "<not a file>");
  io.failRead = failing;
  return out;
}

describe("watched-folders.json: a read error refuses and writes nothing", () => {
  const unreadable: Array<[string, () => Promise<void>]> = [
    [
      "a passing I/O error (the file itself is intact)",
      async () => {
        await writeFile(cfg(FILE), JSON.stringify(OTHER));
        io.failRead = FILE;
      },
    ],
    ["a directory in its place", () => mkdir(cfg(FILE))],
    ["a link that cannot be followed (stands in for no permission when the tests run as root)", () => symlink(cfg(FILE), cfg(FILE))],
  ];
  for (const [what, make] of unreadable) {
    it(`${what}: add, set, remove and list refuse in plain words (no path); nothing is moved or written`, async () => {
      const p = await project();
      const wf = await addWatchedFolder({ repo, lib }, p.id, inbox);
      await rm(cfg(FILE));
      await make();
      const before = await snapshot();
      const warnings: string[] = [];
      const d = { repo, lib, onWarning: (w: string) => warnings.push(w) };
      for (const op of [() => addWatchedFolder(d, p.id, inbox), () => setWatchFolder(d, p.id, wf.id, inbox), () => listWatchedFolders(d, p.id), () => removeWatchedFolder(d, p.id, wf.id)]) {
        const err = await op().catch((e: unknown) => e);
        expect(err, what).toBeInstanceOf(WatchedFoldersUnreadableError);
        expect((err as Error).message).toMatch(/list of watched folders/);
        expect((err as Error).message).not.toContain(tmp);
      }
      expect(await snapshot()).toEqual(before);
      expect(warnings).toEqual([]);
      await deviceNoticesIdle();
      expect(await readDeviceNotices(join(tmp, "config"))).toEqual([]);
    });
  }
});

describe("watched-folders.json: damaged content is kept aside, then a fresh store, and the researcher is told", () => {
  const damaged: Array<[string, string]> = [
    ["invalid JSON", "{ not json"],
    ["a truncated file", JSON.stringify(OTHER).slice(0, 15)],
    ["the wrong shape", JSON.stringify(["a"])],
    ["an entry this app cannot use (a relative folder)", JSON.stringify({ otherLib: { p1: { w9: "relative/folder" } } })],
  ];
  for (const [what, content] of damaged) {
    it(`${what}: kept aside as watched-folders.json.corrupt-<stamp>; the new entry written; one notice raised`, async () => {
      const p = await project();
      await mkdir(join(tmp, "config"), { recursive: true });
      await writeFile(cfg(FILE), content);
      const warnings: string[] = [];
      const wf = await addWatchedFolder({ repo, lib, onWarning: (w) => warnings.push(w) }, p.id, inbox);
      await listWatchedFolders({ repo, lib }, p.id);
      const kept = (await readdir(join(tmp, "config"))).filter((n) => n.startsWith("watched-folders.json.corrupt-"));
      expect(kept).toHaveLength(1);
      expect(await readFile(cfg(kept[0]!), "utf8")).toBe(content);
      expect(await readFile(cfg(FILE), "utf8")).toContain(wf.id);
      expect(warnings).toHaveLength(1);
      await deviceNoticesIdle();
      expect((await readDeviceNotices(join(tmp, "config"))).map((n) => n.kind)).toEqual(["watched-folders-list-set-aside"]);
    });
  }

  it("when the damaged file cannot be set aside, nothing is written over it and the change is refused", async () => {
    const p = await project();
    await mkdir(join(tmp, "config"), { recursive: true });
    await writeFile(cfg(FILE), "{ not json");
    io.failRename = true;
    const err = await addWatchedFolder({ repo, lib }, p.id, inbox).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WatchedFoldersUnreadableError);
    expect(await readFile(cfg(FILE), "utf8")).toBe("{ not json");
  });

  it("missing on a fresh folder: nothing yet, and an add works; two changes at once both land", async () => {
    const p = await project();
    const second = join(tmp, "Inbox2");
    await mkdir(second);
    const [a, b] = await Promise.all([addWatchedFolder({ repo, lib }, p.id, inbox), addWatchedFolder({ repo, lib }, p.id, second)]);
    const listed = await listWatchedFolders({ repo, lib }, p.id);
    expect(listed.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
    expect(listed.every((w) => typeof w.dir === "string")).toBe(true);
    await deviceNoticesIdle();
    expect(await readDeviceNotices(join(tmp, "config"))).toEqual([]);
  });
});
