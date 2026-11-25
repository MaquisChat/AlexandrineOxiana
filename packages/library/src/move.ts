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
  moveFinished,
  listPendingOldCopies,
  listUnfinishedMoves,
  markPendingComplete,
  readVerifiedHashes,
  markPendingDeleted,
  sameFolder,
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
  /** finishMoveAt: the library's new place is open on another computer. */
  | "in-use"
  /** deleteOldCopy: the move of this old copy has not finished (its journal is still at the new place, R583 M2). */
  | "move-unfinished"
  /** finishMoveAt: the library at the new place was saved by a newer version of the app. */
  | "newer-format"
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
  /**
   * The library's open index. It is checkpointed before the copy, so `library.sqlite` is complete without its WAL, and
   * the move closes it together with the source library, before the source's lock is released (R570 b).
   */
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
export const moveSeams: {
  crashAfter?: SwitchStep;
  /** deleteOldCopy: reading this old-copy folder fails. */
  unreadableDir?: string;
  /**
   * One write of the switch fails as on a full disk (once): the journal's write after step `after`, the marking of the
   * old copy's record as complete, or the removal of the journal (FR-755).
   */
  fail?: { at: "journal"; after: SwitchStep } | { at: "mark-complete" } | { at: "unlink" } | { at: "split-mark"; afterFolders: number };
} = {};
/** Throws the seam's simulated "no space left" once, when it names `at` (and `after`: the step, or how many moved folders a split has marked). */
function failSeam(at: "journal" | "mark-complete" | "unlink" | "split-mark", after?: SwitchStep | number): void {
  const f = moveSeams.fail;
  if (!f || f.at !== at || (f.at === "journal" && f.after !== after) || (f.at === "split-mark" && f.afterFolders !== after)) return;
  moveSeams.fail = undefined;
  throw Object.assign(new Error("no space left on device (simulated)"), { code: "ENOSPC" });
}
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

/**
 * acceptMovePlan met a write-ahead marker: a change still being written by work that runs until the move stops it, or a
 * change interrupted earlier — it cannot tell which while that work runs. It judges nothing more (R513 M2): the move's
 * own plan, after the stop, answers in the old order ("pending writes" before the destination and any project's rules).
 */
class PlanAfterStop extends Error {}

/**
 * Shared refusals of planMove and executeMove. Returns the journal of an interrupted move, if any. `checkPending` false
 * (acceptMovePlan, while work may still be writing): a project left refusing changes by an interrupted change (the
 * open repo's own state, which running work does not change) still refuses at once, as "pending writes"; a write-ahead
 * marker ends the early plan with nothing judged (PlanAfterStop), so that no later check is answered before it.
 */
