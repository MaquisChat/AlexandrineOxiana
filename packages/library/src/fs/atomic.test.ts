import { createHash, randomBytes } from "node:crypto";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptStream, encryptStream } from "../crypto/format.js";
import { generateDataKey } from "../crypto/keys.js";
import { _renameRetry, cleanupTempFiles, copyFileAtomic, writeFileAtomic } from "./atomic.js";

// Wrap rename/unlink so individual tests can make them fail; by default they
// delegate to the real implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

const { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } = realFs;
const HOUR = 60 * 60 * 1000;

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("atomic file writes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ao-atomic-"));
  });
  afterEach(async () => {
    vi.mocked(realFs.rename).mockClear();
    vi.mocked(realFs.unlink).mockClear();
    vi.mocked(realFs.open).mockClear();
    _renameRetry.force = false;
    await rm(dir, { recursive: true, force: true });
  });

  describe("writeFileAtomic", () => {
    it("writes strings and bytes, replacing an existing file", async () => {
      const p = join(dir, "a.json");
      await writeFileAtomic(p, "first");
      expect(await readFile(p, "utf8")).toBe("first");
      await writeFileAtomic(p, new Uint8Array([1, 2, 3]));
      expect([...(await readFile(p))]).toEqual([1, 2, 3]);
      expect(await readdir(dir)).toEqual(["a.json"]);
    });

    it("a crash before rename leaves the original intact and only a *.tmp-* file, which cleanup removes after 1 hour", async () => {
      const p = join(dir, "data.json");
      await writeFile(p, "original");
      // Simulated crash: rename never happens and the process gets no chance to clean up.
      vi.mocked(realFs.rename).mockRejectedValueOnce(new Error("simulated crash"));
      vi.mocked(realFs.unlink).mockResolvedValueOnce(undefined);
      await expect(writeFileAtomic(p, "replacement")).rejects.toThrow("simulated crash");

      expect(await readFile(p, "utf8")).toBe("original");
      const entries = (await readdir(dir)).sort();
      expect(entries).toHaveLength(2);
      const tmp = entries.find((e) => e !== "data.json")!;
      expect(tmp).toMatch(/^data\.json\.tmp-[0-9a-f]+$/);
      expect(await readFile(join(dir, tmp), "utf8")).toBe("replacement");

      const mtime = (await stat(join(dir, tmp))).mtimeMs;
      // Not yet an hour old: kept.
      expect(await cleanupTempFiles(dir, { now: () => mtime + HOUR - 1000 })).toBe(0);
      expect(await readdir(dir)).toContain(tmp);
      // Older than an hour: removed.
      expect(await cleanupTempFiles(dir, { now: () => mtime + HOUR + 1000 })).toBe(1);
      expect(await readdir(dir)).toEqual(["data.json"]);
      expect(await readFile(p, "utf8")).toBe("original");
    });

    it("removes its temp file when a write fails in-process", async () => {
      const p = join(dir, "b.txt");
      await writeFile(p, "original");
      vi.mocked(realFs.rename).mockRejectedValueOnce(new Error("EIO"));
      await expect(writeFileAtomic(p, "new")).rejects.toThrow("EIO");
      expect(await readdir(dir)).toEqual(["b.txt"]);
      expect(await readFile(p, "utf8")).toBe("original");
    });

    it("uses a unique temp name per write", async () => {
      const p = join(dir, "c.txt");
      await Promise.all(Array.from({ length: 10 }, (_, i) => writeFileAtomic(p, `v${i}`)));
      expect(await readdir(dir)).toEqual(["c.txt"]);
      expect(await readFile(p, "utf8")).toMatch(/^v\d$/);
    });
  });

  describe("cleanupTempFiles", () => {
    it("only removes old *.tmp-* files", async () => {
      const now = Date.now();
      const old = new Date(now - 2 * HOUR);
      for (const name of ["x.tmp-abc", "y.json", "tmp-z", "y.json.tmp-0f"]) {
        await writeFile(join(dir, name), "");
        await utimes(join(dir, name), old, old);
      }
      await writeFile(join(dir, "fresh.tmp-1"), "");
      expect(await cleanupTempFiles(dir, { now: () => now })).toBe(2);
      expect((await readdir(dir)).sort()).toEqual(["fresh.tmp-1", "tmp-z", "y.json"]);
    });

    it("returns 0 for a missing directory", async () => {
      expect(await cleanupTempFiles(join(dir, "nope"))).toBe(0);
    });
  });

  describe("copyFileAtomic", () => {
    it("copies and returns the sha256 and size of the content", async () => {
      const src = join(dir, "src.bin");
      const dest = join(dir, "dest.bin");
      const data = randomBytes(2.5 * 1024 * 1024);
      await writeFile(src, data);
      const r = await copyFileAtomic(src, dest);
      expect(r).toEqual({ sha256: sha256(data), bytes: data.length });
      expect((await readFile(dest)).equals(data)).toBe(true);
      expect((await readdir(dir)).sort()).toEqual(["dest.bin", "src.bin"]);
    });

    it.skipIf(process.platform === "win32")("noFollow refuses a source that is a symbolic link (R70) and leaves no temp file", async () => {
      const target = join(dir, "target.bin");
      await writeFile(target, "secret");
      const link = join(dir, "link.bin");
      await realFs.symlink(target, link);
      await expect(copyFileAtomic(link, join(dir, "dest.bin"), { noFollow: true })).rejects.toMatchObject({ code: "ELOOP" });
      expect((await readdir(dir)).sort()).toEqual(["link.bin", "target.bin"]);
      expect(await copyFileAtomic(target, join(dir, "ok.bin"), { noFollow: true })).toEqual({ sha256: sha256(Buffer.from("secret")), bytes: 6 });
    });

    it("with a transform, hashes the source plaintext and writes the transformed bytes", async () => {
      const src = join(dir, "plain.txt");
      const dest = join(dir, "plain.txt.enc");
      const data = randomBytes(1024 * 1024 + 17);
      await writeFile(src, data);
      const key = generateDataKey();
      const keyId = newId();
      const r = await copyFileAtomic(src, dest, {
        transform: (r) => r.pipe(encryptStream(key, keyId)),
      });
      expect(r).toEqual({ sha256: sha256(data), bytes: data.length });
      const written = await readFile(dest);
      expect(written.equals(data)).toBe(false);
      expect(sha256(written)).not.toBe(r.sha256);

      const back: Buffer[] = [];
      const d = decryptStream(() => key);
      d.on("data", (c: Buffer) => back.push(c));
      await new Promise<void>((resolve, reject) => {
        d.on("end", resolve).on("error", reject);
        d.end(written);
      });
      expect(Buffer.concat(back).equals(data)).toBe(true);
    });

    it("hashes an empty file", async () => {
      const src = join(dir, "empty");
      await writeFile(src, "");
      const r = await copyFileAtomic(src, join(dir, "empty2"));
      expect(r).toEqual({ sha256: sha256(Buffer.alloc(0)), bytes: 0 });
    });

    it("leaves dest untouched and no temp file when the source is missing", async () => {
      const dest = join(dir, "dest");
      await writeFile(dest, "keep");
      await expect(copyFileAtomic(join(dir, "missing"), dest)).rejects.toThrow();
      expect(await readFile(dest, "utf8")).toBe("keep");
      expect(await readdir(dir)).toEqual(["dest"]);
    });

    it("leaves dest untouched and no temp file when the transform fails", async () => {
      const src = join(dir, "src");
      const dest = join(dir, "dest");
      await writeFile(src, "data");
      await writeFile(dest, "keep");
      const { Transform } = await import("node:stream");
      const failing = () =>
        new Transform({
          transform(_c, _e, cb) {
            cb(new Error("transform boom"));
          },
        });
      await expect(copyFileAtomic(src, dest, { transform: (r) => r.pipe(failing()) })).rejects.toThrow(
        "transform boom",
      );
      expect(await readFile(dest, "utf8")).toBe("keep");
      expect((await readdir(dir)).sort()).toEqual(["dest", "src"]);
    });
  });
  describe("hardening", () => {
    const posix = process.platform !== "win32";
    const errno = (code: string) => Object.assign(new Error(code), { code });

    it.runIf(posix)("writeFileAtomic applies mode to the file (0600)", async () => {
      const p = join(dir, "key.json");
      await writeFileAtomic(p, "secret", { mode: 0o600 });
      expect((await stat(p)).mode & 0o777).toBe(0o600);
      // Replacing keeps the requested mode.
      await writeFileAtomic(p, "secret2", { mode: 0o600 });
      expect((await stat(p)).mode & 0o777).toBe(0o600);
    });

    it.runIf(posix)("copyFileAtomic applies mode to the file (0600)", async () => {
      const src = join(dir, "src");
      await writeFile(src, "data");
      const dest = join(dir, "dest");
      await copyFileAtomic(src, dest, { mode: 0o600 });
      expect((await stat(dest)).mode & 0o777).toBe(0o600);
    });

    it("does not unlink the temp path when the exclusive open itself failed", async () => {
      vi.mocked(realFs.open).mockRejectedValueOnce(errno("EEXIST"));
      await expect(writeFileAtomic(join(dir, "x"), "data")).rejects.toThrow("EEXIST");
      expect(realFs.unlink).not.toHaveBeenCalled();
    });

    it("retries a rename on EPERM/EACCES/EBUSY with bounded backoff on Windows", async () => {
      _renameRetry.force = true;
      const sleeps: number[] = [];
      const realSleep = _renameRetry.sleep;
      _renameRetry.sleep = async (ms) => {
        sleeps.push(ms);
      };
      try {
        vi.mocked(realFs.rename).mockRejectedValueOnce(errno("EPERM")).mockRejectedValueOnce(errno("EBUSY"));
        const p = join(dir, "w.txt");
        await writeFileAtomic(p, "ok");
        expect(await readFile(p, "utf8")).toBe("ok");
        expect(sleeps).toEqual([20, 40]);

        sleeps.length = 0;
        vi.mocked(realFs.rename).mockClear();
        vi.mocked(realFs.rename).mockRejectedValue(errno("EACCES"));
        await expect(writeFileAtomic(join(dir, "never.txt"), "x")).rejects.toThrow("EACCES");
        expect(sleeps).toEqual([20, 40, 80, 160, 320]);
        expect(realFs.rename).toHaveBeenCalledTimes(6);
        expect(await readdir(dir)).toEqual(["w.txt"]);
      } finally {
        vi.mocked(realFs.rename).mockReset();
        vi.mocked(realFs.rename).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename);
        _renameRetry.sleep = realSleep;
      }
    });

    it("does not retry renames off Windows, nor on other error codes", async () => {
      vi.mocked(realFs.rename).mockRejectedValueOnce(errno("EPERM"));
      await expect(writeFileAtomic(join(dir, "a"), "x")).rejects.toThrow("EPERM");
      expect(realFs.rename).toHaveBeenCalledTimes(1);
      _renameRetry.force = true;
      vi.mocked(realFs.rename).mockClear();
      vi.mocked(realFs.rename).mockRejectedValueOnce(errno("ENOSPC"));
      await expect(writeFileAtomic(join(dir, "b"), "x")).rejects.toThrow("ENOSPC");
      expect(realFs.rename).toHaveBeenCalledTimes(1);
    });
  });
});
