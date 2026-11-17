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
 *
 * The switch is a list of idempotent steps recorded in the destination's
 * journal (phase `switching`) before the first of them runs, so a crash in the
 * middle is finished by `completeMove` (or by rerunning `executeMove`). While
 * the journal exists the destination opens read-only (`move-incomplete`); the
 * old copy is marked with MOVED.json and opens read-only (`moved`).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dateRuleZone, evaluate, newId, parseGovernance, type PolicyDecision, type ResidencyKind } from "@ao/core";
import { scrubPaths } from "./app-settings.js";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { copyFileAtomic, writeFileAtomic } from "./fs/atomic.js";
import { checkpointTruncate, INDEX_FILE, type IndexHandle } from "./index/db.js";
import { FINDER_FILES, MOVED_MARKER, MOVE_JOURNAL, entriesBesidesFinderFiles, isClosed, openLibraryInternal, projectMovedAway, type Library, type LibraryJson } from "./library.js";
import { classifyLocation, type Location, type LocationEnv } from "./location.js";
import { acquireLock, peekLock, readLock, releaseLock } from "./lock.js";
import {
  OldCopiesUnreadableError,
  addPendingOldCopy,
  getPendingOldCopy,
  isExpired,
  listPendingOldCopies,
  listUnfinishedMoves,
  markPendingComplete,
  readVerifiedHashes,
  removePendingOldCopy,
  type PendingOldCopy,
} from "./old-copies.js";
import { addKnownPath, registerLibrary } from "./registry.js";
import { PathEscapeError } from "./repo/errors.js";
import { assertContained } from "./repo/io.js";
import { holdsLock, newAttentionId, projectFolderOf, reasonOf, writeAttention, writeOutbox, type UnrecordedAudit } from "./repo/attention.js";
import { openRepo, recordOrMark, recoveryPendingProjects, repoLibrary, type Repo } from "./repo/repo.js";
import { parseProjectJson } from "./repo/state.js";

export { MOVE_JOURNAL, MOVED_MARKER };
export { listPendingOldCopies, listUnfinishedMoves };
export type { PendingOldCopy } from "./old-copies.js";

/** Library folders every library has (see createLibrary); recreated at the destination when not copied. */
const LIBRARY_DIRS = ["Projects", "Exports", "Backups", ".cache", ".tmp"];
/** Never copied: the lock, transaction scratch space, SQLite side files (checkpointed or rebuildable), move markers. */
const NEVER_COPIED = new Set([".lock", ".tmp", `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`, `${INDEX_FILE}-journal`, MOVE_JOURNAL, MOVED_MARKER]);
/**
 * Library-level data that may hold any project's content (index rows, exports,
 * backups, caches). When projects are excluded it stays behind with them; the
 * index is rebuilt at the destination from the files.
 */
const SHARED_DERIVED = new Set([INDEX_FILE, "Exports", "Backups", ".cache"]);
const JOURNAL_EVERY_FILES = 50;
const JOURNAL_EVERY_MS = 5000;
const MAX_LISTED = 20;
const TEMP_FILE = /\.tmp-[0-9a-f]+$/;
const PLAUSIBLE: ResidencyKind[] = ["device", "removable", "network"];

export type MoveRefusal =
  | "read-only"
  | "pending-writes"
  | "overlap"
  | "destination-not-empty"
  | "policy-denied"
  | "unknown-project"
  | "unreadable-project"
  | "name-collision"
  | "old-copy-in-use"
  | "nothing-to-complete";

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
        ? "The offer to delete the old copy has expired (24 hours after the move); the old copy was kept and stays read-only. Delete it by hand if you no longer need it"
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
  /** The destination's residency kind (the stricter of the typed path and its real path). */
  destination: Location;
  /** Every classification considered: the typed path, and its real path when different. */
  destinations: Location[];
  perProject: ProjectPlan[];
  /** `Projects/<n>` folders validly marked as moved to another library: not projects of this library, not copied. */
  projectsMovedAway: string[];
  /** Everything that would be copied with no project excluded. */
  totalBytes: number;
  fileCount: number;
}

export interface PlanOptions {
  /** The open repo of the source library, so projects that refuse writes (recoveryPending) block the move. Never written to. */
  sourceRepo?: Repo;
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
  /** An already-open repo on the destination library (rare); otherwise the move opens the destination itself. */
  destRepo?: Repo;
}

export interface MoveResult {
  newRoot: string;
  verified: true;
  /** Pass to deleteOldCopy (single use, valid 24 hours, this process only; after a restart use `{ confirm: true }`). */
  confirmToken: string;
  fileCount: number;
  totalBytes: number;
  /** Files copied by this run (a resumed run skips files already copied and verified). */
  filesCopied: number;
  /** `Projects/<n>` folders validly marked as moved to another library; they were not moved. */
  projectsMovedAway: string[];
  /** Problems after the switch that did not undo it (e.g. an audit event that could not be appended). */
  warnings: string[];
}

interface Walked {
  files: Array<{ rel: string; size: number; mode: number }>;
  dirs: Array<{ rel: string; mode: number }>;
  /** Symbolic links and special files. */
  odd: string[];
}

export type SwitchStep = "register" | "mark-old" | "close-source" | "audit-split" | "audit-move" | "finalize";