async function preflight(lib: Library, destRoot: string, repo?: Repo, checkPending = true): Promise<Journal | null> {
  if (lib.mode !== "read-write") {
    throw new MoveNotAllowedError("read-only", `The library is open read-only${lib.readOnlyReason ? ` (${lib.readOnlyReason})` : ""}; it cannot be moved`);
  }
  const markers = (await markerFiles(lib.root)) > 0;
  const recovering = repo !== undefined && recoveryPendingProjects(repo).length > 0;
  if (markers && !recovering && !checkPending) throw new PlanAfterStop();
  if (markers || recovering) {
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
  return planWith(lib, destRoot, env, opts, true);
}

/** planMove, with or without its check for interrupted changes (see preflight). */
async function planWith(lib: Library, destRoot: string, env: LocationEnv, opts: PlanOptions, checkPending: boolean): Promise<MovePlan> {
  await preflight(lib, destRoot, opts.sourceRepo, checkPending);
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
          // A guessed kind is refused in words that say it may be that kind (R473 M4).
          move: { destination: loc.kind, ...(loc.cloudFolderId ? { cloudFolderId: loc.cloudFolderId } : {}), ...(guessed ? { uncertain: true } : {}) },
        });
        if (d.result === "deny") {
          decision = d;
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

/** A switch interrupted by a crash at `dest`, of this library: the move finishes it, taking no plan. */
async function finishesSwitch(lib: Library, dest: string, deps: Deps): Promise<boolean> {
  const prior = await readJournal(dest);
  if (prior?.phase !== "switching") return false;
  const rec = await getPendingOldCopy(deps, prior.switch!.pendingId);
  return prior.libraryId === lib.id || rec?.oldRoot === resolve(lib.root);
}

/**
 * The move's refusals of its plan: a project to exclude that is not here; projects whose rules deny it, each audited.
 * Accepted, the projects moved.
 */
async function refuseUnaccepted(lib: Library, dest: string, plan: MovePlan, exclude: string[], opts: MoveOptions): Promise<ProjectPlan[]> {
  const { deps } = opts;
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
  return moved;
}

/**
 * R503 l (FR-733): the move's own plan, accepted or refused, for a caller that must stop work still writing in the
 * library (a running transcription) only once the move is accepted. The same code as executeMove's first steps — a
 * switch already decided is accepted (the move finishes it); otherwise the plan is taken and refused as executeMove
 * refuses it (each policy refusal audited in its project), in executeMove's order — and nothing is written at the
 * destination. Two things it leaves to executeMove, which takes its plan again once that work has stopped: a write-ahead
 * marker in the library (a change still being written by the running work, or one interrupted earlier: it judges
 * nothing after it, so that "pending writes" is still answered before the destination and any project's rules, unaudited,
 * R513 M2), and any failure that is not one of the move's refusals (a file that changed under the plan's walk). A project
 * left refusing changes by an interrupted change is refused here at once, as executeMove refuses it. Nothing of this
 * plan is used by executeMove.
 */
export async function acceptMovePlan(lib: Library, destRoot: string, opts: MoveOptions): Promise<void> {
  const { deps, env } = opts;
  const dest = resolve(destRoot);
  try {
    if (await finishesSwitch(lib, dest, deps)) return;
    const exclude = [...new Set(opts.excludeProjectIds ?? [])].sort();
    const plan = await planWith(lib, dest, env, { sourceRepo: opts.sourceRepo, now: deps.clock(), tz: opts.tz, actor: opts.actor }, false);
    await refuseUnaccepted(lib, dest, plan, exclude, opts);
  } catch (err) {
    // PlanAfterStop: an interrupted change may be there; the plan after the stop judges it first, as before (R513 M2).
    if (err instanceof PlanAfterStop) return;
    if (err instanceof MoveNotAllowedError || err instanceof MoveVerificationError) throw err;
  }
}

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
  if (await finishesSwitch(lib, dest, deps)) {
    return completeMove(dest, deps, env, { source: lib, index: opts.index, tz: opts.tz, actor: opts.actor, destRepo: opts.destRepo });
  }

  const exclude = [...new Set(opts.excludeProjectIds ?? [])].sort();
  const plan = await planMove(lib, dest, env, { sourceRepo: opts.sourceRepo, now: deps.clock(), tz: opts.tz, actor: opts.actor });
  await progress({ phase: "plan", filesDone: 0, fileCount: plan.fileCount, bytesDone: 0, totalBytes: plan.totalBytes });
  const moved = await refuseUnaccepted(lib, dest, plan, exclude, opts);
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
  const res = await runSwitch(dest, j, rec, deps, { source: lib, index: opts.index, tz: opts.tz, actor: opts.actor, destRepo: opts.destRepo });
  return { ...res, filesCopied };
}

interface SwitchContext {
  /** The source library handle, when this process still has it open. */
  source?: Library;
  /** The source's open index: closed with the source, before its lock is released (R570 b). */
  index?: IndexHandle;
  tz?: string;
  actor?: string;
  destRepo?: Repo;
  /** finishMoveAt holds the old copy's lock already (taken before the destination was opened). */
  oldLockHeld?: boolean;
  /** Called once the old copy is marked (finishMoveAt releases its lock then). */
  afterMarkOld?: () => Promise<void>;
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
  // Only at the place this computer's record names, for the library it names (R578): a copy of the destination made by
  // hand, journal and all, is not that move's destination.
  if (!(await sameFolder(rec.newRoot, dest)) || rec.libraryId !== j.libraryId) {
    throw new MoveNotAllowedError("nothing-to-complete", "This folder is not the destination this computer recorded for that move");
  }
  return runSwitch(dest, j, rec, deps, ctx);
}

