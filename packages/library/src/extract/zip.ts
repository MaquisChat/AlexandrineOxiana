/**
 * Bounded ZIP reading for EPUB and DOCX (R50): at most 10,000 entries, each at most 50 MB and all
 * together at most 200 MB uncompressed (as declared, and enforced while inflating), and no
 * absolute or `..` entry names. Violations throw UnsafeFileError; nothing is ever written to disk.
 *
 * `extractArchive` (Bulk Import, R59) unpacks a user's ZIP archive into a private folder with the
 * archive limits: at most 100,000 entries, each at most 50 MB, at most 2 GB in all (declared and
 * enforced while inflating); traversal, absolute and symbolic-link entries refuse the whole archive.
 */
import { createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { UnsafeFileError } from "./errors.js";

export const ZIP_LIMITS = {
  maxEntries: 10_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
} as const;

export interface SafeZip {
  names(): string[];
  has(name: string): boolean;
  /** The entry's bytes, read at most up to `maxBytes` (the rest is not inflated). */
  read(name: string, maxBytes?: number): Promise<Buffer | undefined>;
  close(): void;
}

/** Limits for a user's archive unpacked by Bulk Import. */
export const ARCHIVE_LIMITS = {
  maxEntries: 100_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
} as const;

function unsafeName(name: string): boolean {
  if (name.includes("\0")) return true;
  const n = name.replace(/\\/gu, "/");
  if (n.startsWith("/") || /^[A-Za-z]:/u.test(n)) return true;
  return n.split("/").some((seg) => seg === "..");
}

const open = (path: string) =>
  new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false, decodeStrings: true }, (err, zf) =>
      err || !zf ? reject(err ?? new Error("cannot open")) : resolve(zf),
    ),
  );

export async function openZip(path: string): Promise<SafeZip> {
  let zf: yauzl.ZipFile;
  try {
    zf = await open(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relative path|absolute path|invalid characters/iu.test(msg)) throw new UnsafeFileError("zip-path", "The archive contains a file name that points outside it");
    throw new UnsafeFileError("zip-invalid", "The archive could not be read");
  }
  if (zf.entryCount > ZIP_LIMITS.maxEntries) {
    zf.close();
    throw new UnsafeFileError("zip-too-many-entries", `The archive has more than ${ZIP_LIMITS.maxEntries} files`);
  }
  const entries = new Map<string, yauzl.Entry>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zf.on("error", reject);
      zf.on("end", resolve);
      zf.on("entry", (e: yauzl.Entry) => {
        if (unsafeName(e.fileName)) return reject(new UnsafeFileError("zip-path", "The archive contains a file name that points outside it"));
        if (e.uncompressedSize > ZIP_LIMITS.maxEntryBytes) return reject(new UnsafeFileError("zip-entry-too-large", "A file inside the archive is larger than 50 MB"));
        total += e.uncompressedSize;
        if (total > ZIP_LIMITS.maxTotalBytes) return reject(new UnsafeFileError("zip-too-large", "The archive's contents are larger than 200 MB"));
        if (entries.size >= ZIP_LIMITS.maxEntries) return reject(new UnsafeFileError("zip-too-many-entries", `The archive has more than ${ZIP_LIMITS.maxEntries} files`));
        if (!e.fileName.endsWith("/")) entries.set(e.fileName, e);
        zf.readEntry();
      });
      zf.readEntry();
    });
  } catch (e) {
    zf.close();
    if (e instanceof UnsafeFileError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/relative path|absolute path|invalid characters/iu.test(msg)) throw new UnsafeFileError("zip-path", "The archive contains a file name that points outside it");
    throw new UnsafeFileError("zip-invalid", "The archive could not be read");
  }

  return {
    names: () => [...entries.keys()],
    has: (n) => entries.has(n),
    read: (name, maxBytes = ZIP_LIMITS.maxEntryBytes) =>
      new Promise<Buffer | undefined>((resolve, reject) => {
        const entry = entries.get(name);
        if (!entry) return resolve(undefined);
        zf.openReadStream(entry, (err, stream) => {
          if (err || !stream) return reject(new UnsafeFileError("zip-invalid", "A file inside the archive could not be read"));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              chunks.push(c.subarray(0, c.length - (size - maxBytes)));
              stream.destroy();
              resolve(Buffer.concat(chunks));
              return;
            }
            chunks.push(c);
          });
          stream.on("error", () => reject(new UnsafeFileError("zip-invalid", "A file inside the archive could not be read")));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
        });
      }),
    close: () => zf.close(),
  };
}

