/**
 * Retention and destruction of raw data (spec 6.3(5), R90 d).
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
 * Then the app's backups that hold any of the destroyed files: a fresh backup is tried first, and
 * those backups are overwritten and removed whether or not it could be made (R138 e). The
 * certificate records each one removed (and when), each one that could NOT be removed with its
 * reason (`notRemoved`; the project shows `destruction-backups-pending` until a retry removes it),
 * and, if no fresh backup could be made, why (`freshBackupFailed`, `note`). A crash or a failed
 * removal leaves the certificate's backups "pending": `resumeDestruction` (Task 30, at start) retries.
 * Destruction holds the project's maintenance lock (R138 a).
 * Audited: the change's `delete` event (op `retention.destroy`), `retention.destroyed` (counts and
 * the certificate's sha256; no paths) and `retention.backups` when backups are settled.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, join } from "node:path";
import { formatModified, type Asset } from "@ao/core";
import {
  backupFailureReason,
  backupProjectHeld,
  destroyBackups,
  listBackups,
  plainErrorText,
  pruneBackupsHeld,
  retentionRetry,
  setHoldingNotRemoved,
  setRetentionRetry,
  unresolvedBackupsOf,
  withProjectMaintenance,
  DEFAULT_KEEP,
  type MaintenanceHold,
  type RetentionRetry,
} from "./export/backup.js";
import { decryptBytes } from "./repo/io.js";
import { NotFoundError } from "./repo/errors.js";
import {
  appendLibraryEvent,
  destroyProjectAssets,
  lookupPolicyInfo,
  projectDataKey,
  repoClock,
  repoLibrary,
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

interface CertificateBackups {
  /**
   * none: no backup held the files; pending: not all removed yet (retried); unknown-pending: some
   * backups could not be read (a damaged manifest) and may hold them; deleted: all removed.
   */
  status: "none" | "pending" | "unknown-pending" | "deleted";
  /** Backups (library-relative) that held destroyed files. */
  containing: string[];
  deleted: string[];
  freshBackup?: string;
  /** Why no fresh backup could be made after the destruction (R138 e: the holding backups are removed regardless). */
  freshBackupFailed?: string;
  /** Plain words for a reader of the certificate when no fresh backup could be made: composed from what actually happened. */
  note?: string;
  /** When each backup in `deleted` was actually removed (a retry shows its later time). */
  removedAt?: Record<string, string>;
  /**
   * Every recorded failure to remove a holding backup, with the plain reason and when (N1). Kept
   * after a later removal: the certificate is amended, never rewritten.
   */
  notRemoved?: Array<{ file: string; reason: string; at?: string }>;
  /** Later removals of backups an earlier attempt could not remove, appended with their time. */
  amendments?: Array<{ at: string; removed: string[] }>;
  /** Holding backups still in place after the last recorded attempt (retried). */
  outstanding?: string[];
  /** Why the last attempt stopped (plain; retried). */
  lastError?: string;
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
 * original of this project. Returns the certificate's absolute path and content.
 */
export function destroyRaw(
  repo: Repo,
  projectId: string,
  assetIds: string[],
  by: string,
  opts: DestroyOptions = {},
): Promise<{ certificatePath: string; certificate: Record<string, unknown> }> {
  // Never at the same time as a backup, prune or restore of the project (R138 a): a backup in
  // progress is finished first, and then found among the backups that hold the data.
  return withProjectMaintenance(repo, projectId, (hold) => destroyRawLocked(repo, hold, projectId, assetIds, by, opts));
}

/** Package-internal (tests of the commit-point check): destroyRaw under a hold the caller already has on the project. */
export function destroyRawHeld(
  repo: Repo,
  hold: MaintenanceHold,
  projectId: string,
  assetIds: string[],
  by: string,
  opts: DestroyOptions = {},
): Promise<{ certificatePath: string; certificate: Record<string, unknown> }> {
  return withProjectMaintenance(repo, projectId, (h) => destroyRawLocked(repo, h, projectId, assetIds, by, opts), hold);
}