/**
 * R583: why finishMoveAt did not finish a move that is this computer's own: the journal at the new place cannot be read;
 * the old copy cannot be reached when its marks must be looked at; files at the new place no longer match the move's
 * check (`count`, and whether the old copy at `oldRoot` still matches it: `oldWhole`); a split's projects not yet marked
 * were changed in the library they came from after they were copied; a mark the journal records as made in the old copy
 * is no longer there (removed by hand, R590 N3). Its message carries no path.
 */
export class MoveFinishRefusedError extends Error {
  override name = "MoveFinishRefusedError";
  constructor(
    readonly kind: "journal-damaged" | "old-copy-unreachable" | "files-differ" | "source-changed" | "mark-missing",
    message: string,
    readonly detail: { count?: number; oldRoot?: string; oldWhole?: boolean } = {},
  ) {
    super(message);
  }
}

/**
 * FR-755 (R578, R583): finishes, at an opening of `destRoot`, a move whose switch did not finish — only when it is this
 * computer's own move and `destRoot` is the folder its record names, and only once the old copy was marked as moved (the
 * journal records the step, or the old copy shows the marks: its top's MOVED.json, or for a split a moved project's mark
 * or its rewritten library.json). Returns undefined, writing nothing, when there is nothing this computer may finish here
 * (no journal; a move still copying; no record of the move here, as for a library brought from another computer; another
 * folder than the record's, as for a copy made by hand; the old copy not yet marked, so it is still the library).
 *
 * Before anything is written it checks the new place again against the checksums the move recorded (every file present;
 * the same content, except library.json and the projects' audit logs, which the switch's own steps may have written:
 * present), and for a split whose marking stopped part-way, that the moved projects not yet marked are unchanged in the
 * library they came from. Either failing, it refuses (MoveFinishRefusedError) and writes nothing.
 *
 * It holds the destination's lock for every step (the destination is opened read-write, ignoring the journal; held by
 * another, it refuses) and, when the old copy must be marked again, that copy's own lock for that step. A step that fails
 * throws; the journal then records only the steps that completed, and the next opening tries again.
 */
