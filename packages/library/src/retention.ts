/**
 * Retention and destruction of raw data (spec 6.3(5), R90 d, R138 e, R147).
 *
 * `retentionDue(projectId, now)` lists, once the project's `retention.rawDataDestroyAfter` date
 * has come (in the researcher's time zone), the stored raw originals of its identifiable sources
 * (linked files are outside the library and are not the app's to destroy). The interface (Task 36)
 * shows them and asks for explicit confirmation before calling `destroyRaw`.
 *
 * `destroyRaw(projectId, assetIds, by, { includeDerived })` destroys those originals, in one
 * governed change (`delete`; R26 write-ahead marker: a crash before the commit rolls everything
 * back, one after it is finished on the next open):
 *   - each file is overwritten, then removed (fs/shred.ts) — with the honest caveat in the
 *     certificate (DESTRUCTION_NOTICE): SSDs, copy-on-write file systems, snapshots and cloud sync
 *     or backup tools outside the app may keep copies the app cannot reach;
 *   - the asset's viewing proxies go with it; text derivatives (transcripts, OCR) are kept unless
 *     `includeDerived` (then every file derived from it goes);
 *   - stray copies of its files in the scratch space (`.tmp/trash-*`, left by interrupted changes)
 *     are overwritten and removed;
 *   - the assets are marked `destroyed` in source.json (path and sha256 stay as the record);
 *   - the certificate `Projects/<p>/retention/destruction-<YYYY-MM-DD HHmm>.json` (0600) records
 *     the asset ids, library-relative paths, sha256s, the time and the actor (`by`).
 *
 * The backups that hold the destroyed files (R147). WHICH backups must go is decided once, in that
 * same change, and recorded in its audit event (`backupsToRemove`; `backupsUnreadable` for files of
 * the project's name the manifest could not read, which may hold them): nothing later works it out
 * again from the project's sources. The hash-chained audit log is the authority from then on:
 *   - a backup is removed only if the audit log names it for a destruction and no later event
 *     records it as removed or as no longer present;
 *   - it leaves the list only when it is verifiably gone: removed by the app (`removed`, with the
 *     time), or found missing (`noLongerPresent`, with the time it was noticed; never worded as
 *     removed by the app; its manifest entry is cleared). One that could not be read leaves it too
 *     once it can be read and holds none of the destroyed files (`notHolding`; it is kept);
 *   - the step is `pending` (or `unknown-pending`) while the list has an entry, and the project
 *     shows `destruction-backups-pending`; it is `deleted` (or `no-longer-present`, when a file was
 *     not removed by the app) only when the list is empty.
 * A fresh backup is tried first, and the listed backups are removed whether or not it could be made
 * (R138 e). The certificate written at the destruction is NEVER rewritten: its sha256 is in the
 * destruction's audit events and keeps verifying. Each later fact is an amendment, a file of its
 * own beside it (`<certificate>.amendment-<n>.json`), written in a governed change whose audit
 * event carries the amendment's sha256 and what it reports, so the file and its record exist
 * together or not at all. `listDestructions` / `readDestruction` present the original with its
 * amendments and the resulting status.
 *
 * The certificate, the amendments and `Backups/backups-state.json` are conveniences, not
 * authorities. `resumeDestruction` (at open, at unlock and hourly) deletes nothing for a
 * destruction whose files disagree with the audit log, keeps the warning and says why; it only
 * records listed backups that are found gone. Destruction holds the project's maintenance lock
 * (R138 a). Audited: the change's `delete` event (op `retention.destroy`), `retention.destroyed`
 * (counts and the certificate's sha256), each amendment's `delete` event (op `retention.backups`)
 * and a `retention.backups` report of the same facts.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, join } from "node:path";
import { formatModified, type Asset, type AuditEvent } from "@ao/core";
import {
  backupCrashPoint,
  backupFailureReason,
  backupFilesNow,
  backupProjectHeld,
  destructionNotes,
  forgetMissingBackups,
  listBackups,
  noteDestruction,
  plainErrorText,
  pruneBackupsHeld,
  removeHoldingBackups,
  retentionRetry,
  setDestructionNotes,
  setRetentionRetry,
  unresolvedBackupsOf,
  withProjectMaintenance,
  DEFAULT_KEEP,
  type DestructionNote,
  type MaintenanceHold,
  type RetentionRetry,
} from "./export/backup.js";
import { DESTRUCTION_CERTIFICATE, amendmentNumber } from "./repo/destroy.js";
import { decryptBytes } from "./repo/io.js";
import { NotFoundError } from "./repo/errors.js";
import { SimulatedCrash } from "./repo/seams.js";
import {
  amendProjectDestruction,
  appendLibraryEvent,
  auditEventsMentioning,
  destroyProjectAssets,
  lookupPolicyInfo,
  projectDataKey,
  repoClock,
  repoLibrary,
  verifiedAuditEvents,
  type Repo,
} from "./repo/repo.js";
import { toRel } from "./repo/txn.js";
import { isDue, projectTimeZone } from "./retention-date.js";

export const DESTRUCTION_NOTICE =
  "Each file was overwritten with zeros and then deleted. This is a best effort: on solid-state drives (SSD), on copy-on-write file systems (such as APFS, Btrfs or ZFS) and in file system snapshots, and wherever cloud sync or backup software outside this app copied the library, earlier copies of the data may still exist. This certificate covers the copies this app manages.";

export interface DueItem {
  sourceId: string;
  assetIds: string[];
}

const destroyable = (a: Asset) => a.role === "original" && a.status !== "destroyed" && !a.linked;

/** Raw originals of identifiable sources due for destruction under the project's retention rule. */
export async function retentionDue(repo: Repo, projectId: string, now: Date): Promise<DueItem[]> {
  const { policy } = await lookupPolicyInfo(repo, projectId);
  const date = policy?.retention.rawDataDestroyAfter ?? null;
  if (!date || !isDue(date, now, projectTimeZone(repo, projectId))) return [];
  const out: DueItem[] = [];
  for (const id of repo.listSourceIds(projectId)) {
    const sf = await repo.getSource(projectId, id);
    if (!sf.source.provenance.identifiable) continue;
    const assetIds = sf.assets.filter(destroyable).map((a) => a.id);
    if (assetIds.length) out.push({ sourceId: id, assetIds });
  }
  return out;
}

