/**
 * Moving a library inside the app (spec 4.5): plan → copy → verify → switch,
 * then, only after explicit confirmation, delete the old copy. ADR 0008.
 *
 * Nothing in the source is deleted or changed before every file has been
 * re-read at the destination and its SHA-256 matched against the source. The
 * move holds the source lock throughout, so nothing writes to it meanwhile.
 * Each project's residency rules decide whether it may go to the destination;
 * a project that may not can be excluded and stays behind in the old folder,
 * which then becomes a separate library.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evaluate, newId, parseGovernance, type PolicyDecision } from "@ao/core";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { copyFileAtomic, writeFileAtomic } from "./fs/atomic.js";
import { checkpointTruncate, INDEX_FILE, type IndexHandle } from "./index/db.js";
import { openLibrary, type Library, type LibraryJson } from "./library.js";
import { classifyLocation, type Location, type LocationEnv } from "./location.js";
import { peekLock } from "./lock.js";
import { registerLibrary } from "./registry.js";
import { PathEscapeError } from "./repo/errors.js";
import { assertContained } from "./repo/io.js";
import { appendLibraryEvent, openRepo, recoveryPendingProjects, type Repo } from "./repo/repo.js";
import { parseProjectJson } from "./repo/state.js";

export const MOVE_JOURNAL = ".move-journal.json";
/** Library folders every library has (see createLibrary); recreated at the destination when not copied. */
const LIBRARY_DIRS = ["Projects", "Exports", "Backups", ".cache", ".tmp"];
/** Never copied: the lock, transaction scratch space, SQLite side files (checkpointed or rebuildable), the journal. */
const NEVER_COPIED = new Set([".lock", ".tmp", `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`, `${INDEX_FILE}-journal`, MOVE_JOURNAL]);
/**
 * Library-level data that may hold any project's content (index rows, exports,
 * backups, caches). When projects are excluded it stays behind with them; the
 * index is rebuilt at the destination from the files.
 */
const SHARED_DERIVED = new Set([INDEX_FILE, "Exports", "Backups", ".cache"]);
const JOURNAL_EVERY_FILES = 50;
const JOURNAL_EVERY_MS = 5000;
const TOKEN_TTL_MS = 24 * 3600_000;
const MAX_LISTED = 20;
const TEMP_FILE = /\.tmp-[0-9a-f]+$/;

export type MoveRefusal =
  | "read-only"
  | "pending-writes"
  | "overlap"
  | "destination-not-empty"
  | "policy-denied"
  | "unknown-project"
  | "old-copy-in-use";

