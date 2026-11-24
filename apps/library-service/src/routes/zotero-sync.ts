/**
 * Zotero account sync (Task Z8; types and sentences in @ao/shared api/zotero-sync.ts): the routes, and the holder of
 * the one run in progress. A run starts through `POST /zotero/sync/run`, or — only while the researcher has turned
 * automatic sync on — through the scheduler (Task Z10, zotero-sync-scheduler.ts), which the holder starts at a
 * read-write library's activation and which comes through the same door (`start`, trigger "automatic"). The runner is the library's (`syncZoteroLibrary`, Task Z7), which always
 * leaves an honest record in this computer's history; these routes never write to the library themselves.
 *
 * Who may call (R96): the desktop app's token only, on every route, reads included (the extension's token is refused
 * by the server's hook, and again here). The key (R78) never leaves the password store through this code: the key
 * check checks the SAVED key (a key sent in the body is refused, never stored, echoed or logged; storing is
 * `PUT /secrets/zotero-api-key`'s work), and answers what it may read, never the key. Errors are our own sentences:
 * whatever Zotero's servers said goes nowhere but a bounded debug note.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  SecretStoreUnavailableError,
  ZOTERO_SYNC_MAX_BACKOFF_MS,
  ZOTERO_SYNC_MIN_BACKOFF_MS,
  ZOTERO_SYNC_NEWER_SENTENCE,
  ZoteroAccountError,
  ZoteroSyncFileNewerError,
  ZoteroSyncFileBusyError,
  ZoteroSyncFileUnreadableError,
  checkZoteroKey,
  clearZoteroKeyPauses,
  getSecret,
  ocrQueueFor,
  peekLock,
  proxyQueueFor,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  scrubPaths,
  syncZoteroLibrary,
  updateZoteroSyncSettings,
  zoteroHistoryBackoff,
  zoteroSyncBackoff,
  zoteroSyncRunCounts,
  zoteroSyncRunning,
  type BatchHandle,
  type IndexHandle,
  type ZoteroAccountReason,
  type ZoteroKeyAccess as LibraryKeyAccess,
  type ZoteroSyncFileOptions,
  type ZoteroSyncLink,
  type ZoteroSyncReason as LibraryReason,
  type ZoteroSyncRun as LibraryRun,
  type ZoteroSyncSettings,
} from "@ao/library";
import {
  ZOTERO_SYNC_EVERY_MINUTES,
  ZOTERO_SYNC_REASON_TEXT,
  ZOTERO_SYNC_SENTENCES,
  zoteroKeySummary,
  zoteroSyncReasonText,
  zoteroSyncStatusLine,
  type ZoteroKeyAccess,
  type ZoteroKeyCheckResponse,
  type ZoteroSyncEvent,
  type ZoteroSyncHistoryResponse,
  type ZoteroSyncReason,
  type ZoteroSyncRun,
  type ZoteroSyncRunResponse,
  type ZoteroSyncSettingsRequest,
  type ZoteroSyncStateResponse,
  type ZoteroSyncStopResponse,
} from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import type { ServiceState, Session } from "../state.js";
import { ZoteroSyncScheduler } from "../zotero-sync-scheduler.js";
import { bodyOf, type Ctx, type Obj, type Same } from "./util.js";

// The library's types and their declarations in @ao/shared are one and the same (a reason without a sentence, or a
// record field the interface does not know, does not compile).
true satisfies Same<LibraryReason, ZoteroSyncReason>;
true satisfies Same<LibraryRun, ZoteroSyncRun>;
true satisfies Same<Omit<LibraryKeyAccess, "backoffUntil">, ZoteroKeyAccess>;
true satisfies Same<typeof ZOTERO_SYNC_NEWER_SENTENCE, (typeof ZOTERO_SYNC_SENTENCES)["settingsNewer"]>;

const REF = /^(user|group):[1-9]\d{0,11}$/u;
const STRUCTURES = ["collections", "tags", "none"] as const;
const DUPLICATES = ["merge", "skip", "keep-both"] as const;
/** At most one `running` event per second (real time, whatever the service's clock says). */
const PROGRESS_EVERY_MS = 1000;
/** How long stop and close wait for the run to reach a safe point (the batch's own suspend timeout is the same). */
const STOP_WAIT_MS = 60_000;
/** The answers to Zotero's refusals of a key check. */
const ACCOUNT: Record<ZoteroAccountReason, { status: number; code: "CONFLICT" | "UNAVAILABLE"; reason: ZoteroSyncReason }> = {
  "no-key": { status: 409, code: "CONFLICT", reason: "key-missing" },
  "no-store": { status: 503, code: "UNAVAILABLE", reason: "no-store" },
  "key-refused": { status: 409, code: "CONFLICT", reason: "key-refused" },
  "library-gone": { status: 409, code: "CONFLICT", reason: "library-gone" },
  offline: { status: 503, code: "UNAVAILABLE", reason: "offline" },
  "backing-off": { status: 409, code: "CONFLICT", reason: "backing-off" },
};

