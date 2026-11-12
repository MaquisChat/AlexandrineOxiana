/**
 * What a restore reads of the destruction record (Task 50b; R174 d, R175): which files must not be
 * brought back, and which backups a restored copy inherits as still to be removed. Readers only:
 * nothing here removes a backup or writes to an audit log. Built on destruction-record.ts (the fold
 * of audit events into destructions, shared with the retry in retention.ts); it imports neither
 * retention.ts nor export/backup.ts, so the restore in backup.ts can use it.
 */
import type { AuditEvent, Project } from "@ao/core";
import { auditedDestructions, outstandingOf, parseObject, readPlain, retentionNames, sha256, strings } from "./destruction-record.js";
import { DESTRUCTION_CERTIFICATE } from "./repo/destroy.js";
import { ProjectLockedError } from "./repo/errors.js";
import { auditHeadOf, verifiedAuditEvents, verifiedAuditEventsInQueue, type Repo } from "./repo/repo.js";
import { DestructionRecordError, type DestroyedRecord } from "./repo/restore.js";

type Head = { seq: number; hash: string } | null;
const sameHead = (a: Head, b: Head) => (a?.seq ?? 0) === (b?.seq ?? 0) && (a?.hash ?? "") === (b?.hash ?? "");

/** What one project's audit log says was destroyed, and the head of the log it was read at. */
interface ProjectDestroyed {
  head: Head;
  byId: Array<[string, string]>;
  bySha256: Array<[string, string]>;
  notes: string[];
}

/**
 * Package-internal (restore): what the destructions recorded in this library say a restore must not
 * bring back, with each project's part kept so the commit turn reads again only what changed since.
 */
export interface DestroyedOnRecord extends DestroyedRecord {
  byId: Map<string, string>;
  bySha256: Map<string, string>;
  notes: string[];
  projects: Map<string, ProjectDestroyed>;
}

const LOG_UNREADABLE_FOR_RESTORE = (name: string) =>
  `The audit log of the project "${name}" does not hold together: an entry was changed or removed outside the app, or the log is not as the app left it. The app cannot tell from it which files were destroyed under a retention rule, so nothing was restored.`;

/**
 * Package-internal (restore, R174 d): what a restore must not bring back, as the audit logs of this
 * library's projects record it. Every project's log is read in full and its chain verified (the
 * reading the retry makes before it removes anything); a destruction is its change's own audit
 * entry, as `auditedDestructions` reads it. From each recorded destruction:
 *   - the ids of the destroyed assets, which that entry names itself (`destroyedAssets`): known
 *     whatever became of the certificate file (deleted, edited), and without a locked project's key;
 *   - the sha256 of each destroyed file, from the certificate, only when the file on disk is byte
 *     for byte the one the entry recorded (so the same file kept under other ids, in a copy made by
 *     an earlier restore, is left out as well).
 * A certificate file the audit log does not record (added, forged) counts for nothing, and is said.
 * The app does not guess: while a project's audit log does not hold together, or records a
 * destruction without naming its files while the certificate does not verify either, this throws
 * DestructionRecordError (plain words) and nothing is restored.
 * `inQueue`: the caller holds the write queue (the restore's commit turn). `prior`: an earlier
 * reading, reused for each project whose audit log still ends where it did then.
 */
export async function destroyedOnRecord(repo: Repo, opts: { inQueue?: boolean; prior?: DestroyedOnRecord } = {}): Promise<DestroyedOnRecord> {
  const out: DestroyedOnRecord = { byId: new Map(), bySha256: new Map(), notes: [], projects: new Map() };
  for (const p of repo.listProjects()) {
    let mine = opts.prior?.projects.get(p.id);
    if (!mine || !sameHead(mine.head, auditHeadOf(repo, p.id))) {
      const read = opts.inQueue ? await verifiedAuditEventsInQueue(repo, p.id) : await verifiedAuditEvents(repo, p.id);
      if (!read.ok) throw new DestructionRecordError(LOG_UNREADABLE_FOR_RESTORE(p.name), p.id, true);
      mine = await destroyedIn(repo, p, read.events);
    }
    out.projects.set(p.id, mine);
    for (const [id, at] of mine.byId) if (!out.byId.has(id)) out.byId.set(id, at);
    for (const [hash, at] of mine.bySha256) if (!out.bySha256.has(hash)) out.bySha256.set(hash, at);
    out.notes.push(...mine.notes);
  }
  return out;
}

