/**
 * R82 (1): a missing anchor must not hide tampering. A log holding events written by this device,
 * with no anchor for the project, is 'anchor-missing'; a log with no events is never valid.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { openTestRepo } from "./testing.js";

const FAST = 2 ** 10;
let tmp: string;
let ring: KeyRing;

const deps = (deviceId = "dev-A"): Deps => ({
  clock: () => new Date(),
  deviceId,
  hostname: "host",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, `config-${deviceId}`),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-anchor-"));
  ring = new KeyRing();
});
afterEach(async () => {
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; projectId: string; folder: string }> {
  const lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  const repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "t" });
  const { project } = await repo.createProject({ name: "P", governanceYaml: "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n", encryption: { enabled: false } });
  await repo.createCollection(project.id, "A");
  await repo.createCollection(project.id, "B");
  await lib.close();
  return { root: lib.root, projectId: project.id, folder: project.folder };
}

async function open(root: string, deviceId = "dev-A", noHeal = false): Promise<{ lib: Library; repo: Awaited<ReturnType<typeof openTestRepo>> }> {
  const lib = await openLibrary(root, deps(deviceId));
  const repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "t", ...(noHeal ? { noHeal: true } : {}) });
  return { lib, repo };
}

async function segments(root: string, folder: string): Promise<string[]> {
  const d = join(root, folder, "audit");
  return (await readdir(d)).sort().map((f) => join(d, f));
}

describe("missing anchor (R82)", () => {
  it("truncated log + deleted anchors: verify fails; a normal open warns and audits anchor-missing; verify then reports it", async () => {
    const { root, projectId, folder } = await setup();
    const [seg] = await segments(root, folder);
    const lines = (await readFile(seg!, "utf8")).split("\n").filter(Boolean);
    await writeFile(seg!, `${lines.slice(0, -1).join("\n")}\n`);
    await rm(join(tmp, "config-dev-A", "audit-anchors.json"));

    let o = await open(root, "dev-A", true);
    let r = await o.repo.verifyAudit(projectId);
    expect(r).toMatchObject({ ok: false, anchored: false, problem: { kind: "anchor-missing" } });
    await o.lib.close();

    o = await open(root);
    expect(o.repo.integrityWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ projectId, kind: "anchor-missing" })]));
    await o.lib.close();
    const audit = await readFile((await segments(root, folder)).at(-1)!, "utf8");
    expect(audit).toContain('"action":"audit.anchor-missing"');

    o = await open(root, "dev-A", true);
    r = await o.repo.verifyAudit(projectId);
    expect(r.ok).toBe(false);
    expect(r.anchored).toBe(true);
    expect(r.alteredAt).toHaveLength(1);
    await o.lib.close();
  });

  it("an empty log is never valid, anchored or not", async () => {
    const { root, projectId, folder } = await setup();
    for (const f of await segments(root, folder)) await writeFile(f, "");
    await rm(join(tmp, "config-dev-A", "audit-anchors.json"));
    const o = await open(root, "dev-A", true);
    expect(await o.repo.verifyAudit(projectId)).toMatchObject({ ok: false, events: 0, problem: { kind: "empty" } });
    await o.lib.close();
  });

  it("a log this device never wrote to, with no anchor here: unverified, not a problem", async () => {
    const { root, projectId } = await setup();
    const o = await open(root, "dev-B", true);
    expect(await o.repo.verifyAudit(projectId)).toMatchObject({ ok: true, anchored: false });
    expect(o.repo.integrityWarnings).toEqual([]);
    await o.lib.close();
  });
});