async function destroyRawLocked(
  repo: Repo,
  hold: MaintenanceHold,
  projectId: string,
  assetIds: string[],
  by: string,
  opts: DestroyOptions,
): Promise<{ certificatePath: string; certificate: Record<string, unknown> }> {
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
  const held = await holdingBackups(repo, projectId, allIds);
  const containing = [...held.files, ...held.unresolved].map((f) => `Backups/${f}`);
  const initialStatus: CertificateBackups["status"] = !containing.length ? "none" : held.unresolved.length ? "unknown-pending" : "pending";
  const res = await destroyProjectAssets(repo, projectId, {
    plan: [...plan.entries()].map(([sourceId, ids]) => ({ sourceId, assetIds: [...ids] })),
    strayCopies: strays,
    certificateStem: (at) => certificateStem(at, tz),
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
    certificateSha256: createHash("sha256").update(certificateText(res.certificate)).digest("hex"),
  });
  let certificate = res.certificate;
  if (containing.length) certificate = await settleBackups(repo, hold, projectId, res.certificateRel);
  return { certificatePath, certificate };
}

/** The certificate as written (destroy.ts). */
const certificateText = (c: Record<string, unknown>) => `${JSON.stringify(c, null, 2)}\n`;

/**
 * The app's backups of the project that may hold any of `ids`: manifest entries listing one of them
 * (or listing no asset ids at all: unknown, so possibly), and backup files the rebuilt manifest
 * could not read whose name is the project's (R92 I2).
 */
async function holdingBackups(repo: Repo, projectId: string, ids: ReadonlySet<string>): Promise<{ files: string[]; unresolved: string[] }> {
  const files = (await listBackups(repo, projectId)).filter((b) => !Array.isArray(b.assets) || b.assets.some((id) => ids.has(id))).map((b) => b.file);
  return { files, unresolved: await unresolvedBackupsOf(repo, projectId) };
}

async function readCertificate(repo: Repo, projectId: string, rel: string): Promise<Record<string, unknown> & { backups: CertificateBackups; assets?: Array<{ assetId?: string }> }> {
  const raw = await fsp.readFile(join(repoLibrary(repo).root, ...rel.split("/")));
  if (!rel.endsWith(".enc")) return JSON.parse(raw.toString("utf8"));
  const k = projectDataKey(repo, projectId);
  if (!k) throw new TypeError("the certificate is sealed and the project is not encrypted");
  return JSON.parse((await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw)).toString("utf8"));
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
/** Any failure, in plain words with paths scrubbed (R138 e: not only a refusal), and that it is retried. */
const plainError = (repo: Repo, err: unknown) => `${backupFailureReason(repo, err).replace(/[.]$/u, "")}; the step will be tried again`;

/**
 * The backups step of a destruction (R92 I3, R138 e): the backups holding destroyed files are
 * worked out again now (from the manifest's asset ids, and only for assets the governed, audited
 * destruction really marked destroyed); a fresh backup is tried first, then each holding backup is
 * overwritten and removed, the manifest updated after each. A backup that could not be removed is
 * named in `notRemoved` with its reason; the step stays `pending` (retried by resumeDestruction).
 * Unreadable project-named backups (a rebuilt manifest) are never deleted blindly: the step stays
 * `unknown-pending`. The certificate is amended, never rewritten (point 3): `notRemoved` entries
 * stay, and later removals are appended to `amendments` with their time. It is updated in a
 * governed, audited change.
 *
 * `retry` (resumeDestruction): a retry whose outcome is the same as the last recorded one (nothing
 * removed, the same backups still in place, no new fresh backup) changes nothing in the certificate
 * and writes no audit event; at most one summarising `retention.backups` event a day records how
 * many attempts were made meanwhile (R2-I1). A refused or failed fresh backup is tried again at
 * most once a day.
 */
