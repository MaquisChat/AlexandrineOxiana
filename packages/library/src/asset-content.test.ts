/**
 * Reading one stored file of a source as a stream of byte ranges (Task 34a, R135): plain and
 * encrypted (decrypted as it streams, across the format's 1 MiB chunk boundaries), nothing
 * written anywhere, a locked project refused, a destroyed or unknown asset refused, a file swapped
 * for a symbolic link refused.
 */
import { randomBytes } from "node:crypto";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, SourceFile } from "@ao/core";
import { openAssetContent, isMediaMime, isPictureMime } from "./asset-content.js";
import { CHUNK_SIZE } from "./crypto/format.js";
import { OPEN_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { NotFoundError, PathEscapeError, ProjectLockedError } from "./repo/errors.js";
import { InvalidInputError } from "./repo/errors.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-asset-content-");
});
afterEach(async () => {
  await kit.close();
});

async function collect(s: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

async function mediaSource(p: Project, data: Buffer, name = "talk.mp3"): Promise<SourceFile> {
  const file = await scratchFile(kit, name, data);
  return addSource(kit, p, { type: "audio", title: "A talk", files: [{ path: file, role: "original", handling: "copy" }] });
}

describe("openAssetContent", () => {
  for (const encrypted of [false, true]) {
    it(`${encrypted ? "an encrypted" : "a plain"} project: whole file and ranges across chunk boundaries`, async () => {
      const p = await makeProject(kit, OPEN_GOV, encrypted);
      const data = randomBytes(2 * CHUNK_SIZE + 12345);
      const sf = await mediaSource(p, data);
      const asset = sf.assets[0]!;
      expect(asset.encrypted).toBe(encrypted);
      const c = await openAssetContent(kit.repo, p.id, sf.source.id, asset.id, (a) => isMediaMime(a.mime));
      try {
        expect(c.size).toBe(data.length);
        expect(c.mime).toBe("audio/mpeg");
        expect((await collect(c.range(0, data.length - 1))).equals(data)).toBe(true);
        // Spanning both boundaries, starting and ending mid-chunk.
        const a = CHUNK_SIZE - 7;
        const b = 2 * CHUNK_SIZE + 9;
        expect((await collect(c.range(a, b))).equals(data.subarray(a, b + 1))).toBe(true);
        expect((await collect(c.range(data.length - 1, data.length - 1))).equals(data.subarray(data.length - 1))).toBe(true);
        expect((await collect(c.range(CHUNK_SIZE, CHUNK_SIZE))).equals(data.subarray(CHUNK_SIZE, CHUNK_SIZE + 1))).toBe(true);
        expect(() => c.range(0, data.length)).toThrow(RangeError);
        expect((await c.read(a, 30)).equals(data.subarray(a, a + 30))).toBe(true);
        expect(() => c.read(data.length - 1, 2)).toThrow(RangeError);
      } finally {
        await c.close();
      }
    });
  }

  it("a locked encrypted project is refused", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const sf = await mediaSource(p, randomBytes(1000));
    kit.repo.lockProject(p.id);
    await expect(openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true)).rejects.toBeInstanceOf(ProjectLockedError);
  });

  it("an unknown asset, or one the caller does not accept, is refused", async () => {
    const p = await makeProject(kit);
    const sf = await mediaSource(p, randomBytes(100));
    await expect(openAssetContent(kit.repo, p.id, sf.source.id, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", () => true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, (a) => isPictureMime(a.mime))).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("a stored file replaced by a symbolic link is refused", async () => {
    const p = await makeProject(kit);
    const sf = await mediaSource(p, randomBytes(100));
    const abs = join(kit.lib.root, ...sf.assets[0]!.path.split("/"));
    const elsewhere = await scratchFile(kit, "secret.mp3", "outside the library");
    await rm(abs);
    await symlink(elsewhere, abs);
    await expect(openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true)).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("a missing file is NotFoundError without its path", async () => {
    const p = await makeProject(kit);
    const sf = await mediaSource(p, randomBytes(100));
    await rm(join(kit.lib.root, ...sf.assets[0]!.path.split("/")));
    const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).not.toContain(kit.tmp);
  });

  it("closing while a range is being read ends it and releases the file", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const data = randomBytes(3 * CHUNK_SIZE);
    const sf = await mediaSource(p, data);
    const c = await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true);
    const s = c.range(0, data.length - 1);
    const it = s[Symbol.asyncIterator]();
    await it.next();
    await c.close();
    await c.close(); // idempotent
    await expect(collect(s)).rejects.toThrow();
  });

  it("mime rules: audio and video only for media; raster pictures only (no SVG) for pictures", () => {
    expect(isMediaMime("audio/mpeg")).toBe(true);
    expect(isMediaMime("video/mp4")).toBe(true);
    expect(isMediaMime("image/png")).toBe(false);
    expect(isMediaMime("text/html")).toBe(false);
    expect(isMediaMime("video/mp4; charset=x")).toBe(false);
    expect(isPictureMime("image/png")).toBe(true);
    expect(isPictureMime("image/jpeg")).toBe(true);
    expect(isPictureMime("image/webp")).toBe(true);
    expect(isPictureMime("image/svg+xml")).toBe(false);
    expect(isPictureMime("text/html")).toBe(false);
  });
});
