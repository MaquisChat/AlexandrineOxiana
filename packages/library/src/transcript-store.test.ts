/**
 * FR-393 (R464 c): a transcript's two files (the WebVTT and the segments file) are stored in ONE
 * governed, audited, crash-safe change: a lock or a crash at any point of it leaves both files or
 * neither, never one; a rerun after either leaves exactly one version of each; the audit has one
 * `store` entry for the transcript, whose details name both files.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { OPEN_GOV, PASS, addSource, auditEvents, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { SimulatedCrash, seams, type CrashPoint } from "./repo/testing.js";
import { transcriptVersions } from "./source-actions.js";
import { storeTranscript } from "./transcript-store.js";
import type { JobResult } from "./worker-client.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-transcript-store-");
});
afterEach(async () => {
  seams.crashAt = undefined;
  await kit.close();
});

async function audioSource(p: Project) {
  const audio = await scratchFile(kit, "talk.mp3", Buffer.alloc(64, 1));
  return addSource(kit, p, { type: "audio" as never, title: "Talk", files: [{ path: audio, role: "original", handling: "copy" }] });
}

/** A finished transcription's output (plain files, as a worker writes them for a project not encrypted). */
async function output(missingSegments = false): Promise<JobResult> {
  const dir = join(kit.tmp, `out-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "transcript.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome.\n");
  if (!missingSegments) await writeFile(join(dir, "segments.json"), JSON.stringify([{ start: 0, end: 2, text: "Welcome.", lang: "en", flags: [] }]));
  return { id: randomUUID(), type: "audio.transcribe", output: dir, files: [join(dir, "transcript.vtt"), join(dir, "segments.json")], meta: { model: "small", detectedLanguages: ["en"], flaggedCount: 0 }, encrypted: false };
}

/** The transcript versions recorded, and the files in the source's `derived` folder. */
async function stored(p: Project, sourceId: string): Promise<{ versions: number; files: number }> {
  const sf = await kit.repo.getSource(p.id, sourceId);
  const versions = transcriptVersions(sf).length;
  const files = await readdir(join(kit.lib.root, ...sf.source.folder.split("/"), "derived")).then(
    (xs) => xs.length,
    () => 0,
  );
  return { versions, files };
}

const store = async (p: Project, sf: Awaited<ReturnType<typeof audioSource>>, r?: JobResult) =>
  storeTranscript(kit.repo, p.id, sf.source.id, sf.assets[0]!, r ?? (await output()), { model: "small" }, "tester");

const rounds = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("a transcript's two files in one governed change (FR-393, R464 c)", () => {
  it("one `store` entry for the transcript, whose details name both files; the chain verifies", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const before = (await auditEvents(kit, p)).length;
    const out = await store(p, sf);
    const events = (await auditEvents(kit, p)).slice(before);
    expect(events.map((e) => [e.action, e.decision?.result])).toEqual([["store", "allow"]]);
    const versions = transcriptVersions(await kit.repo.getSource(p.id, sf.source.id));
    expect(versions.map((v) => v.path).sort()).toEqual([...out.files].sort());
    const details = events[0]!.details as { op?: string; files?: Array<{ asset: string; ext: string }> };
    expect(details.op).toBe("asset.derive");
    expect(details.files).toEqual([
      { asset: versions.find((v) => v.mime === "text/vtt")!.id, ext: "vtt" },
      { asset: versions.find((v) => v.mime === "application/json")!.id, ext: "json" },
    ]);
    expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
  });

  it("a failure while the second file is copied leaves neither file, and no `store` entry", async () => {
    const p = await makeProject(kit);
    const sf = await audioSource(p);
    const before = (await auditEvents(kit, p)).length;
    await expect(store(p, sf, await output(true))).rejects.toThrow();
    expect(await stored(p, sf.source.id)).toEqual({ versions: 0, files: 0 });
    expect((await auditEvents(kit, p)).slice(before).filter((e) => e.action === "store")).toEqual([]);
  });

  it("a lock at every point of the change leaves both files or neither; the rerun after it leaves exactly one version of each", async () => {
    // How many turns of the event loop a store takes when nothing stops it: the lock is tried at each.
    const p0 = await makeProject(kit, OPEN_GOV, true);
    const s0 = await audioSource(p0);
    const r0 = await output();
    let turns = 0;
    let done = false;
    const plain = store(p0, s0, r0).then(() => void (done = true));
    while (!done) {
      await rounds(1);
      turns++;
    }
    await plain;
    expect(turns).toBeGreaterThan(2);
    const seen = new Set<string>();
    // At most 16 lock points, evenly spread from before the change to after it.
    const points = [...new Set(Array.from({ length: 16 }, (_, i) => Math.round((i * (turns + 1)) / 15)))];
    for (const n of points) {
      const p = await makeProject(kit, OPEN_GOV, true);
      const sf = await audioSource(p);
      const r = await output();
      const run = store(p, sf, r).then(
        () => "stored",
        (err: unknown) => (err as Error).name,
      );
      await rounds(n);
      const lock = kit.repo.lockProject(p.id);
      const outcome = await run;
      await lock;
      await kit.repo.unlockProject(p.id, PASS);
      seen.add(outcome);
      const after = await stored(p, sf.source.id);
      expect([{ versions: 0, files: 0 }, { versions: 2, files: 2 }], `lock after ${n} turns: ${outcome}`).toContainEqual(after);
      if (after.versions === 0) {
        await store(p, sf, await output());
        expect(await stored(p, sf.source.id), `rerun after a lock at ${n} turns`).toEqual({ versions: 2, files: 2 });
      }
    }
    // The lock landed before the change at some point and after it at another.
    expect(seen.has("stored")).toBe(true);
    expect([...seen].some((o) => o !== "stored")).toBe(true);
  }, 240_000);

  for (const point of ["before-changes", "before-audit", "before-marker-delete"] as CrashPoint[]) {
    it(`a crash at ${point} leaves both files or neither once the library is opened again; the rerun leaves exactly one version of each`, async () => {
      const p = await makeProject(kit, OPEN_GOV, true);
      const sf = await audioSource(p);
      seams.crashAt = point;
      await expect(store(p, sf)).rejects.toBeInstanceOf(SimulatedCrash);
      await kit.reopen();
      if (!kit.repo.isUnlocked(p.id)) await kit.repo.unlockProject(p.id, PASS);
      const after = await stored(p, sf.source.id);
      expect(after).toEqual(point === "before-marker-delete" ? { versions: 2, files: 2 } : { versions: 0, files: 0 });
      if (after.versions === 0) await store(p, sf);
      expect(await stored(p, sf.source.id)).toEqual({ versions: 2, files: 2 });
      expect((await auditEvents(kit, p)).filter((e) => e.action === "store" && e.decision?.result === "allow" && (e.details as { op?: string }).op === "asset.derive")).toHaveLength(1);
      expect((await kit.repo.verifyAudit(p.id)).ok).toBe(true);
    });
  }
});