async function settleBackups(repo: Repo, hold: MaintenanceHold, projectId: string, certificateRel: string, retry = false): Promise<Record<string, unknown>> {
  const cert = await readCertificate(repo, projectId, certificateRel);
  const b = cert.backups;
  if (b.status !== "pending" && b.status !== "unknown-pending") return cert;
  // Only assets the audited destruction marked destroyed: a certificate edited by hand cannot make
  // this remove backups that hold live data (point 4).
  const claimed = new Set((cert.assets ?? []).map((a) => a.assetId).filter((x): x is string => typeof x === "string"));
  const ids = await reallyDestroyed(repo, projectId, claimed);
  const held = ids.size ? await holdingBackups(repo, projectId, ids) : { files: [], unresolved: [] };
  const now = repoClock(repo)();
  const at = now.toISOString();
  const key = retryKey(projectId, certificateRel);
  const rec = retry ? await retentionRetry(repo, key) : undefined;
  const next: CertificateBackups = {
    ...b,
    containing: union(b.containing, [...held.files, ...held.unresolved].map((f) => `Backups/${f}`)),
    deleted: [...b.deleted],
  };
  const unresolvedLeft = held.unresolved.length > 0;
  // A fresh backup first, when it can be made (R90 d), at most once a day on a retry; the holding
  // backups are removed whether or not it could (R138 e).
  let freshMade = false;
  const freshDue = !rec?.lastFreshAt || now.getTime() - Date.parse(rec.lastFreshAt) >= DAY_MS;
  let freshTried = false;
  if (held.files.length && !next.freshBackup && (!retry || freshDue)) {
    freshTried = true;
    try {
      const fresh = await backupProjectHeld(repo, hold, projectId, { prune: false });
      next.freshBackup = `Backups/${basename(fresh.path)}`;
      delete next.freshBackupFailed;
      freshMade = true;
    } catch (err) {
      // backupProject has recorded `backup-failed` with the same reason.
      next.freshBackupFailed = backupFailureReason(repo, err);
    }
  }
  // Each holding backup: removed (with when), or named as NOT removed with the plain reason (N1).
  let removedNow: string[] = [];
  let failedNow: Array<{ file: string; reason: string }> = [];
  let otherError: string | undefined;
  try {
    const r = await destroyBackups(repo, projectId, held.files);
    removedNow = r.deleted.map((f) => `Backups/${f}`);
    failedNow = r.failed.map(({ file, error }) => ({ file: `Backups/${file}`, reason: `It could not be overwritten and removed (${plainErrorText(repo, error)}).` }));
    if (r.failed.length) otherError = `A backup holding the destroyed files could not be removed (${plainErrorText(repo, r.failed[0]!.error)}); the step will be tried again`;
  } catch (err) {
    otherError = plainError(repo, err);
  }
  const outstanding = failedNow.map((x) => x.file);
  next.status = unresolvedLeft ? "unknown-pending" : otherError ? "pending" : "deleted";

  // A retry that changed nothing: no certificate rewrite, no audit event, except one summary a day.
  if (retry && rec && !removedNow.length && !freshMade && sameFiles(outstanding, rec.outstanding) && next.status === b.status) {
    const attempts = rec.attemptsSinceRecord + 1;
    if (now.getTime() - Date.parse(rec.lastRecordedAt) >= DAY_MS) {
      await appendLibraryEvent(repo, projectId, "retention.backups", { status: b.status, summary: true, attempts, removed: [], notRemoved: outstanding, ...(next.freshBackupFailed ? { freshBackupFailed: next.freshBackupFailed } : {}) });
      await setRetentionRetry(repo, key, { ...rec, lastAttemptAt: at, lastRecordedAt: at, attemptsSinceRecord: 0, ...(freshTried ? { lastFreshAt: at } : {}) });
    } else {
      await setRetentionRetry(repo, key, { ...rec, lastAttemptAt: at, attemptsSinceRecord: attempts, ...(freshTried ? { lastFreshAt: at } : {}) });
    }
    return cert;
  }

  if (otherError) next.lastError = otherError;
  else delete next.lastError;
  next.deleted = union(next.deleted, removedNow);
  next.removedAt = { ...(b.removedAt ?? {}), ...Object.fromEntries(removedNow.map((f) => [f, at])) };
  // Amended, not replaced: earlier "not removed" entries stay; a new failure is added once.
  const earlier = b.notRemoved ?? [];
  const added = failedNow.filter((f) => !earlier.some((e) => e.file === f.file && e.reason === f.reason)).map((f) => ({ ...f, at }));
  if (earlier.length || added.length) next.notRemoved = [...earlier, ...added];
  // Later removals of backups an earlier attempt could not remove.
  const late = removedNow.filter((f) => earlier.some((e) => e.file === f));
  if (late.length) next.amendments = [...(b.amendments ?? []), { at, removed: late }];
  next.outstanding = outstanding;
  if (!outstanding.length) delete next.outstanding;
  // The note says only what happened (N1): composed from the outcome above.
  delete next.note;
  if (next.freshBackupFailed && !next.freshBackup) {
    const reason = next.freshBackupFailed;
    const stop = /[.!?]$/u.test(reason) ? "" : ".";
    const one = outstanding.length === 1;
    next.note = outstanding.length
      ? `No new backup could be made after the destruction: ${reason}${stop} ${one ? "A backup that holds the destroyed files could not be removed yet" : "Some backups that hold the destroyed files could not be removed yet"} (see notRemoved); removing ${one ? "it" : "them"} is tried again.`
      : `The earlier backups that held the destroyed files were removed. No new backup could be made afterwards: ${reason}${stop} This project has no backup until one succeeds.`;
  }
  await setHoldingNotRemoved(repo, projectId, certificateRel, outstanding).catch(() => {});
  if (next.status === "deleted") {
    // Pruning keeps its own record when it cannot be audited (backup-audit-pending): not this step's failure.
    await pruneBackupsHeld(repo, hold, projectId, repo.getProject(projectId).backups?.keep ?? DEFAULT_KEEP).catch(() => {});
  }
  const updated = { ...cert, backups: next };
  await repo.mutate(
    projectId,
    { action: "delete" },
    async (tx) => {
      await tx.writeFile(certificateRel, certificateText(updated), certificateRel.endsWith(".enc") ? { encrypt: true } : { mode: 0o600 });
    },
    { op: "retention.backups", entity: { type: "project", id: projectId } },
  );
  // The same facts as the certificate: what was removed now, and what could not be (with why).
  await appendLibraryEvent(repo, projectId, "retention.backups", {
    status: next.status,
    deleted: next.deleted.length,
    removed: removedNow,
    notRemoved: outstanding,
    ...(failedNow.length ? { reasons: failedNow } : {}),
    ...(retry && rec ? { attempts: rec.attemptsSinceRecord + 1 } : {}),
    ...(next.freshBackupFailed && !next.freshBackup ? { freshBackupFailed: next.freshBackupFailed } : {}),
  });
  // The retry record: started by a failure, reset by each recorded outcome, gone once settled.
  if (next.status === "deleted") await setRetentionRetry(repo, key, undefined);
  else {
    await setRetentionRetry(repo, key, {
      firstFailedAt: rec?.firstFailedAt ?? at,
      ...(retry ? { lastAttemptAt: at } : {}),
      lastRecordedAt: at,
      attemptsSinceRecord: 0,
      outstanding,
      ...(freshTried ? { lastFreshAt: at } : rec?.lastFreshAt ? { lastFreshAt: rec.lastFreshAt } : {}),
    });
  }
  return updated;
}