/** The move may not start (or the old copy may not be deleted now); nothing was changed. */
export class MoveNotAllowedError extends Error {
  override name = "MoveNotAllowedError";
  constructor(
    readonly code: MoveRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Files that could not be copied faithfully: symbolic links or special files in
 * the library, or destination files that are missing, different, or
 * unexpected. The source and the registry are unchanged; the destination and
 * its journal are left in place for inspection (a rerun resumes).
 */
export class MoveVerificationError extends Error {
  override name = "MoveVerificationError";
  constructor(
    /** Up to 20 library-relative paths. */
    readonly paths: string[],
    /** How many paths failed in all. */
    readonly total: number,
    detail: string,
  ) {
    super(`${detail}: ${paths.join(", ")}${total > paths.length ? ` and ${total - paths.length} more` : ""}`);
  }
}

export class InvalidConfirmTokenError extends Error {
  override name = "InvalidConfirmTokenError";
  constructor(readonly reason: "unknown" | "wrong-root" | "expired") {
    super(
      reason === "expired"
        ? "The confirmation for deleting the old copy has expired (24 hours); the old copy was kept"
        : "This confirmation does not allow deleting that folder (unknown, already used, or for another folder)",
    );
  }
}

export interface MoveProgress {
  phase: "plan" | "copy" | "verify" | "switch";
  filesDone: number;
  fileCount: number;
  bytesDone: number;
  totalBytes: number;
}

export interface ProjectPlan {
  projectId: string;
  name: string;
  /** Library-relative project folder, e.g. `Projects/My Project`. */
  folder: string;
  decision: PolicyDecision;
}

export interface MovePlan {
  destination: Location;
  perProject: ProjectPlan[];
  /** Everything that would be copied with no project excluded. */
  totalBytes: number;
  fileCount: number;
}

export interface PlanOptions {
  /** The open repo of `lib`, so projects that refuse writes (recoveryPending) block the move. */
  repo?: Repo;
  now?: Date;
  /** IANA zone for calendar-date rules (default: the system zone). */
  tz?: string;
  actor?: string;
}

export interface MoveOptions extends Omit<PlanOptions, "now"> {
  deps: Deps;
  env: LocationEnv;
  excludeProjectIds?: string[];
  /** Called as work progresses; throwing (or rejecting) aborts the move like an interruption. */
  onProgress?: (p: MoveProgress) => void | Promise<void>;
  /** The library's open index; it is checkpointed so `library.sqlite` is complete without its WAL. */
  index?: IndexHandle;
}

export interface MoveResult {
  newRoot: string;
  verified: true;
  /** Pass to deleteOldCopy (single use, valid 24 hours, in this process only). */
  confirmToken: string;
  fileCount: number;
  totalBytes: number;
  /** Files copied by this run (a resumed run skips files already copied and verified). */
  filesCopied: number;
  /** Problems after the switch that did not undo it (e.g. an audit event that could not be appended). */
  warnings: string[];
}

interface Walked {
  files: Array<{ rel: string; size: number; mode: number }>;
  dirs: Array<{ rel: string; mode: number }>;
  /** Symbolic links and special files. */
  odd: string[];
}

interface Journal {
  libraryId: string;
  fromHint: string;
  startedAt: string;
  filesDone: string[];
}

const abs = (root: string, rel: string) => join(root, ...rel.split("/"));
const hintFor = (root: string, deps: Pick<Deps, "hostname">) => `${deps.hostname}:${basename(root)}`;
const isWin = process.platform === "win32";
const permBits = (mode: number) => mode & 0o777;

/** Walks `root` without following links; `skip(rel)` prunes files and whole folders. */
async function walk(root: string, skip: (rel: string) => boolean): Promise<Walked> {
  const out: Walked = { files: [], dirs: [], odd: [] };
  const visit = async (dir: string, base: string): Promise<void> => {
    const names = (await fsp.readdir(dir)).sort();
    for (const name of names) {
      const rel = base ? `${base}/${name}` : name;
      if (skip(rel)) continue;
      const p = join(dir, name);
      const st = await fsp.lstat(p);
      if (st.isDirectory()) {
        out.dirs.push({ rel, mode: st.mode });
        await visit(p, rel);
      } else if (st.isFile()) {
        out.files.push({ rel, size: st.size, mode: st.mode });
      } else {
        out.odd.push(rel);
      }
    }
  };
  await visit(root, "");
  return out;
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("error", rej)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")));
  });
}

