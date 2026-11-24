/**
 * Reading one stored file of a source as a stream of byte ranges (Task 34a, R135): plain and
 * encrypted (decrypted as it streams, across the format's 1 MiB chunk boundaries), nothing
 * written anywhere, a locked project refused, a destroyed or unknown asset refused, a file swapped
 * for a symbolic link refused.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

  it("a FIFO or a socket swapped in for the file is refused at once, never read (no hang)", async () => {
    const p = await makeProject(kit);
    for (const kind of ["fifo", "socket"] as const) {
      const sf = await mediaSource(p, randomBytes(100));
      const abs = join(kit.lib.root, ...sf.assets[0]!.path.split("/"));
      await rm(abs);
      // A socket is bound by its short name in its own folder (a full path may pass the length a socket address allows).
      const made = kind === "fifo" ? spawnSync("mkfifo", [abs]) : spawnSync("python3", ["-c", "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", basename(abs)], { cwd: dirname(abs) });
      expect(made.status, String(made.stderr)).toBe(0);
      expect((await lstat(abs)).isFile()).toBe(false);
      const started = Date.now();
      const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error;
      expect(Date.now() - started, kind).toBeLessThan(2000);
      expect(err, kind).toBeInstanceOf(InvalidInputError);
      expect(err.message).toBe("this file could not be opened safely");
    }
  });

  it("a missing file is NotFoundError without its path", async () => {
    const p = await makeProject(kit);
    const sf = await mediaSource(p, randomBytes(100));
    await rm(join(kit.lib.root, ...sf.assets[0]!.path.split("/")));
    const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).not.toContain(kit.tmp);
  });

  describe("R510 (FR-727): a LINKED original whose path holds a symbolic link or a folder is answered as a file not there", () => {
    /** A source whose only original is linked in place (outside the library), and its recorded absolute path. */
    async function linkedSource() {
      const p = await makeProject(kit);
      const file = await scratchFile(kit, "talk.mp3", randomBytes(100));
      const sf = await addSource(kit, p, { type: "audio", title: "A linked talk", files: [{ path: file, role: "original", handling: "link" }] });
      expect(sf.assets[0]!.linked).toBeDefined();
      return { p, sf, abs: sf.assets[0]!.linked!.absolutePath };
    }
    const KINDS: Array<[string, (abs: string) => Promise<void>]> = [
      ["a symbolic link to a file that is there", async (abs) => symlink(await scratchFile(kit, "real.mp3", randomBytes(100)), abs)],
      ["a symbolic link that leads nowhere", async (abs) => symlink(join(kit.tmp, "unplugged", "talk.mp3"), abs)],
      ["a folder", async (abs) => mkdir(abs)],
      ["a symbolic link to a folder", async (abs) => symlink(dirname(await scratchFile(kit, "x.mp3", "x")), abs)],
    ];
    for (const [kind, make] of KINDS) {
      it(`${kind}: NotFoundError, without its path`, async () => {
        const { p, sf, abs } = await linkedSource();
        await rm(abs);
        await make(abs);
        const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error;
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err.message).not.toContain(kit.tmp);
      });
    }

    it("a FIFO at a linked path is still refused as unsafe (only a link or a folder counts as not there)", async () => {
      const { p, sf, abs } = await linkedSource();
      await rm(abs);
      expect(spawnSync("mkfifo", [abs]).status).toBe(0);
      const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err.message).toBe("this file could not be opened safely");
    });

    it("a folder in place of a file STORED inside the library is still refused as unsafe", async () => {
      const p = await makeProject(kit);
      const sf = await mediaSource(p, randomBytes(100));
      const abs = join(kit.lib.root, ...sf.assets[0]!.path.split("/"));
      await rm(abs);
      await mkdir(abs);
      const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(InvalidInputError);
      expect(err.message).toBe("this file could not be opened safely");
    });
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