export interface DestroyOptions {
  /** Also destroy text derivatives (transcripts, OCR, translations) of the files. */
  includeDerived?: boolean;
  /** Destroy only if the files are due at this time — re-checked inside the change (R117). */
  onlyDue?: Date;
}

/**
 * How the backups step of a destruction stands. none: no backup held the files. pending: a listed
 * backup is still to be removed (retried). unknown-pending: a backup that could not be read, and
 * may hold them, is still there. deleted: every listed backup was removed by the app.
 * no-longer-present: none is left, and at least one was not removed by the app but found missing.
 */
export type BackupsStepStatus = "none" | "pending" | "unknown-pending" | "deleted" | "no-longer-present";

/** The `backups` part of a destruction as it is presented: the certificate's own, brought up to date from its amendments and the audit log. */
interface CertificateBackups {
  status: BackupsStepStatus;
  /** Backups (library-relative) listed at the destruction: those that held destroyed files, and those that could not be read. */
  containing: string[];
  /** Those the app removed. */
  deleted: string[];
  /** When the app removed each one in `deleted`. */
  removedAt?: Record<string, string>;
  /** Those found missing: not removed by the app; `at` is when it was noticed. */
  noLongerPresent?: Array<{ file: string; at: string }>;
  /** Those that could not be read at the destruction, read since and found to hold none of the destroyed files (kept). */
  notHolding?: Array<{ file: string; at: string }>;
  /** Every recorded failure to remove a listed backup, with the plain reason and when (N1). */
  notRemoved?: Array<{ file: string; reason: string; at?: string }>;
  freshBackup?: string;
  /** Why no fresh backup could be made after the destruction (R138 e: the listed backups are removed regardless). */
  freshBackupFailed?: string;
  /** Plain words for a reader when no fresh backup could be made: composed from what actually happened. */
  note?: string;
  /** Listed backups still in place (retried). */
  outstanding?: string[];
  /** Why the last recorded attempt stopped (plain; retried). */
  lastError?: string;
}

/** An amendment to a destruction certificate: a file kept beside it. */
export interface DestructionAmendment {
  /** Library-relative path of the amendment file. */
  file: string;
  /** Its sha256 as the audit log records it (of the JSON text, also when the file is sealed). */
  sha256: string;
  /** Whether the file on disk is the one the audit log recorded. */
  verified: boolean;
  /** Its content; absent when the file is missing or cannot be read. */
  content?: Record<string, unknown>;
}

/** A destruction as its certificate, the amendments beside it and the audit log record it. */
export interface DestructionRecord {
  /** Library-relative path of the certificate written at the destruction. */
  certificateFile: string;
  /** Its sha256 as the audit log records it; absent when the audit log does not record this certificate. */
  certificateSha256?: string;
  /** Whether the certificate on disk is byte for byte the one the audit log recorded. */
  verified: boolean;
  /** The certificate as it is on disk (as written at the destruction, when `verified`); absent when it is missing or cannot be read. */
  original?: Record<string, unknown>;
  /** Later facts, oldest first. */
  amendments: DestructionAmendment[];
  /** The original with its `backups` brought up to date from the amendments and the audit log: what a screen shows. */
  certificate?: Record<string, unknown>;
  /** The resulting status of the backups step (from the audit log). */
  status: BackupsStepStatus;
  /** Backups (library-relative) still listed: not yet verifiably gone. */
  outstanding: string[];
  /** Why the app does not remove this destruction's backups by itself (plain words), if so. */
  problem?: string;
}

/** What `destroyRaw` returns: the certificate as presented (see DestructionRecord), where it is, and what was written. */
export interface DestroyResult {
  /** Absolute path of the certificate written at the destruction. */
  certificatePath: string;
  /** The certificate with its `backups` as they stand after this call. */
  certificate: Record<string, unknown>;
  /** The certificate exactly as written (and never rewritten). */
  original: Record<string, unknown>;
  /** The amendment written by this call, if its backups step recorded anything. */
  amendments: DestructionAmendment[];
  status: BackupsStepStatus;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TRASH = /^trash-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]+$/u;

/** Files in orphan `.tmp/trash-*` folders named like one of `names` (no live transaction marker). */
async function strayCopies(root: string, names: ReadonlySet<string>): Promise<string[]> {
  const tmp = join(root, ".tmp");
  let entries: string[];
  try {
    entries = await fsp.readdir(tmp);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) return;
    if (st.isDirectory()) for (const n of await fsp.readdir(p)) await walk(join(p, n));
    else if (st.isFile() && names.has(p.slice(p.lastIndexOf("/") + 1).slice(p.lastIndexOf("\\") + 1))) out.push(p);
  };
  for (const n of entries) {
    const m = TRASH.exec(n);
    if (!m) continue;
    // A live transaction may still need its trash for a rollback.
    if (await fsp.stat(join(tmp, `txn-${m[1]}.json`)).then(() => true, () => false)) continue;
    await walk(join(tmp, n));
  }
  return out;
}

const baseName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

/**
 * Destroys the given raw originals (see above). Throws for an id that is not a stored, copied
 * original of this project. Returns the certificate's absolute path, the certificate as written,
 * and how its backups step stands.
 */
export function destroyRaw(repo: Repo, projectId: string, assetIds: string[], by: string, opts: DestroyOptions = {}): Promise<DestroyResult> {
  // Never at the same time as a backup, prune or restore of the project (R138 a): a backup in
  // progress is finished first, and then found among the backups that hold the data.
  return withProjectMaintenance(repo, projectId, (hold) => destroyRawLocked(repo, hold, projectId, assetIds, by, opts));
}

/** Package-internal (tests of the commit-point check): destroyRaw under a hold the caller already has on the project. */
export function destroyRawHeld(repo: Repo, hold: MaintenanceHold, projectId: string, assetIds: string[], by: string, opts: DestroyOptions = {}): Promise<DestroyResult> {
  return withProjectMaintenance(repo, projectId, (h) => destroyRawLocked(repo, h, projectId, assetIds, by, opts), hold);
}

