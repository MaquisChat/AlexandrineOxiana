/**
 * What a restore reads of the destruction record (Task 50b; R174 d, R175, R179): which files must
 * not be brought back, and which backups a restored copy inherits as still to be removed. Readers
 * only: nothing here removes a backup or writes to an audit log. Built on destruction-record.ts (the
 * fold of audit events into destructions, shared with the retry in retention.ts); it imports neither
 * retention.ts nor export/backup.ts, so the restore in backup.ts can use it.
 *
 * Whose audit log must hold together (R179):
 *   - the log of the project the backup belongs to, when that project is in the library. If it does
 *     not verify, what that project destroyed cannot be known and the restore is refused, in plain
 *     words that name the way out (another library);
 *   - any other project's log that does not verify does not stop a restore. Its certificate files
 *     are then taken as they are on disk: whatever they name as destroyed is left out (unverified
 *     evidence still excludes; it never brings data back), and the restore says, in its notes and
 *     in its audit entry, that for that project the list rests on certificate files alone, or that
 *     nothing of that project's destructions could be established.
 */
import type { AuditEvent, Project } from "@ao/core";
import { auditedDestructions, outstandingOf, parseObject, readPlain, retentionNames, sha256, strings } from "./destruction-record.js";
import { DESTRUCTION_CERTIFICATE } from "./repo/destroy.js";
import { ProjectLockedError } from "./repo/errors.js";
import { auditHeadOf, repoClock, verifiedAuditEvents, verifiedAuditEventsInQueue, type Repo } from "./repo/repo.js";
import { DestructionRecordError, type DestroyedRecord, type DestroyedSource } from "./repo/restore.js";

type Head = { seq: number; hash: string } | null;
const sameHead = (a: Head, b: Head) => (a?.seq ?? 0) === (b?.seq ?? 0) && (a?.hash ?? "") === (b?.hash ?? "");

/** One project's part of the record, and the head its audit log had (in this process) when it was read. */
interface ProjectPart {
  head: Head;
  sources: DestroyedSource[];
}

/**
 * Package-internal (restore): what the destructions on record in this library say a restore must
 * not bring back, with each project's part kept so the commit turn reads again only what changed.
 */
export interface DestroyedOnRecord extends DestroyedRecord {
  sources: DestroyedSource[];
  projects: Map<string, ProjectPart>;
}

/** An amendment beside a destruction certificate (`destruction-<date>.amendment-<n>.json[.enc]`). */
const AMENDMENT_FILE = /^destruction-\d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?\.amendment-\d+\.json(?:\.enc)?$/u;

const ELSEWHERE = "The backup can be restored into another library.";
/** How many files of the backup were left out on the word of certificate files (`names`: "they name", or "it names" for one file), in words. */
const leftOutWords = (n: number, names: string) => `${n} file${n === 1 ? "" : "s"} of this backup that ${names} as destroyed ${n === 1 ? "was" : "were"} left out`;

/** A file of the project's retention folder: its bytes, null when it is not there, or why it cannot be read now. */
async function retentionFile(repo: Repo, p: Project, name: string): Promise<Buffer | null | "unreadable" | "locked"> {
  try {
    return await readPlain(repo, p.id, `${p.folder}/retention/${name}`);
  } catch (err) {
    return err instanceof ProjectLockedError ? "locked" : "unreadable";
  }
}

/** The assets a certificate (or amendment) file names as destroyed, with when; undefined when it is not such a record at all. */
function namedIn(buf: Buffer, fallbackAt: string): { byId: Map<string, string>; bySha256: Map<string, string> } | undefined {
  const c = parseObject(buf);
  if (!c) return undefined;
  const at = typeof c.at === "string" ? c.at : fallbackAt;
  const out = { byId: new Map<string, string>(), bySha256: new Map<string, string>() };
  for (const a of Array.isArray(c.assets) ? (c.assets as Array<{ assetId?: unknown; sha256?: unknown } | null>) : []) {
    if (typeof a?.assetId === "string") out.byId.set(a.assetId, at);
    if (typeof a?.sha256 === "string") out.bySha256.set(a.sha256, at);
  }
  return out;
}

