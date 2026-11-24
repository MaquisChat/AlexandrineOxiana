/**
 * R470 b (FR-490): a file Find and acquire holds for the researcher's decision can be LOOKED AT before "Use this file" /
 * "Not this file": `openHeldFileContent` opens the held file of one pending entry of one project for reading by
 * ranges, through the same reading code as a stored file (decrypted chunk by chunk in an encrypted project). A locked
 * project is refused as locked; an entry that holds no file, a held file that is gone, a decided entry and an entry of
 * another project are each refused as "not found", saying nothing more; and a look writes nothing anywhere.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHeldFileContent } from "./asset-content.js";
import { CHUNK_SIZE } from "./crypto/format.js";
import { OPEN_GOV, PASS, PSEUDO_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import type { FindEntry } from "./find/types.js";
import { NotFoundError, ProjectLockedError } from "./repo/errors.js";
import { appendFindEntriesIn, holdMismatchedFileIn, projectReviewEntries, resolveHeldFileIn } from "./repo/repo.js";
import type { HeldFileFacts } from "./repo/review.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-held-content-");
});
afterEach(async () => {
  await kit.close();
});

const NOW = "2026-11-10T09:30:00.000Z";
const facts = (kind: "pdf" | "epub", bytes: number): HeldFileFacts => ({
  why: "other-doi",
  kind,
  bytes,
  acquired: { method: "free_copy", via: "service", service: "arxiv", address: "https://arxiv.org/pdf/2101.00001", at: NOW, tool: { name: "find-and-acquire", version: "0.1.0" }, access: "public" },
});

/** A record, its queue entry and a file held for it: the review entry's id, the held file's place and its bytes. */
async function held(p: Project, kind: "pdf" | "epub" = "pdf", data: Buffer = pdfBytes(2 * CHUNK_SIZE + 77)): Promise<{ reviewId: string; held: string; data: Buffer }> {
  const sf = await addSource(kit, p, { title: "Rivers and Memory" });
  const entry: FindEntry = { id: newId(), projectId: p.id, typed: "Rivers and Memory", state: "fetching", createdAt: NOW, updatedAt: NOW, attempts: 0, sourceId: sf.source.id };
  await appendFindEntriesIn(kit.repo, p.id, [entry], "add");
  const file = await scratchFile(kit, `found.${kind}`, data);
  const r = await holdMismatchedFileIn(kit.repo, p.id, { entry: { ...entry, state: "needs-check", reason: { code: "file-other-doi" } }, sourceId: sf.source.id, fromPath: file, facts: facts(kind, data.length) });
  return { ...r, data };
}

const pdfBytes = (n: number): Buffer => {
  const b = randomBytes(n);
  b.write("%PDF-1.7\n", 0, "latin1");
  return b;
};

async function collect(s: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** Every file of the library with its content's hash (the heartbeat `.lock` aside). */
async function tree(dir: string, rel = "", out: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await tree(join(dir, e.name), r, out);
    else if (e.name !== ".lock") out[r] = createHash("sha256").update(await readFile(join(dir, e.name))).digest("hex");
  }
  return out;
}

describe("R470 b: looking at a held file", () => {
  for (const encrypted of [false, true]) {
    it(`${encrypted ? "an encrypted" : "a plain"} project: the held PDF by ranges, across chunk boundaries, and nothing written`, async () => {
      const p = await makeProject(kit, encrypted ? PSEUDO_GOV : OPEN_GOV, encrypted);
      const h = await held(p);
      expect(h.held.endsWith(".enc")).toBe(encrypted);
      const before = await tree(kit.lib.root);
      const c = await openHeldFileContent(kit.repo, p.id, h.reviewId);
      try {
        expect(c.kind).toBe("pdf");
        expect(c.mime).toBe("application/pdf");
        expect(c.size).toBe(h.data.length);
        const a = CHUNK_SIZE - 5;
        const b = 2 * CHUNK_SIZE + 3;
        expect((await collect(c.range(a, b))).equals(h.data.subarray(a, b + 1))).toBe(true);
        expect((await c.read(0, 9)).toString("latin1")).toBe("%PDF-1.7\n");
        expect(() => c.range(0, h.data.length)).toThrow(RangeError);
      } finally {
        await c.close();
      }
      expect(await tree(kit.lib.root)).toEqual(before);
    });
  }

  it("an EPUB held: opened as what it is (the route decides it cannot be shown)", async () => {
    const p = await makeProject(kit);
    const h = await held(p, "epub", Buffer.from("PK\u0003\u0004 an epub"));
    const c = await openHeldFileContent(kit.repo, p.id, h.reviewId);
    try {
      expect([c.kind, c.mime]).toEqual(["epub", "application/epub+zip"]);
    } finally {
      await c.close();
    }
  });

  it("a locked project is refused as locked, before anything is read", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const h = await held(p);
    kit.repo.lockProject(p.id);
    await expect(openHeldFileContent(kit.repo, p.id, h.reviewId)).rejects.toBeInstanceOf(ProjectLockedError);
    // Locked, an unknown entry says the same.
    await expect(openHeldFileContent(kit.repo, p.id, newId())).rejects.toBeInstanceOf(ProjectLockedError);
    await kit.repo.unlockProject(p.id, PASS);
    const c = await openHeldFileContent(kit.repo, p.id, h.reviewId);
    await c.close();
  });

  it("no held file to look at: an unknown entry, an entry that holds none, a decided one, another project's, a file gone — each 'not found'", async () => {
    const p = await makeProject(kit);
    const other = await makeProject(kit);
    const h = await held(p);
    const notFound = async (pid: string, rid: string) => {
      const err = await openHeldFileContent(kit.repo, pid, rid).then(
        (c) => c.close().then(() => undefined),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotFoundError);
      // It names nothing but what was asked for: no place, no file name.
      expect((err as Error).message).not.toMatch(/find\/held|\.pdf|[\\/]/u);
    };
    await notFound(p.id, newId());
    await notFound(other.id, h.reviewId);
    // A review entry that holds no file.
    const plain = await kit.repo.createSource(
      p.id,
      { projectIds: [], type: "webpage", title: { variants: [{ lang: "en", kind: "original", value: "A page" }] }, creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      { provenance: { captureMethod: "manual_upload", capturedAt: NOW, tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false }, reviewItem: { kind: "verification", fields: {}, reasons: ["Check the date."] } },
    );
    const notHeld = (await projectReviewEntries(kit.repo, p.id)).find((e) => e.sourceId === plain.source.id)!;
    await notFound(p.id, notHeld.id);
    // The held file gone from its place.
    const h2 = await held(p);
    await rm(join(kit.lib.root, kit.repo.getProject(p.id).folder, h2.held));
    await notFound(p.id, h2.reviewId);
    // Decided ("Not this file"): its file is no longer held.
    await resolveHeldFileIn(kit.repo, p.id, h.reviewId, "discard");
    await notFound(p.id, h.reviewId);
  });
});