export async function finishMoveAt(destRoot: string, deps: Deps, opts: { tz?: string; actor?: string } = {}): Promise<MoveResult | undefined> {
  const dest = resolve(destRoot);
  const j = await readJournal(dest);
  if (!j) {
    if (await fsp.lstat(join(dest, MOVE_JOURNAL)).then(() => true, () => false)) throw new MoveFinishRefusedError("journal-damaged", "The move's journal at the new place cannot be read");
    return undefined;
  }
  if (j.phase !== "switching" || !j.switch) return undefined;
  const sw = j.switch;
  const rec = await getPendingOldCopy(deps, sw.pendingId).catch(() => undefined);
  if (!rec || !(await sameFolder(rec.newRoot, dest)) || rec.libraryId !== j.libraryId) return undefined;
  const markAgain = !sw.done.includes("mark-old");
  if (markAgain && !(await oldCopyMarked(rec, j))) return undefined;
  // R590 N3: every mark the journal records as made is still there (one removed by hand would let the old copy take
  // changes the finishing leaves behind). An old copy that cannot be reached is not looked at (R583 M4: finished without it).
  if (!markAgain && (await fsp.stat(rec.oldRoot).then((st) => st.isDirectory(), () => false))) {
    const marks = rec.split ? sw.movedFolders.map((f) => join(rec.oldRoot, ...f.split("/"), MOVED_MARKER)) : [join(rec.oldRoot, MOVED_MARKER)];
    for (const m of marks) {
      if (!(await markNames(m, j.libraryId))) throw new MoveFinishRefusedError("mark-missing", "A mark the move recorded in its old copy is no longer there", { oldRoot: rec.oldRoot });
    }
  }

  // R583 M5: the new place checked again against the move's own record of every file it verified. R590 N2: each audit
  // log (a project's, and the library's own, R599 M-1) must begin with exactly what was verified, followed only by the
  // finishing's own lines; and the new place's audit logs must show no fault to a check that writes nothing (empty,
  // shortened, chain broken, head not anchored).
  const verified = (await readVerifiedHashes(rec)).files;
  const differ = await notMatching(dest, verified, (rel) => (rel === "library.json" ? "present" : AUDIT_LOG.test(rel) ? "begins" : "same"));
  for (const where of await auditFaultsAt(dest, deps)) if (!differ.some((rel) => rel.startsWith(where))) differ.push(where);
  if (differ.length > 0) {
    const oldWhole =
      (await fsp.stat(rec.oldRoot).then(() => true, () => false)) &&
      (await notMatching(rec.oldRoot, verified, (rel) => (rel === "library.json" || rel === INDEX_FILE ? "present" : "same"))).length === 0;
    throw new MoveFinishRefusedError("files-differ", `${differ.length} file(s) at the new place no longer match the move's check`, { count: differ.length, oldRoot: rec.oldRoot, oldWhole });
  }
  // A split marked part-way: the moved projects not yet marked could have been opened and changed in the old library.
  if (markAgain && rec.split) {
    const unmarked: string[] = [];
    for (const f of sw.movedFolders) if (!(await markNames(join(rec.oldRoot, ...f.split("/"), MOVED_MARKER), j.libraryId))) unmarked.push(f);
    const theirs = Object.fromEntries(Object.entries(verified).filter(([rel]) => unmarked.some((f) => rel.startsWith(`${f}/`))));
    if ((await notMatching(rec.oldRoot, theirs, () => "same")).length > 0) {
      throw new MoveFinishRefusedError("source-changed", "Projects not yet marked as moved were changed in the library they came from", { oldRoot: rec.oldRoot });
    }
  }

  // The old copy's lock first, when it is to be marked again: refused before anything is written anywhere; released as
  // soon as it is marked.
  let oldLocked = false;
  const releaseOld = async () => {
    if (!oldLocked) return;
    oldLocked = false;
    await releaseLock(rec.oldRoot, deps);
  };
  if (markAgain) {
    await takeOldCopyLock(rec.oldRoot, deps);
    oldLocked = true;
  }
  let lib: Library | undefined;
  try {
    lib = await openLibraryInternal(dest, deps, {}, { ignoreMoveJournal: true });
    if (lib.readOnlyReason === "locked-by-other-device") throw new MoveNotAllowedError("in-use", "The library's new place is open elsewhere");
    if (lib.readOnlyReason === "newer-format") throw new MoveNotAllowedError("newer-format", "The library at the new place was saved by a newer version of the app");
    if (lib.mode !== "read-write" || lib.id !== j.libraryId) {
      throw new MoveNotAllowedError("read-only", `The library's new place could not be opened for writing (${lib.readOnlyReason ?? "another library"})`);
    }
    const repo = await openRepo(lib, new KeyRing(), { clock: deps.clock, ...(opts.tz ? { tz: opts.tz } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });
    return await runSwitch(dest, j, rec, deps, { destRepo: repo, oldLockHeld: markAgain, afterMarkOld: releaseOld, ...(opts.tz ? { tz: opts.tz } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });
  } finally {
    await lib?.close();
    await releaseOld();
  }
}

/** An audit log: a project's (appended by the switch's own audit steps) or the library's own (R599 M-1: the same rule). */
const AUDIT_LOG = /^(?:Projects\/[^/]+\/)?audit\/[^/]+\.jsonl$/u;

/**
 * The files of `expected` (library-relative path → SHA-256, the move's own verification record) that are missing under
 * `root` or, where `rule` says "same", differ from what was verified. Read as the move's verification reads (sha256File).
 */
async function notMatching(root: string, expected: Record<string, string>, rule: (rel: string) => "same" | "present" | "begins"): Promise<string[]> {
  const bad: string[] = [];
  for (const [rel, hash] of Object.entries(expected)) {
    const p = abs(root, rel);
    const st = await fsp.lstat(p).catch(() => null);
    const r = rule(rel);
    if (!st?.isFile()) bad.push(rel);
    else if (r === "same" && (await sha256File(p).catch(() => "")) !== hash) bad.push(rel);
    else if (r === "begins" && !(await beginsWithVerified(p, hash).catch(() => false))) bad.push(rel);
  }
  return bad;
}

/**
 * What the finishing itself may append to an audit log at the new place: the switch's own event (audit-move), and the
 * record its own writable opening makes when this computer's anchor of the log was lost (R599 M-1: a fact about this
 * computer, not a change of the library). `audit.anchor-mismatch` is not among them: it is refused.
 */
const SWITCH_OWN_ACTIONS = new Set(["library.move", "audit.anchor-missing"]);

/**
 * R590 N2: the audit log at `p` begins with exactly what the move verified, and goes on only with the switch's own lines.
 * The move's record holds each file's SHA-256 and no size, so the verified beginning is found by its hash: the log is
 * read once, and the hash of every beginning that ends a line (or is empty, or is the whole file) is compared with the
 * recorded one. Every complete line after it must be an audit event the switch writes; a last line cut off by a crash
 * (no line end) is not a record and is left to the opening's own repair.
 */
async function beginsWithVerified(p: string, hash: string): Promise<boolean> {
  const buf = await fsp.readFile(p);
  const h = createHash("sha256");
  let end = h.copy().digest("hex") === hash ? 0 : -1;
  for (let from = 0; end < 0 && from < buf.length; ) {
    const nl = buf.indexOf(0x0a, from);
    const to = nl < 0 ? buf.length : nl + 1;
    h.update(buf.subarray(from, to));
    from = to;
    if (h.copy().digest("hex") === hash) end = to;
  }
  if (end < 0) return false;
  const rest = buf.subarray(end).toString("utf8").split("\n");
  rest.pop(); // what follows the last line end: nothing, or a line cut off by a crash
  return rest.every((line) => {
    try {
      return SWITCH_OWN_ACTIONS.has((JSON.parse(line) as { action?: unknown }).action as string);
    } catch {
      return false;
    }
  });
}

/** R590 N2: the faults of the new place's audit logs that the finishing refuses over. */
const AUDIT_FAULTS = new Set(["empty", "truncated", "chain-broken", "head-mismatch"]);

/**
 * R590 N2: the new place's audit logs with a fault (`Projects/<n>/audit/`, or `audit/` for the library's own log), found
 * by the library's own check, opened read-only so that nothing is written and no fault is recorded over (a writable
 * opening records a fault in the log and anchors it anew, after which no later opening reports it).
 */
async function auditFaultsAt(dest: string, deps: Deps): Promise<string[]> {
  const lib = await openLibraryInternal(dest, deps, {}, {});
  try {
    // With its journal, the new place opens read-only (no lock, nothing written); any other state is refused later.
    if (lib.readOnlyReason !== "move-incomplete") return [];
    const repo = await openRepo(lib, new KeyRing(), { clock: deps.clock, noHeal: true });
    const out: string[] = [];
    for (const w of repo.integrityWarnings) {
      if (!AUDIT_FAULTS.has(w.kind)) continue;
      const where = w.projectId === "*" ? "audit/" : `${(await projectFolderOf(dest, w.projectId)) ?? `Projects/${w.projectId}`}/audit/`;
      if (!out.includes(where)) out.push(where);
    }
    return out;
  } finally {
    await lib.close();
  }
}

/**
 * R583 I1: what the old copy demonstrably shows of the move's marking: the top's MOVED.json naming the library, or for a
 * split any moved project's MOVED.json naming it, or the old folder's library.json already rewritten as the remaining
 * library. The old copy cannot be reached at all: it cannot be told (MoveFinishRefusedError "old-copy-unreachable").
 */
async function oldCopyMarked(rec: PendingOldCopy, j: Journal): Promise<boolean> {
  if (!(await fsp.stat(rec.oldRoot).then((st) => st.isDirectory(), () => false))) {
    throw new MoveFinishRefusedError("old-copy-unreachable", "The old copy cannot be reached to see whether it is marked as moved", { oldRoot: rec.oldRoot });
  }
  if (!rec.split) return markNames(join(rec.oldRoot, MOVED_MARKER), j.libraryId);
  const sw = j.switch!;
  for (const f of sw.movedFolders) if (await markNames(join(rec.oldRoot, ...f.split("/"), MOVED_MARKER), j.libraryId)) return true;
  try {
    const meta = JSON.parse(await fsp.readFile(join(rec.oldRoot, "library.json"), "utf8")) as Partial<LibraryJson>;
    return sw.remainingLibraryId !== undefined && meta.libraryId === sw.remainingLibraryId;
  } catch {
    return false;
  }
}

/** The moved marker at `p` names the library `libraryId`. */
async function markNames(p: string, libraryId: string): Promise<boolean> {
  try {
    return (JSON.parse(await fsp.readFile(p, "utf8")) as { libraryId?: unknown }).libraryId === libraryId;
  } catch {
    return false;
  }
}

/**
 * R583 I1 (R581): after a move failed, whether its old copy is marked as moved — then it must take no more changes. Read
 * from the journal at the destination (the step recorded) and, where the journal's write was what failed or a split's
 * marking stopped part-way, from what the old copy shows. False when there is no switching journal of this computer's
 * for that old copy, or the old copy cannot be reached.
 */
export async function oldCopyMarkedFor(destRoot: string, oldRoot: string, deps: Deps): Promise<boolean> {
  const j = await readJournal(resolve(destRoot));
  if (j?.phase !== "switching" || !j.switch) return false;
  const rec = await getPendingOldCopy(deps, j.switch.pendingId).catch(() => undefined);
  if (!rec || rec.oldRoot !== resolve(oldRoot)) return false;
  if (j.switch.done.includes("mark-old")) return true;
  return oldCopyMarked(rec, j).catch(() => false);
}

/**
 * Takes the old copy's lock for this process, to mark it (R247 c). Refused when another computer or process holds it, and
 * when this process already holds it (a library still open here: taking it over would end that hold at its release).
 */
async function takeOldCopyLock(oldRoot: string, deps: Deps): Promise<void> {
  const held = await readLock(oldRoot);
  if (held !== null && held !== "corrupt" && held.deviceId === deps.deviceId && held.pid === deps.pid) {
    throw new MoveNotAllowedError("old-copy-in-use", "The old copy of the library is still open, so the move cannot be finished now");
  }
  const got = await acquireLock(oldRoot, deps);
  if (!got.acquired) throw new MoveNotAllowedError("old-copy-in-use", "The old copy of the library is open on another computer, so the move cannot be finished now");
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
    if (name !== "finalize") {
      failSeam("journal", name);
      await writeJournal(dest, j);
    }
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
  // Written only under the old copy's lock (R247 c): the source's, when this process has it open; otherwise its own,
  // taken for this step and released after it (refused when another holds it).
  await step("mark-old", async () => {
    if (ctx.oldLockHeld || (ctx.source && resolve(ctx.source.root) === oldRoot && ctx.source.mode === "read-write" && !isClosed(ctx.source))) return markOld();
    await takeOldCopyLock(oldRoot, deps);
    try {
      await markOld();
    } finally {
      await releaseLock(oldRoot, deps);
    }
  });
  await ctx.afterMarkOld?.();
  async function markOld(): Promise<void> {
    const marker = JSON.stringify({ libraryId: j.libraryId, movedAt: deps.clock().toISOString(), toHint: sw.details.toHint }, null, 2);
    if (!rec.split) {
      await oldWrite(MOVED_MARKER, marker);
      return;
    }
    // Moved project folders first (valid while library.json still names this library), then the
    // old folder becomes a separate library with its own id, remembering the one it was split from.
    for (const [i, f] of sw.movedFolders.entries()) {
      await oldWrite(`${f}/${MOVED_MARKER}`, marker);
      failSeam("split-mark", i + 1);
    }
    const meta = JSON.parse(await fsp.readFile(join(oldRoot, "library.json"), "utf8")) as LibraryJson;
    const restName = meta.libraryId === sw.remainingLibraryId ? meta.name : `${sw.libraryName} (remaining projects)`;
    if (meta.libraryId !== sw.remainingLibraryId) {
      await oldWrite("library.json", JSON.stringify({ ...meta, libraryId: sw.remainingLibraryId, name: restName, splitFrom: j.libraryId }, null, 2));
    }
    await registerLibrary({ libraryId: sw.remainingLibraryId!, name: restName, path: oldRoot }, deps);
  }
  await step("register", () => registerLibrary({ libraryId: j.libraryId, name: sw.libraryName, path: dest }, deps));
  await step("close-source", async () => {
    // The source repo, if any, is never written after this: its library handle is closed.
    // Its index goes with it, before the lock is released (R551 M7, R570 b): a later close of the same library (the
    // service's closeLibrary) only gets this close's promise, so its own step that closes the index never runs.
    // On a fresh move it was checkpointed before the copy and not written since (the verify compared it), so it closes
    // without changing library.sqlite; only its working files (never copied) go. On a RESUMED switch (executeMove →
    // completeMove after a restart) nothing checkpointed it first: what the reopened service wrote into it since is folded
    // into the old copy's library.sqlite as it closes, which may then differ from the new place's, and deleteOldCopy keeps
    // that one file (it fails closed).
    if (ctx.source && resolve(ctx.source.root) === oldRoot) await ctx.source.close({ beforeRelease: () => ctx.index?.close() });
  });
  await step("audit-split", async () => {
    const details = { moveId: sw.moveId, fromHint: sw.details.fromHint, toHint: sw.details.toHint, projectsMoved: sw.movedProjectIds, projectsRemaining: sw.excludedProjectIds };
    await auditIn(oldRoot, deps, ctx, sw.excludedProjectIds, "library.split", details, warnings, { expectId: sw.remainingLibraryId! });
  });
  await step("audit-move", () =>
    auditIn(dest, deps, { ...ctx, repo: ctx.destRepo }, sw.movedProjectIds, "library.move", sw.details, warnings, { expectId: j.libraryId, ignoreMoveJournal: true }),
  );
  await step("finalize", async () => {
    failSeam("mark-complete");
    await markPendingComplete(deps, rec.id);
    failSeam("unlink");
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
  // R583 M2, R590 N4: not while the move is unfinished, nor while that cannot be told (the new place cannot be read).
  const finished = await moveFinished(rec);
  if (finished === "cannot-tell") {
    throw new MoveNotAllowedError(
      "move-unfinished",
      "The old copy cannot be deleted now: the library's new place cannot be reached, so the app cannot tell whether its move has finished. Connect the drive the new place is on and try again.",
    );
  }
  if (finished !== "finished") {
    throw new MoveNotAllowedError("move-unfinished", "The move of this library has not finished, so its old copy cannot be deleted yet. Open the library at its new place first; the move is finished then.");
  }
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
  // The record is not dropped while anything of the library stays at the old place (R409 a): it is
  // marked deleted (with `remains` when a file was kept or left, or the place still holds data of
  // the moved projects), so a destruction under the retention rule that names this copy goes on
  // looking there. (Imported when needed: retention.ts imports backups, which import this module.)
  const { oldPlaceLook, pruneDeletedOldCopy, recordOldCopyDeleted } = await import("./retention.js");
  const remains = kept.length > 0 || leftovers.length > 0 || (await oldPlaceLook(rec)) !== "none";
  await markPendingDeleted(deps, rec.id, remains);

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
  // A destruction under the retention rule that named this old copy as not destroyed records it as
  // removed once none of its files is left there, and its warning ends (R379), in the library open
  // here. Elsewhere, the next retry pass there looks at the place.
  const dest = opts.destRepo && repoLibrary(opts.destRepo).id === rec.libraryId ? opts.destRepo : undefined;
  if (dest) {
    for (const p of dest.listProjects()) {
      await recordOldCopyDeleted(dest, p.id, rec.id).catch((err: unknown) => {
        warnings.push(`That the old copy was deleted could not be recorded for a destruction in project ${p.id} yet (${msg(err)}); it is recorded when the library is next opened`);
      });
    }
  }
  // Dropped now when nothing of the library is left there and no destruction names it.
  await pruneDeletedOldCopy(deps, rec.libraryId, rec.id, join(dest ? repoLibrary(dest).root : rec.newRoot, "Backups")).catch(() => {});
  return { filesDeleted, kept: kept.sort(), leftovers, movedAwayKept, rootRemoved, warnings };
}