async function destroyRawLocked(repo: Repo, hold: MaintenanceHold, projectId: string, assetIds: string[], by: string, opts: DestroyOptions): Promise<DestroyResult> {
  if (typeof by !== "string" || !by.trim()) throw new TypeError("by: the person destroying the data must be named");
  const wanted = new Set(assetIds);
  if (wanted.size === 0) throw new TypeError("no assets to destroy");
  // Which source holds each asset, and what goes with it.
  const plan = new Map<string, Set<string>>();
  const found = new Set<string>();
  const names = new Set<string>();
  for (const sid of repo.listSourceIds(projectId)) {
    const sf = await repo.getSource(projectId, sid);
    const originals = sf.assets.filter((a) => wanted.has(a.id));
    if (!originals.length) continue;
    for (const a of originals) {
      found.add(a.id);
      if (a.role !== "original") throw new TypeError("Only original (raw) files can be destroyed this way");
      if (a.status === "destroyed") throw new TypeError("This file was already destroyed");
      if (a.linked) throw new TypeError("A linked file lives outside the library; the app does not destroy it");
    }
    const set = new Set(originals.map((a) => a.id));
    // Proxies always; other derived files only with includeDerived (and what derives from them).
    for (let grew = true; grew; ) {
      grew = false;
      for (const a of sf.assets) {
        if (set.has(a.id) || a.status === "destroyed" || a.role !== "derived") continue;
        if (!a.derivation?.parents.some((p) => set.has(p))) continue;
        if (a.kind === "proxy" || opts.includeDerived) {
          set.add(a.id);
          grew = true;
        }
      }
    }
    for (const a of sf.assets) if (set.has(a.id)) names.add(baseName(a.path));
    plan.set(sid, set);
  }
  for (const id of wanted) if (!found.has(id)) throw new NotFoundError("Asset", id);

  const root = repoLibrary(repo).root;
  const { tz, policy } = await lookupPolicyInfo(repo, projectId);
  const strays = await strayCopies(root, names);
  const allIds = new Set([...plan.values()].flatMap((s) => [...s]));
  // Decided once, here (R147): the backups that hold any of these files, and those that cannot be read.
  const held = await holdingBackups(repo, projectId, allIds);
  const toRemove = held.files.map(backupRel);
  const unreadable = held.unresolved.filter((f) => !held.files.includes(f)).map(backupRel);
  const containing = [...toRemove, ...unreadable];
  const initialStatus: BackupsStepStatus = !containing.length ? "none" : unreadable.length ? "unknown-pending" : "pending";
  const res = await destroyProjectAssets(repo, projectId, {
    plan: [...plan.entries()].map(([sourceId, ids]) => ({ sourceId, assetIds: [...ids] })),
    strayCopies: strays,
    certificateStem: (at) => certificateStem(at, tz),
    backups: { toRemove, unreadable },
    ...(opts.onlyDue ? { onlyDue: { now: opts.onlyDue, tz: projectTimeZone(repo, projectId), originals: wanted } } : {}),
    certificate: (destroyed, at) => ({
      formatVersion: 1,
      kind: "destruction-certificate",
      projectId,
      at,
      actor: by,
      rule: { rawDataDestroyAfter: policy?.retention.rawDataDestroyAfter ?? null },
      method: "overwrite-then-unlink",
      includeDerived: opts.includeDerived === true,
      assets: destroyed.map(({ asset: a, sourceId }) => ({
        assetId: a.id,
        sourceId,
        role: a.role,
        kind: a.kind,
        path: a.path,
        sha256: a.sha256,
        bytes: a.bytes,
        encrypted: a.encrypted,
      })),
      trashedCopies: strays.map((p) => toRel(root, p)),
      backups: { status: initialStatus, containing, deleted: [] } satisfies CertificateBackups,
      notice: DESTRUCTION_NOTICE,
    }),
  });
  const certificatePath = join(root, ...res.certificateRel.split("/"));
  await appendLibraryEvent(repo, projectId, "retention.destroyed", {
    by,
    assets: res.destroyed.length,
    includeDerived: opts.includeDerived === true,
    trashedCopies: strays.length,
    backupsContaining: containing.length,
    // Of the certificate's JSON (the plaintext, also when it is sealed).
    certificateSha256: res.certificateSha256,
  });
  // What the change's own audit event now says of this destruction: the list this call works on.
  const audited = newAudited(basename(res.certificateRel), res.certificateSha256, res.at, toRemove, unreadable);
  const amendments: DestructionAmendment[] = [];
  if (containing.length) {
    const written = await settleBackups(repo, hold, projectId, audited, { retry: false, certificate: res.certificate });
    if (written) amendments.push(written);
  }
  return { certificatePath, certificate: present(res.certificate, amendments, audited), original: res.certificate, amendments, status: statusOf(audited) };
}

/**
 * The app's backups of the project that may hold any of `ids`: manifest entries listing one of them
 * (or listing no asset ids at all: unknown, so possibly), and backup files the rebuilt manifest
 * could not read whose name is the project's (R92 I2).
 */
async function holdingBackups(repo: Repo, projectId: string, ids: ReadonlySet<string>): Promise<{ files: string[]; unresolved: string[] }> {
  const files = (await listBackups(repo, projectId)).filter((b) => !Array.isArray(b.assets) || b.assets.some((id) => ids.has(id))).map((b) => b.file);
  return { files, unresolved: await unresolvedBackupsOf(repo, projectId) };
}

// ------------------------------------------------------------------------------------------
// What the audit log says of each destruction (R147)

