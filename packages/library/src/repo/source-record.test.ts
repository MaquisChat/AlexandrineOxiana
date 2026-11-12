/**
 * Ruling R186 (Task 69, fix round 1): the light read of a source's own record (`source.json`
 * alone). It never opens the annotations file, makes no cross-file check and cannot record an
 * integrity warning, so a list may call it for every row while annotations are being written.
 */
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Annotation, type SourceDraft } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { NotFoundError, ProjectLockedError } from "./errors.js";
import type { Repo } from "./index.js";
import { openTestRepo } from "./testing.js";

const FAST = 2 ** 10;
const NOW = "2026-11-03T09:15:00.000Z";
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
`;

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

const draft = (pid: string): SourceDraft => ({
  projectIds: [pid],
  type: "social-post",
  title: { variants: [{ lang: "en", kind: "original", value: "A post" }] },
  creators: [],
  identifiers: {},
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});

async function sourceWithNote(encrypted: boolean) {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } });
  const sf = await repo.createSource(project.id, draft(project.id), [], {
    provenance: { captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
    annotations: (sourceId, _assets, actor): Annotation[] => [{ id: newId(), sourceId, kind: "note", body: "A note", anchors: [], author: actor, createdAt: NOW }],
  });
  await repo.updateSource(project.id, sf.source.id, { availability: { status: "unavailable-on-platform", firstNoticedAt: NOW } });
  return { pid: project.id, sid: sf.source.id, folder: sf.source.folder };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-source-record-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { clock: () => new Date(NOW), tz: "UTC", actor: "tester", scryptN: FAST });
});
afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("getSourceRecord: source.json alone (R186)", () => {
  it("returns the record's fields; an annotations file that differs from its recorded hash (as mid-write) raises no warning", async () => {
    const { pid, sid, folder } = await sourceWithNote(false);
    // The state between writeSourceFile's two writes: new annotations next to the old hash.
    await appendFile(join(lib.root, folder, "annotations.json"), " ");
    const rec = await repo.getSourceRecord(pid, sid);
    expect(rec.id).toBe(sid);
    expect(rec.availability).toEqual({ status: "unavailable-on-platform", firstNoticedAt: NOW });
    expect(repo.integrityWarnings).toEqual([]);
  });

  it("a missing or damaged annotations file raises no warning either", async () => {
    const { pid, sid, folder } = await sourceWithNote(false);
    await writeFile(join(lib.root, folder, "annotations.json"), "[{ not json");
    expect((await repo.getSourceRecord(pid, sid)).availability.status).toBe("unavailable-on-platform");
    await rm(join(lib.root, folder, "annotations.json"));
    expect((await repo.getSourceRecord(pid, sid)).availability.status).toBe("unavailable-on-platform");
    expect(repo.integrityWarnings).toEqual([]);
  });

  it("an encrypted project: decrypted while unlocked; refused while locked; an unknown id is not found", async () => {
    const { pid, sid } = await sourceWithNote(true);
    expect((await repo.getSourceRecord(pid, sid)).availability).toEqual({ status: "unavailable-on-platform", firstNoticedAt: NOW });
    await expect(repo.getSourceRecord(pid, "no-such-source")).rejects.toBeInstanceOf(NotFoundError);
    repo.lockProject(pid);
    await expect(repo.getSourceRecord(pid, sid)).rejects.toBeInstanceOf(ProjectLockedError);
  });
});
