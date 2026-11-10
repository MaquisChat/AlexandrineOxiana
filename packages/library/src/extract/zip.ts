/**
 * Bounded ZIP reading for EPUB and DOCX (R50): at most 10,000 entries, each at most 50 MB and all
 * together at most 200 MB uncompressed (as declared, and enforced while inflating), and no
 * absolute or `..` entry names. Violations throw UnsafeFileError; nothing is ever written to disk.
 */
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