/** The switch, planned in full before its first step. No absolute paths: the old root is in the pending record (app config). */
interface SwitchPlan {
  moveId: string;
  pendingId: string;
  libraryName: string;
  steps: SwitchStep[];
  done: SwitchStep[];
  remainingLibraryId?: string;
  movedFolders: string[];
  movedProjectIds: string[];
  excludedProjectIds: string[];
  projectsMovedAway: string[];
  fileCount: number;
  totalBytes: number;
  details: Record<string, unknown>;
}

interface Journal {
  libraryId: string;
  fromHint: string;
  startedAt: string;
  filesDone: string[];
  phase?: "copying" | "switching";
  switch?: SwitchPlan;
}

/** Test seams: simulate a crash right after a switch step. */
export const moveSeams: { crashAfter?: SwitchStep; /** deleteOldCopy: reading this old-copy folder fails. */ unreadableDir?: string } = {};
export class SimulatedMoveCrash extends Error {
  override name = "SimulatedMoveCrash";
}

const abs = (root: string, rel: string) => join(root, ...rel.split("/"));
const hintFor = (root: string, deps: Pick<Deps, "hostname">) => `${deps.hostname}:${basename(root)}`;
const isWin = process.platform === "win32";
const permBits = (mode: number) => mode & 0o777;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      ...(j.phase === "switching" && j.switch ? { phase: "switching" as const, switch: j.switch } : { phase: "copying" as const }),
    };
  } catch {
    return null;
  }
}
const writeJournal = (dest: string, j: Journal) => writeFileAtomic(join(dest, MOVE_JOURNAL), JSON.stringify(j));

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
    names = await entriesBesidesFinderFiles(destRoot); // the Finder's own files count as empty (FR-047)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (names.length === 0) return null;
  if (names.some((n) => sameName(n, MOVE_JOURNAL))) {
    const j = await readJournal(destRoot);
    if (j?.libraryId === lib.id && j.phase !== "switching") return j;
  }
  throw new MoveNotAllowedError("destination-not-empty", "The destination folder is not empty; choose an empty folder");
}

const isFile = (p: string) => fsp.lstat(p).then((s) => s.isFile(), () => false);
const isThere = (p: string) => fsp.lstat(p).then(() => true, () => false);

/**
 * The projects in `Projects/`, and folders there that belong to no project of
 * this library (old copies marked MOVED.json, not copied). A folder that
 * looks like a project (governance.yaml or Sources) but whose project.json is
 * missing or unreadable refuses the move: its governance cannot be checked.
 */
async function readProjects(root: string): Promise<{ projects: Array<{ id: string; name: string; folder: string; timeZone?: string }>; movedAway: string[] }> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(join(root, "Projects"))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const projects = [];
  const movedAway: string[] = [];
  const unreadable: string[] = [];
  for (const n of names) {
    const folder = `Projects/${n}`;
    const dir = join(root, "Projects", n);
    if (!(await fsp.lstat(dir).then((s) => s.isDirectory(), () => false))) continue;
    if (await projectMovedAway(root, n)) {
      movedAway.push(folder);
      continue;
    }
    let p: { id: string; name: string; timeZone?: string } | null = null;
    if (!n.startsWith(".")) {
      try {
        p = parseProjectJson(JSON.parse(await fsp.readFile(join(dir, "project.json"), "utf8"))).project;
      } catch {
        p = null;
      }
    }
    if (p) projects.push({ id: p.id, name: p.name, folder, ...(p.timeZone ? { timeZone: p.timeZone } : {}) });
    else if ((await isThere(join(dir, "governance.yaml"))) || (await isThere(join(dir, "Sources"))) || (await isThere(join(dir, "project.json")))) {
      unreadable.push(folder);
    }
  }
  if (unreadable.length > 0) {
    throw new MoveNotAllowedError(
      "unreadable-project",
      `These project folders have no readable project.json, so their governance cannot be checked; repair or remove them first: ${unreadable.slice(0, MAX_LISTED).join(", ")}`,
    );
  }
  return { projects, movedAway };
}

const denyOf = (reason: string, warnings: string[] = []): PolicyDecision => ({ result: "deny", reason, warnings });

function skipper(excludedFolders: string[], split: boolean): (rel: string) => boolean {
  return (rel) => {
    if (!rel.includes("/") && NEVER_COPIED.has(rel)) return true;
    if (split && !rel.includes("/") && SHARED_DERIVED.has(rel)) return true;
    // A project-level marker that did not validate stays behind: copied, it might validate at the destination.
    if (/^Projects\/[^/]+\/MOVED\.json$/.test(rel)) return true;
    return excludedFolders.some((f) => rel === f || rel.startsWith(`${f}/`));
  };
}

function abortOnOdd(w: Walked): void {
  if (w.odd.length > 0) {
    throw new MoveVerificationError(w.odd.slice(0, MAX_LISTED), w.odd.length, "The library contains symbolic links or special files, which are not moved");
  }
}

/** Paths that would land on the same name where names are compared case-insensitively or after Unicode normalization. */
function assertNoCollisions(w: Walked): void {
  const seen = new Map<string, string>();
  const pairs: string[] = [];
  for (const rel of [...w.dirs.map((d) => d.rel), ...w.files.map((f) => f.rel)]) {
    const key = rel.normalize("NFC").toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) pairs.push(`${other} ↔ ${rel}`);
    else seen.set(key, rel);
  }
  if (pairs.length > 0) {
    throw new MoveNotAllowedError(
      "name-collision",
      `These names differ only in letter case or Unicode form and would collide on many disks; rename one of each pair first: ${pairs.slice(0, MAX_LISTED).join("; ")}${pairs.length > MAX_LISTED ? ` and ${pairs.length - MAX_LISTED} more` : ""}`,
    );
  }
}

