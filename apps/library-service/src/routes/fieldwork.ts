/**
 * Fieldwork (spec 3.6): participants, sessions and consent records — listed and created through the
 * governed repository. (The library has no update or delete for them yet: those routes answer 405.)
 */
import type { FastifyInstance } from "fastify";
import type { ConsentInput, ParticipantInput, SessionInput } from "@ao/library";
import { ApiError, notFound } from "../errors.js";
import { bodyOf, optObj, optStr, paramsOf, projectParam, str, strArray, type Ctx } from "./util.js";

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
    for (const method of ["patch", "delete"] as const) {
      app[method](`/projects/:id/${kind}/:fid`, async () => {
        throw new ApiError(405, "VALIDATION", "Fieldwork records cannot be changed or removed yet.");
      });
    }
  }

  app.post("/projects/:id/participants", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const details = optObj(b, "details");
    const input: ParticipantInput = {
      ...(optStr(b, "code", 64) ? { code: optStr(b, "code", 64)! } : {}),
      ...(details ? { details: Object.fromEntries(Object.entries(details).map(([k, v]) => [k.slice(0, 200), String(v).slice(0, 4000)])) } : {}),
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
