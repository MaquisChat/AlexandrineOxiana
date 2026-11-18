/**
 * Protocol approval documents (spec 6.3(9), Task 36, R117 I6): files the researcher drops onto the
 * protocol record are copied into `<Project>/protocol/`.
 *
 * - Never a file inside the open library's own folder (by real path, links followed; R368 b).
 * - Only PDF, Word (DOCX), OpenDocument text, plain text and images (by content, not by name), each
 *   at most 100 MB, regular files only (no folder or symbolic link).
 * - Unencrypted projects keep the document's name; a name in use gets " (2)", " (3)", ….
 * - Encrypted projects store each document sealed under a generated name (`doc-<id>.enc`); the
 *   real name is kept only in the sealed `manifest.json.enc` beside them.
 * - Each document is one governed change, audited as `protocol.document` without its name; the
 *   name is chosen inside that change (so two drops at once never collide), and every file dropped
 *   gets its own result.
 */
import * as fsp from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileTypeFromFile } from "file-type";
import { newId } from "@ao/core";
import { InvalidInputError, PolicyDeniedError, ProjectLockedError, ReadOnlyLibraryError, RecoveryPendingError, isLockedRefusal } from "./repo/errors.js";
import { decryptBytes, readMaybe } from "./repo/io.js";
import type { Tx } from "./repo/mutate.js";
import { noteIntegrityWarning, projectDataKey, projectEncrypted, repoLibrary, type Repo } from "./repo/repo.js";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { insideLibrary } from "./fs/inside-library.js";

/** Test seam (package-internal): a smaller cap for the check made on what was copied. */
export const protocolSeams: { copyMaxBytes?: number } = {};

const MANIFEST_UNREADABLE =
  "The names of the protocol documents cannot be read (their sealed list is damaged). The documents themselves are kept; nothing is added until the list is repaired";

export interface ProtocolDocument {
  /** The document's name as dropped (made unique). */
  name: string;
  /** Size of the file as dropped (plaintext bytes) on add; size on disk when listed. */
  bytes: number;
  encrypted: boolean;
}

export interface ProtocolDocumentResult {
  /** The dropped file's name. */
  file: string;
  outcome: "added" | "failed";
  document?: ProtocolDocument;
  /** Why it was not added (plain language). */
  reason?: string;
}

export const PROTOCOL_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
const MANIFEST = "manifest.json.enc";
const MAX_NAME = 200;
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\u007f/\\:*?"<>|]/u;
const ALLOWED_EXT = new Set(["pdf", "docx", "odt"]);
const KIND_REASON = "Only a PDF, Word, OpenDocument, plain text or an image can be added as a protocol document.";

interface Manifest {
  formatVersion: 1;
  documents: Record<string, { name: string; bytes: number; addedAt: string }>;
}

function folderOf(repo: Repo, projectId: string): { rel: string; abs: string } {
  const rel = `${repo.getProject(projectId).folder}/protocol`;
  return { rel, abs: join(repoLibrary(repo).root, ...rel.split("/")) };
}

/** The sealed names list; a damaged one is a plain error and an integrity warning (R119), never replaced. */
async function readManifest(repo: Repo, projectId: string, abs: string, key: { key: Uint8Array; keyId: string }): Promise<Manifest> {
  const raw = await readMaybe(join(abs, MANIFEST));
  if (!raw) return { formatVersion: 1, documents: {} };
  try {
    const plain = await decryptBytes((id) => (id === key.keyId ? key.key : undefined), raw);
    const m = JSON.parse(plain.toString("utf8")) as Manifest;
    if (m?.formatVersion !== 1 || typeof m.documents !== "object" || m.documents === null) throw new Error("not a manifest");
    return m;
  } catch (err) {
    // A key a lock wiped mid-read: the project is locked, the list is not damaged (R404); no warning is noted.
    if (isLockedRefusal(err)) throw new ProjectLockedError(projectId);
    noteIntegrityWarning(repo, { projectId, kind: "protocol-manifest-unreadable", detail: "the sealed list of protocol document names cannot be read" });
    throw new InvalidInputError(MANIFEST_UNREADABLE);
  }
}