interface CurrentRun {
  session: Session;
  ac: AbortController;
  ref: string;
  projectId: string;
  done: number;
  total: number;
  /** Events of this run may still be published (false once the library closed under it). */
  live: boolean;
  /** Settles when every link of the run has ended (never rejects). */
  ended: Promise<void>;
  /** The record of the link that ended last. */
  last?: ZoteroSyncRun;
}

/**
 * The one sync in progress in this service, its abort, and the back-off Zotero asked for (Task Z8, point 4). It lives
 * in the service's state (`state.zoteroSync`); closing or switching the library, a move and the shutdown call `stop`
 * BEFORE the running batches are suspended and the library's lock is released, so the run ends with its record
 * ("stopped", "library-closed"; "app-closed" at the app's shutdown) and writes nothing after.
 */
export class ZoteroSyncHolder {
  private current: CurrentRun | undefined;
  /** The latest moment Zotero asked this app to wait until (ms), as kept by the last record or key check. */
  private backoffUntil: number | undefined;
  /**
   * R250 a: the ONE place that says which Zotero libraries (canonical ref, `user:42`) are being read by an import or a
   * sync in the open library, whatever the project. Taken in the same synchronous step as its check (claim), given up
   * when its batch or run has ended. A claim of another session (a library since closed, switched or moved) counts
   * for nothing and is replaced.
   */
  private readonly claims = new Map<string, { session: Session; token: object }>();
  /** The batches the sync runs now (R250 k: not paused or resumed through the import routes). */
  private readonly syncBatches = new Set<string>();
  /** The runner (a test seam). */
  runner: typeof syncZoteroLibrary = syncZoteroLibrary;

  /**
   * Claims the Zotero library `ref` for one import or sync of the session's library: the function that gives it up,
   * or undefined when it is taken. Synchronous: no wait comes between the check and the claim.
   */
  claim(given: string, session: Session): (() => void) | undefined {
    const ref = canonical(given);
    if (this.taken(ref, session)) return undefined;
    const token = {};
    this.claims.set(ref, { session, token });
    return () => {
      if (this.claims.get(ref)?.token === token) this.claims.delete(ref);
    };
  }

  /** Whether the Zotero library `ref` is claimed now by an import or a sync of the session's library (nothing is claimed). */
  taken(ref: string, session: Session): boolean {
    return this.claims.get(canonical(ref))?.session === session;
  }

  /** Whether the batch is one the sync runs now. */
  ownsBatch(batchId: string): boolean {
    return this.syncBatches.has(batchId);
  }

  /** The run in progress: which link, and how far. */
  get running(): { ref: string; projectId: string; done: number; total: number } | undefined {
    const c = this.current;
    return c ? { ref: c.ref, projectId: c.projectId, done: c.done, total: c.total } : undefined;
  }

  /** Settles when no run is in progress (tests). */
  async idle(): Promise<void> {
    while (this.current) await this.current.ended;
  }

  /** The back-off in force at `now` (ms): the later of the kept one and `fromHistory`, by the runner's clock rule. */
  backoffInForce(now: number, fromHistory?: number): number | undefined {
    const kept = Math.max(this.backoffUntil ?? -Infinity, fromHistory ?? -Infinity);
    return zoteroSyncBackoff(Number.isFinite(kept) ? kept : undefined, now);
  }

  /** Zotero asked to wait (a key check): no run before the later of now + an hour and its time, at most a day (as the runner keeps it). */
  noteAsked(until: number, now: number): void {
    const kept = Math.min(Math.max(until, now + ZOTERO_SYNC_MIN_BACKOFF_MS), now + ZOTERO_SYNC_MAX_BACKOFF_MS);
    this.backoffUntil = Math.max(this.backoffUntil ?? 0, kept);
  }