/** Package-internal (also backups, R125). Classifications of the typed path and its real path; the first cloud folder, else the real path's. */
export async function locate(destRoot: string, env: LocationEnv): Promise<{ destination: Location; destinations: Location[] }> {
  const typed = classifyLocation(resolve(destRoot), env);
  const realPath = await realish(destRoot);
  const destinations = realPath === resolve(destRoot) ? [typed] : [typed, classifyLocation(realPath, env)];
  const destination = destinations.find((l) => l.kind === "cloud_folder") ?? destinations[destinations.length - 1]!;
  return { destination, destinations };
}

/** Package-internal (also backups, R125). Each destination candidate: a certain classification as is; an uncertain one as every plausible kind. */
export function candidates(destinations: Location[]): Array<{ loc: Location; guessed: boolean }> {
  const out: Array<{ loc: Location; guessed: boolean }> = [];
  const add = (loc: Location, guessed: boolean) => {
    if (!out.some((c) => c.loc.kind === loc.kind && c.loc.cloudFolderId === loc.cloudFolderId)) out.push({ loc, guessed });
  };
  for (const d of destinations) add(d, !d.certain);
  for (const d of destinations) if (!d.certain) for (const kind of PLAUSIBLE) add({ kind, certain: false }, true);
  return out;
}

/**
 * Checks whether the library can move to `destRoot` and evaluates each
 * project's residency rules for it: for the typed path and its real path
 * (symbolic links resolved), and, where the kind is uncertain, for every
 * plausible kind; any deny denies the project. Throws MoveNotAllowedError for a
 * read-only library, unresolved interrupted writes, an overlapping or
 * non-empty destination, unreadable project folders or colliding names, and
 * MoveVerificationError for symbolic links in the library.
 */
export async function planMove(lib: Library, destRoot: string, env: LocationEnv, opts: PlanOptions = {}): Promise<MovePlan> {
  await preflight(lib, destRoot, opts.sourceRepo);
  const { destination, destinations } = await locate(destRoot, env);
  const now = (opts.now ?? new Date()).toISOString();
  const { projects, movedAway } = await readProjects(lib.root);
  const perProject: ProjectPlan[] = [];
  for (const p of projects) {
    let decision: PolicyDecision | undefined;
    try {
      const cfg = parseGovernance(await fsp.readFile(join(lib.root, ...p.folder.split("/"), "governance.yaml"), "utf8"));
      for (const { loc, guessed } of candidates(destinations)) {
        const d = evaluate(cfg, {
          action: "move",
          projectId: p.id,
          actor: opts.actor ?? "local-user",
          now,
          // The project's zone when set, else the computer's (R160 as amended).
          tz: dateRuleZone(p, "protocol", opts.tz),
          move: { destination: loc.kind, ...(loc.cloudFolderId ? { cloudFolderId: loc.cloudFolderId } : {}) },
        });
        if (d.result === "deny") {
          decision = guessed ? denyOf(`Destination type could not be determined (it may be ${loc.kind}): ${d.reason}`, d.warnings) : d;
          break;
        }
        decision ??= d;
      }
    } catch (e) {
      // Error text is scrubbed of absolute paths where it is captured: it may be recorded (Task 50 N5).
      decision = denyOf(`Policy could not be evaluated: ${scrubPaths(msg(e), [lib.root])}`);
    }
    perProject.push({ projectId: p.id, name: p.name, folder: p.folder, decision: decision ?? denyOf("Policy could not be evaluated") });
  }
  const w = await walk(lib.root, skipper(movedAway, false));
  abortOnOdd(w);
  assertNoCollisions(w);
  return { destination, destinations, perProject, projectsMovedAway: movedAway, fileCount: w.files.length, totalBytes: w.files.reduce((s, f) => s + f.size, 0) };
}

/** In-memory confirmation tokens → their persisted pending record. */
const tokens = new Map<string, { pendingId: string; deps: Deps; tz?: string; actor?: string }>();

/**
 * Copies the library to `destRoot`, verifies every file, and switches to it.
 * Resumable: `<dest>/.move-journal.json` records the files copied so far, and
 * a rerun skips those whose destination copy still matches the source. A rerun
 * after a crash during the switch finishes the switch (see completeMove).
 */
