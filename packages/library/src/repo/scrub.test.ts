/**
 * Task 50 round 3 (R2): only text the system produced from an error is scrubbed of absolute paths,
 * where that error is captured; what the researcher typed is recorded exactly as typed.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { PolicyDeniedError } from "./errors.js";
import type { Repo } from "./repo.js";
import { openTestRepo } from "./testing.js";

const NOW = "2026-11-09T14:30:00.000Z";
const OPEN = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;
const NEEDS_ENCRYPTION = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
`;

let tmp: string;
let lib: Library;
let repo: Repo;
const ring = new KeyRing();

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
async function events(folder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) for (const l of (await readFile(join(dir, f), "utf8")).split("\n")) if (l.trim()) out.push(JSON.parse(l) as AuditEvent);
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-scrub-"));
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", clock: () => new Date(NOW), tz: "UTC" });
});
afterEach(async () => {
  await lib.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("R2: the researcher's own text is recorded exactly as typed", () => {
  it("a refused project's name with slashes, and same-day dropping still works for it", async () => {
    const name = "Interviews /Berlin/2025 and folder /data/raw interviews";
    for (let i = 0; i < 3; i++) await expect(repo.createProject({ name, governanceYaml: NEEDS_ENCRYPTION, encryption: { enabled: false } })).rejects.toThrow();
    const { events: ev } = await repo.libraryAudit();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details?.name).toBe(name);
  });

  it("a set-aside reason with slashes", async () => {
    const p = (await repo.createProject({ name: "P", governanceYaml: OPEN, encryption: { enabled: false } })).project;
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(lib.root, p.folder, "attention"), { recursive: true });
    await writeFile(join(lib.root, p.folder, "attention", "stray.txt"), "x");
    const id = (await repo.attentionMarks(p.id))[0]!.id;
    const reason = "Copied from /Volumes/Field Drive/2025 by hand; see /data/raw notes";
    await repo.setAsideMark(p.id, id, reason);
    expect((await events(p.folder)).at(-1)!.details?.reason).toBe(reason);
  });

  it("a governance change's reason with slashes", async () => {
    const p = (await repo.createProject({ name: "G", governanceYaml: `profiles: [hipaa]\n`, encryption: { enabled: true, passphrase: "correct horse battery" } })).project;
    const cur = await readFile(join(lib.root, p.folder, "governance.yaml"));
    const base = createHash("sha256").update(cur).digest("hex");
    const reason = "IRB amendment /2025/07 approved by /Ethics Board/";
    await repo
      .setGovernance(p.id, `profiles: [hipaa]\nencryption:\n  atRest: optional\n`, { baseSha256: base, reason })
      .catch(() => undefined);
    // The project is encrypted: since R362 b its log holds a digest of the reason exactly as typed (keyed, R369 b), and
    // the text, sealed, reads back exactly as typed (no scrubbing either way).
    const withReason = (await events(p.folder)).filter((e) => e.details?.reasonGiven === true);
    expect(withReason.length).toBeGreaterThanOrEqual(1);
    expect(withReason.at(-1)!.details!.reasonMac).toMatch(/^[0-9a-f]{64}$/);
    expect(withReason.at(-1)!.details!.reasonSha256).toBeUndefined();
    const shown = (await repo.readAudit(p.id)).events.find((e) => e.seq === withReason.at(-1)!.seq)!;
    expect(shown.reasonShown).toEqual({ state: "text", text: reason });
    expect(JSON.stringify(await events(p.folder))).not.toContain("<path>");
  });
});

describe("R2: error text the system produced never stores an absolute path", () => {
  it("ELOOP from an unreadable governance file, in a project's log", async () => {
    const p = (await repo.createProject({ name: "E", governanceYaml: OPEN, encryption: { enabled: false } })).project;
    const gov = join(lib.root, p.folder, "governance.yaml");
    await rm(gov);
    await symlink(gov, gov);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(lib.root, p.folder, "attention"), { recursive: true });
    await writeFile(join(lib.root, p.folder, "attention", "stray.txt"), "x");
    const id = (await repo.attentionMarks(p.id))[0]!.id;
    await expect(repo.setAsideMark(p.id, id, "why")).rejects.toBeInstanceOf(PolicyDeniedError);
    const last = (await events(p.folder)).at(-1)!;
    expect(last.decision?.reason).toMatch(/^Policy could not be evaluated/);
    expect(JSON.stringify(last)).not.toContain(tmp);
  });
});