const PATH_REASON = "The archive contains a file name that points outside it";

/** A symbolic link entry (Unix mode in the external attributes). */
function isSymlink(e: yauzl.Entry): boolean {
  const made = (e.versionMadeBy >> 8) & 0xff;
  if (made !== 3 && made !== 19) return false; // Unix or OS X
  return ((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

export interface ExtractedEntry {
  /** The entry's name in the archive ("/"-separated). */
  name: string;
  /** Where it was written. */
  path: string;
  bytes: number;
}

/**
 * Unpacks `zipPath` into `destDir` (created 0700; files 0600). Every entry is checked before
 * anything is written: a traversal, absolute or symbolic-link name, or a limit exceeded refuses the
 * whole archive with UnsafeFileError (what was written so far is the caller's to remove: it lives
 * in the caller's private work folder). `limits` is a test seam.
 */
export async function extractArchive(
  zipPath: string,
  destDir: string,
  limits: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number } = ARCHIVE_LIMITS,
  signal?: AbortSignal,
): Promise<ExtractedEntry[]> {
  let zf: yauzl.ZipFile;
  try {
    zf = await open(zipPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relative path|absolute path|invalid characters/iu.test(msg)) throw new UnsafeFileError("zip-path", PATH_REASON);
    throw new UnsafeFileError("zip-invalid", "The archive could not be read");
  }
  try {
    if (zf.entryCount > limits.maxEntries) throw new UnsafeFileError("zip-too-many-entries", `The archive has more than ${limits.maxEntries} files`);
    // First pass: names and declared sizes only.
    const entries: yauzl.Entry[] = [];
    let declared = 0;
    await new Promise<void>((res, rej) => {
      zf.on("error", rej);
      zf.on("end", res);
      zf.on("entry", (e: yauzl.Entry) => {
        if (unsafeName(e.fileName) || isSymlink(e)) return rej(new UnsafeFileError("zip-path", PATH_REASON));
        if (e.uncompressedSize > limits.maxEntryBytes) return rej(new UnsafeFileError("zip-entry-too-large", "A file inside the archive is larger than 50 MB"));
        declared += e.uncompressedSize;
        if (declared > limits.maxTotalBytes) return rej(new UnsafeFileError("zip-too-large", "The archive's contents are too large to import"));
        if (entries.length >= limits.maxEntries) return rej(new UnsafeFileError("zip-too-many-entries", `The archive has more than ${limits.maxEntries} files`));
        entries.push(e);
        zf.readEntry();
      });
      zf.readEntry();
    });
    await fsp.mkdir(destDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(destDir, 0o700);
    const base = resolve(destDir);
    const out: ExtractedEntry[] = [];
    let total = 0;
    for (const e of entries) {
      signal?.throwIfAborted();
      const name = e.fileName.replace(/\\/gu, "/");
      const segs = name.split("/").filter((x) => x !== "" && x !== ".");
      if (name.endsWith("/") || segs.length === 0) continue;
      const target = join(base, ...segs);
      const rel = relative(base, target);
      if (rel.startsWith("..") || rel.split(sep).includes("..")) throw new UnsafeFileError("zip-path", PATH_REASON);
      await fsp.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let bytes = 0;
      const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
        zf.openReadStream(e, (err, s) => (err || !s ? rej(new UnsafeFileError("zip-invalid", "A file inside the archive could not be read")) : res(s))),
      );
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          total += chunk.length;
          if (bytes > limits.maxEntryBytes) return cb(new UnsafeFileError("zip-entry-too-large", "A file inside the archive is larger than 50 MB"));
          if (total > limits.maxTotalBytes) return cb(new UnsafeFileError("zip-too-large", "The archive's contents are too large to import"));
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, counter, createWriteStream(target, { flags: "wx", mode: 0o600 }));
      } catch (err) {
        if (err instanceof UnsafeFileError) throw err;
        throw new UnsafeFileError("zip-invalid", "A file inside the archive could not be read");
      }
      out.push({ name: segs.join("/"), path: target, bytes });
    }
    return out;
  } catch (e) {
    if (e instanceof UnsafeFileError) throw e;
    if ((e as Error)?.name === "AbortError") throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/relative path|absolute path|invalid characters/iu.test(msg)) throw new UnsafeFileError("zip-path", PATH_REASON);
    throw new UnsafeFileError("zip-invalid", "The archive could not be read");
  } finally {
    zf.close();
  }
}