export async function executeMove(lib: Library, destRoot: string, opts: MoveOptions): Promise<MoveResult> {
  const { deps, env } = opts;
  const dest = resolve(destRoot);
  const progress = async (p: MoveProgress) => {
    await opts.onProgress?.(p);
  };

  // A switch interrupted by a crash: finish it (the source is closed as the move would have).
  const prior = await readJournal(dest);
  if (prior?.phase === "switching") {
    const rec = await getPendingOldCopy(deps, prior.switch!.pendingId);
    if (prior.libraryId === lib.id || rec?.oldRoot === resolve(lib.root)) {
      return completeMove(dest, deps, env, { source: lib, tz: opts.tz, actor: opts.actor, destRepo: opts.destRepo });
    }
  }

  const exclude = [...new Set(opts.excludeProjectIds ?? [])].sort();
  const plan = await planMove(lib, dest, env, { sourceRepo: opts.sourceRepo, now: deps.clock(), tz: opts.tz, actor: opts.actor });
  await progress({ phase: "plan", filesDone: 0, fileCount: plan.fileCount, bytesDone: 0, totalBytes: plan.totalBytes });
  const known = new Set(plan.perProject.map((p) => p.projectId));
  const unknown = exclude.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new MoveNotAllowedError("unknown-project", `No such project in this library: ${unknown.join(", ")}`);
  const moved = plan.perProject.filter((p) => !exclude.includes(p.projectId));
  const denied = moved.filter((p) => p.decision.result === "deny");
  if (denied.length > 0) {
    // Each refusal is audited in the refused project (Task 50); one that cannot be is marked for the next open.
    const details = {
      op: "library.move",
      toHint: hintFor(dest, deps),
      destinationKind: plan.destination.kind,
      destinationCertain: plan.destinations.every((d) => d.certain),
      ...(plan.destination.cloudFolderId ? { cloudFolderId: plan.destination.cloudFolderId } : {}),
    };
    let unrecorded = false;
    for (const p of denied) {
      const reason = p.decision.result === "deny" ? p.decision.reason : "";
      const w = await auditOrMark(lib.root, p.projectId, p.folder, opts.sourceRepo, lib, "move", details, { actor: opts.actor, deps }, { libraryId: lib.id, held: await holdsLock(lib) }, { reason });
      if (w?.includes("either")) unrecorded = true;
    }
    const why = denied.map((p) => `${p.name}: ${p.decision.result === "deny" ? p.decision.reason : ""}`).join("; ");
    throw new MoveNotAllowedError(
      "policy-denied",
      `Some projects may not be moved there (exclude them or choose another destination): ${why}${unrecorded ? " (this refusal could not be recorded in the audit log)" : ""}`,
    );
  }
  const excludedFolders = plan.perProject.filter((p) => exclude.includes(p.projectId)).map((p) => p.folder);
  const { movedAway } = await readProjects(lib.root);
  const journal = await preflight(lib, dest, opts.sourceRepo);

  if (opts.index?.isOpen) checkpointTruncate(opts.index.db);
  const split = excludedFolders.length > 0;
  const skip = skipper([...excludedFolders, ...movedAway], split);
  const src = await walk(lib.root, skip);
  abortOnOdd(src);
  const fileCount = src.files.length;
  const totalBytes = src.files.reduce((s, f) => s + f.size, 0);

  // Copy.
  await fsp.mkdir(dest, { recursive: true });
  const fromHint = hintFor(lib.root, deps);
  const j: Journal = journal ?? { libraryId: lib.id, fromHint, startedAt: deps.clock().toISOString(), filesDone: [] };
  j.phase = "copying";
  const expected = new Set(src.files.map((f) => f.rel));
  // Journaled files are never trusted: each is re-hashed against the source before it is skipped.
  const journaled = new Set(j.filesDone.filter((f) => expected.has(f)));
  const done = new Set(journaled);
  const flush = () => writeJournal(dest, { ...j, filesDone: [...done] });
  await flush();
  // Temp files of an interrupted copy (ours: they shadow a file this move copies).
  const leftovers = await walk(dest, (rel) => rel === ".tmp");
  for (const f of leftovers.files) {
    const base = f.rel.replace(TEMP_FILE, "");
    if (TEMP_FILE.test(f.rel) && (expected.has(base) || base === MOVE_JOURNAL)) await fsp.unlink(abs(dest, f.rel));
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
        await flush();
        sinceFlush = 0;
        lastFlush = Date.now();
      }
      await progress({ phase: "copy", filesDone, fileCount, bytesDone, totalBytes });
    }
  } finally {
    await flush().catch(() => {});
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
  const hashes: Record<string, string> = {};
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
      else hashes[f.rel] = a;
    }
    filesDone++;
    bytesDone += f.size;
    await progress({ phase: "verify", filesDone, fileCount, bytesDone, totalBytes });
  }
  const dirSet = new Set([...src.dirs.map((d) => d.rel), ...LIBRARY_DIRS]);
  const atDest = await walk(dest, (rel) => rel === MOVE_JOURNAL || rel === ".tmp");
  // The Finder's own files at the destination's top (there before the move, which counted the folder as empty; FR-047) are left.
  for (const f of atDest.files) if (!expected.has(f.rel) && !FINDER_FILES.has(f.rel)) bad.push(f.rel);
  for (const d of atDest.dirs) if (!dirSet.has(d.rel)) bad.push(d.rel);
  bad.push(...atDest.odd);
  if (bad.length > 0) {
    const uniq = [...new Set(bad)];
    throw new MoveVerificationError(uniq.slice(0, MAX_LISTED), uniq.length, "Verification failed; nothing was switched or deleted");
  }

  // Switch: plan every step, record it, then run the steps.
  await progress({ phase: "switch", filesDone: fileCount, fileCount, bytesDone: totalBytes, totalBytes });
  const movedProjectIds = moved.map((p) => p.projectId).sort();
  const moveId = newId();
  // Durably, before the old copy is marked: the destination stays findable after any crash
  // (listUnfinishedMoves, Library.movedTo, and the registry's known paths).
  // A list that cannot be read stops the move here, before anything is switched (Task 68, ruling 1).
  const rec = await addPendingOldCopy(
    deps,
    {
      oldRoot: resolve(lib.root),
      newRoot: dest,
      libraryId: lib.id,
      split,
      movedFolders: moved.map((p) => p.folder),
      movedProjectIds,
      movedAway,
      moveId,
    },
    { files: hashes, dirs: src.dirs.map((d) => d.rel) },
  ).catch((err: unknown) => {
    throw err instanceof OldCopiesUnreadableError ? new OldCopiesUnreadableError("move") : err;
  });
  await addKnownPath(lib.id, dest, deps);
  j.phase = "switching";
  j.filesDone = [...done];
  j.switch = {
    moveId,
    pendingId: rec.id,
    libraryName: lib.name,
    steps: ["mark-old", "register", "close-source", ...(split ? (["audit-split"] as const) : []), "audit-move", "finalize"],
    done: [],
    ...(split ? { remainingLibraryId: newId() } : {}),
    movedFolders: moved.map((p) => p.folder),
    movedProjectIds,
    excludedProjectIds: exclude,
    projectsMovedAway: movedAway,
    fileCount,
    totalBytes,
    details: {
      moveId,
      fromHint,
      toHint: hintFor(dest, deps),
      destinationKind: plan.destination.kind,
      destinationCertain: plan.destinations.every((d) => d.certain),
      ...(plan.destination.cloudFolderId ? { cloudFolderId: plan.destination.cloudFolderId } : {}),
      projectsMoved: movedProjectIds,
      projectsExcluded: exclude,
      fileCount,
      totalBytes,
      verified: true,
    },
  };
  await writeJournal(dest, j);
  const res = await runSwitch(dest, j, rec, deps, { source: lib, tz: opts.tz, actor: opts.actor, destRepo: opts.destRepo });
  return { ...res, filesCopied };
}

