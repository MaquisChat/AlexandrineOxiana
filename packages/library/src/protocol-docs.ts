/**
 * Protocol approval documents (spec 6.3(9), Task 36): files the researcher drops onto the protocol
 * record are copied into `<Project>/protocol/`, sealed with the project key (`<name>.enc`) when the
 * project is encrypted. Each copy is one governed change, audited as `protocol.document` without
 * the file's name. Nothing is ever overwritten: a name already used gets " (2)", " (3)", ….
 */
import * as fsp from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { InvalidInputError } from "./repo/errors.js";
import { projectEncrypted, repoLibrary, type Repo } from "./repo/repo.js";

export interface ProtocolDocument {
  /** The document's name (without the `.enc` of an encrypted copy). */
  name: string;
  /** Size of the file as dropped (plaintext bytes) on add; size on disk when listed. */
  bytes: number;
  encrypted: boolean;
}

const MAX_NAME = 200;
// eslint-disable-next-line no-control-regex
const BAD_NAME = /[\u0000-\u001f\u007f/\\:*?"<>|]/u;

function folderOf(repo: Repo, projectId: string): { rel: string; abs: string } {
  const rel = `${repo.getProject(projectId).folder}/protocol`;
  return { rel, abs: join(repoLibrary(repo).root, ...rel.split("/")) };
}

async function existingNames(abs: string): Promise<Array<{ file: string; name: string; encrypted: boolean }>> {
  let names: string[];
  try {
    names = await fsp.readdir(abs);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith("."))
    .map((file) => (file.endsWith(".enc") ? { file, name: file.slice(0, -4), encrypted: true } : { file, name: file, encrypted: false }));
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

/** The project's protocol documents, by name. */
export async function listProtocolDocuments(repo: Repo, projectId: string): Promise<ProtocolDocument[]> {
  const { abs } = folderOf(repo, projectId);
  const out: ProtocolDocument[] = [];
  for (const e of await existingNames(abs)) {
    const st = await fsp.lstat(join(abs, e.file)).catch(() => null);
    if (st?.isFile()) out.push({ name: e.name, bytes: st.size, encrypted: e.encrypted });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Copies `paths` (absolute paths of regular files) into the project's protocol folder. Every path
 * is checked before anything is copied: a folder, a symbolic link or a missing file refuses the
 * whole drop (InvalidInputError).
 */
export async function addProtocolDocuments(repo: Repo, projectId: string, paths: string[]): Promise<ProtocolDocument[]> {
  if (!paths.length) throw new InvalidInputError("Drop at least one document");
  for (const p of paths) {
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) throw new InvalidInputError(`${basename(p)} could not be found`);
    if (st.isSymbolicLink()) throw new InvalidInputError(`${basename(p)} is a shortcut (symbolic link); drop the document itself`);
    if (!st.isFile()) throw new InvalidInputError(`${basename(p)} is not a file; drop documents, not folders`);
    const name = basename(p);
    if (!name || name.length > MAX_NAME || BAD_NAME.test(name) || name.startsWith(".")) {
      throw new InvalidInputError("A document name is not usable; rename the file and drop it again");
    }
  }
  const { rel, abs } = folderOf(repo, projectId);
  const encrypted = projectEncrypted(repo, projectId);
  const out: ProtocolDocument[] = [];
  for (const p of paths) {
    const taken = new Set((await existingNames(abs)).map((e) => e.name.toLowerCase()));
    const name = uniqueName(basename(p), taken);
    const r = await repo.mutate(
      projectId,
      { action: "store", store: { identifiable: false, hasLocation: false } },
      async (tx) => {
        if (!(await tx.exists(rel))) await tx.mkdir(rel);
        return tx.copyFile(p, `${rel}/${name}${tx.encrypted ? ".enc" : ""}`, { encrypt: tx.encrypted, noFollow: true });
      },
      { op: "protocol.document", entity: { type: "project", id: projectId } },
    );
    out.push({ name, bytes: r.bytes, encrypted });
  }
  return out;
}