const whyNot = (buf: Buffer | null | "unreadable" | "locked") =>
  buf === null ? "is missing" : buf === "locked" ? "is sealed, and its project is locked" : buf === "unreadable" ? "cannot be read" : "is not the file the audit log recorded: it was changed afterwards";

/**
 * Package-internal (restore, R174 d, R179): what a restore must not bring back, as this library
 * records it. `own` is the id of the project the backup belongs to.
 *
 * For each project whose audit log verifies (read in full, its chain checked, ending at the head
 * the process holds: the reading the retry makes before it removes anything), each destruction is
 * its change's own audit entry, as `auditedDestructions` reads it, and gives:
 *   - the ids of the destroyed assets, which that entry names itself (`destroyedAssets`): known
 *     whatever became of the certificate file, and without a locked project's key;
 *   - the sha256 of each destroyed file, from the certificate, only when the file on disk is byte
 *     for byte the one the entry recorded (so the same file kept under other ids, in a copy made by
 *     an earlier restore, is left out as well).
 * An entry written before `destroyedAssets` existed names no files: it is read from its
 * certificate while that verifies. A certificate file a verified log does not record counts for
 * nothing, and is said only when it names a file the restore brought back.
 *
 * What cannot be read with certainty:
 *   - in the backup's own project (its log does not verify, or an entry names no files and its
 *     certificate does not verify): DestructionRecordError, and nothing is restored;
 *   - in any other project: its certificate files are taken as they are on disk (`certificate-only`).
 *
 * `inQueue`: the caller holds the write queue (the restore's commit turn). `prior`: an earlier
 * reading, reused for each project whose audit log still ends where it did then.
 */
export async function destroyedOnRecord(repo: Repo, opts: { own?: string; inQueue?: boolean; prior?: DestroyedOnRecord } = {}): Promise<DestroyedOnRecord> {
  const out: DestroyedOnRecord = { sources: [], projects: new Map() };
  for (const p of repo.listProjects()) {
    const head = auditHeadOf(repo, p.id);
    let mine = opts.prior?.projects.get(p.id);
    if (!mine || !sameHead(mine.head, head)) {
      const read = opts.inQueue ? await verifiedAuditEventsInQueue(repo, p.id) : await verifiedAuditEvents(repo, p.id);
      if (read.ok) {
        const last = read.events.at(-1);
        mine = { head: last ? { seq: last.seq, hash: last.hash } : null, sources: await recorded(repo, p, read.events, p.id === opts.own) };
      } else if (p.id === opts.own) {
        throw new DestructionRecordError(
          `The audit log of the project "${p.name}" does not hold together: an entry was changed or removed outside the app, or the log is not as the app left it. This backup belongs to that project, and what the project destroyed under a retention rule cannot be known from such a log, so nothing was restored here. ${ELSEWHERE}`,
          p.id,
          true,
        );
      } else mine = { head, sources: [await certificatesAlone(repo, p)] };
    }
    out.projects.set(p.id, mine);
    out.sources.push(...mine.sources);
  }
  return out;
}

