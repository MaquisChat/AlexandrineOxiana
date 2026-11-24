/**
 * R532 M5 (a): a project held ONLY because an unfinished last line of its audit log could not be trimmed at a writable
 * opening (no interrupted change exists) refuses a write with the "opened again" reason, which the service says as
 * "This project takes no changes until the library is opened again. The warning on the library's main screen says
 * why."; the warning shown for that hold says that the next opening tidies it up.
 */
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import type { Repo } from "./index.js";
import { RecoveryPendingError } from "./errors.js";
import { openTestRepo } from "./testing.js";

/** Makes the trim of an unfinished last line fail, as a permission or I/O error would (this file only). */
const trim = vi.hoisted(() => ({ fail: false }));
vi.mock("./io.js", async (orig) => {
  const m = await orig<typeof import("./io.js")>();
  return {
    ...m,
    truncateDurable: async (...a: Parameters<typeof m.truncateDurable>) => {
      if (trim.fail) throw new Error("simulated trim failure");
      return m.truncateDurable(...a);
    },
  };
});

const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-11T10:00:00.000Z";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let pid: string;

const mkDeps = (): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});
const repoFor = (): Promise<Repo> => openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: 2 ** 10 });
const reopen = async () => {
  await lib.close();
  lib = await openLibrary(lib.root, mkDeps());
  repo = await repoFor();
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-r532m5-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  repo = await repoFor();
  pid = (await repo.createProject({ name: "P", governanceYaml: OPEN_GOV, encryption: { enabled: false } })).project.id;
});
afterEach(async () => {
  trim.fail = false;
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("R532 M5 (a): a hold that only opening the library again lifts", () => {
  it("an unfinished audit line that could not be trimmed: the write is refused as \"opened again\", and its warning says the next opening tidies it up", async () => {
    const audit = join(lib.root, repo.getProject(pid).folder, "audit");
    const [last] = (await readdir(audit)).sort().reverse();
    await appendFile(join(audit, last!), '{"seq":99,"torn');
    trim.fail = true;
    await reopen();
    const w = repo.integrityWarnings.filter((x) => x.projectId === pid);
    expect(w.map((x) => x.kind)).toEqual(["incomplete-audit-line-pending"]);
    expect(w[0]!.detail).toMatch(/could not be removed \(simulated trim failure\) and is left in place$/u);
    const err = await repo.createCollection(pid, "x").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecoveryPendingError);
    // No interrupted change holds it: the reason is "opened again" (the service's sentence for it, R530).
    expect((err as RecoveryPendingError).reason).toBe("reopen");
    expect(await repo.pendingWrites()).toEqual([]);
    // Opened again with the trim working: tidied up, and the project takes changes.
    trim.fail = false;
    await reopen();
    expect(repo.integrityWarnings.filter((x) => x.projectId === pid).map((x) => x.kind)).toEqual(["trimmed-incomplete-audit-line"]);
    await expect(repo.createCollection(pid, "x")).resolves.toBeDefined();
  });
});
