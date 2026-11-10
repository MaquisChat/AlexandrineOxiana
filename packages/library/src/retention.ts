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
import { basename, join } from "node:path";
import { formatModified, type Asset } from "@ao/core";
import { backupProject, destroyBackups, listBackups, pruneBackups, unresolvedBackupsOf, DEFAULT_KEEP } from "./export/backup.js";
import { decryptBytes } from "./repo/io.js";
import { NotFoundError } from "./repo/errors.js";
import {
  appendLibraryEvent,
  destroyProjectAssets,
  lookupPolicyInfo,
  projectDataKey,
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
  /** Why the last attempt stopped (plain; retried). */
  lastError?: string;
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
  const held = await holdingBackups(repo, projectId, allIds);
  const containing = [...held.files, ...held.unresolved].map((f) => `Backups/${f}`);
  const initialStatus: CertificateBackups["status"] = !containing.length ? "none" : held.unresolved.length ? "unknown-pending" : "pending";
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
  if (containing.length) certificate = await settleBackups(repo, projectId, res.certificateRel);
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
const plainError = (err: unknown) => `${err instanceof Error ? err.name : "Error"}: the step will be tried again`;

/**
 * The backups step of a destruction (R92 I3): the backups holding destroyed files are worked out
 * again now (from the manifest's asset ids); a fresh backup is made first (once), then each of
 * them is overwritten and removed, the manifest updated after each. Whatever fails leaves the
 * step `pending` with `lastError` (retried by resumeDestruction), and `deleted` lists exactly what
 * was removed. Unreadable project-named backups (a rebuilt manifest) are never deleted blindly:
 * the step stays `unknown-pending`. The certificate is updated in a governed, audited change.
 */
async function settleBackups(repo: Repo, projectId: string, certificateRel: string): Promise<Record<string, unknown>> {
  const cert = await readCertificate(repo, projectId, certificateRel);
  const b = cert.backups;
  if (b.status !== "pending" && b.status !== "unknown-pending") return cert;
  const ids = new Set((cert.assets ?? []).map((a) => a.assetId).filter((x): x is string => typeof x === "string"));
  const held = await holdingBackups(repo, projectId, ids);
  const next: CertificateBackups = {
    ...b,
    containing: union(b.containing, [...held.files, ...held.unresolved].map((f) => `Backups/${f}`)),
    deleted: [...b.deleted],
  };
  const unresolvedLeft = held.unresolved.length > 0;
  try {
    if (held.files.length && !next.freshBackup) {
      const fresh = await backupProject(repo, projectId, { prune: false });
      next.freshBackup = `Backups/${basename(fresh.path)}`;
    }
    const r = await destroyBackups(repo, projectId, held.files);
    next.deleted = union(next.deleted, r.deleted.map((f) => `Backups/${f}`));
    if (r.error) throw r.error;
    delete next.lastError;
    next.status = unresolvedLeft ? "unknown-pending" : "deleted";
    await pruneBackups(repo, projectId, repo.getProject(projectId).backups?.keep ?? DEFAULT_KEEP);
  } catch (err) {
    next.status = unresolvedLeft ? "unknown-pending" : "pending";
    next.lastError = plainError(err);
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
  await appendLibraryEvent(repo, projectId, "retention.backups", { status: next.status, deleted: next.deleted.length });
  return updated;
}

/**
 * Finishes (or retries) destructions whose backups step is not done (a crash, a quit or a failure
 * after the destruction): returns the certificates (absolute paths) worked on. For Task 30, at start.
 */
export async function resumeDestruction(repo: Repo, projectId: string): Promise<string[]> {
  const root = repoLibrary(repo).root;
  const dirRel = `${repo.getProject(projectId).folder}/retention`;
  let names: string[];
  try {
    names = (await fsp.readdir(join(root, ...dirRel.split("/")))).filter((n) => /^destruction-.*\.json(\.enc)?$/u.test(n)).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    const rel = `${dirRel}/${n}`;
    let status: string | undefined;
    try {
      status = (await readCertificate(repo, projectId, rel)).backups?.status;
    } catch {
      continue;
    }
    if (status !== "pending" && status !== "unknown-pending") continue;
    await settleBackups(repo, projectId, rel);
    out.push(join(root, ...rel.split("/")));
  }
  return out;
}

/** `destruction-<YYYY-MM-DD HHmm>` for a time in `tz`. */
export function certificateStem(at: Date, tz?: string): string {
  return `destruction-${formatModified(at, tz)}`;
}
