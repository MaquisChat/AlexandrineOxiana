/**
 * Projects: list (also for the browser extension: names and whether browser capture is allowed),
 * create, unlock (pending proxies / OCR resume and watched folders rescan), lock (sensitive lookups
 * purged from the shared HttpClient, R96), a new recovery code (Task 61), backup settings, a backup
 * now (governed, R125) and the one-time acknowledgements.
 */
import type { FastifyInstance } from "fastify";
import { effectivePolicy, parseGovernance, type Project } from "@ao/core";
import { basename } from "node:path";
import { InvalidRecoveryCodeError, WrongPassphraseError, backupProject, setBackupSettings, type Repo } from "@ao/library";
import type { AcknowledgeRequest, AcknowledgeResponse } from "@ao/shared";
import { ApiError, badRequest } from "../errors.js";
import { bodyAs, bodyOf, optBool, optObj, projectParam, str, strArray, type Ctx } from "./util.js";

async function captureMethods(repo: Repo, projectId: string): Promise<string[]> {
  try {
    return effectivePolicy(parseGovernance(await repo.getGovernanceText(projectId))).policy.captureMethods;
  } catch {
    return []; // unreadable rules allow nothing
  }
}

/** The compliance profiles the project's rules name (badges in the UI); unreadable rules name none. */
async function profilesOf(repo: Repo, projectId: string): Promise<string[]> {
  try {
    return [...parseGovernance(await repo.getGovernanceText(projectId)).profiles];
  } catch {
    return [];
  }
}

async function projectView(repo: Repo, p: Project) {
  return {
    id: p.id,
    name: p.name,
    folder: p.folder,
    encrypted: p.encryption.enabled,
    unlocked: repo.isUnlocked(p.id),
    ...(p.backups ? { backups: p.backups } : {}),
    ...(p.captureAcknowledgements ? { acknowledgements: Object.keys(p.captureAcknowledgements) } : {}),
    profiles: await profilesOf(repo, p.id),
  };
}

/** Wrong passphrases allowed per project within the window before further tries are refused. */
const MAX_WRONG_PASSPHRASES = 5;
const WRONG_PASSPHRASE_WINDOW_MS = 60_000;

/**
 * A modest limit on guessing a project's passphrase (or recovery code) through the service (R141):
 * every attempt is counted BEFORE it is verified, and a project's attempts are verified one at a time
 * (across unlock and the new-recovery-code request), so parallel requests cannot get past it and
 * cannot start a burst of key derivations. After 5 counted wrong attempts within a minute the project
 * answers 429, even to the right passphrase, until the oldest is a minute old. A correct passphrase
 * clears the count; a request refused for another reason (locked, read-only, …) is not counted. In
 * memory only.
 */
class WrongPassphraseLimit {
  private readonly attempts = new Map<string, number[]>();
  /** The last attempt queued per project: the next one waits for it. */
  private readonly turns = new Map<string, Promise<void>>();
  constructor(private readonly now: () => number) {}

  private recent(projectId: string): number[] {
    const cutoff = this.now() - WRONG_PASSPHRASE_WINDOW_MS;
    const list = (this.attempts.get(projectId) ?? []).filter((t) => t > cutoff);
    if (list.length) this.attempts.set(projectId, list);
    else this.attempts.delete(projectId);
    return list;
  }

  /** Runs `fn` in the project's turn unless it is limited; the attempt is counted first and kept only if the passphrase was wrong. */
  async guard<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turns.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.turns.set(projectId, tail);
    await prev;
    try {
      const list = this.recent(projectId);
      if (list.length >= MAX_WRONG_PASSPHRASES) {
        throw new ApiError(429, "RATE_LIMITED", "Too many wrong passphrases for this project. For a minute even the right passphrase is refused: wait a minute, then try again.");
      }
      const at = this.now();
      this.attempts.set(projectId, [...list, at]);
      try {
        const r = await fn();
        this.attempts.delete(projectId);
        return r;
      } catch (err) {
        if (!(err instanceof WrongPassphraseError || err instanceof InvalidRecoveryCodeError)) {
          // Not a guess: take this attempt back.
          const cur = this.attempts.get(projectId);
          const i = cur?.lastIndexOf(at) ?? -1;
          if (cur && i >= 0) cur.splice(i, 1);
        }
        throw err;
      }
    } finally {
      release();
      if (this.turns.get(projectId) === tail) this.turns.delete(projectId);
    }
  }
}

