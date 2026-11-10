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
 * Then the app's backups that hold any of the destroyed files: a fresh backup is made first, and
 * only once it succeeded are those backups overwritten and removed; the certificate is updated
 * with them (or says they were kept because the fresh backup failed). A crash in between leaves the
 * certificate's backups "pending": `resumeDestruction` (Task 30, at start) finishes it.
 * Audited: the change's `delete` event (op `retention.destroy`), `retention.destroyed` (counts and
 * the certificate's sha256; no paths) and `retention.backups` when backups are settled.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { formatModified, type Asset } from "@ao/core";
import { backupProject, destroyBackups, listBackups, pruneBackups, DEFAULT_KEEP } from "./export/backup.js";
import { NotFoundError } from "./repo/errors.js";
import {
  appendLibraryEvent,
  destroyProjectAssets,
  lookupPolicyInfo,
  repoLibrary,
  type Repo,
} from "./repo/repo.js";
import { toRel } from "./repo/txn.js";

export const DESTRUCTION_NOTICE =
  "Each file was overwritten with zeros and then deleted. This is a best effort: on solid-state drives (SSD), on copy-on-write file systems (such as APFS, Btrfs or ZFS) and in file system snapshots, and wherever cloud sync or backup software outside this app copied the library, earlier copies of the data may still exist. This certificate covers the copies this app manages.";

export interface DueItem {
  sourceId: string;
  assetIds: string[];
}

/** The calendar date (YYYY-MM-DD) of `now` in `tz`. */
function localDate(now: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { ...(tz ? { timeZone: tz } : {}), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Whether the retention date has come at `now`: a date counts from its start in `tz`, a time from that instant. */
function isDue(date: string, now: Date, tz?: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) return localDate(now, tz) >= date;
  const t = Date.parse(date);
  return !Number.isNaN(t) && now.getTime() >= t;
}

const destroyable = (a: Asset) => a.role === "original" && a.status !== "destroyed" && !a.linked;

/** Raw originals of identifiable sources due for destruction under the project's retention rule. */
export async function retentionDue(repo: Repo, projectId: string, now: Date): Promise<DueItem[]> {
  const { policy, tz } = await lookupPolicyInfo(repo, projectId);
  const date = policy?.retention.rawDataDestroyAfter ?? null;
  if (!date || !isDue(date, now, tz)) return [];
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
}

interface CertificateBackups {
  status: "none" | "pending" | "deleted" | "kept-fresh-backup-failed";
  /** Backups (library-relative) that held destroyed files. */
  containing: string[];
  deleted: string[];
  freshBackup?: string;
  reason?: string;
}

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
export async function destroyRaw(
  repo: Repo,
  projectId: string,
  assetIds: string[],
  by: string,
  opts: DestroyOptions = {},
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
  const holding = (await listBackups(repo, projectId)).filter((b) => b.assets.some((id) => allIds.has(id)));
  const containing = holding.map((b) => `Backups/${b.file}`);
  const res = await destroyProjectAssets(repo, projectId, {
    plan: [...plan.entries()].map(([sourceId, ids]) => ({ sourceId, assetIds: [...ids] })),
    strayCopies: strays,
    certificateStem: (at) => certificateStem(at, tz),
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
      backups: { status: containing.length ? "pending" : "none", containing, deleted: [] } satisfies CertificateBackups,
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
    certificateSha256: createHash("sha256").update(await fsp.readFile(certificatePath)).digest("hex"),
  });
  let certificate = res.certificate;
  if (containing.length) certificate = await settleBackups(repo, projectId, res.certificateRel);
  return { certificatePath, certificate };
}

/**
 * The backups step of a destruction: a fresh backup, then the backups that held destroyed files are
 * overwritten and removed; the certificate is updated (a governed, audited change).
 */
async function settleBackups(repo: Repo, projectId: string, certificateRel: string): Promise<Record<string, unknown>> {
  const root = repoLibrary(repo).root;
  const cert = JSON.parse(await fsp.readFile(join(root, ...certificateRel.split("/")), "utf8")) as Record<string, unknown> & { backups: CertificateBackups };
  const b = cert.backups;
  if (b.status !== "pending") return cert;
  let next: CertificateBackups;
  try {
    const fresh = await backupProject(repo, projectId, { prune: false });
    const files = b.containing.map((r) => r.slice("Backups/".length));
    const deleted = await destroyBackups(repo, projectId, files);
    next = { status: "deleted", containing: b.containing, deleted: deleted.map((f) => `Backups/${f}`), freshBackup: `Backups/${fresh.path.slice(fresh.path.lastIndexOf("/") + 1).slice(fresh.path.lastIndexOf("\\") + 1)}` };
    await pruneBackups(repo, projectId, repo.getProject(projectId).backups?.keep ?? DEFAULT_KEEP);
  } catch (err) {
    next = {
      status: "kept-fresh-backup-failed",
      containing: b.containing,
      deleted: [],
      reason: `A fresh backup could not be made (${err instanceof Error ? err.name : "error"}), so the older backups that hold the destroyed files were kept.`,
    };
  }
  const updated = { ...cert, backups: next };
  await repo.mutate(
    projectId,
    { action: "delete" },
    async (tx) => {
      await tx.writeFile(certificateRel, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    },
    { op: "retention.backups", entity: { type: "project", id: projectId } },
  );
  await appendLibraryEvent(repo, projectId, "retention.backups", { status: next.status, deleted: next.deleted.length });
  return updated;
}

/**
 * Finishes destructions whose backups step did not run (a crash or quit after the destruction):
 * returns the certificates (absolute paths) settled now. For Task 30, at start.
 */
export async function resumeDestruction(repo: Repo, projectId: string): Promise<string[]> {
  const root = repoLibrary(repo).root;
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  let names: string[];
  try {
    names = (await fsp.readdir(join(root, ...dirRel.split("/")))).filter((n) => /^destruction-.*\.json$/u.test(n)).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const rel = `${dirRel}/${n}`;
    const abs = join(root, ...rel.split("/"));
    let pending = false;
    try {
      pending = (JSON.parse(await fsp.readFile(abs, "utf8")) as { backups?: { status?: string } }).backups?.status === "pending";
    } catch {
      continue;
    }
    if (!pending) continue;
    await settleBackups(repo, projectId, rel);
    out.push(abs);
  }
  return out;
}

/** `destruction-<YYYY-MM-DD HHmm>` for a time in `tz`. */
export function certificateStem(at: Date, tz?: string): string {
  return `destruction-${formatModified(at, tz)}`;
}
