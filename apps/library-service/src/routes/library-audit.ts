/**
 * The library's own audit log and projects' attention marks (Task 50, R154 b, d). UI token and
 * origin only (the extension token reaches none of these). Answers carry no absolute path: every
 * string from the log or a mark passes the path scrubber.
 */
import type { FastifyInstance } from "fastify";
import { scrubPaths } from "@ao/library";
import type { AttentionMarksResponse, LibraryAuditCheck, LibraryAuditPage, SetAsideResponse } from "@ao/shared";
import { badRequest } from "../errors.js";
import { bodyOf, intParam, projectParam, queryOf, type Ctx } from "./util.js";

/** A record id (hex) or an unrecognised item's opaque id (`u-` and hex). */
const MARK_ID = /^(?:u-)?[0-9a-f]{16,64}$/;

/** Every string in a JSON value with absolute paths scrubbed. */
function scrubDeep<T>(v: T, roots: Iterable<string>): T {
  if (typeof v === "string") return scrubPaths(v, roots) as T;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, roots)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x, roots)])) as T;
  return v;
}

export function registerLibraryAudit(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/libraries/audit", async (req): Promise<LibraryAuditPage> => {
    const s = state.requireSession();
    const q = queryOf(req);
    const limit = intParam(q.limit, "limit", 1, 1000, 100);
    const before = q.before === undefined ? undefined : intParam(q.before, "before", 0, Number.MAX_SAFE_INTEGER, 0);
    const page = await s.repo.readLibraryAuditPage({ limit, ...(before !== undefined ? { beforeSeq: before } : {}) });
    return scrubDeep(page, state.roots) as LibraryAuditPage;
  });

  app.get("/libraries/audit/verify", async (): Promise<LibraryAuditCheck> => {
    const s = state.requireSession();
    return scrubDeep(await s.repo.verifyLibraryAudit(), state.roots);
  });

  app.get("/projects/:id/attention", async (req): Promise<AttentionMarksResponse> => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    return { marks: scrubDeep(await s.repo.attentionMarks(projectId), state.roots) };
  });

  app.post("/projects/:id/attention/:markId/set-aside", async (req): Promise<SetAsideResponse> => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const markId = (req.params as { markId?: string }).markId ?? "";
    if (!MARK_ID.test(markId)) throw badRequest("That is not a mark of this project.");
    // The policy engine decides on the reason (a blank one is refused there, and audited, N7).
    const body = bodyOf(req);
    if (body.reason !== undefined && typeof body.reason !== "string") throw badRequest('"reason" must be text.');
    const reason = typeof body.reason === "string" ? body.reason : "";
    if (reason.length > 1000) throw badRequest('"reason" is too long.');
    try {
      return await s.repo.setAsideMark(projectId, markId, reason);
    } finally {
      // The banner and the audit screen follow (a set-aside, or a refusal recorded by it).
      state.publishState();
    }
  });
}