/** `Backups/<file>`: how certificates, amendments and audit events name a backup. */
const backupRel = (file: string) => `Backups/${file}`;
const fileOf = (rel: string) => rel.slice("Backups/".length);
const isBackupRel = (v: unknown): v is string => typeof v === "string" && /^Backups\/[^/\\]+$/u.test(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** A destruction as the audit log records it: its fixed list, and what later events say became of each entry. */
interface Audited {
  /** The certificate's file name in the project's `retention` folder, and its sha256 as written. */
  certificate: string;
  certificateSha256: string;
  at: string;
  /** Decided at the destruction: backups that hold the destroyed files. */
  toRemove: string[];
  /** Backups that could not be read then and may hold them. */
  unreadable: string[];
  /** Listed backup → when the app removed it. */
  removed: Map<string, string>;
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

const newAudited = (certificate: string, certificateSha256: string, at: string, toRemove: string[], unreadable: string[]): Audited => ({
  certificate,
  certificateSha256,
  at,
  toRemove,
  unreadable,
  removed: new Map(),
  gone: new Map(),
  notHolding: new Map(),
  amendments: [],
  reused: new Set(),
});

const listedIn = (a: Audited, f: string) => a.toRemove.includes(f) || a.unreadable.includes(f);
const settledIn = (a: Audited, f: string) => a.removed.has(f) || a.gone.has(f) || a.notHolding.has(f);
/** The listed backups not yet verifiably gone (nor found not to hold the files). */
const outstandingOf = (a: Audited): string[] => [...new Set([...a.toRemove, ...a.unreadable])].filter((f) => !settledIn(a, f));

function statusOf(a: Audited): BackupsStepStatus {
  if (!a.toRemove.length && !a.unreadable.length) return "none";
  const left = outstandingOf(a);
  if (left.some((f) => a.unreadable.includes(f))) return "unknown-pending";
  if (left.length) return "pending";
  return a.gone.size ? "no-longer-present" : "deleted";
}

/** Lines of the audit log worth parsing for this: the destruction and backups-step events, and backups made. */
const NEEDLES = ['"retention.', '"backup.create"'] as const;

/**
 * Folds audit events (in order) into the destructions they record. Only events written in the R147
 * form count: a destruction is its change's `delete` event naming the certificate, its sha256 and
 * the list; an entry leaves the list only by a later `delete` event (op `retention.backups`) for
 * the same certificate. The first record of a file stands: nothing is counted twice.
 */
function auditedDestructions(events: Iterable<AuditEvent | null>): { list: Audited[]; certificateHashes: Set<string> } {
  const bySha = new Map<string, Audited>();
  const list: Audited[] = [];
  const certificateHashes = new Set<string>();
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const d = (e.details ?? {}) as Record<string, unknown>;
    if (e.action === "retention.destroyed" && typeof d.certificateSha256 === "string") certificateHashes.add(d.certificateSha256);
    if (e.action === "delete" && d.op === "retention.destroy") {
      if (typeof d.certificate !== "string" || !DESTRUCTION_CERTIFICATE.test(d.certificate) || typeof d.certificateSha256 !== "string") continue;
      certificateHashes.add(d.certificateSha256);
      if (bySha.has(d.certificateSha256)) continue;
      const a = newAudited(d.certificate, d.certificateSha256, e.at, strings(d.backupsToRemove).filter(isBackupRel), strings(d.backupsUnreadable).filter(isBackupRel));
      bySha.set(a.certificateSha256, a);
      list.push(a);
      continue;
    }
    const a = typeof d.certificateSha256 === "string" ? bySha.get(d.certificateSha256) : undefined;
    if (a && e.action === "delete" && d.op === "retention.backups") {
      const at = typeof d.stepAt === "string" ? d.stepAt : e.at;
      for (const f of strings(d.removed)) if (listedIn(a, f) && !settledIn(a, f)) a.removed.set(f, at);
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
    }
  }
  return { list, certificateHashes };
}

/** A cheap pass over the audit log for the destructions it records, and whether the log is as this process left it. */
async function scan(repo: Repo, projectId: string): Promise<{ list: Audited[]; certificateHashes: Set<string>; headMatches: boolean }> {
  const { events, headMatches } = await auditEventsMentioning(repo, projectId, NEEDLES);
  return { ...auditedDestructions(events), headMatches };
}

// ------------------------------------------------------------------------------------------
// The files: the certificate and the amendments beside it

const AUDIT_CHANGED =
  "The audit log of this project is not as the app left it: it was changed outside the app. The app removes no backup on its word until the library has been opened again and the log checked.";
const AUDIT_UNVERIFIED =
  "The audit log of this project does not hold together: an entry was changed or removed outside the app. The app removes no backup on its word; the backups still listed can be removed by hand.";
const FILES_DISAGREE = "While its files and the audit log disagree, the app removes no backup for this destruction by itself. If the backups still listed are removed by hand, the app records that they are gone.";
const UNRECORDED =
  "The audit log does not record this destruction certificate in the form the app now keeps (it was written by an earlier version of the app, or outside it), so the app does not remove the backups it lists by itself. If they hold destroyed data, remove them by hand.";
const stateProblem = (file: string) =>
  `The app's own note of the backups still to remove (backups-state.json in the Backups folder) names "${fileOf(file)}" for this destruction, and the audit log does not. Nothing was removed for this destruction this time, and the note was corrected from the audit log.`;
/** Problems with the audit log itself: nothing may be appended to it about them, and nothing is recorded on its word. */
const aboutAudit = (problem: string | undefined) => problem === AUDIT_CHANGED || problem === AUDIT_UNVERIFIED;

/** A file in the retention folder as it is (decrypted when sealed): null when it is not there, "unreadable" when it cannot be opened. */
async function readPlain(repo: Repo, projectId: string, rel: string): Promise<Buffer | null | "unreadable"> {
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
  } catch {
    return "unreadable";
  }
}

