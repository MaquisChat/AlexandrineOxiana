import { userInfo } from "node:os";
import { resolve } from "node:path";
import type { Project } from "@ao/core";
import {
  IndexHandle,
  KeyRing,
  WrongPassphraseError,
  appConfigDir,
  createIndexSink,
  deviceDeps,
  listLibraries,
  openLibrary,
  openRepo,
  type Deps,
  type Library,
  type Repo,
} from "@ao/library";
import { EXIT, ExitError, rememberRoot } from "./errors.js";
import { hasEnvPassphrase, isInteractive, readPassphrase } from "./prompt.js";
import { startCaptureWorker, type CaptureWorker } from "./worker.js";

/** Where a path the researcher typed is relative to: the folder the command was run from. */
export const userCwd = (): string => process.env.INIT_CWD || process.cwd();
export const resolveUserPath = (p: string): string => resolve(userCwd(), p);

let renewalSaid = false;

/**
 * This device's Deps. When its identity file was damaged and had to be renewed (Task 68), the tool
 * says so once on standard error, in plain words without a path; the device-level notice is written
 * before the tool exits (index.ts awaits deviceNoticesIdle).
 */
export function makeDeps(): Deps {
  const deps = deviceDeps(appConfigDir());
  if (deps.deviceRenewed && !renewalSaid) {
    renewalSaid = true;
    process.stderr.write("This computer's identity for the app could not be read and had to be renewed. The damaged file is kept beside the app's settings, and the desktop app will show a notice about it.\n");
  }
  return deps;
}

const READ_ONLY_TEXT: Record<string, string> = {
  "locked-by-other-device": "another computer (or another copy of this program) is using this library right now",
  "newer-format": "this library was made by a newer version of the program",
  offline: "the library's folder is not reachable (is the drive or network folder connected?)",
  "not-writable": "the library's folder cannot be written to",
  moved: "this folder is an old copy: the library was moved elsewhere",
  "move-incomplete": "a move of this library into this folder has not finished",
};
export const readOnlyText = (reason: string | undefined): string => (reason ? (READ_ONLY_TEXT[reason] ?? reason) : "unknown reason");

/** The library to use: --library, else AO_LIBRARY, else the most recently opened one. */
export async function locateLibrary(explicit: string | undefined, deps: Deps): Promise<string> {
  const given = explicit ?? process.env.AO_LIBRARY;
  if (given) return resolveUserPath(given);
  const known = await listLibraries(deps).catch(() => []);
  const path = known[0]?.lastKnownPaths[0];
  if (path) return path;
  throw new ExitError("No library was chosen.", EXIT.failure, "Use --library <folder>, set AO_LIBRARY, or create one with: ao library create <folder> --name \"My library\"");
}

export interface Session {
  deps: Deps;
  lib: Library;
  repo: Repo;
  ring: KeyRing;
  index: IndexHandle | undefined;
  worker?: CaptureWorker;
  /** Starts the media worker (once) and returns it. */
  needWorker(): Promise<CaptureWorker>;
  /** Runs before the library is closed (e.g. cancelling a running import on Ctrl+C). */
  beforeClose(fn: () => Promise<void>): void;
  /** Stops the worker, closes the index and releases the library. Safe to call twice. */
  close(): Promise<void>;
}

/** Everything open at the moment, so a SIGINT can close it. */
const open = new Set<Session>();
export const openSessions = (): readonly Session[] => [...open];

export interface OpenSessionOptions {
  library?: string | undefined;
  /** The command writes: a read-only library is refused. */
  write: boolean;
  /** Open for checking only (verify-audit): nothing is repaired, re-anchored or recorded. */
  noHeal?: boolean;
}