/** One project's destructions, from its verified audit events. */
async function recorded(repo: Repo, p: Project, events: AuditEvent[], own: boolean): Promise<DestroyedSource[]> {
  const out: DestroyedSource[] = [];
  const { list, certificateHashes } = auditedDestructions(events);
  const now = repoClock(repo)().toISOString();
  // What each destruction's own audit entry names as destroyed (the first entry for a certificate
  // stands, as in the fold; an entry recorded late from a mark is never one: its action differs).
  const named = new Map<string, string[]>();
  for (const e of events) {
    const d = (e?.details ?? {}) as Record<string, unknown>;
    if (e?.action !== "delete" || d.op !== "retention.destroy" || typeof d.certificateSha256 !== "string" || !Array.isArray(d.destroyedAssets)) continue;
    if (!named.has(d.certificateSha256)) named.set(d.certificateSha256, strings(d.destroyedAssets));
  }
  /** The backup's own project: what it destroyed cannot be told, so nothing is restored here. */
  const cannotTell = (which: string, why: string, locked: boolean) =>
    new DestructionRecordError(
      `The audit log of the project "${p.name}" records a destruction of raw data${which} without naming the files that were destroyed, and the certificate ${why}. This backup belongs to that project, and the app cannot tell which files must not be brought back, so nothing was restored here. ${ELSEWHERE}${locked ? " Or unlock that project and try again." : ""}`,
      p.id,
      false,
    );
  /** Another project's: the restore goes on, on its certificate files as they are, and says so. */
  const unestablished = (which: string, why: string, found: { byId: Map<string, string>; bySha256: Map<string, string> } | undefined, certificate?: string): DestroyedSource => ({
    projectId: p.id,
    basis: "certificate-only",
    byId: found?.byId ?? new Map(),
    bySha256: found?.bySha256 ?? new Map(),
    note: (n) =>
      `The audit log of the project "${p.name}" records a destruction of raw data${which} without naming the files that were destroyed, and the certificate ${why}. ${
        found
          ? `What was left out on its account rests on the certificate file alone, taken as it is on disk: ${n ? leftOutWords(n, "it names") : "it names no file of this backup, so nothing was left out"}.`
          : "What it destroyed could not be established at all, so nothing was left out on its account."
      }`,
    audit: (n) => ({ projectId: p.id, ...(certificate ? { certificate } : {}), basis: found ? "certificate-files-alone" : "nothing-could-be-read", leftOut: n }),
  });
  /** Destructions whose files are known from the audit log, but whose sealed certificate could not be read: the project is locked. */
  let sealed = 0;
  for (const a of list) {
    const byId = new Map<string, string>();
    const ids = named.get(a.certificateSha256);
    for (const id of ids ?? []) byId.set(id, a.at);
    const buf = await retentionFile(repo, p, a.certificate);
    const verified = Buffer.isBuffer(buf) && sha256(buf) === a.certificateSha256 ? namedIn(buf, a.at) : undefined;
    if (verified) {
      for (const [id, at] of verified.byId) if (!byId.has(id)) byId.set(id, at);
      out.push({ projectId: p.id, basis: "recorded", byId, bySha256: verified.bySha256 });
      continue;
    }
    const why = whyNot(buf);
    if (ids) {
      // The files are known from the audit log all the same; said only when this restore left one of them out
      // (a locked project is no fault: what could not be read of it is said once, below).
      if (buf === "locked") sealed++;
      out.push({
        projectId: p.id,
        basis: "recorded",
        byId,
        bySha256: new Map(),
        ...(buf === "locked"
          ? {}
          : { note: (n: number) => (n ? `The destruction certificate "${a.certificate}" of the project "${p.name}" ${why}. Which files it destroyed was taken from that project's audit log.` : undefined) }),
      });
      continue;
    }
    // An entry written before the audit log named the destroyed files, whose certificate does not verify either.
    if (own) throw cannotTell(` (certificate "${a.certificate}")`, why, buf === "locked");
    out.push(unestablished(` (certificate "${a.certificate}")`, why, Buffer.isBuffer(buf) ? namedIn(buf, now) : undefined, a.certificate));
  }
  // A locked project (the restore unlocks nothing, I1): its audit log, which is not sealed, names the
  // destroyed files by id, and that is what was used. Its sealed certificates also list each file's
  // sha256, which would catch the same file kept under another id; that could not be read, and is said.
  if (sealed) {
    out.push({
      projectId: p.id,
      basis: "recorded",
      byId: new Map(),
      bySha256: new Map(),
      sealed: true,
      note: () =>
        `The project "${p.name}" is locked, and ${sealed === 1 ? "its destruction certificate is sealed, so it was" : "its destruction certificates are sealed, so they were"} not read. The files that project destroyed were recognised by the ids its audit log names; the same file kept under another id in this backup could not be recognised. To be sure, unlock that project and restore the backup again.`,
    });
  }
  // Certificate-named files the fold does not tie to a destruction of its own: one the log records only by its
  // sha256 (the earliest form, a `retention.destroyed` event alone), or one the log does not record at all.
  const earliest = new Set([...certificateHashes].filter((h) => !list.some((a) => a.certificateSha256 === h)));
  const loose: Array<{ name: string; byId: Map<string, string>; bySha256: Map<string, string> }> = [];
  let lockedOne = false;
  for (const n of await retentionNames(repo, `${p.folder}/retention`)) {
    if (!DESTRUCTION_CERTIFICATE.test(n) || list.some((a) => a.certificate === n)) continue;
    const buf = await retentionFile(repo, p, n);
    if (buf === "locked") lockedOne = true;
    if (!Buffer.isBuffer(buf)) continue;
    const found = namedIn(buf, now);
    if (!found) continue;
    if (earliest.has(sha256(buf))) {
      earliest.delete(sha256(buf));
      out.push({ projectId: p.id, basis: "recorded", byId: found.byId, bySha256: found.bySha256 });
    } else loose.push({ name: n, ...found });
  }
  if (earliest.size) {
    const why = lockedOne ? "is sealed, and its project is locked" : "is missing, or is not the file the audit log recorded";
    if (own) throw cannotTell("", why, lockedOne);
    // Whatever certificate files are there still exclude (unverified).
    const all = { byId: new Map<string, string>(), bySha256: new Map<string, string>() };
    for (const l of loose) {
      for (const [k, v] of l.byId) all.byId.set(k, v);
      for (const [k, v] of l.bySha256) all.bySha256.set(k, v);
    }
    out.push(unestablished("", why, loose.length ? all : undefined));
  } else {
    // Not on record in a log that verifies: it counts for nothing. Said only when it names a file the restore brought back.
    for (const l of loose) {
      out.push({
        projectId: p.id,
        basis: "unrecorded",
        byId: l.byId,
        bySha256: l.bySha256,
        note: (n) => (n ? `A file named like a destruction certificate ("${l.name}") in the project "${p.name}" is not recorded in that project's audit log. It was not taken into account.` : undefined),
      });
    }
  }
  return out;
}