const sameFiles = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const retryKey = (projectId: string, rel: string) => `${projectId}:${rel}`;

/** Ids among `claimed` whose asset the project really records as destroyed. */
async function reallyDestroyed(repo: Repo, projectId: string, claimed: ReadonlySet<string>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of repo.listSourceIds(projectId)) {
    const sf = await repo.getSource(projectId, id);
    for (const a of sf.assets) if (a.status === "destroyed" && claimed.has(a.id)) out.add(a.id);
  }
  return out;
}

/**
 * Whether a retry of this certificate's backups step is due (R2-I1): hourly during the first day
 * after its first failure, then once a day. The first retry after a destruction is always due.
 */
function retryDue(rec: RetentionRetry | undefined, now: Date): boolean {
  if (!rec?.lastAttemptAt) return true;
  const since = now.getTime() - Date.parse(rec.lastAttemptAt);
  const age = now.getTime() - Date.parse(rec.firstFailedAt);
  return since >= (age < DAY_MS ? HOUR_MS : DAY_MS);
}

/**
 * Finishes (or retries) destructions whose backups step is not done (a crash, a quit or a failure
 * after the destruction): returns the certificates (absolute paths) worked on. It never destroys
 * raw data itself: it only finishes removing backups that hold data an audited destruction already
 * destroyed. Run by the service at open, at unlock and hourly, with a back-off (retryDue).
 */