const foldsCase = process.platform === "win32" || process.platform === "darwin";
const fold = (s: string) => (foldsCase ? s.toLowerCase() : s);
const sameName = (a: string, b: string) => fold(a) === fold(b);
/** `child` is `parent` or inside it (whole segments; case-insensitive on macOS and Windows). */
function inside(child: string, parent: string): boolean {
  const rel = relative(fold(parent), fold(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Real path of `p`, resolving symbolic links in its existing ancestors. */
async function realish(p: string): Promise<string> {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await fsp.realpath(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

async function readJournal(dest: string): Promise<Journal | null> {
  try {
    const j = JSON.parse(await fsp.readFile(join(dest, MOVE_JOURNAL), "utf8")) as Partial<Journal>;
    if (typeof j.libraryId !== "string" || !Array.isArray(j.filesDone)) return null;
    return {
      libraryId: j.libraryId,
      fromHint: String(j.fromHint ?? ""),
      startedAt: String(j.startedAt ?? ""),
      filesDone: j.filesDone.filter((f): f is string => typeof f === "string"),
    };
  } catch {
    return null;
  }
}

/** `.tmp/txn-*.json` write-ahead markers, including ones recovery cannot parse (those block too). */
async function markerFiles(root: string): Promise<number> {
  const names = await fsp.readdir(join(root, ".tmp")).catch(() => [] as string[]);
  return names.filter((n) => /^txn-.*\.json$/i.test(n)).length;
}

/** Shared refusals of planMove and executeMove. Returns the journal of an interrupted move, if any. */
async function preflight(lib: Library, destRoot: string, repo?: Repo): Promise<Journal | null> {
  if (lib.mode !== "read-write") {
    throw new MoveNotAllowedError("read-only", `The library is open read-only${lib.readOnlyReason ? ` (${lib.readOnlyReason})` : ""}; it cannot be moved`);
  }
  const pending = (await markerFiles(lib.root)) > 0 || (repo !== undefined && recoveryPendingProjects(repo).length > 0);
  if (pending) {
    throw new MoveNotAllowedError("pending-writes", "Some changes were interrupted and are not resolved yet; finish or resolve pending writes first (reopen the library)");
  }
  const src = await realish(lib.root);
  const dest = await realish(destRoot);
  if (inside(dest, src) || inside(src, dest)) {
    throw new MoveNotAllowedError("overlap", "The destination must not be the library folder, inside it, or contain it");
  }
  let names: string[];
  try {
    const st = await fsp.stat(destRoot);
    if (!st.isDirectory()) throw new MoveNotAllowedError("destination-not-empty", "The destination exists and is not a folder");
    names = await fsp.readdir(destRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (names.length === 0) return null;
  if (names.some((n) => sameName(n, MOVE_JOURNAL))) {
    const j = await readJournal(destRoot);
    if (j?.libraryId === lib.id) return j;
  }
  throw new MoveNotAllowedError("destination-not-empty", "The destination folder is not empty; choose an empty folder");
}

async function readProjects(root: string): Promise<Array<{ id: string; name: string; folder: string }>> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(join(root, "Projects"))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const out = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    let raw: string;
    try {
      raw = await fsp.readFile(join(root, "Projects", n, "project.json"), "utf8");
    } catch {
      continue; // not a project folder: copied as ordinary content
    }
    const p = parseProjectJson(JSON.parse(raw)).project;
    out.push({ id: p.id, name: p.name, folder: `Projects/${n}` });
  }
  return out;
}

const denyAll = (reason: string): PolicyDecision => ({ result: "deny", reason, warnings: [] });

function skipper(excludedFolders: string[]): (rel: string) => boolean {
  const split = excludedFolders.length > 0;
  return (rel) => {
    if (!rel.includes("/") && NEVER_COPIED.has(rel)) return true;
    if (split && !rel.includes("/") && SHARED_DERIVED.has(rel)) return true;
    return excludedFolders.some((f) => rel === f || rel.startsWith(`${f}/`));
  };
}

function abortOnOdd(w: Walked): void {
  if (w.odd.length > 0) {
    throw new MoveVerificationError(w.odd.slice(0, MAX_LISTED), w.odd.length, "The library contains symbolic links or special files, which are not moved");
  }
}

/**
 * Checks whether the library can move to `destRoot` and evaluates each
 * project's residency rules for it. Throws MoveNotAllowedError for a read-only
 * library, unresolved interrupted writes, an overlapping or non-empty
 * destination, and MoveVerificationError for symbolic links in the library.
 */
export async function planMove(lib: Library, destRoot: string, env: LocationEnv, opts: PlanOptions = {}): Promise<MovePlan> {
  await preflight(lib, destRoot, opts.repo);
  const destination = classifyLocation(resolve(destRoot), env);
  const now = (opts.now ?? new Date()).toISOString();
  const tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const perProject: ProjectPlan[] = [];
  for (const p of await readProjects(lib.root)) {
    let decision: PolicyDecision;
    try {
      const cfg = parseGovernance(await fsp.readFile(join(lib.root, ...p.folder.split("/"), "governance.yaml"), "utf8"));
      decision = evaluate(cfg, {
        action: "move",
        projectId: p.id,
        actor: opts.actor ?? "local-user",
        now,
        tz,
        move: { destination: destination.kind, ...(destination.cloudFolderId ? { cloudFolderId: destination.cloudFolderId } : {}) },
      });
    } catch (e) {
      decision = denyAll(`Policy could not be evaluated: ${e instanceof Error ? e.message : String(e)}`);
    }
    perProject.push({ projectId: p.id, name: p.name, folder: p.folder, decision });
  }
  const w = await walk(lib.root, skipper([]));
  abortOnOdd(w);
  return { destination, perProject, fileCount: w.files.length, totalBytes: w.files.reduce((s, f) => s + f.size, 0) };
}

interface TokenRecord {
  oldRoot: string;
  newRoot: string;
  libraryId: string;
  expiresAt: number;
  split: boolean;
  movedFolders: string[];
  movedProjectIds: string[];
  files: Map<string, string>;
  dirs: string[];
  deps: Deps;
  tz?: string;
  actor?: string;
}
const tokens = new Map<string, TokenRecord>();

/**
 * Copies the library to `destRoot`, verifies every file, and switches to it.
 * Resumable: `<dest>/.move-journal.json` records the files copied so far, and
 * a rerun skips those whose destination copy still matches the source.
 */
export async function executeMove(lib: Library, destRoot: string, opts: MoveOptions): Promise<MoveResult> {
  const { deps, env } = opts;
  const dest = resolve(destRoot);
  const exclude = [...new Set(opts.excludeProjectIds ?? [])].sort();
  const progress = async (p: MoveProgress) => {
    await opts.onProgress?.(p);
  };

  // Plan.
  const plan = await planMove(lib, dest, env, { repo: opts.repo, now: deps.clock(), tz: opts.tz, actor: opts.actor });
  await progress({ phase: "plan", filesDone: 0, fileCount: plan.fileCount, bytesDone: 0, totalBytes: plan.totalBytes });
  const known = new Set(plan.perProject.map((p) => p.projectId));
  const unknown = exclude.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new MoveNotAllowedError("unknown-project", `No such project in this library: ${unknown.join(", ")}`);
  const moved = plan.perProject.filter((p) => !exclude.includes(p.projectId));
  const denied = moved.filter((p) => p.decision.result === "deny");
  if (denied.length > 0) {
    const why = denied.map((p) => `${p.name}: ${p.decision.result === "deny" ? p.decision.reason : ""}`).join("; ");
    throw new MoveNotAllowedError("policy-denied", `Some projects may not be moved there (exclude them or choose another destination): ${why}`);
  }
  const excludedFolders = plan.perProject.filter((p) => exclude.includes(p.projectId)).map((p) => p.folder);
  const journal = await preflight(lib, dest, opts.repo);

  if (opts.index?.isOpen) checkpointTruncate(opts.index.db);
  const skip = skipper(excludedFolders);
  const src = await walk(lib.root, skip);
  abortOnOdd(src);
  const fileCount = src.files.length;
  const totalBytes = src.files.reduce((s, f) => s + f.size, 0);

  // Copy.
  await fsp.mkdir(dest, { recursive: true });
  const fromHint = hintFor(lib.root, deps);
  const j: Journal = journal ?? { libraryId: lib.id, fromHint, startedAt: deps.clock().toISOString(), filesDone: [] };
  const expected = new Set(src.files.map((f) => f.rel));
  // Journaled files are never trusted: each is re-hashed against the source before it is skipped.
  const journaled = new Set(j.filesDone.filter((f) => expected.has(f)));
  const done = new Set(journaled);
  const writeJournal = () => writeFileAtomic(join(dest, MOVE_JOURNAL), JSON.stringify({ ...j, filesDone: [...done] }));
  await writeJournal();
  // Temp files of an interrupted copy (ours: they shadow a file this move copies).
  const leftovers = await walk(dest, (rel) => rel === ".tmp");
  for (const f of leftovers.files) {
    if (TEMP_FILE.test(f.rel) && (expected.has(f.rel.replace(TEMP_FILE, "")) || f.rel.replace(TEMP_FILE, "") === MOVE_JOURNAL)) {
      await fsp.unlink(abs(dest, f.rel));
    }
  }
  for (const d of src.dirs) await fsp.mkdir(abs(dest, d.rel), { recursive: true });
  for (const d of LIBRARY_DIRS) await fsp.mkdir(join(dest, d), { recursive: true });

  let filesDone = 0;
  let bytesDone = 0;
  let filesCopied = 0;
  let sinceFlush = 0;
  let lastFlush = Date.now();
  await progress({ phase: "copy", filesDone, fileCount, bytesDone, totalBytes });
  try {
    for (const f of src.files) {
      const from = abs(lib.root, f.rel);
      const to = abs(dest, f.rel);
      let skipIt = false;
      if (journaled.has(f.rel)) {
        const st = await fsp.lstat(to).catch(() => null);
        skipIt =
          st !== null &&
          st.isFile() &&
          (isWin || permBits(st.mode) === permBits(f.mode)) &&
          (await sha256File(to)) === (await sha256File(from));
      }
      if (!skipIt) {
        await copyFileAtomic(from, to, { mode: permBits(f.mode) });
        filesCopied++;
      }
      done.add(f.rel);
      filesDone++;
      bytesDone += f.size;
      sinceFlush++;
      if (sinceFlush >= JOURNAL_EVERY_FILES || Date.now() - lastFlush >= JOURNAL_EVERY_MS) {
        await writeJournal();
        sinceFlush = 0;
        lastFlush = Date.now();
      }
      await progress({ phase: "copy", filesDone, fileCount, bytesDone, totalBytes });
    }
  } finally {
    await writeJournal().catch(() => {});
  }
  // Folder permissions last, so a read-only folder does not block copying into it.
  if (!isWin) {
    for (const d of [...src.dirs].reverse()) await fsp.chmod(abs(dest, d.rel), permBits(d.mode)).catch(() => {});
  }

  // Verify: re-read both sides; never trust what the copy reported.
  await progress({ phase: "verify", filesDone: 0, fileCount, bytesDone: 0, totalBytes });
  const bad: string[] = [];
  const again = await walk(lib.root, skip);
  const nowSet = new Set(again.files.map((f) => f.rel));
  for (const rel of [...again.files.map((f) => f.rel), ...again.odd]) if (!expected.has(rel)) bad.push(rel); // appeared in the source
  const hashes = new Map<string, string>();
  filesDone = 0;
  bytesDone = 0;
  for (const f of src.files) {
    const to = abs(dest, f.rel);
    const st = await fsp.lstat(to).catch(() => null);
    if (!nowSet.has(f.rel) || !st?.isFile() || (!isWin && permBits(st.mode) !== permBits(f.mode))) {
      bad.push(f.rel);
    } else {
      const [a, b] = await Promise.all([sha256File(abs(lib.root, f.rel)), sha256File(to)]);
      if (a !== b) bad.push(f.rel);
      else hashes.set(f.rel, a);
    }
    filesDone++;
    bytesDone += f.size;
    await progress({ phase: "verify", filesDone, fileCount, bytesDone, totalBytes });
  }
  const dirSet = new Set([...src.dirs.map((d) => d.rel), ...LIBRARY_DIRS]);
  const atDest = await walk(dest, (rel) => rel === MOVE_JOURNAL || rel === ".tmp");
  for (const f of atDest.files) if (!expected.has(f.rel)) bad.push(f.rel);
  for (const d of atDest.dirs) if (!dirSet.has(d.rel)) bad.push(d.rel);
  bad.push(...atDest.odd);
  if (bad.length > 0) {
    const uniq = [...new Set(bad)];
    throw new MoveVerificationError(uniq.slice(0, MAX_LISTED), uniq.length, "Verification failed; nothing was switched or deleted");
  }

  // Switch.
  await progress({ phase: "switch", filesDone: fileCount, fileCount, bytesDone: totalBytes, totalBytes });
  await registerLibrary({ libraryId: lib.id, name: lib.name, path: dest }, deps);
  const split = excludedFolders.length > 0;
  if (split) {
    // Still holding the source lock: the old folder becomes a separate library with its own id.
    const metaPath = join(lib.root, "library.json");
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8")) as LibraryJson;
    const rest: LibraryJson = { ...meta, libraryId: newId(), name: `${lib.name} (remaining projects)` };
    await writeFileAtomic(metaPath, JSON.stringify(rest, null, 2));
    await registerLibrary({ libraryId: rest.libraryId, name: rest.name, path: lib.root }, deps);
  }
  await lib.close();

  const warnings: string[] = [];
  const details = {
    fromHint,
    toHint: hintFor(dest, deps),
    destinationKind: plan.destination.kind,
    ...(plan.destination.cloudFolderId ? { cloudFolderId: plan.destination.cloudFolderId } : {}),
    projectsMoved: moved.map((p) => p.projectId).sort(),
    projectsExcluded: exclude,
    fileCount,
    totalBytes,
    verified: true,
  };
  await auditAtDestination(dest, deps, opts, moved.map((p) => p.projectId), "library.move", details, warnings);
  await fsp.unlink(join(dest, MOVE_JOURNAL)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") warnings.push(`The move journal could not be removed (${err.message})`);
  });

  const confirmToken = randomBytes(32).toString("hex");
  tokens.set(confirmToken, {
    oldRoot: resolve(lib.root),
    newRoot: dest,
    libraryId: lib.id,
    expiresAt: deps.clock().getTime() + TOKEN_TTL_MS,
    split,
    movedFolders: moved.map((p) => p.folder),
    movedProjectIds: moved.map((p) => p.projectId),
    files: hashes,
    dirs: src.dirs.map((d) => d.rel),
    deps,
    tz: opts.tz,
    actor: opts.actor,
  });
  return { newRoot: dest, verified: true, confirmToken, fileCount, totalBytes, filesCopied, warnings };
}

/**
 * Appends `action` to each project through a repo opened on the destination.
 * An audit failure is reported in `warnings` and does not undo the switch:
 * the data is already verified at the destination.
 */
async function auditAtDestination(
  dest: string,
  deps: Deps,
  opts: { repo?: Repo; tz?: string; actor?: string },
  projectIds: string[],
  action: string,
  details: Record<string, unknown>,
  warnings: string[],
): Promise<void> {
  let destLib: Library | undefined;
  try {
    let repo = opts.repo;
    if (!repo) {
      destLib = await openLibrary(dest, deps);
      if (destLib.mode !== "read-write") {
        warnings.push(`The ${action} audit events could not be recorded: the destination library opened read-only (${destLib.readOnlyReason ?? "unknown"})`);
        return;
      }
      repo = await openRepo(destLib, new KeyRing(), { clock: deps.clock, ...(opts.tz ? { tz: opts.tz } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });
    }
    for (const id of projectIds) {
      try {
        await appendLibraryEvent(repo, id, action, details);
      } catch (err) {
        warnings.push(`The ${action} audit event could not be recorded for project ${id} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  } catch (err) {
    warnings.push(`The ${action} audit events could not be recorded (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    await destLib?.close();
  }
}

export interface DeleteOldCopyResult {
  filesDeleted: number;
  /** Library-relative files of the old copy that were kept: changed since the move, or not safely inside it. */
  kept: string[];
  /** The old folder itself was removed (it was empty at the end). */
  rootRemoved: boolean;
  warnings: string[];
}

/**
 * Deletes the old copy after a successful move, with the token executeMove
 * returned (single use, 24 hours, bound to this folder and library). Only
 * files that were verified at the destination and are still identical are
 * deleted, never through a symbolic link or outside `oldRoot`. When the old
 * folder kept excluded projects (it is now a separate library), only the moved
 * projects' folders are deleted there. Recorded as `library.old-copy-deleted`
 * in the destination's projects; pass `repo` if the destination is open.
 */
export async function deleteOldCopy(oldRoot: string, confirmToken: string, opts: { repo?: Repo } = {}): Promise<DeleteOldCopyResult> {
  const rec = tokens.get(confirmToken);
  if (!rec) throw new InvalidConfirmTokenError("unknown");
  const root = resolve(oldRoot);
  if (root !== rec.oldRoot) throw new InvalidConfirmTokenError("wrong-root");
  if (rec.deps.clock().getTime() > rec.expiresAt) {
    tokens.delete(confirmToken);
    throw new InvalidConfirmTokenError("expired");
  }
  if (await peekLock(root, rec.deps)) {
    throw new MoveNotAllowedError("old-copy-in-use", "The old copy is open on a device; close it there first");
  }
  // Without exclusions the old folder must still be the moved library, not something put there since.
  if (!rec.split) {
    const meta = await fsp.readFile(join(root, "library.json"), "utf8").then((t) => JSON.parse(t) as Partial<LibraryJson>, () => null);
    if (meta !== null && meta.libraryId !== rec.libraryId) throw new InvalidConfirmTokenError("wrong-root");
  }
  tokens.delete(confirmToken);

  const inScope = (rel: string) => !rec.split || rec.movedFolders.some((f) => rel === f || rel.startsWith(`${f}/`));
  const kept: string[] = [];
  let filesDeleted = 0;
  for (const [rel, hash] of rec.files) {
    if (!inScope(rel)) continue;
    const p = abs(root, rel);
    const st = await fsp.lstat(p).catch(() => null);
    if (st === null) continue;
    try {
      await assertContained(root, p);
    } catch (err) {
      if (!(err instanceof PathEscapeError)) throw err;
      kept.push(rel);
      continue;
    }
    if (!st.isFile() || (await sha256File(p)) !== hash) {
      kept.push(rel);
      continue;
    }
    await fsp.unlink(p);
    filesDeleted++;
  }
  if (!rec.split) {
    // SQLite side files of the (checkpointed or rebuildable) index; never copied.
    for (const n of [`${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`]) {
      const p = join(root, n);
      const st = await fsp.lstat(p).catch(() => null);
      if (st?.isFile()) await fsp.unlink(p);
    }
  }
  // Remove folders that are now empty, deepest first; rmdir never removes content or follows a link.
  const dirs = [...rec.dirs.filter(inScope), ...(rec.split ? [] : [".tmp"])].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const d of dirs) await fsp.rmdir(abs(root, d)).catch(() => {});
  let rootRemoved = false;
  if (!rec.split) rootRemoved = await fsp.rmdir(root).then(() => true, () => false);

  const warnings: string[] = [];
  await auditAtDestination(
    rec.newRoot,
    rec.deps,
    { repo: opts.repo, tz: rec.tz, actor: rec.actor },
    rec.movedProjectIds,
    "library.old-copy-deleted",
    {
      oldHint: hintFor(root, rec.deps),
      scope: rec.split ? "moved-projects-only" : "whole-library",
      filesDeleted,
      filesKept: kept.length,
      rootRemoved,
    },
    warnings,
  );
  return { filesDeleted, kept: kept.sort(), rootRemoved, warnings };
}