/**
 * A project whose audit log does not verify (never the backup's own): its certificate and amendment
 * files as they are on disk. Whatever they name as destroyed is left out; nothing vouches for them,
 * and nothing says they are complete, which the restore says in its notes and its audit entry.
 */
async function certificatesAlone(repo: Repo, p: Project): Promise<DestroyedSource> {
  const now = repoClock(repo)().toISOString();
  const byId = new Map<string, string>();
  const bySha256 = new Map<string, string>();
  let readable = 0;
  let locked = false;
  for (const n of await retentionNames(repo, `${p.folder}/retention`)) {
    if (!DESTRUCTION_CERTIFICATE.test(n) && !AMENDMENT_FILE.test(n)) continue;
    const buf = await retentionFile(repo, p, n);
    if (buf === "locked") locked = true;
    const found = Buffer.isBuffer(buf) ? namedIn(buf, now) : undefined;
    if (!found) continue;
    readable++;
    for (const [k, v] of found.byId) if (!byId.has(k)) byId.set(k, v);
    for (const [k, v] of found.bySha256) if (!bySha256.has(k)) bySha256.set(k, v);
  }
  const broken = `The audit log of the project "${p.name}" does not hold together`;
  return {
    projectId: p.id,
    basis: "certificate-only",
    byId,
    bySha256,
    note: (n) =>
      readable
        ? `${broken}, so what that project destroyed could not be read from it. What was left out on that project's account rests on its certificate files alone, taken as they are on disk: ${n ? leftOutWords(n, "they name") : "they name no file of this backup, so nothing was left out"}. A destruction those files do not show could not be taken into account.`
        : `${broken}, and no destruction certificate of that project could be read${locked ? " (the project is locked)" : ""}. What that project destroyed could not be established at all, so nothing was left out on its account.`,
    audit: (n) => ({ projectId: p.id, basis: readable ? "certificate-files-alone" : "nothing-could-be-read", leftOut: n }),
  };
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
