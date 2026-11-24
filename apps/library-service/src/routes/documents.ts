/**
 * A stored PDF's bytes for the reader (Task R5; R96, R135, R140, R192 d).
 *
 * `GET /projects/:id/sources/:sid/assets/:aid/document`, the desktop app's token only, in the
 * Authorization header (never a media ticket: pdf.js reads through a range transport, so no element
 * needs a credential-free address, and `media-src` stays as R135 set it). Exactly one byte range is
 * required; the answer is 206 with `Content-Range: bytes a-b/total`, the range cut to
 * DOCUMENT_RANGE_MAX_BYTES. An encrypted project's file is decrypted by the library for exactly the
 * slices that range covers (asset-content.ts), never held whole.
 *
 * Checked in this order, each answer fixed text with no file-system path: the caller; the session;
 * the project (404); its lock (423, before anything about its sources is looked at, so a locked
 * project reveals nothing); the source (404); the Range header (400 "Ask for a byte range."; an
 * If-Range is refused too, so nothing can turn a range into the whole file); the asset's record:
 * unknown (404), destroyed (404, the missing-file sentence), not a PDF (400), larger than
 * READER_PDF_MAX_BYTES (413, from the recorded size, before the file is opened); then the file is
 * opened (never through a symbolic link: O_NOFOLLOW and the library's containment check), its
 * actual size checked against the limit again, and the range against it (416).
 *
 * While the bytes are read, every slice checks that the project is still unlocked and the same
 * library still open, before and after it is read: a lock before the first byte answers 423 in the
 * service's error shape; a lock after it cuts the connection. Reading audits nothing and changes
 * nothing, so it works in a read-only library.
 *
 * R470 b (FR-490): `GET /projects/:id/review/:itemId/held-file/document` serves, the same way, the file Find and acquire
 * holds for one pending entry, to be looked at before the researcher decides (its own handler below).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvalidInputError, KeyNotAvailableError, NotFoundError, PathEscapeError, ProjectLockedError, isPdfMime, openAssetContent, openHeldFileContent, type AssetContent, type HeldFileContent, type StoredContent } from "@ao/library";
import { DOCUMENT_RANGE_MAX_BYTES, READER_PDF_MAX_BYTES } from "@ao/shared";
import { SHELL_ORIGINS } from "../auth.js";
import { ApiError, badRequest, notFound, toApiError } from "../errors.js";
import { guarded, parseRange, readGuard, sendContent } from "../media.js";

/** The guard of every read lives with the stream it guards (media.ts), shared with the picture route (FR-739). */
export { guarded };
import { paramsOf, projectParam, type Ctx } from "./util.js";

const askForRange = (): ApiError => badRequest("Ask for a byte range.");
const cannotShow = (): ApiError => badRequest("This file cannot be shown here.");
const missing = (): ApiError => new ApiError(404, "NOT_FOUND", "The file of this source is not where it was recorded.");
const unreadable = (): ApiError => new ApiError(409, "CONFLICT", "This file could not be read. The library's integrity check can tell more.");
const unsafe = (): ApiError => badRequest("This file could not be opened safely.");
const tooLarge = (): ApiError => new ApiError(413, "PAYLOAD_TOO_LARGE", "This PDF is larger than 512 MB, too large to open in the app.");
/** R470 b: the one answer for "no held file here", whatever the reason (it tells nothing more). */
const noHeldFile = (): ApiError => notFound("That file");
const locked = (): ApiError => new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");

/** The document route's path, exactly (its preflight is judged by it: no route matches an OPTIONS). */
const DOCUMENT_PATH = /^\/projects\/[^/?#]+\/sources\/[^/?#]+\/assets\/[^/?#]+\/document$/;
/** R470 b: the held file's route (looked at before the researcher decides), its preflight judged the same way. */
const HELD_DOCUMENT_PATH = /^\/projects\/[^/?#]+\/review\/[^/?#]+\/held-file\/document$/;

/**
 * Whether an OPTIONS request is the preflight of a GET of the document route (Task R5 review I1):
 * only then does the answer add `range` to the allowed request headers. The origin has been
 * checked by the caller (server.ts) before this is asked.
 */
export function isDocumentPreflight(req: FastifyRequest): boolean {
  if (req.method !== "OPTIONS") return false;
  if (String(req.headers["access-control-request-method"] ?? "").toUpperCase() !== "GET") return false;
  const path = req.url.split("?")[0] ?? "";
  return DOCUMENT_PATH.test(path) || HELD_DOCUMENT_PATH.test(path);
}

/**
 * The response headers the page must read across origins (the UI runs at the shell's origin and
 * calls 127.0.0.1): `Content-Range`. `Content-Length` and `Content-Type` are CORS-safelisted, and
 * `byteRange` reads nothing else. Sent only to an origin the service already accepts (the
 * shell's: server.ts has refused every other before the handler runs).
 */
const EXPOSED = "Content-Range";

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

/** What opening the file can fail with, as the route's own answers. */
export function openFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof NotFoundError) return missing();
  if (err instanceof ProjectLockedError || err instanceof KeyNotAvailableError) return locked();
  if (err instanceof PathEscapeError) return unsafe();
  if (err instanceof InvalidInputError) return err.message === "this file cannot be shown here" ? cannotShow() : unsafe();
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return missing();
  // There but unreadable (permission, too many open files, an I/O error): never "missing".
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) return unreadable();
  return toApiError(err);
}

