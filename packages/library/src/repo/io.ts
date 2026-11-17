/** Small file and crypto helpers shared by the repository modules. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { LibraryRelativePath } from "@ao/core";
import { decryptStream, encryptStream } from "../crypto/format.js";
import { PathEscapeError, TornFileError } from "./errors.js";

/** Absolute path of a library-relative path; validates it first. */
export function absPath(root: string, rel: string): string {
  LibraryRelativePath.parse(rel);
  return join(root, ...rel.split("/"));
}

export async function readMaybe(path: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Throws PathEscapeError unless writing, replacing or removing `target` stays
 * inside `base`: `target` itself must not be a symbolic link, and the real path
 * of its nearest existing ancestor folder must lie inside the real path of
 * `base` (which itself must not be a symbolic link).
 */
export async function assertContained(base: string, target: string, cache?: ContainmentCache): Promise<void> {
  let realBase = cache?.realBase;
  if (realBase === undefined) {
    const baseStat = await fsp.lstat(base).catch(() => null);
    if (!baseStat || baseStat.isSymbolicLink()) throw new PathEscapeError(target);
    realBase = await fsp.realpath(base);
    if (cache) cache.realBase = realBase;
  }
  const t = await fsp.lstat(target).catch(() => null);
  if (t?.isSymbolicLink()) throw new PathEscapeError(target);
  let p = dirname(target);
  if (cache?.dirs.has(p)) return;
  while (!(await exists(p))) {
    const up = dirname(p);
    if (up === p) throw new PathEscapeError(target);
    p = up;
  }
  const real = await fsp.realpath(p);
  if (real !== realBase && !real.startsWith(realBase + sep)) throw new PathEscapeError(target);
  // Only a folder that exists and was checked is remembered (one that did not exist yet is checked
  // again once it does).
  if (cache && p === dirname(target)) cache.dirs.add(p);
}

/**
 * Per-transaction memo for assertContained: the base's real path and the folders already found
 * inside it. Within one transaction (which holds the repository's write lock) a checked folder
 * stays checked; the target itself is still checked for being a symbolic link every time.
 */
export interface ContainmentCache {
  realBase?: string;
  dirs: Set<string>;
}

/** Lower-cased NFC names in `dir` (empty when missing), for case-insensitive collision checks. */
export async function namesIn(dir: string): Promise<Set<string>> {
  try {
    return new Set((await fsp.readdir(dir)).map(foldName));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
}

/** How file systems on macOS/Windows compare names: case- and normalization-insensitive. */
export function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

async function collect(stream: NodeJS.ReadWriteStream, data: Uint8Array): Promise<Buffer> {
  const parts: Buffer[] = [];
  stream.on("data", (c: Buffer) => parts.push(c));
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve).on("error", reject);
    stream.end(data);
  });
  return Buffer.concat(parts);
}