interface SwitchContext {
  /** The source library handle, when this process still has it open. */
  source?: Library;
  tz?: string;
  actor?: string;
  destRepo?: Repo;
}

/**
 * Finishes a move whose switch was interrupted (journal phase `switching`):
 * runs the steps not yet done, each idempotent. Needs this device's record of
 * the old copy (app config folder).
 */
export async function completeMove(destRoot: string, deps: Deps, _env?: LocationEnv, ctx: SwitchContext = {}): Promise<MoveResult> {
  const dest = resolve(destRoot);
  const j = await readJournal(dest);
  if (j?.phase !== "switching" || !j.switch) {
    throw new MoveNotAllowedError("nothing-to-complete", "No verified move is waiting to be finished in this folder; rerun the move to resume copying");
  }
  const rec = await getPendingOldCopy(deps, j.switch.pendingId);
  if (!rec) {
    throw new MoveNotAllowedError("nothing-to-complete", "This move was started on another device or its record is missing; finish it on that device");
  }
  return runSwitch(dest, j, rec, deps, ctx);
}

async function runSwitch(dest: string, j: Journal, rec: PendingOldCopy, deps: Deps, ctx: SwitchContext): Promise<MoveResult> {
  const sw = j.switch!;
  // Registering is an idempotent upsert; always redo it so the destination is first even if
  // the old copy was opened (and re-registered) between a crash and this completion.
  sw.done = sw.done.filter((s) => s !== "register");
  const warnings: string[] = [];
  const oldRoot = rec.oldRoot;
  const step = async (name: SwitchStep, fn: () => Promise<void>) => {
    if (!sw.steps.includes(name) || sw.done.includes(name)) return;
    await fn();
    sw.done.push(name);
    if (name !== "finalize") await writeJournal(dest, j);
    if (moveSeams.crashAfter === name) {
      moveSeams.crashAfter = undefined;
      throw new SimulatedMoveCrash(`simulated crash after ${name}`);
    }
  };
  /** Writes in the old folder stay inside it; with a split, only library.json and Projects/<moved>/ may be touched. */
  const oldWrite = async (rel: string, data: string) => {
    if (rec.split && rel !== "library.json" && !sw.movedFolders.some((f) => rel.startsWith(`${f}/`))) throw new PathEscapeError(rel);
    const p = abs(oldRoot, rel);
    await assertContained(oldRoot, p);
    await writeFileAtomic(p, data);
  };

  // The old copy is marked first, so it can never be opened read-write after the switch began.
  await step("mark-old", async () => {
    const marker = JSON.stringify({ libraryId: j.libraryId, movedAt: deps.clock().toISOString(), toHint: sw.details.toHint }, null, 2);
    if (!rec.split) {
      await oldWrite(MOVED_MARKER, marker);
      return;
    }
    // Moved project folders first (valid while library.json still names this library), then the
    // old folder becomes a separate library with its own id, remembering the one it was split from.
    for (const f of sw.movedFolders) await oldWrite(`${f}/${MOVED_MARKER}`, marker);
    const meta = JSON.parse(await fsp.readFile(join(oldRoot, "library.json"), "utf8")) as LibraryJson;
    const restName = meta.libraryId === sw.remainingLibraryId ? meta.name : `${sw.libraryName} (remaining projects)`;
    if (meta.libraryId !== sw.remainingLibraryId) {
      await oldWrite("library.json", JSON.stringify({ ...meta, libraryId: sw.remainingLibraryId, name: restName, splitFrom: j.libraryId }, null, 2));
    }
    await registerLibrary({ libraryId: sw.remainingLibraryId!, name: restName, path: oldRoot }, deps);
  });
  await step("register", () => registerLibrary({ libraryId: j.libraryId, name: sw.libraryName, path: dest }, deps));
  await step("close-source", async () => {
    // The source repo, if any, is never written after this: its library handle is closed.
    if (ctx.source && resolve(ctx.source.root) === oldRoot) await ctx.source.close();
  });
  await step("audit-split", async () => {
    const details = { moveId: sw.moveId, fromHint: sw.details.fromHint, toHint: sw.details.toHint, projectsMoved: sw.movedProjectIds, projectsRemaining: sw.excludedProjectIds };
    await auditIn(oldRoot, deps, ctx, sw.excludedProjectIds, "library.split", details, warnings, { expectId: sw.remainingLibraryId! });
  });
  await step("audit-move", () =>
    auditIn(dest, deps, { ...ctx, repo: ctx.destRepo }, sw.movedProjectIds, "library.move", sw.details, warnings, { expectId: j.libraryId, ignoreMoveJournal: true }),
  );
  await step("finalize", async () => {
    await markPendingComplete(deps, rec.id);
    await fsp.unlink(join(dest, MOVE_JOURNAL)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  });

  const confirmToken = randomBytes(32).toString("hex");
  tokens.set(confirmToken, { pendingId: rec.id, deps, tz: ctx.tz, actor: ctx.actor });
  return {
    newRoot: dest,
    verified: true,
    confirmToken,
    fileCount: sw.fileCount,
    totalBytes: sw.totalBytes,
    filesCopied: 0,
    projectsMovedAway: sw.projectsMovedAway ?? [],
    warnings,
  };
}

/**
 * Records `action` for one project through `repo` when it is open on the library at `root` and
 * holds the project; otherwise (no open repo, or not this library) marks the project as needing
 * attention (`<Project>/attention/`) so the next writable open records it late (Task 50, R28,
 * R82). Returns a plain warning when the event was not recorded now.
 */
async function auditOrMark(
  root: string,
  projectId: string,
  folder: string | null,
  repo: Repo | undefined,
  lib: Pick<Library, "id" | "root"> | undefined,
  action: string,
  details: Record<string, unknown>,
  who: { actor?: string; deps: Deps },
  where: { libraryId: string; held: boolean },
  refusal?: { reason: string },
  cause?: unknown,
): Promise<string | undefined> {
  if (repo) {
    const l = repoLibrary(repo);
    const sameLib = resolve(l.root) === resolve(root) && (!lib || l.id === lib.id);
    if (sameLib && repo.listProjects().some((p) => p.id === projectId)) return recordOrMark(repo, projectId, action, details, refusal);
  }
  const what = `The ${action} audit event could not be recorded for project ${projectId}${cause !== undefined ? ` (${msg(cause)})` : ""}`;
  const rec: UnrecordedAudit = {
    formatVersion: 1,
    id: newAttentionId(),
    kind: "audit-unrecorded",
    occurredAt: who.deps.clock().toISOString(),
    actor: who.actor ?? "local-user",
    device: who.deps.deviceId,
    action,
    ...(refusal ? { decision: { result: "deny" as const, reason: refusal.reason } } : {}),
    details,
    state: "ready",
    reason: cause !== undefined ? reasonOf(cause) : "RepoNotOpen",
  };
  // Only into a library this device holds the lock for (R154 e); otherwise, or when the project
  // folder cannot take it, the mark waits on this device and is delivered at its next writable open.
  if (where.held) {
    try {
      const rel = folder ?? (await projectFolderOf(root, projectId));
      if (!rel) throw new Error("the project folder was not found");
      await writeAttention(root, rel, rec);
      return `${what}; the project is marked as needing attention and the event is recorded when the library is next opened`;
    } catch {
      // falls through to the outbox
    }
  }
  try {
    await writeOutbox(who.deps.appConfigDir, where.libraryId, projectId, rec);
  } catch (e) {
    return `${what}; it could not be kept for later either (${msg(e)})`;
  }
  return `${what}; it is kept on this computer and recorded when the library is next opened here with write access`;
}

/**
 * Appends `action` to each project through `ctx.repo` or a repo opened on
 * `root` (which also records the location hint when it opens the library).
 * A failure does not undo the move (the data is already verified at the
 * destination): it is reported in `warnings` and the project is marked as
 * needing attention, so the next writable open records the event (Task 50).
 * A mark is only written in a folder that holds the expected library.
 */
async function auditIn(
  root: string,
  deps: Deps,
  ctx: { repo?: Repo; tz?: string; actor?: string },
  projectIds: string[],
  action: string,
  details: Record<string, unknown>,
  warnings: string[],
  check: { expectId: string; ignoreMoveJournal?: boolean },
): Promise<void> {
  if (projectIds.length === 0) return;
  let lib: Library | undefined;
  let repo: Repo | undefined;
  let cause: unknown;
  try {
    repo = ctx.repo;
    if (repo) {
      const l = repoLibrary(repo);
      if (resolve(l.root) !== resolve(root) || l.id !== check.expectId) throw new Error("the repo passed is not open on this library");
    } else {
      lib = await openLibraryInternal(root, deps, {}, { ignoreMoveJournal: check.ignoreMoveJournal });
      if (lib.id !== check.expectId) throw new Error("the folder holds a different library");
      if (lib.mode !== "read-write") throw new Error(`the library opened read-only (${lib.readOnlyReason ?? "unknown"}); pass its open repo`);
      repo = await openRepo(lib, new KeyRing(), { clock: deps.clock, ...(ctx.tz ? { tz: ctx.tz } : {}), ...(ctx.actor ? { actor: ctx.actor } : {}) });
    }
  } catch (err) {
    repo = undefined;
    cause = err;
  }
  try {
    // This device may write into the folder only while it holds that library's lock (R154 e).
    const held = lib !== undefined && lib.id === check.expectId && (await holdsLock(lib));
    for (const id of projectIds) {
      const w = await auditOrMark(root, id, null, repo, undefined, action, details, { actor: ctx.actor, deps }, { libraryId: check.expectId, held }, undefined, cause);
      if (w) warnings.push(w);
    }
  } finally {
    await lib?.close();
  }
}

/**
 * Files (and links or special files) under `bases` of the old copy, without following links.
 * A folder that cannot be read is reported as `<rel>/` in `unreadable` (fail closed).
 */
async function scanOldCopy(
  root: string,
  bases: string[],
  skipFolders: string[],
): Promise<{ files: string[]; unreadable: string[]; movedAwayPresent: string[] }> {
  const out = { files: [] as string[], unreadable: [] as string[], movedAwayPresent: [] as string[] };
  const visit = async (rel: string, isBase: boolean): Promise<void> => {
    let entries: Array<import("node:fs").Dirent>;
    try {
      if (moveSeams.unreadableDir !== undefined && moveSeams.unreadableDir === rel) {
        throw Object.assign(new Error("permission denied (simulated)"), { code: "EACCES" });
      }
      entries = await fsp.readdir(rel ? abs(root, rel) : root, { withFileTypes: true });
    } catch (err) {
      if (isBase && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      out.unreadable.push(`${rel}/`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skipFolders.includes(r)) {
          out.movedAwayPresent.push(r);
          continue;
        }
        await visit(r, false);
      } else {
        out.files.push(r);
      }
    }
  };
  for (const b of bases) await visit(b, true);
  return out;
}

export interface DeleteOldCopyResult {
  filesDeleted: number;
  /** Up to 50 library-relative paths in the old copy that were not part of the verified move; they and the library's identity files were kept. */
  leftovers: string[];
  /** Library-relative files of the old copy that were kept: changed since the move, or not safely inside it. */
  kept: string[];
  /** `Projects/<n>` folders moved away by an earlier move: not part of this one, left untouched. */
  movedAwayKept: string[];
  /** The old folder itself was removed (it was empty at the end). */
  rootRemoved: boolean;
  warnings: string[];
}

/**
 * Deletes the old copy after a finished move. `auth` is the token the move
 * returned (single use, this process), or, after a restart, `{ confirm: true }`
 * for a copy listed by listPendingOldCopies (pass `deps`); either way within 24
 * hours of the move. Holds the old folder's lock while deleting (refused if
 * another device holds it). Only files verified at the destination and still
 * identical are deleted, never through a symbolic link or outside `oldRoot`.
 * When the old folder kept excluded projects (a separate library now), only the
 * moved projects' folders are deleted there. Recorded as
 * `library.old-copy-deleted` in the destination; pass `destRepo` if it is open.
 */
export async function deleteOldCopy(
  oldRoot: string,
  auth: string | { confirm: true },
  opts: { deps?: Deps; destRepo?: Repo; tz?: string; actor?: string } = {},
): Promise<DeleteOldCopyResult> {
  const root = resolve(oldRoot);
  let rec: PendingOldCopy | undefined;
  let deps: Deps;
  let tz = opts.tz;
  let actor = opts.actor;
  if (typeof auth === "string") {
    const t = tokens.get(auth);
    if (!t) throw new InvalidConfirmTokenError("unknown");
    deps = t.deps;
    tz ??= t.tz;
    actor ??= t.actor;
    rec = await getPendingOldCopy(deps, t.pendingId);
    if (!rec) {
      tokens.delete(auth);
      throw new InvalidConfirmTokenError("unknown");
    }
  } else {
    if (auth?.confirm !== true || !opts.deps) throw new InvalidConfirmTokenError("unknown");
    deps = opts.deps;
    const forRoot = (await listPendingOldCopies(deps)).filter((r) => r.oldRoot === root).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (forRoot.length === 0) throw new InvalidConfirmTokenError("unknown");
    rec = forRoot.find((r) => !r.expired) ?? forRoot[0]!;
  }
  if (!rec.complete) throw new InvalidConfirmTokenError("unknown");
  if (root !== rec.oldRoot) throw new InvalidConfirmTokenError("wrong-root");
  if (isExpired(rec, deps)) throw new InvalidConfirmTokenError("expired");
  if (!rec.split) {
    const meta = await fsp.readFile(join(root, "library.json"), "utf8").then((t) => JSON.parse(t) as Partial<LibraryJson>, () => null);
    if (meta !== null && meta.libraryId !== rec.libraryId) throw new InvalidConfirmTokenError("wrong-root");
  }
  // The old folder's lock for the whole deletion; held by this process already (the remaining library is open here) is fine.
  if (await peekLock(root, deps)) throw new MoveNotAllowedError("old-copy-in-use", "The old copy is open on a device; close it there first");
  const held = await readLock(root);
  const ours = held !== null && held !== "corrupt" && held.deviceId === deps.deviceId && held.pid === deps.pid;
  let acquired = false;
  if (!ours) {
    const got = await acquireLock(root, deps).catch(() => ({ acquired: false as const }));
    if (!got.acquired) throw new MoveNotAllowedError("old-copy-in-use", "The old copy is open on a device; close it there first");
    acquired = true;
  }
  if (typeof auth === "string") tokens.delete(auth);

  const kept: string[] = [];
  const warnings: string[] = [];
  let leftovers: string[] = [];
  let movedAwayKept: string[] = [];
  let filesDeleted = 0;
  let rootRemoved = false;
  try {
    const hashes = await readVerifiedHashes(rec);
    // With a split, only the moved projects' folders may be touched (allow-list).
    const inScope = (rel: string) => !rec.split || rec.movedFolders.some((f) => rel === f || rel.startsWith(`${f}/`));
    // Content that was never part of the verified move (added since, or never copied): never deleted,
    // and while any is left the old copy keeps its identity (library.json, MOVED.json) and stays read-only.
    const ignorable = new Set([".lock", MOVED_MARKER, `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`, ...rec.movedFolders.map((f) => `${f}/${MOVED_MARKER}`)]);
    // Folders moved away by an earlier move were deliberately not part of this one: left untouched, reported apart.
    const movedAway = rec.split ? [] : (rec.movedAway ?? []);
    const scan = await scanOldCopy(root, rec.split ? rec.movedFolders : [""], movedAway);
    const unverified = [...scan.files.filter((rel) => !ignorable.has(rel) && !(rel in hashes.files)), ...scan.unreadable].sort();
    movedAwayKept = scan.movedAwayPresent;
    leftovers = unverified.slice(0, 50);
    if (scan.unreadable.length > 0) {
      warnings.push(`${scan.unreadable.length} folder(s) of the old copy could not be read; they and the old copy's library.json and MOVED.json were kept`);
    }
    const added = unverified.length - scan.unreadable.length;
    if (added > 0) {
      warnings.push(`${added} file(s) in the old copy were not part of the move and were left in place; the old copy stays read-only until you remove them`);
    }
    const hasLeft = (prefix: string) => unverified.some((r) => !prefix || r.startsWith(`${prefix}/`));
    const deleteVerified = async (rel: string, hash: string) => {
      const p = abs(root, rel);
      const st = await fsp.lstat(p).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : ("error" as const)));
      if (st === null) return;
      if (st === "error") {
        kept.push(rel); // cannot tell what is there: fail closed
        return;
      }
      try {
        await assertContained(root, p);
      } catch (err) {
        if (!(err instanceof PathEscapeError)) throw err;
        kept.push(rel);
        return;
      }
      if (!st.isFile() || (await sha256File(p)) !== hash) {
        kept.push(rel);
        return;
      }
      await fsp.unlink(p);
      filesDeleted++;
    };
    for (const [rel, hash] of Object.entries(hashes.files)) {
      if (!inScope(rel) || (!rec.split && rel === "library.json")) continue;
      await deleteVerified(rel, hash);
    }
    // library.json last: it goes only when nothing of the old copy is left (kept or unverified),
    // so whatever remains still opens as a library, read-only (MOVED.json).
    const libHash = hashes.files["library.json"];
    if (!rec.split && libHash !== undefined && kept.length === 0 && unverified.length === 0) await deleteVerified("library.json", libHash);
    const removeMarker = async (rel: string) => {
      const p = abs(root, rel);
      if (!(await isFile(p))) return;
      await assertContained(root, p);
      await fsp.unlink(p);
    };
    if (!rec.split) {
      // SQLite side files of the (checkpointed or rebuildable) index; never copied.
      for (const n of [`${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`]) if (await isFile(join(root, n))) await fsp.unlink(join(root, n));
      // The marker keeps the old copy read-only while anything of it is left.
      if (kept.length === 0 && !hasLeft("")) await removeMarker(MOVED_MARKER);
    } else {
      for (const f of rec.movedFolders) if (!kept.some((k) => k.startsWith(`${f}/`)) && !hasLeft(f)) await removeMarker(`${f}/${MOVED_MARKER}`);
    }
    // Remove folders that are now empty, deepest first; rmdir never removes content or follows a link.
    const dirs = [...hashes.dirs.filter(inScope), ...(rec.split ? [] : [".tmp"])].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const d of dirs) await fsp.rmdir(abs(root, d)).catch(() => {});
  } finally {
    if (acquired) await releaseLock(root, deps).catch(() => {});
  }
  if (!rec.split) rootRemoved = await fsp.rmdir(root).then(() => true, () => false);
  await removePendingOldCopy(deps, rec.id);

  await auditIn(
    rec.newRoot,
    deps,
    { repo: opts.destRepo, tz, actor },
    rec.movedProjectIds,
    "library.old-copy-deleted",
    { oldHint: hintFor(root, deps), scope: rec.split ? "moved-projects-only" : "whole-library", filesDeleted, filesKept: kept.length, leftovers: leftovers.length, rootRemoved },
    warnings,
    { expectId: rec.libraryId },
  );
  return { filesDeleted, kept: kept.sort(), leftovers, movedAwayKept, rootRemoved, warnings };
}