/** One project's part of `destroyedOnRecord`, from its verified audit events. */
async function destroyedIn(repo: Repo, p: Project, events: AuditEvent[]): Promise<ProjectDestroyed> {
  const last = events.at(-1);
  const out: ProjectDestroyed = { head: last ? { seq: last.seq, hash: last.hash } : null, byId: [], bySha256: [], notes: [] };
  const { list, certificateHashes } = auditedDestructions(events);
  const dirRel = `${p.folder}/retention`;
  const names = await retentionNames(repo, dirRel);
  const read = async (name: string): Promise<Buffer | null | "unreadable" | "locked"> => {
    try {
      return await readPlain(repo, p.id, `${dirRel}/${name}`);
    } catch (err) {
      return err instanceof ProjectLockedError ? "locked" : "unreadable";
    }
  };
  /** The assets a verified certificate lists; false when it does not say when. */
  const take = (buf: Buffer, at?: string): boolean => {
    const c = parseObject(buf);
    const when = typeof c?.at === "string" ? c.at : at;
    if (when === undefined) return false;
    for (const a of Array.isArray(c?.assets) ? (c.assets as Array<{ assetId?: unknown; sha256?: unknown } | null>) : []) {
      if (typeof a?.assetId === "string") out.byId.push([a.assetId, when]);
      if (typeof a?.sha256 === "string") out.bySha256.push([a.sha256, when]);
    }
    return true;
  };
  // What each destruction's own audit entry names as destroyed (the first entry for a certificate
  // stands, as in the fold; an entry recorded late from a mark is never one: its action differs).
  const named = new Map<string, string[]>();
  for (const e of events) {
    const d = (e?.details ?? {}) as Record<string, unknown>;
    if (e?.action !== "delete" || d.op !== "retention.destroy" || typeof d.certificateSha256 !== "string" || !Array.isArray(d.destroyedAssets)) continue;
    if (!named.has(d.certificateSha256)) named.set(d.certificateSha256, strings(d.destroyedAssets));
  }
  const cannotTell = (which: string, why: string, locked: boolean) =>
    new DestructionRecordError(
      `The audit log of the project "${p.name}" records a destruction of raw data${which} without naming the files that were destroyed, and the certificate ${why}. The app cannot tell which files must not be brought back, so nothing was restored.${locked ? " Unlock that project and try again." : ""}`,
      p.id,
      false,
    );
  for (const a of list) {
    const ids = named.get(a.certificateSha256);
    for (const id of ids ?? []) out.byId.push([id, a.at]);
    const buf = await read(a.certificate);
    if (Buffer.isBuffer(buf) && sha256(buf) === a.certificateSha256 && take(buf, a.at)) continue;
    const why =
      buf === null ? "is missing" : buf === "locked" ? "is sealed, and its project is locked" : buf === "unreadable" ? "cannot be read" : "is not the file the audit log recorded: it was changed afterwards";
    if (!ids) throw cannotTell(` (certificate "${a.certificate}")`, why, buf === "locked");
    // A locked project is no fault: what it destroyed is known from its audit log all the same.
    if (buf !== "locked") out.notes.push(`The destruction certificate "${a.certificate}" of the project "${p.name}" ${why}. Which files it destroyed was taken from that project's audit log.`);
  }
  // Destructions the log records only by their certificate's sha256 (the earlier form of the entry).
  const earlier = new Set([...certificateHashes].filter((h) => !list.some((a) => a.certificateSha256 === h)));
  let lockedOne = false;
  for (const n of names) {
    if (!DESTRUCTION_CERTIFICATE.test(n) || list.some((a) => a.certificate === n)) continue;
    const buf = await read(n);
    if (Buffer.isBuffer(buf) && earlier.has(sha256(buf)) && take(buf)) {
      earlier.delete(sha256(buf));
      continue;
    }
    if (buf === "locked") lockedOne = true;
    else out.notes.push(`A file named like a destruction certificate ("${n}") in the project "${p.name}" is not recorded in that project's audit log. It was not taken into account.`);
  }
  if (earlier.size) throw cannotTell("", lockedOne ? "is sealed, and its project is locked" : "is missing, or is not the file the audit log recorded", lockedOne);
  return out;
}

/**
 * Package-internal (restore, R175): the backups a restored copy inherits as still to be removed,
 * from the audit events it starts with, keyed by its own certificates (library-relative): what the
 * note behind its `destruction-backups-pending` warning says from the moment it is live. The same
 * list its first retry pass reads from the same log.
 */
export function inheritedOutstanding(events: Iterable<AuditEvent | null>, folder: string): Record<string, { files: string[] }> {
  const notes: Record<string, { files: string[] }> = {};
  for (const a of auditedDestructions(events).list) {
    const left = outstandingOf(a);
    if (left.length) notes[`${folder}/retention/${a.certificate}`] = { files: left };
  }
  return notes;
}