export function registerDocuments(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const max = ctx.readerPdfMaxBytes ?? READER_PDF_MAX_BYTES;

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const origin = req.headers.origin;
    if (origin !== undefined && SHELL_ORIGINS.has(origin)) reply.header("Access-Control-Expose-Headers", EXPOSED);
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    if (!s.repo.isUnlocked(projectId)) throw locked();
    const { sid = "", aid = "" } = paramsOf(req);
    if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");

    // One range of bytes, and nothing that could stand for the whole file.
    const range = header(req, "range");
    const ifRange = header(req, "if-range");
    if (range === undefined || ifRange !== undefined || parseRange(range, undefined, Number.MAX_SAFE_INTEGER) === undefined) throw askForRange();

    // The record decides first: the file is not opened for what it says is refused.
    let sf;
    try {
      sf = await s.repo.getSource(projectId, sid);
    } catch (err) {
      throw openFailure(err);
    }
    const asset = sf.assets.find((a) => a.id === aid);
    if (!asset) throw notFound("That file");
    if (asset.status === "destroyed") throw missing();
    if (!isPdfMime(asset.mime)) throw cannotShow();
    if (asset.bytes > max) throw tooLarge();

    let opened: AssetContent;
    try {
      opened = await openAssetContent(s.repo, projectId, sid, aid, (a) => isPdfMime(a.mime));
    } catch (err) {
      throw openFailure(err);
    }
    return serve(req, reply, s, projectId, opened, range);
  };

  /**
   * The bytes of an opened file for one range (the reader's route and the held file's alike): every read guarded (the
   * project still unlocked, the same library still open), the file's actual size checked against the limit, the range
   * against it (416), then one answer of at most DOCUMENT_RANGE_MAX_BYTES. Closes the file on every refusal.
   */
  const serve = async (req: FastifyRequest, reply: FastifyReply, s: ReturnType<Ctx["state"]["requireSession"]>, projectId: string, opened: StoredContent, range: string): Promise<FastifyReply> => {
    const c = guarded(opened, readGuard(state, s, projectId));
    if (c.size > max) {
      await c.close();
      throw tooLarge();
    }
    const r = parseRange(range, undefined, c.size);
    if (r === undefined) {
      await c.close();
      throw askForRange();
    }
    if (r === "unsatisfiable") {
      await c.close();
      return reply.status(416).header("Content-Range", `bytes */${c.size}`).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").send();
    }
    const end = Math.min(r.end, r.start + DOCUMENT_RANGE_MAX_BYTES - 1);
    if (ctx.documentBeforeRead) {
      try {
        await ctx.documentBeforeRead();
      } catch (err) {
        await c.close();
        throw err;
      }
    }
    reply.header("Accept-Ranges", "bytes").header("Content-Range", `bytes ${r.start}-${end}/${c.size}`);
    return sendContent(req, reply, c, { start: r.start, end }, 206, {});
  };

  /**
   * R470 b (FR-490): the file Find and acquire holds for pending review entry `itemId` of the project, to be LOOKED at
   * before "Use this file" / "Not this file": the app's own route (the desktop app's token; never among the extension's
   * routes), checked as the reader's route — the caller, the session, the project (404), its lock (423, before anything
   * about its entries is looked at), one byte range (400) — then the held file opened by the library's reading code
   * (openHeldFileContent: decrypted range by range in an encrypted project). No held file — an unknown entry, one of
   * another project, one that holds none or is decided, a file gone — is one plain 404 that names nothing; an EPUB
   * "cannot be shown here" (the reader shows PDFs only). Reading records nothing, audits nothing and writes nothing.
   */
  const heldHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const origin = req.headers.origin;
    if (origin !== undefined && SHELL_ORIGINS.has(origin)) reply.header("Access-Control-Expose-Headers", EXPOSED);
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    if (!s.repo.isUnlocked(projectId)) throw locked();
    const range = header(req, "range");
    const ifRange = header(req, "if-range");
    if (range === undefined || ifRange !== undefined || parseRange(range, undefined, Number.MAX_SAFE_INTEGER) === undefined) throw askForRange();
    let opened: HeldFileContent;
    try {
      opened = await openHeldFileContent(s.repo, projectId, paramsOf(req).itemId ?? "");
    } catch (err) {
      if (err instanceof NotFoundError) throw noHeldFile();
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") throw noHeldFile();
      throw openFailure(err);
    }
    if (opened.kind !== "pdf") {
      await opened.close();
      throw cannotShow();
    }
    return serve(req, reply, s, projectId, opened, range);
  };

  app.route({ method: "GET", url: "/projects/:id/sources/:sid/assets/:aid/document", exposeHeadRoute: false, handler });
  app.route({ method: "GET", url: "/projects/:id/review/:itemId/held-file/document", exposeHeadRoute: false, handler: heldHandler });
}