function parseObject(buf: Buffer): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(buf.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** File names in the project's retention folder (none when it does not exist). */
async function retentionNames(repo: Repo, dirRel: string): Promise<string[]> {
  try {
    return (await fsp.readdir(join(repoLibrary(repo).root, ...dirRel.split("/")))).sort();
  } catch {
    return [];
  }
}

interface OnDisk {
  /** The certificate file is byte for byte the one the audit log recorded. */
  verified: boolean;
  original?: Record<string, unknown>;
  amendments: DestructionAmendment[];
  /** Where the files disagree with the audit log (plain words). */
  problem?: string;
}

/** A recorded destruction's files, each checked against the sha256 the audit log holds for it. */
async function onDisk(repo: Repo, projectId: string, dirRel: string, a: Audited, names: readonly string[]): Promise<OnDisk> {
  let problem: string | undefined;
  const buf = await readPlain(repo, projectId, `${dirRel}/${a.certificate}`);
  const verified = Buffer.isBuffer(buf) && sha256(buf) === a.certificateSha256;
  const original = Buffer.isBuffer(buf) ? parseObject(buf) : undefined;
  if (buf === null) problem = `The destruction certificate "${a.certificate}" is missing from the project's retention folder, although the audit log records it.`;
  else if (!verified) problem = `The destruction certificate "${a.certificate}" is not the file the audit log recorded at the destruction: it was changed afterwards.`;
  const amendments: DestructionAmendment[] = [];
  for (const am of a.amendments) {
    const rel = `${dirRel}/${am.name}`;
    const b = await readPlain(repo, projectId, rel);
    const ok = Buffer.isBuffer(b) && sha256(b) === am.sha256;
    const content = Buffer.isBuffer(b) ? parseObject(b) : undefined;
    amendments.push({ file: rel, sha256: am.sha256, verified: ok, ...(content ? { content } : {}) });
    if (ok) continue;
    problem ??=
      b === null
        ? `An amendment to the destruction certificate ("${am.name}") is missing, although the audit log records it.`
        : `An amendment to the destruction certificate ("${am.name}") is not the file the audit log recorded: it was changed afterwards.`;
  }
  const known = new Set(a.amendments.map((x) => x.name));
  const stray = names.find((n) => amendmentNumber(a.certificate, n) !== undefined && !known.has(n));
  if (stray) problem ??= `"${stray}" is named like an amendment to the destruction certificate "${a.certificate}", but the audit log does not record it.`;
  return { verified, ...(original ? { original } : {}), amendments, ...(problem ? { problem: `${problem} ${FILES_DISAGREE}` } : {}) };
}

type AmendmentBackups = Partial<Pick<CertificateBackups, "notRemoved" | "note" | "lastError">>;

/**
 * The certificate as a screen shows it: the original's own fields, with `backups` brought up to
 * date. What became of each listed backup comes from the audit log (`a`); the reasons and the plain
 * notes come from the amendments whose files verify.
 */
function present(original: Record<string, unknown>, amendments: readonly DestructionAmendment[], a: Audited): Record<string, unknown> {
  const own = (original.backups ?? {}) as { containing?: unknown };
  const b: CertificateBackups = { status: statusOf(a), containing: strings(own.containing), deleted: [...a.removed.keys()] };
  if (a.removed.size) b.removedAt = Object.fromEntries(a.removed);
  if (a.gone.size) b.noLongerPresent = [...a.gone].map(([file, at]) => ({ file, at }));
  if (a.notHolding.size) b.notHolding = [...a.notHolding].map(([file, at]) => ({ file, at }));
  const steps = amendments.filter((am) => am.verified && am.content).map((am) => (am.content!.backups ?? {}) as AmendmentBackups);
  const notRemoved: NonNullable<CertificateBackups["notRemoved"]> = [];
  for (const s of steps) {
    for (const e of Array.isArray(s.notRemoved) ? s.notRemoved : []) {
      if (e && typeof e.file === "string" && typeof e.reason === "string" && !notRemoved.some((x) => x.file === e.file && x.reason === e.reason)) notRemoved.push(e);
    }
  }
  if (notRemoved.length) b.notRemoved = notRemoved;
  if (a.freshBackup) b.freshBackup = a.freshBackup;
  else if (a.freshBackupFailed) b.freshBackupFailed = a.freshBackupFailed;
  const last = steps.at(-1);
  if (typeof last?.note === "string") b.note = last.note;
  if (typeof last?.lastError === "string") b.lastError = last.lastError;
  const left = outstandingOf(a);
  if (left.length) b.outstanding = left;
  return { ...original, backups: b };
}

/** The listed backups of a certificate the audit log does not record that are still in Backups/, when it says its step is not done. */
async function unrecordedOutstanding(repo: Repo, original: Record<string, unknown> | undefined): Promise<string[]> {
  const b = (original?.backups ?? {}) as { status?: unknown; containing?: unknown; deleted?: unknown };
  if (b.status !== "pending" && b.status !== "unknown-pending") return [];
  const done = new Set(strings(b.deleted));
  const listed = strings(b.containing).filter((f) => isBackupRel(f) && !done.has(f));
  const now = await backupFilesNow(repo, listed.map(fileOf));
  return listed.filter((f) => now.get(fileOf(f))?.present === true);
}

const STATUSES: readonly BackupsStepStatus[] = ["none", "pending", "unknown-pending", "deleted", "no-longer-present"];

/**
 * Every destruction of the project, oldest first: the certificate written at the destruction, the
 * amendments beside it and the resulting status (R147). The status and what is outstanding come
 * from the audit log; each file is checked against the sha256 the audit log holds for it, and a
 * disagreement is said in `problem`. Reads only. A locked project's sealed certificates cannot be
 * read (ProjectLockedError).
 */
export async function listDestructions(repo: Repo, projectId: string): Promise<DestructionRecord[]> {
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  const view = await scan(repo, projectId);
  const names = await retentionNames(repo, dirRel);
  const out: DestructionRecord[] = [];
  for (const a of view.list) {
    const disk = await onDisk(repo, projectId, dirRel, a, names);
    const problem = view.headMatches ? disk.problem : AUDIT_CHANGED;
    out.push({
      certificateFile: `${dirRel}/${a.certificate}`,
      certificateSha256: a.certificateSha256,
      verified: disk.verified,
      ...(disk.original ? { original: disk.original, certificate: present(disk.original, disk.amendments, a) } : {}),
      amendments: disk.amendments,
      status: statusOf(a),
      outstanding: outstandingOf(a),
      ...(problem ? { problem } : {}),
    });
  }
  // Certificates the audit log does not record in this form (an earlier version's, or not the app's).
  for (const n of names) {
    if (!DESTRUCTION_CERTIFICATE.test(n) || view.list.some((a) => a.certificate === n)) continue;
    const rel = `${dirRel}/${n}`;
    const buf = await readPlain(repo, projectId, rel);
    const original = Buffer.isBuffer(buf) ? parseObject(buf) : undefined;
    const hash = Buffer.isBuffer(buf) ? sha256(buf) : undefined;
    const verified = hash !== undefined && view.certificateHashes.has(hash);
    const said = (original?.backups as { status?: unknown } | undefined)?.status;
    const outstanding = await unrecordedOutstanding(repo, original);
    out.push({
      certificateFile: rel,
      ...(verified ? { certificateSha256: hash } : {}),
      verified,
      ...(original ? { original, certificate: original } : {}),
      amendments: [],
      status: STATUSES.includes(said as BackupsStepStatus) ? (said as BackupsStepStatus) : "none",
      outstanding,
      ...(outstanding.length ? { problem: UNRECORDED } : {}),
    });
  }
  return out.sort((x, y) => (x.certificateFile < y.certificateFile ? -1 : x.certificateFile > y.certificateFile ? 1 : 0));
}

/** One destruction, by its certificate (a file name, a library-relative path or an absolute path). */
export async function readDestruction(repo: Repo, projectId: string, certificate: string): Promise<DestructionRecord> {
  const name = basename(certificate.split("\\").join("/"));
  const found = (await listDestructions(repo, projectId)).find((d) => basename(d.certificateFile) === name);
  if (!found) throw new NotFoundError("Destruction certificate", name);
  return found;
}

// ------------------------------------------------------------------------------------------
// The backups step

/** Any failure, in plain words with paths scrubbed (R138 e: not only a refusal), and that it is retried. */
const plainError = (repo: Repo, err: unknown) => `${backupFailureReason(repo, err).replace(/[.]$/u, "")}; the step will be tried again`;
const retryKey = (projectId: string, rel: string) => `${projectId}:${rel}`;

interface SettleOptions {
  /** A later pass (resumeDestruction), as opposed to the destruction itself. */
  retry: boolean;
  /** Nothing is removed and no backup is made: only listed backups that are found gone are recorded. */
  observeOnly?: boolean;
  /** The certificate as written at the destruction (verified), for the ids of the destroyed assets. */
  certificate?: Record<string, unknown>;
}

/**
 * One pass of the backups step of a destruction (R92 I3, R138 e, R147), on the list the audit log
 * holds for it (`a`, brought up to date here with what this pass records):
 *   - a listed backup that is no longer there is recorded as no longer present (never as removed);
 *   - a fresh backup is tried first, when there is something to remove and none was made yet (at
 *     most once a day on a retry);
 *   - each listed backup still there is overwritten and removed, the manifest updated after each;
 *     one that cannot be removed stays listed, with the plain reason;
 *   - one that could not be read at the destruction is never deleted blindly: it stays listed until
 *     it is gone, or can be read (then it is removed if it holds a destroyed file, else kept and
 *     recorded as not holding any).
 * What changed is written as an amendment beside the certificate, in a governed change whose audit
 * event carries the amendment's sha256 and the same facts; a `retention.backups` event reports
 * them. A retry that changes nothing writes no amendment and no event, except one summarising
 * `retention.backups` a day with the number of attempts (R2-I1). Returns the amendment written.
 */
async function settleBackups(repo: Repo, hold: MaintenanceHold, projectId: string, a: Audited, opts: SettleOptions): Promise<DestructionAmendment | undefined> {
  const left = outstandingOf(a);
  const first = a.amendments.length === 0;
  if (!left.length) return undefined;
  const now = repoClock(repo)();
  const at = now.toISOString();
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  const certificateRel = `${dirRel}/${a.certificate}`;
  const key = retryKey(projectId, certificateRel);
  const act = !opts.observeOnly;
  const before = act ? await retentionRetry(repo, key) : undefined;
  let rec = before;
  if (act && opts.retry) {
    // Noted before anything is tried, so the back-off holds even if this attempt cannot be recorded.
    rec = {
      firstFailedAt: before?.firstFailedAt ?? a.amendments[0]?.at ?? at,
      lastAttemptAt: at,
      lastRecordedAt: a.lastRecordedAt ?? before?.lastRecordedAt ?? at,
      attemptsSinceRecord: (before?.attemptsSinceRecord ?? 0) + 1,
      ...(before?.lastFreshAt ? { lastFreshAt: before.lastFreshAt } : {}),
    };
    await setRetentionRetry(repo, key, rec).catch(() => {});
  }

  // How each listed backup stands now. Decided before any backup is made, so a name given to the
  // fresh backup is never taken for a listed one.
  const files = await backupFilesNow(repo, left.map(fileOf));
  const destroyed = opts.certificate ? destroyedIds(opts.certificate) : undefined;
  const gone: string[] = [];
  const missing: string[] = [];
  const notHolding: string[] = [];
  const toDelete: string[] = [];
  for (const f of left) {
    const s = files.get(fileOf(f));
    if (a.reused.has(f)) gone.push(f);
    else if (!s?.present) {
      gone.push(f);
      missing.push(f);
    } else if (!act) continue;
    else if (a.toRemove.includes(f)) toDelete.push(f);
    else if (!s.entry || !destroyed) continue; // still cannot be read: stays listed, never deleted blindly
    else if (s.entry.projectId === projectId && (!Array.isArray(s.entry.assets) || s.entry.assets.some((id) => destroyed.has(id)))) toDelete.push(f);
    else notHolding.push(f);
  }

  // A fresh backup first, when it can be made (R90 d), at most once a day on a retry; the listed
  // backups are removed whether or not it could (R138 e).
  let freshMade: string | undefined;
  let freshFailed: string | undefined;
  let freshTried = false;
  const freshDue = !before?.lastFreshAt || now.getTime() - Date.parse(before.lastFreshAt) >= DAY_MS;
  if (act && toDelete.length && !a.freshBackup && (!opts.retry || freshDue)) {
    freshTried = true;
    try {
      const fresh = await backupProjectHeld(repo, hold, projectId, { prune: false });
      freshMade = backupRel(basename(fresh.path));
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      // backupProject has recorded `backup-failed` with the same reason.
      freshFailed = backupFailureReason(repo, err);
    }
  }

  // Each listed backup: removed (with when), or named as NOT removed with the plain reason (N1).
  let removed: string[] = [];
  let failed: Array<{ file: string; reason: string }> = [];
  let otherError: string | undefined;
  try {
    if (toDelete.length) {
      const r = await removeHoldingBackups(repo, toDelete.map(fileOf));
      removed = r.removed.map(backupRel);
      gone.push(...r.gone.map(backupRel));
      failed = r.failed.map(({ file, error }) => ({ file: backupRel(file), reason: `It could not be overwritten and removed (${plainErrorText(repo, error)}).` }));
      if (r.failed.length) otherError = `A backup holding the destroyed files could not be removed (${plainErrorText(repo, r.failed[0]!.error)}); the step will be tried again`;
    }
    await forgetMissingBackups(repo, missing.map(fileOf));
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    otherError = plainError(repo, err);
  }
  backupCrashPoint("before-removal-record");

  const freshBackupFailed = a.freshBackup || freshMade ? undefined : (freshFailed ?? a.freshBackupFailed);
  const changed = removed.length > 0 || gone.length > 0 || notHolding.length > 0 || freshMade !== undefined;
  if (!changed && (!act || !first)) {
    if (!act || !rec) return undefined;
    const noted = rec;
    // A retry that changed nothing: no amendment, no audit event, except one summary a day.
    if (now.getTime() - Date.parse(rec.lastRecordedAt) >= DAY_MS) {
      await appendLibraryEvent(repo, projectId, "retention.backups", {
        certificate: a.certificate,
        certificateSha256: a.certificateSha256,
        status: statusOf(a),
        summary: true,
        attempts: rec.attemptsSinceRecord,
        removed: [],
        notRemoved: left,
        ...(freshBackupFailed ? { freshBackupFailed } : {}),
      });
      a.lastRecordedAt = at;
      delete a.reportedProblem;
      rec = { ...rec, lastRecordedAt: at, attemptsSinceRecord: 0 };
    }
    if (freshTried) rec = { ...rec, lastFreshAt: at };
    if (rec !== noted) await setRetentionRetry(repo, key, rec).catch(() => {});
    return undefined;
  }

  // What this pass found, applied to the list.
  for (const f of removed) a.removed.set(f, at);
  for (const f of gone) a.gone.set(f, at);
  for (const f of notHolding) a.notHolding.set(f, at);
  if (freshMade) a.freshBackup = freshMade;
  if (freshBackupFailed) a.freshBackupFailed = freshBackupFailed;
  else delete a.freshBackupFailed;
  const outstanding = outstandingOf(a);
  const status = statusOf(a);
  // The note says only what happened (N1): composed from the outcome above.
  let note: string | undefined;
  if (act && freshBackupFailed) {
    const stop = /[.!?]$/u.test(freshBackupFailed) ? "" : ".";
    const one = failed.length === 1;
    note = failed.length
      ? `No new backup could be made after the destruction: ${freshBackupFailed}${stop} ${one ? "A backup that holds the destroyed files could not be removed yet" : "Some backups that hold the destroyed files could not be removed yet"} (see notRemoved); removing ${one ? "it" : "them"} is tried again.`
      : `${a.gone.size ? "None of the earlier backups that held the destroyed files is in the Backups folder any more" : "The earlier backups that held the destroyed files were removed"}. No new backup could be made afterwards: ${freshBackupFailed}${stop} This project has no backup until one succeeds.`;
  }
  const number = a.amendments.length + 1;
  const content = {
    formatVersion: 1,
    kind: "destruction-certificate-amendment",
    projectId,
    certificate: a.certificate,
    certificateSha256: a.certificateSha256,
    number,
    at,
    backups: {
      removed: removed.map((file) => ({ file, at })),
      noLongerPresent: gone.map((file) => ({ file, at })),
      ...(notHolding.length ? { notHolding: notHolding.map((file) => ({ file, at })) } : {}),
      notRemoved: failed.map((f) => ({ ...f, at })),
      ...(freshMade ? { freshBackup: freshMade } : {}),
      ...(freshBackupFailed ? { freshBackupFailed } : {}),
      ...(note ? { note } : {}),
      ...(otherError ? { lastError: otherError } : {}),
      outstanding,
      status,
    },
  };
  // The same facts in the audit event that reports the amendment (with its sha256): the authority.
  const facts = {
    stepAt: at,
    status,
    removed,
    noLongerPresent: gone,
    ...(notHolding.length ? { notHolding } : {}),
    notRemoved: outstanding,
    ...(freshMade ? { freshBackup: freshMade } : {}),
    ...(freshBackupFailed ? { freshBackupFailed } : {}),
  };
  const w = await amendProjectDestruction(repo, projectId, { certificate: a.certificate, certificateSha256: a.certificateSha256, number, content, facts });
  a.amendments.push({ name: w.name, sha256: w.sha256, at });
  a.lastRecordedAt = at;
  delete a.reportedProblem;
  await noteDestruction(repo, projectId, certificateRel, { files: outstanding }).catch(() => {});
  if (!outstanding.length) {
    // Pruning keeps its own record when it cannot be audited (backup-audit-pending): not this step's failure.
    if (act) await pruneBackupsHeld(repo, hold, projectId, repo.getProject(projectId).backups?.keep ?? DEFAULT_KEEP).catch(() => {});
    await setRetentionRetry(repo, key, undefined).catch(() => {});
  } else if (act) {
    // The retry record: started by a failure, reset by each recorded outcome, gone once settled.
    await setRetentionRetry(repo, key, {
      firstFailedAt: rec?.firstFailedAt ?? at,
      ...(opts.retry ? { lastAttemptAt: at } : {}),
      lastRecordedAt: at,
      attemptsSinceRecord: 0,
      ...(freshTried ? { lastFreshAt: at } : rec?.lastFreshAt ? { lastFreshAt: rec.lastFreshAt } : {}),
    }).catch(() => {});
  }
  // A report of the same facts, in the form the earlier events had.
  await appendLibraryEvent(repo, projectId, "retention.backups", {
    certificate: a.certificate,
    certificateSha256: a.certificateSha256,
    amendment: w.name,
    amendmentSha256: w.sha256,
    status,
    deleted: a.removed.size,
    removed,
    noLongerPresent: gone,
    ...(notHolding.length ? { notHolding } : {}),
    notRemoved: outstanding,
    ...(failed.length ? { reasons: failed } : {}),
    ...(opts.retry && rec ? { attempts: rec.attemptsSinceRecord } : {}),
    ...(freshBackupFailed ? { freshBackupFailed } : {}),
  });
  return { file: w.amendmentRel, sha256: w.sha256, verified: true, content };
}

/** The ids of the assets a certificate says were destroyed. */
function destroyedIds(certificate: Record<string, unknown>): Set<string> {
  const assets = Array.isArray(certificate.assets) ? (certificate.assets as Array<{ assetId?: unknown }>) : [];
  return new Set(assets.map((x) => x?.assetId).filter((x): x is string => typeof x === "string"));
}

/**
 * Whether a retry of this destruction's backups step is due (R2-I1): hourly during the first day
 * after its first failure, then once a day. The first retry after a destruction is always due, and
 * so is one whose bookkeeping was lost.
 */
function retryDue(rec: RetentionRetry | undefined, a: Audited, now: Date): boolean {
  if (!rec?.lastAttemptAt) return true;
  const since = now.getTime() - Date.parse(rec.lastAttemptAt);
  const age = now.getTime() - Date.parse(a.amendments[0]?.at ?? rec.firstFailedAt);
  return since >= (age < DAY_MS ? HOUR_MS : DAY_MS);
}

/**
 * Finishes (or retries) destructions whose backups step is not done (a crash, a quit or a failure
 * after the destruction): returns the certificates (absolute paths) whose step was tried. It never
 * destroys raw data itself, and it removes only backups the audit log names for a destruction and
 * does not yet record as removed or no longer present (R147). Run by the service at open, at unlock
 * and hourly, with a back-off (retryDue). Every pass also rewrites, from the audit log, the note
 * behind the project's `destruction-backups-pending` warning.
 */
export function resumeDestruction(repo: Repo, projectId: string): Promise<string[]> {
  return withProjectMaintenance(repo, projectId, (hold) => resumeLocked(repo, hold, projectId));
}

async function resumeLocked(repo: Repo, hold: MaintenanceHold, projectId: string): Promise<string[]> {
  const lib = repoLibrary(repo);
  // Nothing can be recorded in a read-only library, nor read or recorded in a locked project.
  if (lib.mode !== "read-write" || !repo.isUnlocked(projectId)) return [];
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  const view = await scan(repo, projectId);
  const names = await retentionNames(repo, dirRel);
  // The app's own notes as they were found: compared with the audit log, then rewritten from it.
  const found = await destructionNotes(repo, projectId).catch((): Record<string, DestructionNote> => ({}));
  const notes: Record<string, DestructionNote> = {};
  const out: string[] = [];
  const now = repoClock(repo)();
  let firstError: unknown;
  for (const scanned of view.list) {
    let a = scanned;
    if (!outstandingOf(a).length) continue;
    const rel = `${dirRel}/${a.certificate}`;
    let problem: string | undefined;
    try {
      // Do the conveniences agree with the audit log about this destruction?
      const disk = view.headMatches ? await onDisk(repo, projectId, dirRel, a, names) : undefined;
      problem = view.headMatches ? disk!.problem : AUDIT_CHANGED;
      if (!problem) {
        const extra = (Object.hasOwn(found, rel) ? found[rel]!.files : []).find((f) => !listedIn(a, f));
        if (extra !== undefined) problem = stateProblem(extra);
      }
      const rec = problem ? undefined : await retentionRetry(repo, retryKey(projectId, rel));
      if (!problem && !retryDue(rec, a, now)) {
        // Not tried this time: what the last try found about the log still stands.
        if (Object.hasOwn(found, rel) && found[rel]!.problem === AUDIT_UNVERIFIED) problem = AUDIT_UNVERIFIED;
      } else if (!problem) {
        // Before anything is removed: the whole log, its chain verified, read again.
        const checked = await verifiedAuditEvents(repo, projectId);
        const sure = checked.ok ? auditedDestructions(checked.events).list.find((x) => x.certificateSha256 === a.certificateSha256) : undefined;
        if (!sure) {
          problem = AUDIT_UNVERIFIED;
          // The attempt counts for the back-off: the log is not read in full again at every pass.
          const at = now.toISOString();
          await setRetentionRetry(repo, retryKey(projectId, rel), {
            firstFailedAt: rec?.firstFailedAt ?? a.amendments[0]?.at ?? at,
            lastAttemptAt: at,
            lastRecordedAt: a.lastRecordedAt ?? rec?.lastRecordedAt ?? at,
            attemptsSinceRecord: (rec?.attemptsSinceRecord ?? 0) + 1,
            ...(rec?.lastFreshAt ? { lastFreshAt: rec.lastFreshAt } : {}),
          }).catch(() => {});
        } else {
          a = sure;
          await settleBackups(repo, hold, projectId, a, { retry: true, ...(disk?.original ? { certificate: disk.original } : {}) });
          out.push(join(lib.root, ...rel.split("/")));
        }
      } else if (problem && !aboutAudit(problem)) {
        // Nothing is removed while they disagree; a listed backup that is gone is still recorded as gone.
        await settleBackups(repo, hold, projectId, a, { retry: true, observeOnly: true });
      }
      // Said once in the audit log, not at every pass.
      if (problem && problem !== AUDIT_CHANGED && outstandingOf(a).length && scanned.reportedProblem !== problem) {
        await appendLibraryEvent(repo, projectId, "retention.backups", {
          certificate: a.certificate,
          certificateSha256: a.certificateSha256,
          status: statusOf(a),
          problem,
          removed: [],
          notRemoved: outstandingOf(a),
        });
      }
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      firstError ??= err;
    }
    const left = outstandingOf(a);
    if (left.length) notes[rel] = { files: left, ...(problem ? { problem } : {}) };
  }
  // Certificates the audit log does not record in this form: never acted on; said while their backups are there.
  for (const n of names) {
    if (!DESTRUCTION_CERTIFICATE.test(n) || view.list.some((a) => a.certificate === n)) continue;
    const buf = await readPlain(repo, projectId, `${dirRel}/${n}`).catch(() => null);
    const files = await unrecordedOutstanding(repo, Buffer.isBuffer(buf) ? parseObject(buf) : undefined).catch(() => []);
    if (files.length) notes[`${dirRel}/${n}`] = { files, problem: UNRECORDED };
  }
  await setDestructionNotes(repo, projectId, notes).catch(() => {});
  if (firstError !== undefined) throw firstError;
  return out;
}

/** `destruction-<YYYY-MM-DD HHmm>` for a time in `tz`. */
export function certificateStem(at: Date, tz?: string): string {
  return `destruction-${formatModified(at, tz)}`;
}