async function plainNames(abs: string): Promise<string[]> {
  try {
    return (await fsp.readdir(abs)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

function uniqueName(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const ext = extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** Plain text: UTF-8 without NUL or other binary control bytes. */
async function isPlainText(path: string): Promise<boolean> {
  const buf = await fsp.readFile(path);
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0001-\u0008\u000e-\u001f\u007f]/u.test(buf.toString("utf8"));
}

/** Why the file cannot be a protocol document, or undefined when it can. */
async function refusal(repo: Repo, path: string): Promise<string | undefined> {
  const name = basename(path);
  // R368 b: nothing inside the library's own folder (before the file is looked at).
  if (await insideLibrary(path, repoLibrary(repo))) return IN_LIBRARY_TEXT.file;
  const st = await fsp.lstat(path).catch(() => null);
  if (!st) return `${name} could not be found.`;
  if (st.isSymbolicLink()) return `${name} is a shortcut (symbolic link); drop the document itself.`;
  if (!st.isFile()) return `${name} is not a file; drop documents, not folders.`;
  if (st.size > PROTOCOL_DOCUMENT_MAX_BYTES) return TOO_LARGE(name);
  if (!name || name.length > MAX_NAME || BAD_NAME.test(name) || name.startsWith(".")) return "This document's name is not usable; rename the file and drop it again.";
  const type = await fileTypeFromFile(path).catch(() => undefined);
  if (type) {
    const mime = type.mime.toLowerCase();
    if (ALLOWED_EXT.has(type.ext) || (mime.startsWith("image/") && mime !== "image/svg+xml")) return undefined;
    return KIND_REASON;
  }
  if (extname(name).toLowerCase() === ".txt" && (await isPlainText(path))) return undefined;
  return KIND_REASON;
}

/** The project's protocol documents, by name. An encrypted project must be unlocked (the names are sealed). */
export async function listProtocolDocuments(repo: Repo, projectId: string): Promise<ProtocolDocument[]> {
  const { abs } = folderOf(repo, projectId);
  const out: ProtocolDocument[] = [];
  if (projectEncrypted(repo, projectId)) {
    const key = projectDataKey(repo, projectId); // throws ProjectLockedError when locked
    if (!key) return [];
    const m = await readManifest(repo, projectId, abs, key);
    for (const [file, d] of Object.entries(m.documents)) {
      const st = await fsp.lstat(join(abs, file)).catch(() => null);
      if (st?.isFile()) out.push({ name: d.name, bytes: d.bytes, encrypted: true });
    }
  } else {
    for (const file of await plainNames(abs)) {
      const st = await fsp.lstat(join(abs, file)).catch(() => null);
      if (st?.isFile()) out.push({ name: file, bytes: st.size, encrypted: false });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const TOO_LARGE = (name: string) => `${name} is larger than 100 MB.`;
class TooLargeError extends Error {}

/**
 * The cap applies to the bytes actually copied too (a file can grow after it was checked): over it,
 * the change fails and rolls back, so nothing of the file is kept (R119).
 */
function assertCopiedSize(bytes: number): void {
  if (bytes > (protocolSeams.copyMaxBytes ?? PROTOCOL_DOCUMENT_MAX_BYTES)) throw new TooLargeError();
}

async function addOne(repo: Repo, projectId: string, path: string): Promise<ProtocolDocument> {
  const { rel, abs } = folderOf(repo, projectId);
  const wanted = basename(path);
  return repo.mutate(
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx: Tx) => {
      if (!(await tx.exists(rel))) await tx.mkdir(rel);
      if (tx.encrypted) {
        const key = tx.key();
        const m = await readManifest(repo, projectId, abs, key);
        const name = uniqueName(wanted, new Set(Object.values(m.documents).map((d) => d.name.toLowerCase())));
        const file = `doc-${newId()}.enc`;
        const r = await tx.copyFile(path, `${rel}/${file}`, { encrypt: true, noFollow: true });
        assertCopiedSize(r.bytes);
        m.documents[file] = { name, bytes: r.bytes, addedAt: tx.at };
        await tx.writeFile(`${rel}/${MANIFEST}`, JSON.stringify(m), { encrypt: true, mode: 0o600 });
        return { name, bytes: r.bytes, encrypted: true };
      }
      const name = uniqueName(wanted, new Set((await plainNames(abs)).map((n) => n.toLowerCase())));
      const r = await tx.copyFile(path, `${rel}/${name}`, { noFollow: true });
      assertCopiedSize(r.bytes);
      return { name, bytes: r.bytes, encrypted: false };
    },
    { op: "protocol.document", entity: { type: "project", id: projectId } },
  );
}

/**
 * Copies `paths` (absolute paths) into the project's protocol folder, one governed change per
 * document; returns one result per path, in order, whatever fails (refusals, policy, IO errors).
 */
export async function addProtocolDocuments(repo: Repo, projectId: string, paths: string[]): Promise<ProtocolDocumentResult[]> {
  const out: ProtocolDocumentResult[] = [];
  for (const path of paths) {
    const file = basename(path);
    const why = await refusal(repo, path);
    if (why) {
      out.push({ file, outcome: "failed", reason: why });
      continue;
    }
    try {
      out.push({ file, outcome: "added", document: await addOne(repo, projectId, path) });
    } catch (err) {
      // Every file keeps its own result, whatever happens to one of them (R119).
      const reason =
        err instanceof TooLargeError
          ? TOO_LARGE(file)
          : err instanceof PolicyDeniedError
            ? err.reason
            : err instanceof ProjectLockedError
              ? "The project is locked. Unlock it, then try again."
              : err instanceof InvalidInputError
                ? err.message
                : err instanceof RecoveryPendingError
                  ? "The project refuses changes until an interrupted change is resolved; nothing of this file was kept."
                  : err instanceof ReadOnlyLibraryError
                    ? "The library is open read-only, so nothing can be added."
                    : `${file} could not be copied (a file or disk error); nothing of it was kept.`;
      out.push({ file, outcome: "failed", reason });
    }
  }
  return out;
}
