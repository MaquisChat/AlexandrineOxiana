/**
 * The destruction record as the audit log gives it (R147, R174, R175): how a project's audit events
 * fold into its destructions, and how the certificate and amendment files beside them are read.
 *
 * This is the part of retention.ts that only reads. It was moved here, unchanged, so that a restore
 * (export/backup.ts) can read the same record without importing the module that imports it: the
 * retry in retention.ts and the readers for a restore (restore-record.ts) both build on it, and it
 * imports neither of them.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent } from "@ao/core";
import { DESTRUCTION_CERTIFICATE } from "./repo/destroy.js";
import { decryptBytes } from "./repo/io.js";
import { ProjectLockedError, isLockedRefusal } from "./repo/errors.js";
import { projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";

/** `Backups/<file>`: how certificates, amendments and audit events name a backup. */
export const backupRel = (file: string) => `Backups/${file}`;
export const fileOf = (rel: string) => rel.slice("Backups/".length);
export const isBackupRel = (v: unknown): v is string => typeof v === "string" && /^Backups\/[^/\\]+$/u.test(v);
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** A destruction as the audit log records it: its fixed list, and what later events say became of each entry. */
export interface Audited {
  /** The certificate's file name in the project's `retention` folder, and its sha256 as written. */
  certificate: string;
  certificateSha256: string;
  at: string;
  /**
   * The project the data was destroyed in: this one, or, in a restored copy, the project the copy
   * was made from (the destruction is then inherited with the audit log, R175).
   */
  projectId: string;
  /** Listed backup → the sha256 the audit log recorded when that backup was made (none: the log does not record its making). */
  made: Map<string, string>;
  /** Decided at the destruction: backups that hold the destroyed files. */
  toRemove: string[];
  /** Backups that could not be read then and may hold them. */
  unreadable: string[];
  /** Listed backup → when the app removed it. */
  removed: Map<string, string>;
  /** Of those: removed by the app for another destruction of this project → that destruction's certificate (M3). */
  removedUnder: Map<string, string>;
  /** Listed backup → when it was noticed to be gone. */
  gone: Map<string, string>;
  /** Unreadable backup → when it was read and found to hold none of the destroyed files. */
  notHolding: Map<string, string>;
  /** Amendments written beside the certificate, oldest first. */
  amendments: Array<{ name: string; sha256: string; at: string }>;
  freshBackup?: string;
  freshBackupFailed?: string;
  /** When the audit log last heard of this destruction's backups (an amendment, a report or a summary). */
  lastRecordedAt?: string;
  /** The disagreement its last report gave, if that is what it was about. */
  reportedProblem?: string;
  /** Listed names a later backup was given: the listed file is gone (a name is never given while a file has it, R138 b). */
  reused: Set<string>;
}

export const newAudited = (projectId: string, certificate: string, certificateSha256: string, at: string, toRemove: string[], unreadable: string[]): Audited => ({
  certificate,
  certificateSha256,
  at,
  projectId,
  made: new Map(),
  toRemove,
  unreadable,
  removed: new Map(),
  removedUnder: new Map(),
  gone: new Map(),
  notHolding: new Map(),
  amendments: [],
  reused: new Set(),
});

export const listedIn = (a: Audited, f: string) => a.toRemove.includes(f) || a.unreadable.includes(f);
export const settledIn = (a: Audited, f: string) => a.removed.has(f) || a.gone.has(f) || a.notHolding.has(f);
/** The listed backups not yet verifiably gone (nor found not to hold the files). */
export const outstandingOf = (a: Audited): string[] => [...new Set([...a.toRemove, ...a.unreadable])].filter((f) => !settledIn(a, f));

/**
 * Folds audit events (in order) into the destructions they record. Only events written in the R147
 * form count: a destruction is its change's `delete` event naming the certificate, its sha256 and
 * the list; an entry leaves the list only by a later `delete` event (op `retention.backups`) for
 * the same certificate. The first record of a file stands: nothing is counted twice.
 */