export async function openSession(opts: OpenSessionOptions): Promise<Session> {
  const deps = makeDeps();
  const root = await locateLibrary(opts.library, deps);
  rememberRoot(root);
  const lib = await openLibrary(root, deps);
  if (opts.write && lib.mode === "read-only") {
    const reason = readOnlyText(lib.readOnlyReason);
    await lib.close();
    throw new ExitError(`This library is open read-only (${reason}), so nothing can be changed.`, EXIT.failure);
  }
  const ring = new KeyRing();
  let index: IndexHandle | undefined;
  let repo: Repo;
  try {
    index = lib.mode === "read-write" ? new IndexHandle(lib.root) : undefined;
    repo = await openRepo(lib, ring, {
      actor: safeUser(),
      ...(opts.noHeal ? { noHeal: true } : {}),
      ...(index ? { index: createIndexSink(index, { root: lib.root, keyRing: ring }) } : {}),
    });
  } catch (err) {
    index?.close();
    await lib.close();
    throw err;
  }
  let closing: Promise<void> | undefined;
  const hooks: Array<() => Promise<void>> = [];
  const session: Session = {
    deps,
    lib,
    repo,
    ring,
    index,
    async needWorker() {
      session.worker ??= await startCaptureWorker({ repo, index });
      return session.worker;
    },
    beforeClose(fn) {
      hooks.push(fn);
    },
    // One shared promise: the Ctrl+C handler and the command's own `finally` both wait for the
    // same shutdown, so the lock is released before the process exits whichever gets there first.
    close() {
      closing ??= (async () => {
        for (const h of hooks) await h().catch(() => {});
        await session.worker?.stop().catch(() => {});
        // The library's close waits for a change in its store turn (R247 d), which still needs its key and updates the
        // index: both go after it (R551 M7) — the index before the lock is released (its file is in the library).
        await lib
          .close({
            beforeRelease: () => {
              try {
                index?.close();
              } catch {
                // already closed
              }
            },
          })
          .catch(() => {});
        ring.clear();
        open.delete(session); // only once the library is released: a Ctrl+C handler must still see it until then
      })();
      return closing;
    },
  };
  open.add(session);
  return session;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "researcher";
  }
}

/** The project the researcher named (by name, case-insensitive, or by id). */
export function findProject(repo: Repo, ref: string | undefined): Project {
  const projects = repo.listProjects();
  if (!ref) {
    if (projects.length === 1) return projects[0]!;
    throw new ExitError("Say which project with --project <name>.", EXIT.failure, projectHint(projects));
  }
  const folded = ref.trim().toLowerCase();
  const hit = projects.find((p) => p.id === ref) ?? projects.find((p) => p.name.toLowerCase() === folded);
  if (!hit) throw new ExitError(`There is no project called "${ref}" in this library.`, EXIT.failure, projectHint(projects));
  return hit;
}

const projectHint = (projects: Project[]): string =>
  projects.length === 0 ? "This library has no projects yet. Create one with: ao project create <name>" : `Projects here: ${projects.map((p) => p.name).join(", ")}`;

/** Unlocks an encrypted project: AO_PASSPHRASE, or typed (hidden) in a terminal. */
export async function unlockIfNeeded(repo: Repo, project: Project): Promise<void> {
  if (!project.encryption.enabled || repo.isUnlocked(project.id)) return;
  const attempts = isInteractive() && !hasEnvPassphrase() ? 3 : 1;
  for (let i = 0; i < attempts; i++) {
    const pass = await readPassphrase(`Passphrase for project "${project.name}": `, false);
    if (pass === null) {
      throw new ExitError(`The project "${project.name}" is encrypted and needs its passphrase.`, EXIT.failure, "Run in a terminal to be asked, or set the AO_PASSPHRASE environment variable.");
    }
    try {
      await repo.unlockProject(project.id, pass);
      return;
    } catch (err) {
      if (!(err instanceof WrongPassphraseError) || i === attempts - 1) throw err;
      process.stderr.write("That passphrase is not correct. Try again.\n");
    }
  }
}

/** Opens the project the command works on: found, unlocked. */
export async function openProject(s: Session, ref: string | undefined): Promise<Project> {
  const project = findProject(s.repo, ref);
  await unlockIfNeeded(s.repo, project);
  return s.repo.getProject(project.id);
}
