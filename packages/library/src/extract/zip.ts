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
import { Transform, Writable } from "node:stream";
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

const YAUZL_OPTIONS = { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false, decodeStrings: true } as const;

/** A ZIP archive: a file path, or a random-access reader over its bytes (e.g. a sealed backup, R90 b). */
export type ZipSource = string | { reader: yauzl.RandomAccessReader; size: number };

const open = (src: ZipSource) =>
  new Promise<yauzl.ZipFile>((resolve, reject) => {
    const done = (err: Error | null, zf?: yauzl.ZipFile) => (err || !zf ? reject(err ?? new Error("cannot open")) : resolve(zf));
    if (typeof src === "string") yauzl.open(src, YAUZL_OPTIONS, done);
    else yauzl.fromRandomAccessReader(src.reader, src.size, YAUZL_OPTIONS, done);
  });

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
const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** A symbolic link entry (Unix mode in the external attributes). */
function isSymlink(e: yauzl.Entry): boolean {
  const made = (e.versionMadeBy >> 8) & 0xff;
  if (made !== 3 && made !== 19) return false; // Unix or OS X
  return ((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

export interface ExtractedEntry {
  /** The entry's name in the archive ("/"-separated). */
  name: string;
  /** Where it was written ("" when it was not: see `refused`). */
  path: string;
  bytes: number;
  /** Not written: the plain reason (a name that duplicates an earlier entry's, ignoring case). */
  refused?: string;
}

export const DUPLICATE_NAME_REASON = "duplicate name in archive";

export interface ExtractOptions {
  /** Runs after the names and declared sizes were checked, before anything is written (it may throw). */
  beforeWrite?: (declaredTotalBytes: number) => Promise<void>;
  /** Write runs of zeros as holes (sparse files), e.g. for restored backups. */
  sparse?: boolean;
}

const ZERO_RUN = 64 * 1024;
let zeros = Buffer.alloc(ZERO_RUN);

/** A new file (`wx`, 0600) written by position, where all-zero chunks become holes; its length is set at the end. */
async function sparseWriter(target: string): Promise<Writable> {
  const fh = await fsp.open(target, "wx", 0o600);
  let pos = 0;
  return new Writable({
    async write(chunk: Buffer, _enc, cb) {
      try {
        if (chunk.length > zeros.length) zeros = Buffer.alloc(chunk.length);
        if (chunk.compare(zeros, 0, chunk.length) !== 0) {
          for (let off = 0; off < chunk.length; ) off += (await fh.write(chunk, off, chunk.length - off, pos + off)).bytesWritten;
        }
        pos += chunk.length;
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    async final(cb) {
      try {
        await fh.truncate(pos);
        await fh.sync();
        await fh.close();
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    async destroy(err, cb) {
      await fh.close().catch(() => {});
      cb(err);
    },
  });
}

/**
 * One entry's bytes (at most `maxBytes`) from an archive, or undefined when it has no such entry
 * (backup.json of a backup, R92 I2). Only the central directory is walked; nothing is written.
 */
export async function readArchiveEntry(src: ZipSource, name: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer | undefined> {
  const zf = await open(src);
  try {
    const entry = await new Promise<yauzl.Entry | undefined>((res, rej) => {
      zf.on("error", rej);
      zf.on("end", () => res(undefined));
      zf.on("entry", (e: yauzl.Entry) => (e.fileName === name ? res(e) : zf.readEntry()));
      zf.readEntry();
    });
    if (!entry || entry.uncompressedSize > maxBytes) return undefined;
    const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zf.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error("unreadable")) : res(s))));
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    return Buffer.concat(chunks);
  } finally {
    zf.close();
  }
}
const SIZE_MISMATCH_REASON = "A file inside the archive is larger than it says it is";

/**
 * Unpacks `zipPath` into `destDir` (created 0700; files 0600). Every entry is checked before
 * anything is written: a traversal, absolute or symbolic-link name, or a limit exceeded refuses the
 * whole archive with UnsafeFileError (what was written so far is the caller's to remove: it lives
 * in the caller's private work folder). `limits` is a test seam.
 */
export async function extractArchive(
  zipPath: ZipSource,
  destDir: string,
  limits: { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number } = ARCHIVE_LIMITS,
  signal?: AbortSignal,
  opts: ExtractOptions = {},
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
        if (e.uncompressedSize > limits.maxEntryBytes) return rej(new UnsafeFileError("zip-entry-too-large", `A file inside the archive is larger than ${mb(limits.maxEntryBytes)}`));
        declared += e.uncompressedSize;
        if (declared > limits.maxTotalBytes) return rej(new UnsafeFileError("zip-too-large", "The archive's contents are too large to import"));
        if (entries.length >= limits.maxEntries) return rej(new UnsafeFileError("zip-too-many-entries", `The archive has more than ${limits.maxEntries} files`));
        entries.push(e);
        zf.readEntry();
      });
      zf.readEntry();
    });
    // Before anything is written (e.g. a restore checks free space against the declared total).
    try {
      await opts.beforeWrite?.(declared);
    } catch (err) {
      throw new HookError(err);
    }
    await fsp.mkdir(destDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fsp.chmod(destDir, 0o700);
    const base = resolve(destDir);
    const out: ExtractedEntry[] = [];
    let total = 0;
    /** Names written so far, compared the way case-insensitive file systems do. */
    const written = new Set<string>();
    for (const e of entries) {
      signal?.throwIfAborted();
      const name = e.fileName.replace(/\\/gu, "/");
      const segs = name.split("/").filter((x) => x !== "" && x !== ".");
      if (name.endsWith("/") || segs.length === 0) continue;
      const folded = segs.join("/").normalize("NFC").toLowerCase();
      if (written.has(folded)) {
        // Two entries that would be one file: the later one is not imported (only it fails).
        out.push({ name: segs.join("/"), path: "", bytes: 0, refused: DUPLICATE_NAME_REASON });
        continue;
      }
      written.add(folded);
      const target = join(base, ...segs);
      const rel = relative(base, target);
      if (rel.startsWith("..") || rel.split(sep).includes("..")) throw new UnsafeFileError("zip-path", PATH_REASON);
      await fsp.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let bytes = 0;
      // R454: the entry's stream reads (yauzl pipes it into the inflater) as soon as it is opened, so nothing is awaited
      // between opening it and handing it to `pipeline`, or its error has no listener: the sparse target first.
      const sparse = opts.sparse ? await sparseWriter(target) : undefined;
      let stream: NodeJS.ReadableStream;
      try {
        stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
          zf.openReadStream(e, (err, s) => (err || !s ? rej(new UnsafeFileError("zip-invalid", "A file inside the archive could not be read")) : res(s))),
        );
      } catch (err) {
        sparse?.destroy();
        throw err;
      }
      const declaredSize = e.uncompressedSize;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          total += chunk.length;
          // Bomb protection by actual bytes: never more than the entry, or the archive, declared.
          if (bytes > declaredSize || total > declared) return cb(new UnsafeFileError("zip-entry-too-large", SIZE_MISMATCH_REASON));
          if (bytes > limits.maxEntryBytes) return cb(new UnsafeFileError("zip-entry-too-large", `A file inside the archive is larger than ${mb(limits.maxEntryBytes)}`));
          if (total > limits.maxTotalBytes) return cb(new UnsafeFileError("zip-too-large", "The archive's contents are too large to import"));
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, counter, sparse ?? createWriteStream(target, { flags: "wx", mode: 0o600 }));
      } catch (err) {
        if (err instanceof UnsafeFileError) throw err;
        // yauzl checks inflated sizes against the declared ones: more bytes than declared is a bomb.
        if (/too many bytes/iu.test(err instanceof Error ? err.message : String(err))) throw new UnsafeFileError("zip-entry-too-large", SIZE_MISMATCH_REASON);
        throw new UnsafeFileError("zip-invalid", "A file inside the archive could not be read");
      }
      out.push({ name: segs.join("/"), path: target, bytes });
    }
    return out;
  } catch (e) {
    if (e instanceof HookError) throw e.inner; // the caller's own refusal, as it was thrown
    if (e instanceof UnsafeFileError) throw e;
    if ((e as Error)?.name === "AbortError") throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/relative path|absolute path|invalid characters/iu.test(msg)) throw new UnsafeFileError("zip-path", PATH_REASON);
    throw new UnsafeFileError("zip-invalid", "The archive could not be read");
  } finally {
    zf.close();
  }
}

class HookError extends Error {
  constructor(readonly inner: unknown) {
    super("beforeWrite refused");
  }
}
