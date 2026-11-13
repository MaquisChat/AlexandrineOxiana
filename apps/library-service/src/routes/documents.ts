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
 */
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvalidInputError, KeyNotAvailableError, NotFoundError, PathEscapeError, ProjectLockedError, isPdfMime, openAssetContent, type AssetContent } from "@ao/library";
import { DOCUMENT_RANGE_MAX_BYTES, READER_PDF_MAX_BYTES } from "@ao/shared";
import { ApiError, badRequest, notFound, toApiError } from "../errors.js";
import { parseRange, sendContent } from "../media.js";
import { paramsOf, projectParam, type Ctx } from "./util.js";

/** How much each guarded read takes (as the library's own stream does). */
const SLICE = 64 * 1024;

const askForRange = (): ApiError => badRequest("Ask for a byte range.");
const cannotShow = (): ApiError => badRequest("This file cannot be shown here.");
const missing = (): ApiError => new ApiError(404, "NOT_FOUND", "The file of this source is not where it was recorded.");
const unsafe = (): ApiError => badRequest("This file could not be opened safely.");
const tooLarge = (): ApiError => new ApiError(413, "PAYLOAD_TOO_LARGE", "This PDF is larger than 512 MB, too large to open in the app.");
const locked = (): ApiError => new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

/** What opening the file can fail with, as the route's own answers. */
function openFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof NotFoundError) return missing();
  if (err instanceof ProjectLockedError || err instanceof KeyNotAvailableError) return locked();
  if (err instanceof PathEscapeError) return unsafe();
  if (err instanceof InvalidInputError) return err.message === "this file cannot be shown here" ? cannotShow() : unsafe();
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return missing();
  return toApiError(err);
}

/**
 * `c` with every read checked by `ok` before and after it (so no byte read after a lock leaves),
 * and its range stream made of those checked reads.
 */
function guarded(c: AssetContent, ok: () => void): AssetContent {
  const read = async (position: number, length: number): Promise<Buffer> => {
    ok();
    const b = await c.read(position, length);
    ok();
    return b;
  };
  return {
    asset: c.asset,
    mime: c.mime,
    size: c.size,
    read,
    range(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= c.size) throw new RangeError("range outside the file");
      async function* gen(): AsyncGenerator<Buffer> {
        for (let at = start; at <= end; ) {
          const n = Math.min(SLICE, end - at + 1);
          yield await read(at, n);
          at += n;
        }
      }
      return Readable.from(gen(), { objectMode: false, highWaterMark: SLICE });
    },
    close: () => c.close(),
  };
}

export function registerDocuments(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  const max = ctx.readerPdfMaxBytes ?? READER_PDF_MAX_BYTES;

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
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
    const c = guarded(opened, () => {
      if (state.session !== s || !s.repo.isUnlocked(projectId)) throw new ProjectLockedError(projectId);
    });
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
    if (ctx.documentBeforeRead) await ctx.documentBeforeRead();
    reply.header("Accept-Ranges", "bytes").header("Content-Range", `bytes ${r.start}-${end}/${c.size}`);
    return sendContent(req, reply, c, { start: r.start, end }, 206, {});
  };

  app.route({ method: "GET", url: "/projects/:id/sources/:sid/assets/:aid/document", exposeHeadRoute: false, handler });
}
