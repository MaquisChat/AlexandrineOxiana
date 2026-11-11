/**
 * Fieldwork (spec 3.6): participants, sessions and consent records — listed, created, changed and
 * (participants and sessions, only when nothing links to them) deleted through the governed
 * repository (R97, R117). Participant codes never change. Consent records are never deleted: a consent is withdrawn instead, which is
 * audited and queues the participant's sources for review (nothing is deleted). A dropped consent
 * form is stored as an identifiable source linked to the participant.
 */
import type { FastifyInstance } from "fastify";
import { attachConsentDocument, proxyQueueFor, type ConsentInput, type ConsentPatch, type ParticipantInput, type ParticipantPatch, type SessionInput, type SessionPatch } from "@ao/library";
import { ApiError, badRequest, notFound } from "../errors.js";
import { bodyOf, optObj, optStr, paramsOf, projectParam, str, strArray, type Ctx, type Obj } from "./util.js";

/** A text value that may be `null` (to clear it); undefined when absent. */
function nullableStr(o: Obj, key: string, max: number): string | null | undefined {
  return o[key] === null ? null : optStr(o, key, max);
}

function detailsOf(details: Obj): Record<string, string> {
  return Object.fromEntries(Object.entries(details).map(([k, v]) => [k.slice(0, 200), String(v).slice(0, 4000)]));
}

const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

type Kind = "participants" | "sessions" | "consents";

export function registerFieldwork(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  for (const kind of ["participants", "sessions", "consents"] as Kind[]) {
    app.get(`/projects/:id/${kind}`, async (req) => {
      const s = state.requireSession();
      const projectId = projectParam(ctx, req);
      const fw = await s.repo.getFieldwork(projectId);
      return { [kind]: fw[kind], complete: fw.complete };
    });
    app.get(`/projects/:id/${kind}/:fid`, async (req) => {
      const s = state.requireSession();
      const projectId = projectParam(ctx, req);
      const hit = (await s.repo.getFieldwork(projectId))[kind].find((x) => x.id === paramsOf(req).fid);
      if (!hit) throw notFound("That record");
      return hit;
    });
  }

  app.patch("/projects/:id/participants/:fid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const details = b.details === null ? null : optObj(b, "details");
    const patch: ParticipantPatch = {
      ...(optStr(b, "code", 64) !== undefined ? { code: optStr(b, "code", 64)! } : {}),
      ...(details !== undefined ? { details: details === null ? null : detailsOf(details) } : {}),
      ...(optStr(b, "legalBasis", 2000) ? { legalBasis: optStr(b, "legalBasis", 2000)! } : {}),
    };
    return s.repo.updateParticipant(projectId, paramsOf(req).fid ?? "", patch);
  });

  app.patch("/projects/:id/sessions/:fid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const place = nullableStr(b, "place", 500);
    const notes = nullableStr(b, "notes", 20_000);
    const patch: SessionPatch = {
      ...(optStr(b, "date", 40) !== undefined ? { date: optStr(b, "date", 40)! } : {}),
      ...(place !== undefined ? { place } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(b.participantIds !== undefined ? { participantIds: strArray(b, "participantIds", { max: 1000, itemMax: 64 }) } : {}),
      ...(optStr(b, "legalBasis", 2000) ? { legalBasis: optStr(b, "legalBasis", 2000)! } : {}),
    };
    return s.repo.updateSession(projectId, paramsOf(req).fid ?? "", patch);
  });

  app.patch("/projects/:id/consents/:fid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const expires = nullableStr(b, "expires", 40);
    // The document is set only by attaching the signed form (POST …/document); it can only be detached here, with a reason (R117 I3).
    if (b.documentAssetId !== undefined && b.documentAssetId !== null) throw badRequest("A consent record's document is set by attaching the signed form, not by editing the record.");
    const detachReason = optStr(b, "detachReason", 2000);
    const patch: ConsentPatch = {
      ...(optStr(b, "scope", 2000) !== undefined ? { scope: optStr(b, "scope", 2000)! } : {}),
      ...(optStr(b, "date", 40) !== undefined ? { date: optStr(b, "date", 40)! } : {}),
      ...(expires !== undefined ? { expires } : {}),
      ...(b.documentAssetId === null ? { documentAssetId: null } : {}),
      ...(detachReason ? { detachReason } : {}),
    };
    return s.repo.updateConsent(projectId, paramsOf(req).fid ?? "", patch);
  });

  app.post("/projects/:id/consents/:fid/withdraw", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const reason = optStr(bodyOf(req), "reason", 2000);
    return s.repo.withdrawConsent(projectId, paramsOf(req).fid ?? "", reason ? { reason } : {});
  });

  // A consent form dropped onto the record (an absolute path the researcher chose).
  app.post("/projects/:id/consents/:fid/document", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const path = str(b, "path", 4096);
    if (!isAbsolute(path) || path.includes("\0")) throw badRequest('"path" must be an absolute path.');
    const legalBasis = optStr(b, "legalBasis", 2000);
    return attachConsentDocument(s.repo, projectId, paramsOf(req).fid ?? "", path, { proxies: proxyQueueFor(s.repo), ...(legalBasis ? { legalBasis } : {}) });
  });

  app.delete("/projects/:id/participants/:fid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    await s.repo.deleteParticipant(projectId, paramsOf(req).fid ?? "");
    return { deleted: true };
  });

  app.delete("/projects/:id/sessions/:fid", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    await s.repo.deleteSession(projectId, paramsOf(req).fid ?? "");
    return { deleted: true };
  });

  app.delete("/projects/:id/consents/:fid", async () => {
    throw new ApiError(405, "VALIDATION", "Consent records are kept as evidence. Withdraw the consent instead.");
  });

  app.post("/projects/:id/participants", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const details = optObj(b, "details");
    const input: ParticipantInput = {
      ...(optStr(b, "code", 64) ? { code: optStr(b, "code", 64)! } : {}),
      ...(details ? { details: detailsOf(details) } : {}),
      ...(optStr(b, "legalBasis", 2000) ? { legalBasis: optStr(b, "legalBasis", 2000)! } : {}),
    };
    return s.repo.createParticipant(projectId, input);
  });

  app.post("/projects/:id/sessions", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const input: SessionInput = {
      date: str(b, "date", 40),
      ...(optStr(b, "place", 500) ? { place: optStr(b, "place", 500)! } : {}),
      ...(b.participantIds !== undefined ? { participantIds: strArray(b, "participantIds", { max: 1000, itemMax: 64 }) } : {}),
      ...(optStr(b, "notes", 20_000) ? { notes: optStr(b, "notes", 20_000)! } : {}),
      ...(optStr(b, "legalBasis", 2000) ? { legalBasis: optStr(b, "legalBasis", 2000)! } : {}),
    };
    return s.repo.createSession(projectId, input);
  });

  app.post("/projects/:id/consents", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const input: ConsentInput = {
      participantId: str(b, "participantId", 64),
      scope: str(b, "scope", 2000),
      date: str(b, "date", 40),
      ...(optStr(b, "expires", 40) ? { expires: optStr(b, "expires", 40)! } : {}),
      ...(optStr(b, "documentAssetId", 64) ? { documentAssetId: optStr(b, "documentAssetId", 64)! } : {}),
    };
    return s.repo.createConsent(projectId, input);
  });
}