/** Whole-buffer encryption in the v1 file format (for small files such as source.json.enc). */
export function encryptBytes(key: Uint8Array, keyId: string, data: Uint8Array | string): Promise<Buffer> {
  return collect(encryptStream(key, keyId), typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

export function decryptBytes(getKey: (keyId: string) => Uint8Array | undefined, data: Uint8Array): Promise<Buffer> {
  return collect(decryptStream(getKey), data);
}

/** Undo information for an append: truncate back to `prevSize`, or remove the file if we created it. */
export interface AppendUndo {
  path: string;
  prevSize: number;
  created: boolean;
}

/**
 * Appends `text` and fsyncs. On failure the file is truncated back before rethrowing.
 * `onPlan` receives the undo information before anything is written (write-ahead marker).
 */
export async function appendDurable(
  path: string,
  text: string,
  mode?: number,
  onPlan?: (u: AppendUndo) => Promise<void>,
): Promise<AppendUndo> {
  // Small appends (log lines) are done with synchronous calls: one thread-pool round trip per
  // call would cost more than the write itself. The steps and guarantees are the same.
  let prevSize = 0;
  let created = false;
  try {
    const st = fs.lstatSync(path);
    if (st.isSymbolicLink()) throw new PathEscapeError(path);
    prevSize = st.size;
    if (st.isFile() && prevSize > 0 && !endsWithNewlineSync(path, prevSize)) throw new TornFileError(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    created = true;
  }
  const undo = { path, prevSize, created };
  await onPlan?.(undo);
  const fd = fs.openSync(path, "a", mode);
  try {
    if (mode !== undefined && process.platform !== "win32") fs.fchmodSync(fd, mode);
    // A write can be cut short (a full disk writes part of it and says how much): the rest is written, and the
    // next write's error (ENOSPC) undoes the whole append below, so no torn line is left (R393 c).
    const bytes = Buffer.from(text, "utf8");
    for (let off = 0; off < bytes.length; ) {
      const n = fs.writeSync(fd, bytes, off, bytes.length - off);
      // R436 f: a write that takes nothing of a non-empty buffer would never end: it fails, and the append is undone.
      if (n <= 0) throw new Error("a write to the file wrote nothing");
      off += n;
    }
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // closing failed too
    }
    await undoAppend(undo).catch(() => {});
    throw err;
  }
  fs.closeSync(fd);
  return undo;
}

function endsWithNewlineSync(path: string, size: number): boolean {
  const fd = fs.openSync(path, "r");
  try {
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

async function endsWithNewline(path: string, size: number): Promise<boolean> {
  const fh = await fsp.open(path, "r");
  try {
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

/**
 * The incomplete last line of a regular file: the bytes after its last newline
 * (`keep` is where they start). `null` when the file is missing, empty, not a
 * regular file, or ends with a newline. Per R28 such a line is not a committed
 * record: a record exists only once its whole line and newline are written.
 */
export async function incompleteTail(path: string): Promise<{ keep: number; tail: Buffer } | null> {
  const st = await fsp.lstat(path).catch(() => null);
  if (!st?.isFile() || st.size === 0 || (await endsWithNewline(path, st.size))) return null;
  const data = await fsp.readFile(path);
  if (data.length === 0 || data[data.length - 1] === 0x0a) return null;
  const keep = data.lastIndexOf(0x0a) + 1;
  return { keep, tail: data.subarray(keep) };
}

/** Durably cuts `path` back to `size` bytes. */
export async function truncateDurable(path: string, size: number): Promise<void> {
  const fh = await fsp.open(path, "r+");
  try {
    await fh.truncate(size);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function undoAppend(u: AppendUndo): Promise<void> {
  if (u.created) await fsp.rm(u.path, { force: true });
  else await fsp.truncate(u.path, u.prevSize);
}

/**
 * Seals one JSON line for an encrypted project's change log: AES-256-GCM under
 * the project data key, AAD = "ao-changes|" + projectId. Lines carry no plaintext entity data.
 */
/** Seals one JSON line with the project key; `purpose` binds it to its file kind (AAD `<purpose>|<projectId>`). */
export function sealLine(key: Uint8Array, keyId: string, projectId: string, json: string, purpose = "ao-changes"): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(`${purpose}|${projectId}`, "utf8"));
  const ct = Buffer.concat([c.update(json, "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, alg: "aes-256-gcm", keyId, nonce: nonce.toString("base64"), ct: ct.toString("base64") });
}

export function openLine(key: Uint8Array, projectId: string, line: string, purpose = "ao-changes"): string {
  const o = JSON.parse(line) as { nonce: string; ct: string };
  const ct = Buffer.from(o.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(o.nonce, "base64"), { authTagLength: 16 });
  d.setAAD(Buffer.from(`${purpose}|${projectId}`, "utf8"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
}

/** Deep copy without `undefined` object keys (sealEvent rejects nested undefined, R13). */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as T;
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = stripUndefined(x);
    return out as T;
  }
  return v;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  json: "application/json",
  vtt: "text/vtt",
  srt: "application/x-subrip",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  mobi: "application/x-mobipocket-ebook",
  azw: "application/vnd.amazon.ebook",
  azw3: "application/vnd.amazon.mobi8-ebook",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
  cr2: "image/x-canon-cr2",
  cr3: "image/x-canon-cr3",
  dng: "image/x-adobe-dng",
  nef: "image/x-nikon-nef",
  arw: "image/x-sony-arw",
  orf: "image/x-olympus-orf",
  rw2: "image/x-panasonic-rw2",
  raf: "image/x-fujifilm-raf",
  mkv: "video/x-matroska",
  avi: "video/vnd.avi",
  m4v: "video/x-m4v",
  "3gp": "video/3gpp",
  mpg: "video/mpeg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
  oga: "audio/ogg",
  ogv: "video/ogg",
  spx: "audio/ogg",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  amr: "audio/amr",
  m4b: "audio/mp4",
  mp2: "audio/mpeg",
  mts: "video/mp2t",
  m2ts: "video/mp2t",
  asf: "video/x-ms-asf",
  "3g2": "video/3gpp2",
  flv: "video/x-flv",
  apng: "image/apng",
  jxl: "image/jxl",
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

/** Asset kind for an original file, from its extension. */
export function kindFor(ext: string): string {
  const mime = mimeFor(ext);
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/epub+zip") return "epub";
  if (mime === "application/x-mobipocket-ebook" || mime.startsWith("application/vnd.amazon.")) return "ebook";
  for (const k of ["image", "video", "audio", "text"]) if (mime.startsWith(`${k}/`)) return k;
  return "file";
}