  /**
   * Runs `links` one after another, never two at once, in the background. The caller has checked that none runs now.
   * A run that stops, a refused key and a back-off now in force end the rest (they would only be refused).
   * `trigger` is the record's: "automatic" for the scheduler's runs (Z10), which come through this same door.
   * Settles, once every link has ended, with the record of the link that ended last.
   */
  start(state: ServiceState, s: Session & { index: IndexHandle }, links: ZoteroSyncLink[], backoffUntil: number | undefined, trigger: "manual" | "automatic" = "manual"): Promise<ZoteroSyncRun | undefined> {
    const now = () => state.opts.now().getTime();
    if (backoffUntil !== undefined) this.backoffUntil = Math.max(this.backoffUntil ?? 0, backoffUntil);
    let resolveEnded!: () => void;
    const cur: CurrentRun = { session: s, ac: new AbortController(), ref: links[0]!.ref, projectId: links[0]!.projectId, done: 0, total: 0, live: true, ended: new Promise<void>((r) => (resolveEnded = r)) };
    this.current = cur;
    // Published until the close that stopped the run has its record (the "finished" of a run the close stopped is
    // published during the close, before the lock goes); nothing after.
    const publish = (e: ZoteroSyncEvent) => {
      if (cur.live) state.events.publish("zotero.sync", e as unknown as Record<string, unknown>);
    };
    const loop = async () => {
      for (const link of links) {
        if (cur.ac.signal.aborted || state.session !== s) break;
        cur.ref = link.ref;
        cur.projectId = link.projectId;
        cur.done = 0;
        cur.total = 0;
        let linkEnded = false;
        let lastProgress = -Infinity;
        publish({ ref: link.ref, projectId: link.projectId, state: "checking" });
        const at = new Date(now()).toISOString();
        const failed = (reason: ZoteroSyncReason): ZoteroSyncRun => ({ id: randomUUID(), ref: link.ref, projectId: link.projectId, trigger, startedAt: at, finishedAt: at, outcome: "failed", reason });
        // R250 a: this Zotero library, claimed before anything is awaited. Taken by an import, the runner itself refuses
        // the link with its own `import-running` record, before any request (R252: `taken`).
        const release = this.claim(link.ref, s);
        const follow = (projectId: string, h: BatchHandle) => {
          // In the service's batch registry too: GET /jobs lists it, and a close suspends it if all else failed.
          s.batches.set(h.batchId, { projectId, handle: h });
          this.syncBatches.add(h.batchId);
          state.track(
            (async () => {
              try {
                for await (const p of h.progress) {
                  cur.done = p.done;
                  cur.total = p.total ?? 0; // 0: not known yet (the sync's own shape; R392: never a guess)
                  const t = performance.now();
                  if (linkEnded || t - lastProgress < PROGRESS_EVERY_MS) continue;
                  lastProgress = t;
                  publish({ ref: link.ref, projectId: link.projectId, state: "running", done: p.done, total: p.total });
                }
                await h.done.catch(() => undefined);
              } finally {
                if (s.batches.get(h.batchId)?.handle === h) s.batches.delete(h.batchId);
              }
            })(),
            "zotero sync",
          );
        };
        // R250 j: whatever throws, the link's run ends with a "finished" event: the runner's record when it returned one
        // (without counts if they could not be read), else a failed record with the reason "error".
        let run: LibraryRun | undefined;
        try {
          run = await this.runner(
          {
            repo: s.repo,
            http: s.http,
            index: s.index,
            proxies: proxyQueueFor(s.repo),
            queueOcr: async (p, ids) => {
              await ocrQueueFor(s.repo).enqueueMany(p, ids);
            },
            appConfigDir: state.deps.appConfigDir,
            libraryId: s.lib.id,
            onBatch: follow,
            taken: () => !release,
            now,
            // A bounded note at most (the runner's notes name no key, no title and no server text).
            debug: (note) => state.opts.log.info({ note: scrubPaths(String(note), state.roots).slice(0, 300) }, "zotero sync"),
          },
          link,
          { trigger, signal: cur.ac.signal, ...(this.backoffUntil !== undefined ? { backoffUntil: this.backoffUntil } : {}) },
          );
        } catch (err) {
          state.opts.log.info({ note: err instanceof Error ? err.name : "error" }, "zotero sync: the run stopped on an unexpected error");
        } finally {
          release?.();
        }
        let shown: ZoteroSyncRun;
        if (run) {
          // The runner's record carries the back-off actually in force: kept in place of ours.
          if (run.backoffUntil !== undefined) this.backoffUntil = Date.parse(run.backoffUntil);
          // The batch leaves the registry with the run (a stopped run's batch is paused on disk, resumed by the next run).
          if (run.batchId) {
            this.syncBatches.delete(run.batchId);
            if (s.batches.get(run.batchId)) s.batches.delete(run.batchId);
          }
          const { counts: _c, recordSaved: _r, ...bare } = run;
          shown = await withCounts(s, run).catch(() => bare);
        } else shown = failed("error");
        cur.last = shown;
        linkEnded = true;
        publish({ ref: link.ref, projectId: link.projectId, state: "finished", run: shown });
        if (shown.outcome === "stopped" || shown.reason === "key-refused" || this.backoffInForce(now()) !== undefined) break;
      }
    };
    state.track(
      loop().finally(() => {
        if (this.current === cur) this.current = undefined;
        resolveEnded();
      }),
      "zotero sync",
    );
    return cur.ended.then(() => cur.last);
  }

