/**
 * Projects: list (also for the browser extension: names and whether browser capture is allowed),
 * create, unlock (pending proxies / OCR resume and watched folders rescan), lock (sensitive lookups
 * purged from the shared HttpClient, R96), backup settings and the one-time acknowledgements.
 */
import type { FastifyInstance } from "fastify";
import { effectivePolicy, parseGovernance, type Project } from "@ao/core";
import { setBackupSettings, type Repo } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optBool, optObj, projectParam, str, strArray, type Ctx } from "./util.js";

async function captureMethods(repo: Repo, projectId: string): Promise<string[]> {
  try {
    return effectivePolicy(parseGovernance(await repo.getGovernanceText(projectId))).policy.captureMethods;
  } catch {
    return []; // unreadable rules allow nothing
  }
}

function projectView(repo: Repo, p: Project) {
  return {
    id: p.id,
    name: p.name,
    folder: p.folder,
    encrypted: p.encryption.enabled,
    unlocked: repo.isUnlocked(p.id),
    ...(p.backups ? { backups: p.backups } : {}),
    ...(p.captureAcknowledgements ? { acknowledgements: Object.keys(p.captureAcknowledgements) } : {}),
  };
}

export function registerProjects(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/projects", async (req) => {
    const s = state.requireSession();
    const projects = s.repo.listProjects();
    if (req.caller === "extension") {
      // The extension sees only what its project picker needs.
      return { projects: await Promise.all(projects.map(async (p) => ({ id: p.id, name: p.name, captureMethods: await captureMethods(s.repo, p.id) }))) };
    }
    return { projects: projects.map((p) => projectView(s.repo, p)) };
  });

  app.post("/projects", async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const name = str(b, "name", 200);
    const governanceYaml = typeof b.governanceYaml === "string" ? b.governanceYaml : "";
    if (governanceYaml.length > 64 * 1024) throw badRequest('"governanceYaml" is too long.');
    const enc = optObj(b, "encryption") ?? { enabled: false };
    const enabled = optBool(enc, "enabled") ?? false;
    const passphrase = enabled ? str(enc, "passphrase", 1024) : undefined;
    const targetLanguages = strArray(b, "targetLanguages", { optional: true, max: 20, itemMax: 35 });
    const { project, recoveryCode } = await s.repo.createProject({
      name,
      governanceYaml,
      encryption: enabled ? { enabled, passphrase: passphrase! } : { enabled: false },
      ...(targetLanguages.length ? { targetLanguages } : {}),
    });
    state.publishState();
    // The recovery code is shown once, here; it is never logged or stored.
    return { project: projectView(s.repo, project), ...(recoveryCode ? { recoveryCode } : {}) };
  });

  app.post("/projects/:id/unlock", async (req) => {
    const s = state.requireSession();
    const id = projectParam(ctx, req);
    const secret = str(bodyOf(req), "secret", 1024);
    await s.repo.unlockProject(id, secret);
    // Work that waited for the key: viewing proxies and OCR of this project, and its daily backup (R99 I7).
    state.resumeProject(s, id);
    state.track(state.runScheduledBackups(id), "backup after unlock");
    state.publishState();
    return { unlocked: true };
  });

  app.post("/projects/:id/lock", async (req) => {
    const s = state.requireSession();
    const id = projectParam(ctx, req);
    s.repo.lockProject(id);
    // Nothing looked up for an encrypted project stays in memory once it is locked (R30, R50).
    s.http.purgeSensitive();
    state.publishState();
    return { unlocked: false };
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

  app.post("/projects/:id/acknowledge", async (req) => {
    const s = state.requireWritable();
    const id = projectParam(ctx, req);
    const kind = str(bodyOf(req), "kind", 32);
    if (kind !== "cookies") throw badRequest('"kind" must be "cookies".');
    const p = await s.repo.acknowledge(id, kind);
    return { acknowledgements: Object.keys(p.captureAcknowledgements ?? {}) };
  });
}
