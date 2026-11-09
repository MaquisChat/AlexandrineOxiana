/** Small file and crypto helpers shared by the repository modules. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
export async function assertContained(base: string, target: string): Promise<void> {
  const baseStat = await fsp.lstat(base).catch(() => null);
  if (!baseStat || baseStat.isSymbolicLink()) throw new PathEscapeError(target);
  const realBase = await fsp.realpath(base);
  const t = await fsp.lstat(target).catch(() => null);
  if (t?.isSymbolicLink()) throw new PathEscapeError(target);
  let p = dirname(target);
  while (!(await exists(p))) {
    const up = dirname(p);
    if (up === p) throw new PathEscapeError(target);
    p = up;
  }
  const real = await fsp.realpath(p);
  if (real !== realBase && !real.startsWith(realBase + sep)) throw new PathEscapeError(target);
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
  let prevSize = 0;
  let created = false;
  try {
    const st = await fsp.lstat(path);
    if (st.isSymbolicLink()) throw new PathEscapeError(path);
    prevSize = st.size;
    if (st.isFile() && prevSize > 0 && !(await endsWithNewline(path, prevSize))) throw new TornFileError(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    created = true;
  }
  const undo = { path, prevSize, created };
  await onPlan?.(undo);
  const fh = await fsp.open(path, "a", mode);
  try {
    if (mode !== undefined && process.platform !== "win32") await fh.chmod(mode);
    await fh.write(text);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await undoAppend(undo).catch(() => {});
    throw err;
  }
  await fh.close();
  return undo;
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

export async function undoAppend(u: AppendUndo): Promise<void> {
  if (u.created) await fsp.rm(u.path, { force: true });
  else await fsp.truncate(u.path, u.prevSize);
}

/**
 * Seals one JSON line for an encrypted project's change log: AES-256-GCM under
 * the project data key, AAD = "ao-changes|" + projectId. Lines carry no plaintext entity data.
 */
export function sealLine(key: Uint8Array, keyId: string, projectId: string, json: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(`ao-changes|${projectId}`, "utf8"));
  const ct = Buffer.concat([c.update(json, "utf8"), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, alg: "aes-256-gcm", keyId, nonce: nonce.toString("base64"), ct: ct.toString("base64") });
}

export function openLine(key: Uint8Array, projectId: string, line: string): string {
  const o = JSON.parse(line) as { nonce: string; ct: string };
  const ct = Buffer.from(o.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(o.nonce, "base64"), { authTagLength: 16 });
  d.setAAD(Buffer.from(`ao-changes|${projectId}`, "utf8"));
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
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

/** Asset kind for an original file, from its extension. */
export function kindFor(ext: string): string {
  const mime = mimeFor(ext);
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/epub+zip") return "epub";
  for (const k of ["image", "video", "audio", "text"]) if (mime.startsWith(`${k}/`)) return k;
  return "file";
}