export function registerProjects(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const limit = new WrongPassphraseLimit(() => state.opts.now().getTime());

  app.get("/projects", async (req) => {
    const s = state.requireSession();
    const projects = s.repo.listProjects();
    if (req.caller === "extension") {
      // The extension sees only what its project picker needs.
      return { projects: await Promise.all(projects.map(async (p) => ({ id: p.id, name: p.name, captureMethods: await captureMethods(s.repo, p.id) }))) };
    }
    return { projects: await Promise.all(projects.map((p) => projectView(s.repo, p))) };
  });

  app.post("/projects", async (req, reply) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const name = str(b, "name", 200);
    const governanceYaml = typeof b.governanceYaml === "string" ? b.governanceYaml : "";
    if (governanceYaml.length > 64 * 1024) throw badRequest('"governanceYaml" is too long.');
    const enc = optObj(b, "encryption") ?? { enabled: false };
    const enabled = optBool(enc, "enabled") ?? false;
    const passphrase = enabled ? str(enc, "passphrase", 1024) : undefined;
    const targetLanguages = strArray(b, "targetLanguages", { optional: true, max: 20, itemMax: 35 });
    let created: Awaited<ReturnType<typeof s.repo.createProject>>;
    try {
      created = await s.repo.createProject({
        name,
        governanceYaml,
        encryption: enabled ? { enabled, passphrase: passphrase! } : { enabled: false },
        ...(targetLanguages.length ? { targetLanguages } : {}),
      });
    } finally {
      // Refused or not, the interface is told: a refusal is now in the library's audit log (Task 50).
      state.publishState();
    }
    const { project, recoveryCode } = created;
    // The recovery code is shown once, here; it is never logged or stored (nor cached).
    reply.header("Cache-Control", "no-store");
    return { project: await projectView(s.repo, project), ...(recoveryCode ? { recoveryCode } : {}) };
  });

  app.post("/projects/:id/unlock", async (req) => {
    const s = state.requireSession();
    const id = projectParam(ctx, req);
    const secret = str(bodyOf(req), "secret", 1024);
    await limit.guard(id, () => s.repo.unlockProject(id, secret));
    // Work that waited for the key: viewing proxies, OCR and worker jobs of this project (R142), and its daily backup (R99 I7).
    state.resumeProject(s, id, { workerJobs: true });
    state.resumeFind(s, id); // Find and acquire (Task F5): its queue goes on (the runner waits for the index itself)
    state.startWork("backup", async () => {
      await state.runScheduledBackups(id);
    });
    state.publishState();
    return { unlocked: true };
  });

  app.post("/projects/:id/lock", async (req) => {
    const s = state.requireSession();
    const id = projectParam(ctx, req);
    // Find and acquire (Task F5) stops for an encrypted project BEFORE its key is dropped: nothing more is written.
    if (s.repo.getProject(id).encryption.enabled) state.stopFind(s, id);
    // R379: waits for the change being saved (if any), never lands inside it.
    await s.repo.lockProject(id);
    // Its recordings stop playing: media tickets end with the key (R135 2).
    state.media.revokeProject(id);
    // Nothing looked up for an encrypted project stays in memory once it is locked (R30, R50),
    // nor what it was capturing: its running captures end now, for good (Task 63 I3). A project that
    // is not encrypted has nothing to lock, and its captures run on.
    s.http.purgeSensitive();
    if (s.repo.getProject(id).encryption.enabled) {
      state.endCaptures(id, "lock");
      state.transcriptions.forgetProject(id); // what it was transcribing too (Task 62 R1-2); its journal keeps the run
    }
    state.publishState();
    return { unlocked: false };
  });

  // A new recovery code (Task 61, R134 c): the passphrase again, the new code once in the response.
  // Neither is logged (the logger redacts both names and never logs bodies) nor audited.
  app.post("/projects/:id/recovery-code", async (req, reply) => {
    const s = state.requireWritable();
    const id = projectParam(ctx, req);
    const passphrase = str(bodyOf(req), "passphrase", 1024);
    const { recoveryCode } = await limit.guard(id, () => s.repo.issueRecoveryCode(id, passphrase));
    reply.header("Cache-Control", "no-store");
    return { recoveryCode };
  });

  app.put("/projects/:id/backup-settings", async (req) => {
    const s = state.requireWritable();
    const id = projectParam(ctx, req);
    const b = bodyOf(req);
    const automatic = optBool(b, "automatic");
    const keep = b.keep === undefined ? undefined : Number(b.keep);
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 1 || keep > 1000)) throw badRequest('"keep" must be a whole number from 1 to 1000.');
    const p = await setBackupSettings(s.repo, id, { ...(automatic !== undefined ? { automatic } : {}), ...(keep !== undefined ? { keep } : {}) });
    return { backups: p.backups ?? {} };
  });

  // A backup now (R125): governed and audited by the library; a refusal is 403 POLICY_DENIED with
  // the engine's reason. The answer names the file in the library's Backups folder, never a path.
  app.post("/projects/:id/backups", async (req) => {
    const s = state.requireWritable();
    const id = projectParam(ctx, req);
    try {
      const r = await backupProject(s.repo, id);
      return { backup: { file: basename(r.path), sha256: r.sha256, bytes: r.bytes, pruned: r.pruned, warnings: r.warnings } };
    } finally {
      state.publishState(); // `backup-failed` set or cleared
    }
  });

  app.post("/projects/:id/acknowledge", async (req): Promise<AcknowledgeResponse> => {
    const s = state.requireWritable();
    const id = projectParam(ctx, req);
    const kind = str(bodyAs<AcknowledgeRequest>(req), "kind", 32);
    if (kind !== "cookies") throw badRequest('"kind" must be "cookies".');
    const p = await s.repo.acknowledge(id, kind);
    return { acknowledgements: Object.keys(p.captureAcknowledgements ?? {}) };
  });
}