export function resumeDestruction(repo: Repo, projectId: string): Promise<string[]> {
  return withProjectMaintenance(repo, projectId, (hold) => resumeLocked(repo, hold, projectId));
}

async function resumeLocked(repo: Repo, hold: MaintenanceHold, projectId: string): Promise<string[]> {
  const root = repoLibrary(repo).root;
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  let names: string[];
  try {
    names = (await fsp.readdir(join(root, ...dirRel.split("/")))).filter((n) => /^destruction-.*\.json(\.enc)?$/u.test(n)).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  const now = repoClock(repo)();
  for (const n of names) {
    const rel = `${dirRel}/${n}`;
    let status: string | undefined;
    try {
      status = (await readCertificate(repo, projectId, rel)).backups?.status;
    } catch {
      continue;
    }
    if (status !== "pending" && status !== "unknown-pending") continue;
    if (!retryDue(await retentionRetry(repo, retryKey(projectId, rel)), now)) continue;
    await settleBackups(repo, hold, projectId, rel, true);
    out.push(join(root, ...rel.split("/")));
  }
  return out;
}

/** How the backups step of a destruction stands. */
export type BackupsStepStatus = "none" | "pending" | "unknown-pending" | "deleted" | "no-longer-present";

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
  /** The certificate as it is on disk. */
  original?: Record<string, unknown>;
  /** Later facts, oldest first. */
  amendments: DestructionAmendment[];
  /** The original with its `backups` brought up to date: what a screen shows. */
  certificate?: Record<string, unknown>;
  /** The resulting status of the backups step. */
  status: BackupsStepStatus;
  /** Backups (library-relative) still to be removed. */
  outstanding: string[];
  /** Why the app does not act on this destruction by itself (plain words), if so. */
  problem?: string;
}

/** Every destruction of the project, oldest first. */
export async function listDestructions(repo: Repo, projectId: string): Promise<DestructionRecord[]> {
  const root = repoLibrary(repo).root;
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  let names: string[];
  try {
    names = (await fsp.readdir(join(root, ...dirRel.split("/")))).filter((n) => /^destruction-.*\.json(\.enc)?$/u.test(n)).sort();
  } catch {
    return [];
  }
  const out: DestructionRecord[] = [];
  for (const n of names) {
    const rel = `${dirRel}/${n}`;
    const cert = await readCertificate(repo, projectId, rel);
    out.push({ certificateFile: rel, verified: false, original: cert, amendments: [], certificate: cert, status: cert.backups.status, outstanding: cert.backups.outstanding ?? [] });
  }
  return out;
}

/** One destruction, by its certificate (a file name, a library-relative path or an absolute path). */
export async function readDestruction(repo: Repo, projectId: string, certificate: string): Promise<DestructionRecord> {
  const name = basename(certificate.split("\\").join("/"));
  const found = (await listDestructions(repo, projectId)).find((d) => basename(d.certificateFile) === name);
  if (!found) throw new NotFoundError("Destruction certificate", name);
  return found;
}

/** `destruction-<YYYY-MM-DD HHmm>` for a time in `tz`. */
export function certificateStem(at: Date, tz?: string): string {
  return `destruction-${formatModified(at, tz)}`;
}
