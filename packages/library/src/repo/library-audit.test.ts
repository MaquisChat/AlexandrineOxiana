import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, openLibrary, type Library } from "../library.js";
import { GovernanceViolationError } from "./errors.js";
import type { Repo } from "./repo.js";
import { openTestRepo } from "./testing.js";

/** Encryption at rest required: an unencrypted project is refused. */
const NEEDS_ENCRYPTION = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
`;
const OPEN = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NOW = "2026-11-09T14:30:00.000Z";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

function deps(): Deps {
  return {
    clock: () => new Date(NOW),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}
const open = (l: Library) => openTestRepo(l, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(NOW), tz: "UTC" });
async function reopen(): Promise<Repo> {
  await lib.close();
  lib = await openLibrary(join(tmp, "Lib"), deps());
  repo = await open(lib);
  return repo;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-libaudit-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await open(lib);
});
afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("Task 50: a refused project creation is audited in the library's audit log", () => {
  it("records who, what and the rule; nothing else is created; it survives a restart", async () => {
    await expect(repo.createProject({ name: "Secret study", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toBeInstanceOf(
      GovernanceViolationError,
    );
    expect((await readdir(join(lib.root, "Projects"))).filter((n) => !n.startsWith("."))).toEqual([]);
    const r = await reopen();
    const { events, verify } = await r.libraryAudit();
    expect(verify.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      at: NOW,
      actor: "tester",
      device: "dev-A",
      action: "store",
      decision: { result: "deny", reason: expect.stringMatching(/encryption/i) },
      details: { op: "project.create", name: "Secret study", encrypted: false },
    });
    expect(events[0]!.projectId).toBeUndefined();
    const raw = await readFile(join(lib.root, "audit", "0001.jsonl"), "utf8");
    expect(raw).not.toContain(tmp);
    expect(r.integrityWarnings).toEqual([]);
  });

  it("an input error is not a refusal and records nothing; an allowed creation records nothing here", async () => {
    await expect(repo.createProject({ name: " ", governanceYaml: OPEN, encryption: { enabled: false } })).rejects.toThrow(/name/);
    await expect(repo.createProject({ name: "E", governanceYaml: OPEN, encryption: { enabled: true, passphrase: "" } })).rejects.toThrow(/passphrase/);
    await repo.createProject({ name: "Fine", governanceYaml: OPEN, encryption: { enabled: false } });
    expect((await repo.libraryAudit()).events).toEqual([]);
  });

  it("a refusal that cannot be recorded is still refused, and the library warns", async () => {
    await writeFile(join(lib.root, "audit"), "not a folder");
    await expect(repo.createProject({ name: "S", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toBeInstanceOf(
      GovernanceViolationError,
    );
    expect(repo.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: "*", kind: "refusal-unrecorded" }));
  });

  it("a library audit log changed outside the app is reported on open; an incomplete last line is trimmed and reported", async () => {
    await expect(repo.createProject({ name: "A", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toThrow();
    await expect(repo.createProject({ name: "B", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toThrow();
    const seg = join(lib.root, "audit", "0001.jsonl");
    await appendFile(seg, '{"seq":3,"half');
    let r = await reopen();
    expect(r.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: "*", kind: "trimmed-incomplete-audit-line", file: "audit/0001.jsonl" }));
    expect((await r.libraryAudit()).events).toHaveLength(2);
    await expect(r.createProject({ name: "C", governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toThrow();
    expect((await r.libraryAudit()).verify).toMatchObject({ ok: true, count: 3 });

    const lines = (await readFile(seg, "utf8")).split("\n");
    lines[0] = lines[0]!.replace('"name":"A"', '"name":"Z"');
    await writeFile(seg, lines.join("\n"));
    r = await reopen();
    expect(r.integrityWarnings).toContainEqual(expect.objectContaining({ projectId: "*", kind: "chain-broken" }));
  });
});
