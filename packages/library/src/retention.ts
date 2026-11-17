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
 * records listed backups that are found gone. The audit log is the authority while its chain holds
 * (R174): while it does not verify, a pass removes nothing, writes nothing (no amendment, no audit
 * event, no manifest entry cleared), drops nothing from the note behind the warning, and keeps the
 * plain reason with that warning; once it holds again the next due pass proceeds. Its limit: an
 * entry that is correctly chained and appended while the app is closed is believed at the next
 * open, and whoever can write that can also remove the file.
 *
 * A restored project (R175). A restore copies the certificates and amendments byte for byte, so the
 * copy's audit log (inherited, never rewritten) vouches for them, and they go on naming the project
 * the data was destroyed in. The copy inherits the list and settles it as the original would. Its
 * log cannot see what the original did afterwards, so of an inherited list it removes a file only
 * when it is, byte for byte, the backup the inherited log recorded under that name (the sha256 of
 * its `backup.create` event), holding the maintenance lock of the project the backup belongs to; a
 * file of another content under a listed name is a later backup and is never touched. The original
 * and the copy each record the step in their own log: the one that removed the file as removed, the
 * other as no longer present. Within one project, a backup removed for another of its destructions
 * is recorded as removed, under that destruction (`removedUnder`). The copy's warning stands from
 * the restore itself: the list it inherits is noted for it as the last step before it goes live
 * (restore-record.ts `inheritedOutstanding`, called by the restore), and its own passes settle it.
 *
 * The reading of the record (how audit events fold into destructions; the certificate and amendment
 * files) lives in destruction-record.ts, moved there unchanged so that a restore can read the same
 * record without importing this module. What a restore must not bring back (R174 d, R179) is read
 * from it in restore-record.ts.
 *
 * Old copies of the library left by a move (R379, FR-A16). After "Move library" the old folder is
 * kept, read-only, and this computer lists it (old-copies.ts) until it is deleted through the app;
 * an offer that expired stays listed. Such a copy still holds the project's files, so a destruction
 * looks, once, at every listed old copy of this library (expired or not, finished or not) and notes
 * those that still hold any of the files being destroyed: in the certificate (`oldCopies`: each by
 * the time of the move that left it, never by its path; the notice's last sentence is true because
 * the copies not covered are named) and in the change's audit event (`oldCopiesNotDestroyed`, with
 * this computer's record id). A list that cannot be read is said so (`unknown-pending`,
 * `oldCopiesUnchecked`): never taken for "none". An old folder that cannot be reached (its disk
 * unplugged: neither it nor the folder holding it is there) counts as still holding the files. The
 * project shows `destruction-old-copies-pending` while any such copy is outstanding; the note behind
 * it is in `Backups/backups-state.json` (`oldCopiesUndestroyed`), rewritten from the audit log at
 * every retry pass. Each copy leaves the list as the backups do, by an amendment beside the
 * certificate in a governed change and a `retention.old-copies` report: deleted through the app
 * (`removed`, from deleteOldCopy), or found to hold none of the files any more (`noLongerHolding`:
 * deleted by hand, or no longer listed). The check is cheap and made at every retry pass (at open,
 * at unlock and hourly): one read of this computer's list, and for each noted copy a look for the
 * destroyed files' paths in it. Nothing in an old copy is ever deleted by a destruction, and a
 * destruction is never refused because of one.
 *
 * Destruction holds the project's maintenance lock (R138 a). Audited: the change's `delete` event (op `retention.destroy`), `retention.destroyed`
 * (counts and the certificate's sha256), each amendment's `delete` event (op `retention.backups`)
 * and a `retention.backups` report of the same facts.
 */
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { formatModified, type Asset, type AuditEvent } from "@ao/core";
import {
  auditedDestructions,
  backupRel,
  fileOf,
  isBackupRel,
  listedIn,
  newAudited,
  oldCopiesOutstandingOf,
  oldCopiesPending,
  outstandingOf,
  parseObject,
  readPlain,
  retentionNames,
  sha256,
  strings,
  type Audited,
  type OldCopyRef,
} from "./destruction-record.js";
import { oldCopiesOfLibrary, removePendingOldCopy, type PendingOldCopy } from "./old-copies.js";
import {
  backupCrashPoint,
  backupFailureReason,
  backupFilesNow,
  backupProjectHeld,
  destructionNotes,
  forgetMissingBackups,
  isBackupFileName,
  listBackups,
  noteDestruction,
  oldCopiesNotes,
  oldCopyNotedIn,
  plainErrorText,
  pruneBackupsHeld,
  removeHoldingBackups,
  retentionRetry,
  setDestructionNotes,
  setOldCopiesNotes,
  setRetentionRetry,
  unresolvedBackupsOf,
  withProjectMaintenance,
  DEFAULT_KEEP,
  type DestructionNote,
  type MaintenanceHold,
  type OldCopiesNote,
  type RetentionRetry,
} from "./export/backup.js";
import { DESTRUCTION_CERTIFICATE, amendmentNumber } from "./repo/destroy.js";
import { NotFoundError } from "./repo/errors.js";
import { SimulatedCrash } from "./repo/seams.js";
import {
  amendProjectDestruction,
  appendLibraryEvent,
  auditEventsMentioning,
  destroyProjectAssets,
  lookupPolicyInfo,
  repoClock,
  repoLibrary,
  verifiedAuditEvents,
  type Repo,
} from "./repo/repo.js";
import { toRel } from "./repo/txn.js";
import { isDue, projectTimeZone } from "./retention-date.js";
import type { DestructionOldCopiesPending } from "@ao/shared";

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
  /** Those in `deleted` that the app removed for another destruction of this project: the certificate of that destruction. */
  removedUnder?: Record<string, string>;
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
  /**
   * In a restored copy: the id of the project the data was destroyed in. The certificate and its
   * amendments were copied byte for byte, so they name that project's ids and folder (R175).
   */
  inheritedFrom?: string;
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
  const paths = new Set<string>();
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
    for (const a of sf.assets) {
      if (!set.has(a.id)) continue;
      names.add(baseName(a.path));
      paths.add(a.path);
    }
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
  // Decided once, here too (R379): the old copies of the library left by a move that hold any of these files.
  const copies = await holdingOldCopies(repo, projectId, [...paths]);
  const copiesSaid = copies.notDestroyed.length > 0 || copies.unchecked;
  const res = await destroyProjectAssets(repo, projectId, {
    plan: [...plan.entries()].map(([sourceId, ids]) => ({ sourceId, assetIds: [...ids] })),
    strayCopies: strays,
    certificateStem: (at) => certificateStem(at, tz),
    backups: { toRemove, unreadable },
    ...(copiesSaid ? { oldCopies: copies } : {}),
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
      // Always said (R409 b): "none known to this computer" when this computer's list names none that holds them.
      oldCopies: {
        status: copies.unchecked ? "unknown-pending" : copiesSaid ? "pending" : "none",
        notDestroyed: copies.notDestroyed.map((c) => ({ movedAt: c.movedAt, moveId: c.moveId })),
        note: oldCopiesSentence(copies.notDestroyed, copies.unchecked, tz),
      },
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
  const audited = newAudited(projectId, basename(res.certificateRel), res.certificateSha256, res.at, toRemove, unreadable);
  for (const c of copies.notDestroyed) audited.oldCopies.set(c.id, { movedAt: c.movedAt, moveId: c.moveId });
  audited.oldCopiesUnchecked = copies.unchecked;
  if (copiesSaid) {
    // The warning stands from the destruction itself (R379), as the backups' does once noted.
    const notes = await oldCopiesNotes(repo, projectId).catch((): Record<string, OldCopiesNote> => ({}));
    await setOldCopiesNotes(repo, projectId, { ...notes, [res.certificateRel]: oldCopiesNoteOf(audited) }).catch(() => {});
  }
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
  // Only files named as the app names its backups are ever listed (and so ever removed).
  return { files: files.filter(isBackupFileName), unresolved: (await unresolvedBackupsOf(repo, projectId)).filter(isBackupFileName) };
}

// ------------------------------------------------------------------------------------------
// What the audit log says of each destruction (R147)

function statusOf(a: Audited): BackupsStepStatus {
  if (!a.toRemove.length && !a.unreadable.length) return "none";
  const left = outstandingOf(a);
  if (left.some((f) => a.unreadable.includes(f))) return "unknown-pending";
  if (left.length) return "pending";
  return a.gone.size ? "no-longer-present" : "deleted";
}

/** Lines of the audit log worth parsing for this: the destruction and backups-step events, and backups made. */
const NEEDLES = ['"retention.', '"backup.create"'] as const;

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
  "The audit log of this project does not hold together: an entry was changed or removed outside the app. Until it does, the app removes no backup on its word, records nothing about these backups and does not end this warning, also when a backup listed here is no longer in the Backups folder.";
const FILES_DISAGREE = "While its files and the audit log disagree, the app removes no backup for this destruction by itself. If the backups still listed are removed by hand, the app records that they are gone.";
const UNRECORDED =
  "The audit log does not record this destruction certificate in the form the app now keeps (it was written by an earlier version of the app, or outside it), so the app does not remove the backups it lists by itself. If they hold destroyed data, remove them by hand.";
const CANNOT_TELL =
  "The audit log this project was restored with does not record the making of this backup, so the app cannot tell whether the file now under this name is the backup that was listed. It was left as it is. If it holds the destroyed data, remove it by hand.";
/** Never with the name the note gives: it is text from a file anyone can edit, and may be a path (R96). */
const STATE_DISAGREES =
  "The app's own note of the backups still to remove (backups-state.json in the Backups folder) names a backup for this destruction that the audit log does not. Nothing was removed for this destruction this time, and the note was corrected from the audit log.";

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
  if (a.removedUnder.size) b.removedUnder = Object.fromEntries(a.removedUnder);
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
  const copies = presentOldCopies(original, a);
  return { ...original, backups: b, ...(copies ? { oldCopies: copies } : {}) };
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
 * disagreement is said in `problem`. So is an audit log that does not hold together (its chain is
 * verified here): the status given is then only that log's word. Reads only. A locked project's
 * sealed certificates cannot be read (ProjectLockedError).
 */
export async function listDestructions(repo: Repo, projectId: string): Promise<DestructionRecord[]> {
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  const view = await scan(repo, projectId);
  const names = await retentionNames(repo, dirRel);
  const logProblem = !view.headMatches ? AUDIT_CHANGED : view.list.length && !(await verifiedAuditEvents(repo, projectId)).ok ? AUDIT_UNVERIFIED : undefined;
  const out: DestructionRecord[] = [];
  for (const a of view.list) {
    const disk = await onDisk(repo, projectId, dirRel, a, names);
    const problem = logProblem ?? disk.problem;
    out.push({
      certificateFile: `${dirRel}/${a.certificate}`,
      certificateSha256: a.certificateSha256,
      verified: disk.verified,
      ...(disk.original ? { original: disk.original, certificate: present(disk.original, disk.amendments, a) } : {}),
      amendments: disk.amendments,
      status: statusOf(a),
      outstanding: outstandingOf(a),
      ...(problem ? { problem } : {}),
      ...(a.projectId !== projectId ? { inheritedFrom: a.projectId } : {}),
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
  /**
   * With `observeOnly`: asked once something would be recorded, before anything is written. False:
   * the audit log does not hold together, and this pass writes nothing (R174).
   */
  mayRecord?: () => Promise<boolean>;
  /** The certificate as written at the destruction (verified), for the ids of the destroyed assets. */
  certificate?: Record<string, unknown>;
  /** Every destruction the same reading of the audit log records (this one among them). */
  all?: readonly Audited[];
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
  // An inherited destruction (R175): the listed backups are the origin's. This project's audit log
  // cannot see what the origin did after the copy was made, so a file is removed only when it is, byte
  // for byte, the backup the inherited log recorded under that name: never one that only carries the name.
  const inherited = a.projectId !== projectId;
  const gone: string[] = [];
  const missing: string[] = [];
  const notHolding: string[] = [];
  const toDelete: string[] = [];
  const unidentified: string[] = [];
  /** Missing because the app removed it for another destruction of this project, as the audit log says (M3): file → that record. */
  const elsewhere = new Map<string, { certificate: string; at: string }>();
  for (const f of left) {
    const s = files.get(fileOf(f));
    if (a.reused.has(f)) gone.push(f);
    else if (!s?.present) {
      // (Not a removal from before this destruction: that was an earlier backup of the same name.)
      const o = (opts.all ?? []).find((x) => x.certificateSha256 !== a.certificateSha256 && x.removed.has(f) && !x.removedUnder.has(f) && x.removed.get(f)! >= a.at);
      if (o) elsewhere.set(f, { certificate: o.certificate, at: o.removed.get(f)! });
      else gone.push(f);
      missing.push(f);
    } else if (!act) continue;
    else if (a.toRemove.includes(f)) (inherited && !a.made.has(f) ? unidentified : toDelete).push(f);
    else if (!s.entry || !destroyed) continue; // still cannot be read: stays listed, never deleted blindly
    else if (s.entry.projectId === a.projectId && (!Array.isArray(s.entry.assets) || s.entry.assets.some((id) => destroyed.has(id)))) toDelete.push(f);
    else notHolding.push(f);
  }
  // An observing pass has nothing to do unless a listed backup is gone; and it records that only on
  // the word of a log that holds together: otherwise nothing is written, not even to the manifest.
  if (!act && ((!gone.length && !elsewhere.size) || (opts.mayRecord !== undefined && !(await opts.mayRecord())))) return undefined;

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
      const names = toDelete.map(fileOf);
      // Of an inherited list: only the very file that was listed, and never at the same time as a
      // backup, a prune, a restore or a destruction of the project it belongs to (R138 a).
      const expect = inherited ? new Map(toDelete.flatMap((f) => (a.made.has(f) ? [[fileOf(f), a.made.get(f)!] as const] : []))) : undefined;
      const remove = () => removeHoldingBackups(repo, names, expect);
      const r = inherited && repo.listProjects().some((p) => p.id === a.projectId) ? await withProjectMaintenance(repo, a.projectId, remove) : await remove();
      removed = r.removed.map(backupRel);
      // A file of another content under a listed name is a later backup: the listed one is gone.
      gone.push(...r.gone.map(backupRel), ...r.other.map(backupRel));
      failed = r.failed.map(({ file, error }) => ({ file: backupRel(file), reason: `It could not be overwritten and removed (${plainErrorText(repo, error)}).` }));
      if (r.failed.length) otherError = `A backup holding the destroyed files could not be removed (${plainErrorText(repo, r.failed[0]!.error)}); the step will be tried again`;
    }
    failed.push(...unidentified.map((file) => ({ file, reason: CANNOT_TELL })));
    await forgetMissingBackups(repo, missing.map(fileOf));
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    otherError = plainError(repo, err);
  }
  backupCrashPoint("before-removal-record");

  const freshBackupFailed = a.freshBackup || freshMade ? undefined : (freshFailed ?? a.freshBackupFailed);
  const changed = removed.length > 0 || gone.length > 0 || elsewhere.size > 0 || notHolding.length > 0 || freshMade !== undefined;
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

  // What this pass found, applied to a copy of the list: `a` itself changes only once it is recorded.
  const next: Audited = { ...a, removed: new Map(a.removed), removedUnder: new Map(a.removedUnder), gone: new Map(a.gone), notHolding: new Map(a.notHolding) };
  for (const f of removed) next.removed.set(f, at);
  for (const [f, e] of elsewhere) {
    next.removed.set(f, e.at);
    next.removedUnder.set(f, e.certificate);
  }
  for (const f of gone) next.gone.set(f, at);
  for (const f of notHolding) next.notHolding.set(f, at);
  if (freshMade) next.freshBackup = freshMade;
  if (freshBackupFailed) next.freshBackupFailed = freshBackupFailed;
  else delete next.freshBackupFailed;
  const outstanding = outstandingOf(next);
  const status = statusOf(next);
  // The note says only what happened (N1): composed from the outcome above.
  let note: string | undefined;
  if (act && freshBackupFailed) {
    const stop = /[.!?]$/u.test(freshBackupFailed) ? "" : ".";
    const one = failed.length === 1;
    note = failed.length
      ? `No new backup could be made after the destruction: ${freshBackupFailed}${stop} ${one ? "A backup that holds the destroyed files could not be removed yet" : "Some backups that hold the destroyed files could not be removed yet"} (see notRemoved); removing ${one ? "it" : "them"} is tried again.`
      : `${next.gone.size ? "None of the earlier backups that held the destroyed files is in the Backups folder any more" : "The earlier backups that held the destroyed files were removed"}. No new backup could be made afterwards: ${freshBackupFailed}${stop} This project has no backup until one succeeds.`;
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
      removed: [...removed.map((file) => ({ file, at })), ...[...elsewhere].map(([file, e]) => ({ file, at: e.at, under: e.certificate }))],
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
  const removedByApp = [...removed, ...elsewhere.keys()];
  const facts = {
    stepAt: at,
    status,
    removed: removedByApp,
    ...(elsewhere.size ? { removedUnder: Object.fromEntries(elsewhere) } : {}),
    noLongerPresent: gone,
    ...(notHolding.length ? { notHolding } : {}),
    notRemoved: outstanding,
    ...(freshMade ? { freshBackup: freshMade } : {}),
    ...(freshBackupFailed ? { freshBackupFailed } : {}),
  };
  const w = await amendProjectDestruction(repo, projectId, { certificate: a.certificate, certificateSha256: a.certificateSha256, number, content, facts });
  // Recorded: the list is now what the audit log says.
  Object.assign(a, { removed: next.removed, removedUnder: next.removedUnder, gone: next.gone, notHolding: next.notHolding });
  if (next.freshBackup) a.freshBackup = next.freshBackup;
  if (next.freshBackupFailed) a.freshBackupFailed = next.freshBackupFailed;
  else delete a.freshBackupFailed;
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
    removed: removedByApp,
    ...(elsewhere.size ? { removedUnder: Object.fromEntries(elsewhere) } : {}),
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
  /**
   * Whether the whole log, read in this pass with its chain verified, holds together. Asked before
   * anything is written or dropped (R174): a pass that changes nothing does not read the log in full.
   */
  let holds: boolean | undefined;
  const logHolds = async (): Promise<boolean> => (holds ??= view.headMatches && (await verifiedAuditEvents(repo, projectId)).ok);
  // The old copies of the library first (R379): what it records is added to the same audit-log
  // records the backups step below works on, so their amendments are numbered one after the other.
  let firstError: unknown = await syncOldCopies(repo, projectId, view.list, view.headMatches, logHolds);
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
        if (extra !== undefined) problem = STATE_DISAGREES;
      }
      if (!problem) {
        const rec = await retentionRetry(repo, retryKey(projectId, rel));
        if (!retryDue(rec, a, now)) {
          // Not tried this time: what the last try found about the log still stands.
          if (Object.hasOwn(found, rel) && found[rel]!.problem === AUDIT_UNVERIFIED) problem = AUDIT_UNVERIFIED;
        } else {
          // Before anything is removed: the whole log, its chain verified, read again.
          const checked = await verifiedAuditEvents(repo, projectId);
          holds = checked.ok;
          const all = checked.ok ? auditedDestructions(checked.events).list : [];
          const sure = all.find((x) => x.certificateSha256 === a.certificateSha256);
          if (sure) {
            a = sure;
            await settleBackups(repo, hold, projectId, a, { retry: true, all, ...(disk?.original ? { certificate: disk.original } : {}) });
            out.push(join(lib.root, ...rel.split("/")));
          } else {
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
          }
        }
      } else if (problem !== AUDIT_CHANGED) {
        // A convenience disagrees: nothing is removed. A listed backup that is gone is still recorded
        // as gone, and the disagreement is said once in the audit log (not at every pass): both only
        // on the word of a log that holds together. Otherwise this pass writes nothing (R174).
        await settleBackups(repo, hold, projectId, a, { retry: true, observeOnly: true, mayRecord: logHolds, all: view.list });
        if (outstandingOf(a).length && scanned.reportedProblem !== problem && (await logHolds())) {
          await appendLibraryEvent(repo, projectId, "retention.backups", {
            certificate: a.certificate,
            certificateSha256: a.certificateSha256,
            status: statusOf(a),
            problem,
            removed: [],
            notRemoved: outstandingOf(a),
          });
        }
        if (holds === false) problem = AUDIT_UNVERIFIED;
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
  // A noted backup leaves the note, and so the warning, only on the word of a log that holds
  // together (R147 4, R174), whether or not its file is still in the Backups folder. The lines read
  // above are not checked against the chain, so before anything noted is dropped the whole log is
  // read and verified (unless this pass already did). If it does not hold, everything noted stays.
  try {
    const leaving = Object.entries(found).flatMap(([rel, note]) =>
      note.files.filter((f) => isBackupRel(f) && isBackupFileName(fileOf(f)) && !notes[rel]?.files.includes(f)).map((file) => ({ rel, file })),
    );
    if (leaving.length && !(await logHolds())) {
      for (const x of leaving) notes[x.rel] = { files: [...new Set([...(notes[x.rel]?.files ?? []), x.file])], problem: view.headMatches ? AUDIT_UNVERIFIED : AUDIT_CHANGED };
    }
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err;
    // It could not be checked: the notes are not rewritten this time, and the next pass checks again.
    throw firstError ?? err;
  }
  await setDestructionNotes(repo, projectId, notes).catch(() => {});
  if (firstError !== undefined) throw firstError;
  return out;
}

/** A destruction whose listed backups are not all gone yet, as the last retry pass noted it. */
export interface PendingRemoval {
  /** Library-relative path of the destruction certificate. */
  certificateFile: string;
  /** Backups (library-relative) still to be removed. */
  backups: string[];
  /** Why the app does not remove them by itself (plain words), when it does not. */
  reason?: string;
}

/**
 * What stands behind the project's `destruction-backups-pending` warning: which backups wait, for
 * which destruction, and why the app does not remove them by itself when it does not. Read from the
 * note the last retry pass wrote from the audit log (cheap; `listDestructions` reads the log itself).
 */
export async function backupsAwaitingRemoval(repo: Repo, projectId: string): Promise<PendingRemoval[]> {
  const notes = await destructionNotes(repo, projectId);
  return Object.keys(notes)
    .sort()
    .map((rel) => ({ certificateFile: rel, backups: notes[rel]!.files, ...(notes[rel]!.problem ? { reason: notes[rel]!.problem } : {}) }));
}

// ------------------------------------------------------------------------------------------
// Old copies of the library left by a move (R379)

/** How a destruction's old copies stand. none: none held the files (or, checked later, none did). pending: one still holds them. unknown-pending: the list could not be read yet. deleted / no-longer-present: as for backups. */
export type OldCopiesStatus = BackupsStepStatus;

const ENOENT_LIKE = new Set(["ENOENT", "ENOTDIR"]);
const exists = (p: string): Promise<"yes" | "no" | "cannot-tell"> =>
  fsp.lstat(p).then(
    () => "yes" as const,
    (e: NodeJS.ErrnoException) => (ENOENT_LIKE.has(e.code ?? "") ? ("no" as const) : ("cannot-tell" as const)),
  );

/**
 * What a look at an old place found (R409 a): `holds` — some of what was looked for is there;
 * `none` — the place was looked at and holds none of it; `cannot-tell` — it could not be looked at
 * (not reachable, an error other than "not there"). A destruction names a copy unless the look
 * says `none`; a retry pass records a copy as gone only when it says `none`.
 */
export type OldPlaceLook = "holds" | "none" | "cannot-tell";

/** The old folder itself: there, gone (its parent is there: it was deleted), or cannot tell (a disk unplugged: neither is there). */
async function oldRootThere(root: string): Promise<"yes" | "gone" | "cannot-tell"> {
  const here = await exists(root);
  if (here === "yes") return "yes";
  if (here === "cannot-tell") return "cannot-tell";
  return (await exists(dirname(root))) === "yes" ? "gone" : "cannot-tell";
}

/** What a look for one destruction's files searches (R379, R409). */
interface DestroyedData {
  /** The project the destruction was made in (as its audit events name it). */
  projectId: string;
  /** Library-relative paths of the destroyed files. */
  paths: readonly string[];
}

/**
 * Whether the old copy at `root` still holds any of the destroyed files: each looked for at the same
 * place, and in any `Projects/<n>` of the old copy whose project.json names the project (a folder
 * renamed since the move).
 */
async function lookAtPlace(root: string, what: DestroyedData): Promise<OldPlaceLook> {
  const there = await oldRootThere(root);
  if (there !== "yes") return there === "gone" ? "none" : "cannot-tell";
  let unsure = false;
  // `Projects/<n>` folders the paths are in, and those of the old copy that hold this project now.
  const split = what.paths.flatMap((p) => {
    const parts = p.split("/");
    return parts.length > 2 && parts[0] === "Projects" ? [{ folder: `${parts[0]}/${parts[1]}`, rest: parts.slice(2) }] : [];
  });
  const folders = new Set(split.map((x) => x.folder));
  let names: string[] = [];
  try {
    names = await fsp.readdir(join(root, "Projects"));
  } catch (e) {
    if (!ENOENT_LIKE.has((e as NodeJS.ErrnoException).code ?? "")) unsure = true;
  }
  for (const n of names) {
    if (folders.has(`Projects/${n}`)) continue;
    const raw = await fsp.readFile(join(root, "Projects", n, "project.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (!ENOENT_LIKE.has(e.code ?? "")) unsure = true;
      return null;
    });
    const id = raw === null ? undefined : (parseObject(Buffer.from(raw))?.project as { id?: unknown } | undefined)?.id;
    if (id === what.projectId) folders.add(`Projects/${n}`);
  }
  for (const folder of folders) {
    for (const x of split) {
      const e = await exists(join(root, ...folder.split("/"), ...x.rest));
      if (e === "yes") return "holds";
      if (e === "cannot-tell") unsure = true;
    }
  }
  return unsure ? "cannot-tell" : "none";
}

/**
 * A look at the old copy a record names, for one destruction's data. The library's own folder is
 * never an old copy of itself (a move A→B→A): `none`.
 */
async function oldCopyLook(currentRoot: string, rec: PendingOldCopy, what: DestroyedData): Promise<OldPlaceLook> {
  const root = resolve(rec.oldRoot);
  if (root === resolve(currentRoot)) return "none";
  return lookAtPlace(root, what);
}

/**
 * Whether the old place of a record the app deleted still holds anything of the library (R409 a):
 * a file in any of the folders the old copy shared with the move (the whole `Projects/` of a
 * whole-library copy, except folders moved away earlier; a split copy's moved `Projects/<n>`
 * folders), other than the move's own marker. `none` only when the place was looked at and holds
 * nothing of them, or is gone.
 */
export async function oldPlaceLook(rec: PendingOldCopy): Promise<OldPlaceLook> {
  const root = resolve(rec.oldRoot);
  const there = await oldRootThere(root);
  if (there !== "yes") return there === "gone" ? "none" : "cannot-tell";
  const scope = rec.split ? rec.movedFolders : ["Projects"];
  const skip = new Set((rec.split ? [] : (rec.movedAway ?? [])).map((f) => join(root, ...f.split("/"))));
  let unsure = false;
  const walk = async (p: string): Promise<boolean> => {
    if (skip.has(p)) return false;
    const st = await fsp.lstat(p).catch((e: NodeJS.ErrnoException) => {
      if (!ENOENT_LIKE.has(e.code ?? "")) unsure = true;
      return null;
    });
    if (!st) return false;
    if (!st.isDirectory()) return basename(p) !== "MOVED.json";
    let names: string[];
    try {
      names = await fsp.readdir(p);
    } catch {
      unsure = true;
      return false;
    }
    for (const n of names) if (await walk(join(p, n))) return true;
    return false;
  };
  for (const f of scope) if (await walk(join(root, ...f.split("/")))) return "holds";
  return unsure ? "cannot-tell" : "none";
}

/**
 * Package-internal (move.ts, and every retry pass): drops this computer's record `id` of an old copy
 * the app deleted, once its place holds nothing of the library (oldPlaceLook says `none`) and no
 * destruction of the library still names it (the notes in `backupsDir`, any project). Otherwise it
 * stays, and passes go on looking (R409 a). Nothing is dropped from a list that is damaged.
 */
export async function pruneDeletedOldCopy(deps: { appConfigDir: string; clock: () => Date }, libraryId: string, id: string, backupsDir: string): Promise<void> {
  const { records, damaged } = await oldCopiesOfLibrary(deps, libraryId);
  const r = records.find((x) => x.id === id);
  if (damaged || !r?.deleted) return;
  if ((await oldPlaceLook(r)) !== "none") return;
  if (await oldCopyNotedIn(backupsDir, id)) return;
  await removePendingOldCopy(deps, id);
}

/** The listed old copies of this library that hold any of `paths`, or cannot be looked at; `unchecked` when the list cannot be read (never "none"). */
async function holdingOldCopies(repo: Repo, projectId: string, paths: readonly string[]): Promise<{ notDestroyed: Array<OldCopyRef & { id: string }>; unchecked: boolean }> {
  const lib = repoLibrary(repo);
  let records: PendingOldCopy[];
  try {
    const list = await oldCopiesOfLibrary({ appConfigDir: lib.appConfigDir, clock: repoClock(repo) }, lib.id);
    // A damaged list (or a record without a usable place) is not "none" either (R409 b).
    if (list.damaged) return { notDestroyed: [], unchecked: true };
    records = list.records;
  } catch {
    return { notDestroyed: [], unchecked: true };
  }
  const out: Array<OldCopyRef & { id: string }> = [];
  for (const r of records) if ((await oldCopyLook(lib.root, r, { projectId, paths })) !== "none") out.push({ id: r.id, movedAt: r.createdAt, moveId: r.moveId });
  return { notDestroyed: out, unchecked: false };
}

/** The date of a move, in the project's zone: how a researcher knows which old copy is meant. */
const moveDate = (movedAt: string, tz: string | undefined) => formatModified(new Date(movedAt), tz).slice(0, 10);

/** The certificate's line when this computer's list names no old copy that holds the destroyed data (R409 b). */
export const OLD_COPIES_NONE = "Old copies of the library left by a move: none known to this computer.";

/** The certificate's plain words about its old copies (R379). */
function oldCopiesSentence(copies: readonly OldCopyRef[], unchecked: boolean, tz: string | undefined): string {
  if (unchecked) {
    return "This computer's list of old copies of this library left by a move could not be read, so whether such a copy still holds the destroyed data could not be checked. Any that does was not destroyed.";
  }
  const n = copies.length;
  if (n === 0) return OLD_COPIES_NONE;
  const dates = [...new Set(copies.map((c) => moveDate(c.movedAt, tz)))].join(", ");
  return `${n === 1 ? "An old copy" : `${n} old copies`} of this library, left by the move of ${dates}, still ${n === 1 ? "holds" : "hold"} the destroyed data and ${n === 1 ? "was" : "were"} not destroyed. Delete ${n === 1 ? "it" : "them"} from the Move library screen (or by hand) to complete the destruction.`;
}

function oldCopiesStatusOf(a: Audited): OldCopiesStatus {
  if (oldCopiesOutstandingOf(a).length) return "pending";
  if (a.oldCopiesUnchecked && a.oldCopiesCheckedAt === undefined) return "unknown-pending";
  if (!a.oldCopies.size) return "none";
  return a.oldCopiesGone.size ? "no-longer-present" : "deleted";
}

/** The note behind the warning for one destruction (R379). */
function oldCopiesNoteOf(a: Audited): OldCopiesNote {
  const copies = oldCopiesOutstandingOf(a).map((id) => ({ id, movedAt: a.oldCopies.get(id)!.movedAt }));
  return { copies, ...(a.oldCopiesUnchecked && a.oldCopiesCheckedAt === undefined ? { unchecked: true as const } : {}) };
}

/** The certificate's `oldCopies` brought up to date from the audit log, as `backups` is; undefined when it never had any. */
function presentOldCopies(original: Record<string, unknown>, a: Audited): Record<string, unknown> | undefined {
  const own = original.oldCopies;
  if (own === undefined && !a.oldCopies.size && !a.oldCopiesUnchecked) return undefined;
  const ref = (id: string) => ({ movedAt: a.oldCopies.get(id)!.movedAt });
  const left = oldCopiesOutstandingOf(a);
  return {
    ...(own && typeof own === "object" ? (own as Record<string, unknown>) : {}),
    status: oldCopiesStatusOf(a),
    ...(a.oldCopiesCheckedAt ? { checkedAt: a.oldCopiesCheckedAt, notDestroyed: [...a.oldCopies.values()].map((c) => ({ movedAt: c.movedAt, moveId: c.moveId })) } : {}),
    ...(a.oldCopiesRemoved.size ? { removed: [...a.oldCopiesRemoved].map(([id, at]) => ({ ...ref(id), at })) } : {}),
    ...(a.oldCopiesGone.size ? { noLongerHolding: [...a.oldCopiesGone].map(([id, at]) => ({ ...ref(id), at })) } : {}),
    ...(left.length ? { outstanding: left.map(ref) } : {}),
  };
}

/** The library-relative paths a certificate says were destroyed. */
function destroyedPaths(certificate: Record<string, unknown> | undefined): string[] {
  const assets = Array.isArray(certificate?.assets) ? (certificate.assets as Array<{ path?: unknown }>) : [];
  return assets.map((x) => x?.path).filter((x): x is string => typeof x === "string");
}

/**
 * One look at a destruction's old copies (R379), on the list the audit log holds for it (`a`,
 * brought up to date with what is recorded here): a list not read at the destruction is read and
 * checked; each listed copy whose place was looked at and holds none of the destroyed files is
 * recorded — as removed when the app deleted it (just now, `justDeleted`, or earlier with nothing
 * left behind), otherwise as no longer holding them. A copy this computer's list has no record of
 * (the library opened on another computer, a restored copy in another library, a list that lost it)
 * is "cannot tell", and so is a place that could not be looked at: nothing is recorded for it, and
 * the warning stays (R409 a, as R147 has it for backups). What changed is an amendment beside the
 * certificate (governed, its audit event carrying the same facts) and a `retention.old-copies`
 * report. A list that is damaged or cannot be read, or a certificate that does not verify, records
 * nothing (the warning stays).
 */
async function settleOldCopies(
  repo: Repo,
  projectId: string,
  a: Audited,
  opts: { certificate?: Record<string, unknown>; justDeleted?: string; mayRecord: () => Promise<boolean> },
): Promise<void> {
  const left = oldCopiesOutstandingOf(a);
  const needCheck = a.oldCopiesUnchecked && a.oldCopiesCheckedAt === undefined;
  if (!left.length && !needCheck) return;
  const paths = destroyedPaths(opts.certificate);
  if (!paths.length) return; // nothing to look for: cannot tell, so nothing is recorded
  const what: DestroyedData = { projectId: a.projectId, paths };
  const lib = repoLibrary(repo);
  let records: PendingOldCopy[];
  try {
    const list = await oldCopiesOfLibrary({ appConfigDir: lib.appConfigDir, clock: repoClock(repo) }, lib.id);
    if (list.damaged) return; // cannot tell (R409 a)
    records = list.records;
  } catch {
    return;
  }
  const found: Array<OldCopyRef & { id: string }> = [];
  if (needCheck) for (const r of records) if ((await oldCopyLook(lib.root, r, what)) !== "none") found.push({ id: r.id, movedAt: r.createdAt, moveId: r.moveId });
  const removed: string[] = [];
  const gone: string[] = [];
  for (const id of left) {
    const r = records.find((x) => x.id === id);
    if (!r) continue; // no record on this computer: cannot tell (R409 a)
    if ((await oldCopyLook(lib.root, r, what)) !== "none") continue;
    // Removed by the app only when the app deleted it and left nothing (or this is that deletion's own look, R147).
    if (r.deleted && (opts.justDeleted === id || !r.deleted.remains)) removed.push(id);
    else gone.push(id);
  }
  if (!needCheck && !removed.length && !gone.length) return;
  if (!(await opts.mayRecord())) return;

  const at = repoClock(repo)().toISOString();
  const next: Audited = { ...a, oldCopies: new Map(a.oldCopies), oldCopiesRemoved: new Map(a.oldCopiesRemoved), oldCopiesGone: new Map(a.oldCopiesGone) };
  if (needCheck) {
    next.oldCopiesCheckedAt = at;
    for (const c of found) next.oldCopies.set(c.id, { movedAt: c.movedAt, moveId: c.moveId });
  }
  for (const id of removed) next.oldCopiesRemoved.set(id, at);
  for (const id of gone) next.oldCopiesGone.set(id, at);
  const status = oldCopiesStatusOf(next);
  const refOf = (id: string) => ({ movedAt: next.oldCopies.get(id)!.movedAt });
  const number = a.amendments.length + 1;
  const content = {
    formatVersion: 1,
    kind: "destruction-certificate-amendment",
    projectId,
    certificate: a.certificate,
    certificateSha256: a.certificateSha256,
    number,
    at,
    oldCopies: {
      ...(needCheck ? { checkedAt: at, found: found.map((c) => ({ movedAt: c.movedAt, moveId: c.moveId })) } : {}),
      removed: removed.map((id) => ({ ...refOf(id), at })),
      noLongerHolding: gone.map((id) => ({ ...refOf(id), at })),
      outstanding: oldCopiesOutstandingOf(next).map(refOf),
      status,
    },
  };
  const facts = {
    stepAt: at,
    ...(needCheck ? { oldCopiesCheckedAt: at, oldCopiesFound: found } : {}),
    oldCopiesRemoved: removed,
    oldCopiesNoLongerHolding: gone,
    oldCopiesStatus: status,
  };
  const w = await amendProjectDestruction(repo, projectId, { certificate: a.certificate, certificateSha256: a.certificateSha256, number, content, facts });
  // Recorded: the list is now what the audit log says.
  Object.assign(a, { oldCopies: next.oldCopies, oldCopiesRemoved: next.oldCopiesRemoved, oldCopiesGone: next.oldCopiesGone });
  if (next.oldCopiesCheckedAt) a.oldCopiesCheckedAt = next.oldCopiesCheckedAt;
  a.amendments.push({ name: w.name, sha256: w.sha256, at });
  a.lastRecordedAt = at;
  await appendLibraryEvent(repo, projectId, "retention.old-copies", {
    certificate: a.certificate,
    certificateSha256: a.certificateSha256,
    amendment: w.name,
    amendmentSha256: w.sha256,
    status,
    removed: removed.length,
    noLongerHolding: gone.length,
    ...(needCheck ? { checked: true, found: found.length } : {}),
    outstanding: oldCopiesOutstandingOf(a).length,
  });
}

/**
 * Every destruction of the project with old copies outstanding (R379): each looked at once (see
 * settleOldCopies), then the note behind `destruction-old-copies-pending` rewritten from what the
 * audit log says. A noted copy leaves the note only on the word of a log that holds together.
 */
async function syncOldCopies(
  repo: Repo,
  projectId: string,
  list: readonly Audited[],
  headMatches: boolean,
  logHolds: () => Promise<boolean>,
  justDeleted?: string,
): Promise<unknown> {
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  const notes: Record<string, OldCopiesNote> = {};
  let firstError: unknown;
  for (const a of list) {
    if (!oldCopiesPending(a)) continue;
    const rel = `${dirRel}/${a.certificate}`;
    try {
      if (headMatches) {
        const buf = await readPlain(repo, projectId, rel);
        // Only a certificate that is the one the audit log recorded is believed for what was destroyed.
        if (Buffer.isBuffer(buf) && sha256(buf) === a.certificateSha256) {
          await settleOldCopies(repo, projectId, a, { certificate: parseObject(buf), mayRecord: logHolds, ...(justDeleted ? { justDeleted } : {}) });
        }
      }
    } catch (err) {
      if (err instanceof SimulatedCrash) throw err;
      firstError ??= err;
    }
    if (oldCopiesPending(a)) notes[rel] = oldCopiesNoteOf(a);
  }
  const found = await oldCopiesNotes(repo, projectId).catch((): Record<string, OldCopiesNote> => ({}));
  const leaving = Object.entries(found).filter(([rel, n]) => n.copies.some((c) => !notes[rel]?.copies.some((x) => x.id === c.id)) || (n.unchecked && !notes[rel]?.unchecked));
  if (leaving.length && !(await logHolds().catch(() => false))) {
    for (const [rel, n] of leaving) notes[rel] = { copies: [...(notes[rel]?.copies ?? []), ...n.copies.filter((c) => !notes[rel]?.copies.some((x) => x.id === c.id))], ...(n.unchecked || notes[rel]?.unchecked ? { unchecked: true as const } : {}) };
  }
  await setOldCopiesNotes(repo, projectId, notes).catch(() => {});
  // Records of old copies the app deleted, kept to be looked at (R409 a): dropped once nothing of the library is left there and no destruction names them.
  const lib = repoLibrary(repo);
  const cfg = { appConfigDir: lib.appConfigDir, clock: repoClock(repo) };
  const kept = await oldCopiesOfLibrary(cfg, lib.id).catch(() => ({ records: [] as PendingOldCopy[], damaged: true }));
  if (!kept.damaged) for (const r of kept.records) if (r.deleted) await pruneDeletedOldCopy(cfg, lib.id, r.id, join(lib.root, "Backups")).catch(() => {});
  return firstError;
}

/**
 * Package-internal (move.ts, deleteOldCopy): the old copy `id` was just deleted through the app (its
 * record is marked deleted, R409 a). Each destruction of the project that lists it records it as
 * removed (an amendment and a report, R147 as for backups) once none of the destroyed files is left
 * in it, and the warning follows. Nothing is done in a read-only library or a locked project: the
 * record stays, and the next retry pass there looks at the place.
 */
export function recordOldCopyDeleted(repo: Repo, projectId: string, id: string): Promise<void> {
  return withProjectMaintenance(repo, projectId, async () => {
    if (repoLibrary(repo).mode !== "read-write" || !repo.isUnlocked(projectId)) return;
    const view = await scan(repo, projectId);
    if (!view.list.some((a) => a.oldCopies.has(id))) return;
    let holds: boolean | undefined;
    const logHolds = async () => (holds ??= view.headMatches && (await verifiedAuditEvents(repo, projectId)).ok);
    const err = await syncOldCopies(repo, projectId, view.list, view.headMatches, logHolds, id);
    if (err !== undefined) throw err;
  });
}

/** What stands behind the project's `destruction-old-copies-pending` warning: for each destruction, the old copies still holding its files (by the time of the move), or that the list could not be checked. */
export async function oldCopiesAwaitingDeletion(repo: Repo, projectId: string): Promise<DestructionOldCopiesPending[]> {
  const notes = await oldCopiesNotes(repo, projectId);
  return Object.keys(notes)
    .sort()
    .map((rel) => ({ certificateFile: rel, oldCopies: notes[rel]!.copies.map((c) => ({ movedAt: c.movedAt })), ...(notes[rel]!.unchecked ? { unchecked: true as const } : {}) }));
}

/** `destruction-<YYYY-MM-DD HHmm>` for a time in `tz`. */
export function certificateStem(at: Date, tz?: string): string {
  return `destruction-${formatModified(at, tz)}`;
}