  // ---- the scheduler of automatic runs (Task Z10, R274) ----------------------------------------------------------

  /** The scheduler (one for the service; started at a read-write library's activation, stopped before every close). */
  scheduler: ZoteroSyncScheduler | undefined;

  /**
   * Starts the scheduler for the open library `s` (at `activate`): its first run comes no sooner than 2 minutes from
   * now. Never for a read-only library (nothing could become due). It reads the settings and the records afresh at each
   * pass (through the library's own reader, which says itself when a file is newer, R269 c), never the key, and starts
   * a run only through `start` with the trigger "automatic", in the same synchronous step as its check that nothing
   * holds the link back (`obstacleTo`): so the claim of R250 is taken before anything is awaited, as for a manual run.
   */
  startScheduler(state: ServiceState, s: Session): void {
    if (s.lib.mode !== "read-write" || !s.index) return;
    const now = () => state.opts.now().getTime();
    const open = () => (state.session === s ? s : undefined);
    this.scheduler ??= new ZoteroSyncScheduler({
      now: () => state.opts.now(),
      ...(state.opts.zoteroTickMs !== undefined ? { tickMs: state.opts.zoteroTickMs } : {}),
      settings: async () => {
        const o = state.session;
        if (!o) return undefined;
        let newer = false;
        const settings = await readZoteroSyncSettings(state.deps.appConfigDir, o.lib.id, { onNewer: () => (newer = true) });
        return newer ? undefined : settings;
      },
      history: async () => {
        const o = state.session;
        if (!o) return undefined;
        // R276 d: records written by a newer version (the module says so itself) stop scheduling, as newer settings do.
        let newer = false;
        const runs = await readZoteroSyncHistory(state.deps.appConfigDir, o.lib.id, { onNewer: () => (newer = true) });
        return newer ? undefined : runs;
      },
      obstacle: (link) => this.obstacleTo(state, link),
      backoffUntil: (history) => this.backoffInForce(now(), zoteroHistoryBackoff(history)),
      run: (link) => {
        const o = state.session;
        if (!o?.index || o.lib.mode !== "read-write") return Promise.reject(new Error("no library is open"));
        return this.start(state, o as Session & { index: IndexHandle }, [link], undefined, "automatic").then((r) => r ?? Promise.reject(new Error("no record")));
      },
      debug: (note) => state.opts.log.info({ note }, "zotero sync"),
    });
    if (open()) this.scheduler.start();
  }

  /** Stops the scheduler (close, switch, before a move, shutdown; awaited BEFORE `stop`): no timer left, nothing started after. */
  async stopScheduler(): Promise<void> {
    await this.scheduler?.stop();
  }

  /**
   * Why the scheduler may not start `link` now (R274 a: then nothing is started and nothing recorded): "busy" while a
   * run is going or its Zotero library is claimed by an import; "held" while the library is not open read-write (or is
   * being moved or closed), the link's project is gone or locked. A paused link and a back-off the scheduler sees itself.
   */
  obstacleTo(state: ServiceState, link: ZoteroSyncLink): "busy" | "held" | undefined {
    const s = state.session;
    if (!s?.index || s.lib.mode !== "read-write" || state.startsHeld || state.shuttingDown) return "held";
    try {
      s.repo.getProject(link.projectId);
    } catch {
      return "held";
    }
    if (lockedNow(s, link.projectId)) return "held";
    if (this.current || zoteroSyncRunning(s.lib.id, link.ref) || this.taken(link.ref, s)) return "busy";
    return undefined;
  }

