import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, Condition } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { PolicyDeniedError } from "./errors.js";
import { mutateRefusing, type Repo } from "./repo.js";
import { openTestRepo } from "./testing.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: required
captureMethods: [manual_upload]
`;
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

function deps(): Deps {
  return {
    clock: () => new Date(),
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

async function auditEvents(folder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-refuse-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester" });
});
afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function project() {
  return (await repo.createProject({ name: "P", governanceYaml: GOV, encryption: { enabled: true, passphrase: "pw" } })).project;
}

describe("refuse hook (R57 I1)", () => {
  it("public repo.mutate does not accept a refuse hook (type) and ignores one at runtime", async () => {
    const p = await project();
    const r = await repo.mutate(p.id, STORE, async () => 1, {
      op: "test.public",
      // @ts-expect-error refuse is internal-only
      refuse: () => "refused",
    });
    expect(r).toBe(1);
  });

  it("the hook gets frozen copies: mutating them changes neither tx.conditions nor the audit", async () => {
    const p = await project();
    let seen: Condition[] = [];
    await mutateRefusing(
      repo,
      p.id,
      STORE,
      async (tx) => {
        seen = [...tx.conditions];
      },
      { op: "test.frozen" },
      (d, req) => {
        const dd = d as { result: string; conditions?: Condition[] };
        for (const f of [() => dd.conditions!.splice(0), () => (dd.result = "allow"), () => ((req as { store?: { hasLocation: boolean } }).store!.hasLocation = true)]) {
          try {
            f();
          } catch {
            // frozen
          }
        }
        return undefined;
      },
    );
    expect(seen).toEqual([{ type: "encrypt" }]);
    const ev = (await auditEvents(p.folder)).find((e) => e.details?.op === "test.frozen")!;
    expect(ev.decision).toEqual({ result: "allow_with_conditions", conditions: [{ type: "encrypt" }] });
  });

  it("a hook that throws is an audited deny with the generic reason only (no message); nothing runs", async () => {
    const p = await project();
    let ran = false;
    const err = await mutateRefusing(
      repo,
      p.id,
      STORE,
      async () => {
        ran = true;
      },
      { op: "test.throw" },
      () => {
        throw new Error("boom reading /home/someone/secret/file.tif");
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDeniedError);
    expect(ran).toBe(false);
    const deny = (await auditEvents(p.folder)).find((e) => e.details?.op === "test.throw")!;
    expect(deny.decision?.result).toBe("deny");
    expect(deny.decision?.reason).toBe("Refused by an internal check");
    expect((err as PolicyDeniedError).reason).toBe("Refused by an internal check");
  });
});