export function auditedDestructions(events: Iterable<AuditEvent | null>): { list: Audited[]; certificateHashes: Set<string> } {
  const bySha = new Map<string, Audited>();
  const list: Audited[] = [];
  const certificateHashes = new Set<string>();
  /** Backup → the sha256 recorded when the backup of that name was last made. */
  const made = new Map<string, string>();
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const d = (e.details ?? {}) as Record<string, unknown>;
    if (e.action === "retention.destroyed" && typeof d.certificateSha256 === "string") certificateHashes.add(d.certificateSha256);
    if (e.action === "delete" && d.op === "retention.destroy") {
      if (typeof d.certificate !== "string" || !DESTRUCTION_CERTIFICATE.test(d.certificate) || typeof d.certificateSha256 !== "string") continue;
      certificateHashes.add(d.certificateSha256);
      if (bySha.has(d.certificateSha256)) continue;
      const a = newAudited(e.projectId ?? "", d.certificate, d.certificateSha256, e.at, strings(d.backupsToRemove).filter(isBackupRel), strings(d.backupsUnreadable).filter(isBackupRel));
      // Which file each listed name stood for at that moment: the backup last made under it.
      for (const f of a.toRemove) if (made.has(f)) a.made.set(f, made.get(f)!);
      bySha.set(a.certificateSha256, a);
      list.push(a);
      continue;
    }
    const a = typeof d.certificateSha256 === "string" ? bySha.get(d.certificateSha256) : undefined;
    if (a && e.action === "delete" && d.op === "retention.backups") {
      const at = typeof d.stepAt === "string" ? d.stepAt : e.at;
      const under = (d.removedUnder && typeof d.removedUnder === "object" ? d.removedUnder : {}) as Record<string, { certificate?: unknown; at?: unknown } | undefined>;
      for (const f of strings(d.removed)) {
        if (!listedIn(a, f) || settledIn(a, f)) continue;
        // Removed for another destruction of this project: at the time that one's record gives.
        const u = Object.hasOwn(under, f) ? under[f] : undefined;
        const elsewhere = typeof u?.certificate === "string" && typeof u.at === "string" ? { certificate: u.certificate, at: u.at } : undefined;
        a.removed.set(f, elsewhere?.at ?? at);
        if (elsewhere) a.removedUnder.set(f, elsewhere.certificate);
      }
      for (const f of strings(d.noLongerPresent)) if (listedIn(a, f) && !settledIn(a, f)) a.gone.set(f, at);
      for (const f of strings(d.notHolding)) if (a.unreadable.includes(f) && !settledIn(a, f)) a.notHolding.set(f, at);
      if (typeof d.amendment === "string" && typeof d.amendmentSha256 === "string") a.amendments.push({ name: d.amendment, sha256: d.amendmentSha256, at: e.at });
      if (typeof d.freshBackup === "string" && isBackupRel(d.freshBackup)) a.freshBackup ??= d.freshBackup;
      if (a.freshBackup) delete a.freshBackupFailed;
      else if (typeof d.freshBackupFailed === "string") a.freshBackupFailed = d.freshBackupFailed;
      a.lastRecordedAt = e.at;
      delete a.reportedProblem;
    } else if (a && e.action === "retention.backups") {
      a.lastRecordedAt = e.at;
      if (typeof d.problem === "string") a.reportedProblem = d.problem;
      else delete a.reportedProblem;
    } else if (e.action === "backup.create" && typeof d.file === "string") {
      const f = backupRel(d.file);
      for (const x of list) if (listedIn(x, f) && !settledIn(x, f)) x.reused.add(f);
      if (typeof d.sha256 === "string") made.set(f, d.sha256);
      else made.delete(f);
    }
  }
  return { list, certificateHashes };
}

/** A file in the retention folder as it is (decrypted when sealed): null when it is not there, "unreadable" when it cannot be opened. */
export async function readPlain(repo: Repo, projectId: string, rel: string): Promise<Buffer | null | "unreadable"> {
  let raw: Buffer;
  try {
    raw = await fsp.readFile(join(repoLibrary(repo).root, ...rel.split("/")));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  if (!rel.endsWith(".enc")) return raw;
  // Throws ProjectLockedError while the project is locked: nothing of it can be read then.
  const k = projectDataKey(repo, projectId);
  if (!k) return "unreadable";
  try {
    return await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
  } catch (err) {
    if (isLockedRefusal(err)) throw new ProjectLockedError(projectId); // locked mid-read, never "unreadable" (R404)
    return "unreadable";
  }
}

export function parseObject(buf: Buffer): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(buf.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** File names in the project's retention folder (none when it does not exist). */
export async function retentionNames(repo: Repo, dirRel: string): Promise<string[]> {
  try {
    return (await fsp.readdir(join(repoLibrary(repo).root, ...dirRel.split("/")))).sort();
  } catch {
    return [];
  }
}