  /**
   * Stops the run in progress (its batch is suspended at its next safe point, resumable by the next run) and waits for
   * its record, at most STOP_WAIT_MS. `library-closed` (close, switch, move) and `app-closed` (the app's shutdown) also
   * end its events: none after.
   * Returns the record of the link that ended last, or undefined when no run was in progress.
   */
  async stop(reason: "stopped-by-you" | "library-closed" | "app-closed"): Promise<{ last?: ZoteroSyncRun } | undefined> {
    const cur = this.current;
    if (!cur) return undefined;
    cur.ac.abort(reason);
    await withTimeout(cur.ended, STOP_WAIT_MS);
    if (reason !== "stopped-by-you") cur.live = false;
    return cur.last ? { last: cur.last } : {};
  }
}

/** Canonical: `user:042` and `user:42` are one library (a stored ref may be older than the canonical form). */
function canonical(ref: string): string {
  return ref.replace(/^(user|group):0*(\d+)$/u, (_m, type: string, id: string) => `${type}:${id}`);
}

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    void p.finally(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Whether the project is encrypted and locked now. */
function lockedNow(s: Session, projectId: string): boolean {
  try {
    return s.repo.getProject(projectId).encryption.enabled && !s.repo.isUnlocked(projectId);
  } catch {
    return false;
  }
}
function encrypted(s: Session, projectId: string): boolean {
  try {
    return s.repo.getProject(projectId).encryption.enabled;
  } catch {
    return false;
  }
}

/** A record as the interface is given it: an encrypted project's counts read from its batch while it is unlocked (never from this computer's file). */
async function withCounts(s: Session, run: LibraryRun, read = true): Promise<ZoteroSyncRun> {
  const { recordSaved: _r, ...rec } = run;
  if (!encrypted(s, run.projectId)) return rec;
  const { counts: _c, ...rest } = rec;
  if (!read || !run.batchId || lockedNow(s, run.projectId)) return rest;
  const counts = await zoteroSyncRunCounts(s.repo, run.projectId, run.batchId);
  return counts ? { ...rest, counts } : rest;
}

/** This computer's sync files, refused in our words (never a path). */
function fileError(err: unknown): unknown {
  if (err instanceof ZoteroSyncFileNewerError) return new ApiError(409, "CONFLICT", err.message);
  // R306 b: another program held the file's lock for the whole wait — a passing condition, said as one (409, as for a
  // run already going), in the lock's own sentence; nothing was written.
  if (err instanceof ZoteroSyncFileBusyError) return new ApiError(409, "CONFLICT", err.message, "settings-busy");
  if (err instanceof ZoteroSyncFileUnreadableError) return new ApiError(503, "UNAVAILABLE", ZOTERO_SYNC_SENTENCES.settingsUnreadable);
  return err;
}

async function readSettings(dir: string, libraryId: string, o: ZoteroSyncFileOptions = {}): Promise<ZoteroSyncSettings> {
  try {
    return await readZoteroSyncSettings(dir, libraryId, o);
  } catch (err) {
    throw fileError(err);
  }
}
/** The record of the run in progress: the newest unfinished one of its ref (an older one was left by an earlier process). */
function inProgressId(runs: LibraryRun[], ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return runs.filter((r) => r.finishedAt === undefined && r.ref === ref).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id;
}
async function readHistory(dir: string, libraryId: string, o: ZoteroSyncFileOptions & { heldElsewhereSince?: string } = {}): Promise<LibraryRun[]> {
  try {
    return await readZoteroSyncHistory(dir, libraryId, o);
  } catch (err) {
    throw fileError(err);
  }
}

/** Whether a key is saved (the value dropped at once); null when the password store cannot be asked. */
async function keyStored(): Promise<boolean | null> {
  try {
    let k: string | null = await getSecret("zotero-api-key");
    const has = k !== null;
    k = null;
    return has;
  } catch (err) {
    if (err instanceof SecretStoreUnavailableError) return null;
    throw err;
  }
}

/** The settings request, checked strictly: every refusal names its field (Accept 3). */
function settingsRequest(b: Obj, s: Session, stored: ZoteroSyncSettings): ZoteroSyncSettingsRequest {
  for (const k of Object.keys(b)) if (!["automatic", "everyMinutes", "links"].includes(k)) throw badRequest(`"${k}" cannot be sent here.`);
  if (typeof b.automatic !== "boolean") throw badRequest('"automatic" must be true or false.');
  if (!(ZOTERO_SYNC_EVERY_MINUTES as readonly unknown[]).includes(b.everyMinutes)) throw badRequest('"everyMinutes" must be 30, 60 or 240.');
  if (!Array.isArray(b.links)) throw badRequest('"links" must be a list.');
  if (b.links.length > 20) throw badRequest('"links": at most 20 Zotero libraries can be linked.');
  const refs = new Set<string>();
  const links = b.links.map((l: unknown, i: number) => {
    const f = (name: string) => `"links[${i}].${name}"`;
    if (!l || typeof l !== "object" || Array.isArray(l)) throw badRequest(`"links[${i}]" must be an object.`);
    const o = l as Obj;
    for (const k of Object.keys(o)) if (!["ref", "projectId", "structure", "duplicates", "resume"].includes(k)) throw badRequest(`${f(k)} cannot be sent here.`);
    if (typeof o.ref !== "string" || !REF.test(o.ref)) throw badRequest(`${f("ref")} must be user:<number> or group:<number>.`);
    if (refs.has(o.ref)) throw badRequest(`${f("ref")}: each Zotero library can be linked to one project only.`);
    refs.add(o.ref);
    if (typeof o.projectId !== "string" || !s.repo.listProjects().some((p) => p.id === o.projectId)) throw badRequest(`${f("projectId")} is not a project in this library.`);
    // A link already saved may stay while its project is locked; a new one cannot be made into a locked project.
    const kept = stored.links.some((x) => x.ref === o.ref && x.projectId === o.projectId);
    if (!kept && lockedNow(s, o.projectId)) throw badRequest(`${f("projectId")}: the project is locked. Unlock it first.`);
    if (!(STRUCTURES as readonly unknown[]).includes(o.structure)) throw badRequest(`${f("structure")} must be collections, tags or none.`);
    if (!(DUPLICATES as readonly unknown[]).includes(o.duplicates)) throw badRequest(`${f("duplicates")} must be merge, skip or keep-both.`);
    // R265 (D26): only `true`, and only for the link it names, turns syncing on again after an undo.
    if ("resume" in o && o.resume !== true) throw badRequest(`${f("resume")} must be true, or left out.`);
    return { ref: o.ref, projectId: o.projectId, structure: o.structure as (typeof STRUCTURES)[number], duplicates: o.duplicates as (typeof DUPLICATES)[number], ...(o.resume === true ? { resume: true as const } : {}) };
  });
  return { automatic: b.automatic, everyMinutes: b.everyMinutes as ZoteroSyncSettingsRequest["everyMinutes"], links };
}

export function registerZoteroSync(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const holder = state.zoteroSync;
  const uiOnly = (caller: string | undefined) => {
    if (caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
  };
  const now = () => state.opts.now();
  const dir = () => state.deps.appConfigDir;

  /** The state, built from this computer's settings and history at request time (point 8). */
  /**
   * R474 M8: when another live process of this computer holds the library (the command line, another copy of the app),
   * the time it opened it: only that process can be running a sync of it, so a record with no end started since is
   * running there. Undefined when this service holds it, or the holder is on another computer or gone.
   */
  async function heldElsewhereSince(s: Session): Promise<string | undefined> {
    if (s.lib.mode !== "read-only") return undefined;
    const holder = await peekLock(s.lib.root, state.deps).catch(() => null);
    return holder && holder.deviceId === state.deps.deviceId && holder.hostname === state.deps.hostname ? holder.openedAt : undefined;
  }

  async function stateOf(s: Session): Promise<ZoteroSyncStateResponse> {
    // R268 M4, R269 c: whether the settings were written by a newer version is said by the library module itself.
    let newer = false;
    let historyNewer = false;
    const since = await heldElsewhereSince(s);
    const [settings, history, stored] = await Promise.all([
      readSettings(dir(), s.lib.id, { onNewer: () => (newer = true) }),
      readHistory(dir(), s.lib.id, { onNewer: () => (historyNewer = true), ...(since !== undefined ? { heldElsewhereSince: since } : {}) }),
      keyStored(),
    ]);
    const running = holder.running;
    const current = inProgressId(history, running?.ref);
    const links: ZoteroSyncStateResponse["links"] = [];
    for (const l of settings.links) {
      // The record of the run going on now is not the last run.
      const last = history.find((r) => r.ref === l.ref && r.projectId === l.projectId && r.id !== current);
      const lastRun = last ? await withCounts(s, last) : undefined;
      const waitingFor = l.paused ? ("paused" as const) : lockedNow(s, l.projectId) ? ("project-locked" as const) : undefined;
      links.push({
        ref: l.ref,
        projectId: l.projectId,
        structure: l.options.structure,
        duplicates: l.options.duplicates,
        ...(l.paused ? { paused: l.paused } : {}),
        fullDone: l.fullDone,
        status: zoteroSyncStatusLine(lastRun, now()),
        ...(lastRun ? { lastRun } : {}),
        ...(waitingFor ? { waitingFor } : {}),
      });
    }
    const backoff = holder.backoffInForce(now().getTime(), zoteroHistoryBackoff(history));
    // R274 c: when the scheduler would next start a run, from these same settings and records ("not before").
    // Settings or records written by a newer version: nothing is scheduled (R269 c, R276 d).
    const next = holder.scheduler?.nextRunAt({ settings: newer || historyNewer ? undefined : settings, history });
    return {
      readOnly: s.lib.mode === "read-only",
      settingsNewer: newer,
      keyStored: stored,
      automatic: settings.automatic,
      everyMinutes: settings.everyMinutes,
      links,
      ...(running ? { running: { ref: running.ref, done: running.done, total: running.total } } : {}),
      ...(backoff !== undefined ? { backoffUntil: new Date(backoff).toISOString() } : {}),
      ...(next ? { nextRunAt: next.toISOString() } : {}),
    };
  }

  async function clearRefusals(s: Session, a: LibraryKeyAccess): Promise<void> {
    try {
      await clearZoteroKeyPauses(dir(), s.lib.id, a);
    } catch (err) {
      // A settings file of a newer version, or one that cannot be read: left as it is; the check's answer stands.
      state.opts.log.info({ note: err instanceof Error ? err.name : "error" }, "zotero key check: the pauses could not be cleared");
    }
  }

  const backingOff = (until: number) => new ApiError(409, "CONFLICT", zoteroSyncReasonText("backing-off", now(), new Date(until).toISOString()), "backing-off");

  // ---- what the saved key may read ----
  app.post("/zotero/key-check", async (req): Promise<ZoteroKeyCheckResponse> => {
    uiOnly(req.caller);
    const b = bodyOf(req);
    // A key is never taken here (R78): storing it is the secrets route's work. Neither echoed nor logged.
    if (Object.keys(b).length) throw badRequest(ZOTERO_SYNC_SENTENCES.keyNotChecked);
    const s = state.session;
    const fromHistory = s ? zoteroHistoryBackoff(await readHistory(dir(), s.lib.id).catch(() => [])) : undefined;
    const wait = holder.backoffInForce(now().getTime(), fromHistory);
    // No request of any kind inside a back-off (Global Constraints).
    if (wait !== undefined) throw backingOff(wait);
    let access: LibraryKeyAccess;
    try {
      access = await checkZoteroKey();
    } catch (err) {
      if (!(err instanceof ZoteroAccountError)) {
        state.opts.log.info({ note: err instanceof Error ? err.name : "error" }, "zotero key check");
        throw new ApiError(500, "INTERNAL", "The key could not be checked. Try again in a moment.");
      }
      if (err.backoffUntil !== undefined) holder.noteAsked(err.backoffUntil, now().getTime());
      const a = ACCOUNT[err.reason];
      const message = a.reason === "backing-off" ? zoteroSyncReasonText("backing-off", now(), err.backoffUntil !== undefined ? new Date(err.backoffUntil).toISOString() : undefined) : ZOTERO_SYNC_REASON_TEXT[a.reason];
      throw new ApiError(a.status, a.code, message, a.reason);
    }
    if (access.backoffUntil !== undefined) holder.noteAsked(access.backoffUntil, now().getTime());
    // R248: a key that works again clears the pauses Zotero's refusals set, for every link of the open library at once
    // (one settings write): `key-refused` everywhere, `library-gone` where the key now reads the library. A failed
    // check (above) clears nothing; `undone` is the researcher's own: only a settings save that names the link with `resume: true` clears it (R265).
    const open = state.session;
    if (open && open.lib.mode === "read-write") await clearRefusals(open, access);
    const out: ZoteroKeyAccess = {
      userId: access.userId,
      personal: { library: access.personal.library, files: access.personal.files, notes: access.personal.notes, write: access.personal.write },
      groups: access.groups.map((g) => ({ ref: g.ref, name: g.name, write: g.write })),
    };
    return { ...out, summary: zoteroKeySummary(out) };
  });

  app.get("/zotero/sync", async (req): Promise<ZoteroSyncStateResponse> => {
    uiOnly(req.caller);
    return stateOf(state.requireSession());
  });

  app.put("/zotero/sync/settings", async (req): Promise<ZoteroSyncStateResponse> => {
    uiOnly(req.caller);
    const s = state.requireWritable();
    const stored = await readSettings(dir(), s.lib.id);
    const r = settingsRequest(bodyOf(req), s, stored);
    try {
      // Only this computer's file, in the runner's serialised turn.
      await updateZoteroSyncSettings(dir(), s.lib.id, (cur) => ({
        automatic: r.automatic,
        everyMinutes: r.everyMinutes,
        links: r.links.map((l) => {
          const was = cur.links.find((x) => x.ref === l.ref && x.projectId === l.projectId);
          // A pause belongs to the Zotero library while it stays linked, whatever else the save changes (its project
          // included). R265 (D26): `undone` is cleared only for a link the request names with `resume: true`;
          // `key-refused` and `library-gone` only by a successful key check (R248), never by a save.
          const paused = cur.links.find((x) => x.ref === l.ref)?.paused;
          const keep = paused && !(paused === "undone" && l.resume) ? paused : undefined;
          return { ref: l.ref, projectId: l.projectId, fullDone: was?.fullDone ?? false, options: { structure: l.structure, duplicates: l.duplicates }, ...(keep ? { paused: keep } : {}) };
        }),
      }));
    } catch (err) {
      throw fileError(err);
    }
    return stateOf(s);
  });

  app.post("/zotero/sync/run", async (req, reply): Promise<ZoteroSyncRunResponse> => {
    uiOnly(req.caller);
    const s = state.requireWritable();
    const b = bodyOf(req);
    for (const k of Object.keys(b)) if (k !== "ref") throw badRequest(`"${k}" cannot be sent here.`);
    if (b.ref !== undefined && (typeof b.ref !== "string" || !REF.test(b.ref))) throw badRequest('"ref" must be user:<number> or group:<number>.');
    if (holder.running) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.alreadyRunning);
    const [settings, history] = await Promise.all([readSettings(dir(), s.lib.id), readHistory(dir(), s.lib.id)]);
    const fromHistory = zoteroHistoryBackoff(history);
    const wait = holder.backoffInForce(now().getTime(), fromHistory);
    if (wait !== undefined) throw backingOff(wait);
    let links: ZoteroSyncLink[];
    if (typeof b.ref === "string") {
      const l = settings.links.find((x) => x.ref === b.ref);
      if (!l) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.notLinked);
      // A paused link asked for by name is run: the runner refuses it with its own record.
      links = [l];
    } else {
      if (!settings.links.length) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.nothingLinked);
      links = settings.links.filter((l) => !l.paused);
      if (!links.length) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.allPaused);
    }
    // Checked again right before it starts: another request may have started one while the files were read.
    if (holder.running) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.alreadyRunning);
    void holder.start(state, s, links, fromHistory);
    void reply.status(202);
    return { started: true };
  });

  app.post("/zotero/sync/stop", async (req): Promise<ZoteroSyncStopResponse> => {
    uiOnly(req.caller);
    state.requireWritable();
    const r = await holder.stop("stopped-by-you");
    if (!r) throw new ApiError(409, "CONFLICT", ZOTERO_SYNC_SENTENCES.notRunning);
    return { stopped: true, ...(r.last ? { run: r.last } : {}) };
  });

  app.get("/zotero/sync/history", async (req): Promise<ZoteroSyncHistoryResponse> => {
    uiOnly(req.caller);
    const s = state.requireSession();
    // R250 b: the run in progress is left out (the state's `running` and the events say it).
    const since = await heldElsewhereSince(s);
    const all = await readHistory(dir(), s.lib.id, since !== undefined ? { heldElsewhereSince: since } : {});
    const current = inProgressId(all, holder.running?.ref);
    const runs = all.filter((r) => r.id !== current);
    // An encrypted project's counts come from its batch while it is unlocked: for the newest 20 (what the screen shows).
    const out: ZoteroSyncRun[] = [];
    for (const [i, r] of runs.entries()) out.push(await withCounts(s, r, i < 20));
    return { runs: out };
  });
}
