/**
 * Pictures and audio/video for the UI (Task 34a, R135).
 *
 * Pictures: `GET /projects/:id/sources/:sid/assets/:aid/content`, UI token, raster types only, at
 * most PICTURE_MAX_BYTES (48 MiB: a full-page screenshot of a very long page, which browser capture
 * accepts up to 32 MB of request, fits with room to spare); the UI shows it as a blob URL.
 *
 * Audio and video: a media element cannot send an Authorization header, so the UI asks
 * (`POST …/assets/:aid/media-ticket`, UI token only) for a ticket: 256 random bits, kept only in
 * this process's memory (by its SHA-256, so the map holds no usable ticket), naming exactly one
 * asset of one project of the library open now. `GET`/`HEAD /media/<ticket>` serves that asset with
 * range requests, decrypting as it streams (never holding the file in memory). A ticket ends after
 * 10 minutes without a request in progress, 8 hours after it was issued whatever happens, when its
 * project is locked, when the library is closed or moved, and when the service stops; at most 16
 * are live (the 17th is refused, 429, until one ends: evicting one silently would stop a recording
 * that is playing). Ending a ticket also ends its streams in progress.
 *
 * Who may load `/media/<ticket>` (decided here, checked in server.ts before any token logic):
 *  - Host must be ours (as for every route).
 *  - No query string at all (R135: path only).
 *  - Origin, when sent, must be the desktop shell's (`tauri://localhost`, `http://tauri.localhost`);
 *    a media element without `crossorigin` sends none (a no-cors GET), one with it sends the
 *    shell's. A paired extension's origin is refused here (it has no business with recordings).
 *  - Fetch metadata, when sent: a navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-User`,
 *    `Sec-Fetch-Site: none`) is refused, so a ticket address never opens as a page; so is any
 *    destination but audio, video, track or empty (no document, frame, embed, object, script…).
 *    `Sec-Fetch-Mode: cors` without an Origin is refused (no browser sends that).
 *    `Sec-Fetch-Site` cannot tell the shell from another site (both are cross-site to 127.0.0.1),
 *    so it is not used to allow anything.
 *  - Referer, when sent, must be from the shell's origin: a page elsewhere that embeds a leaked
 *    ticket is refused unless it also suppresses its referrer. This is defence in depth only; the
 *    ticket is the credential (R135's stated cost).
 *  - Clients that send no fetch metadata (non-browser programs, older web views, the platform's
 *    media stack) are served on the ticket alone.
 * The ticket never appears in a log line (server.ts redacts `/media/…` in the request serializer)
 * or in an error message (every message here is fixed text).
 */
import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DecryptionError, EncryptionFormatError, KeyNotAvailableError, ProjectLockedError, isMediaMime, isPictureMime, openAssetContent, type AssetContent } from "@ao/library";
import {
  MEDIA_TICKETS_MAX,
  MEDIA_TICKET_IDLE_MS,
  MEDIA_TICKET_LIFETIME_MS,
  PICTURE_MAX_BYTES,
  isMediaTicketPath,
  type MediaTicketResponse,
  type MediaTicketRevokeRequest,
  type MediaTicketRevokeResponse,

} from "@ao/shared";
import { SHELL_ORIGINS } from "./auth.js";
import { ApiError, badRequest, notFound, toApiError } from "./errors.js";
import { bodyAs, paramsOf, projectParam, str, type Ctx } from "./routes/util.js";

export { PICTURE_MAX_BYTES };

interface Stream {
  destroy(err?: Error): void;
}

interface Ticket {
  /** The library open when it was issued (a ticket never outlives it). */
  lib: object;
  projectId: string;
  sourceId: string;
  assetId: string;
  issuedAt: number;
  /** When bytes were last sent for it (or it was issued): R140, idle means no bytes sent. */
  lastUsed: number;
  /** Responses streaming now. */
  streams: Set<Stream>;
}

const digest = (ticket: string) => createHash("sha256").update(ticket, "utf8").digest("hex");

/** The live media tickets (memory only). */
export class MediaTickets {
  private readonly tickets = new Map<string, Ticket>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly now: () => number) {}

  /** Live tickets (after ending the expired ones). */
  live(): number {
    this.sweep();
    return this.tickets.size;
  }

  /** Responses streaming now, over all tickets. */
  activeStreams(): number {
    let n = 0;
    for (const t of this.tickets.values()) n += t.streams.size;
    return n + this.orphans.size;
  }

  /** Streams whose ticket ended while they ran, until they have closed. */
  private readonly orphans = new Set<Stream>();
  private sent = 0;

  /** Bytes handed to responses so far, over all tickets (diagnostics, tests). */
  bytesSent(): number {
    return this.sent;
  }

  /** Bytes were sent for `t`: the idle clock starts again (R140). */
  sentBytes(t: Ticket, n: number): void {
    this.sent += n;
    t.lastUsed = this.now();
  }

  /** Whether `ticket` is still live (no use recorded). */
  isLive(ticket: string): boolean {
    this.sweep();
    return this.tickets.has(digest(ticket));
  }

  issue(entry: Omit<Ticket, "issuedAt" | "lastUsed" | "streams">): { ticket: string; issuedAt: number } {
    this.sweep();
    if (this.tickets.size >= MEDIA_TICKETS_MAX) {
      throw new ApiError(429, "RATE_LIMITED", "Too many recordings are open at once. Close one, then try again.");
    }
    const ticket = randomBytes(32).toString("base64url");
    const at = this.now();
    this.tickets.set(digest(ticket), { ...entry, issuedAt: at, lastUsed: at, streams: new Set() });
    this.startTimer();
    return { ticket, issuedAt: at };
  }

  /** The live ticket; undefined when unknown or ended. A request alone does not refresh it: bytes do. */
  use(ticket: string): Ticket | undefined {
    this.sweep();
    return this.tickets.get(digest(ticket));
  }

  /** Tracks a response of `t` until `done` is called. */
  track(t: Ticket, s: Stream): () => void {
    t.streams.add(s);
    return () => {
      t.streams.delete(s);
      this.orphans.delete(s);
    };
  }

  revoke(ticket: string): boolean {
    const key = digest(ticket);
    const t = this.tickets.get(key);
    if (!t) return false;
    this.end(key, t);
    return true;
  }

  revokeProject(projectId: string): void {
    for (const [k, t] of this.tickets) if (t.projectId === projectId) this.end(k, t);
  }

  revokeAll(): void {
    for (const [k, t] of this.tickets) this.end(k, t);
    this.stopTimer();
  }

  /**
   * Ends tickets past their lifetime, or with no bytes sent for 10 minutes (R140: a response open
   * but making no progress does not keep its ticket; ending it closes that connection).
   */
  sweep(): void {
    const now = this.now();
    for (const [k, t] of this.tickets) {
      const idle = now - t.lastUsed >= MEDIA_TICKET_IDLE_MS;
      if (idle || now - t.issuedAt >= MEDIA_TICKET_LIFETIME_MS) this.end(k, t);
    }
    if (this.tickets.size === 0) this.stopTimer();
  }

  expiry(t: { issuedAt: number; lastUsed: number }): { idleExpiresAt: string; expiresAt: string } {
    const end = t.issuedAt + MEDIA_TICKET_LIFETIME_MS;
    return { idleExpiresAt: new Date(Math.min(end, t.lastUsed + MEDIA_TICKET_IDLE_MS)).toISOString(), expiresAt: new Date(end).toISOString() };
  }

  private end(key: string, t: Ticket): void {
    this.tickets.delete(key);
    for (const s of t.streams) {
      this.orphans.add(s);
      s.destroy(ticketEnded());
    }
    t.streams.clear();
  }

  /** A sweep each minute, so a stream past the 8-hour limit is ended even if no request comes. */
  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Fetch-metadata destinations a media element (or a plain fetch of it) uses. */
const MEDIA_DESTS = new Set(["audio", "video", "track", "empty"]);

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(",") : v;
};

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "tauri:" ? `tauri://${u.host}` : u.origin;
  } catch {
    return undefined;
  }
}

/** Marks the media route: server.ts exempts it from the token check by this, never by a path test (R140 3). */
export const MEDIA_ROUTE_CONFIG = { mediaTicket: true } as const;

/** Whether the request was routed to the media route itself (its own configuration says so). */
export function isMediaRoute(req: FastifyRequest): boolean {
  return (req.routeOptions.config as { mediaTicket?: unknown } | undefined)?.mediaTicket === true;
}

/** The answer for a media address that has ended (or never existed, or is spelled otherwise). */
export const ticketEnded = (): ApiError => new ApiError(404, "NOT_FOUND", "This media address has ended. Open the recording again.");

/**
 * Whether a request to the media route may be answered at all (before the ticket is looked up),
 * and the refusal if not. Host is checked by the caller. Only the exact address form is served:
 * `/media/` and the ticket's own 43 characters, nothing percent-encoded, nothing after it (R140 4).
 */
export function mediaRequestRefusal(req: FastifyRequest): ApiError | undefined {
  if (req.url.includes("?")) return badRequest("A media address carries nothing after its path.");
  if (!isMediaTicketPath(req.url)) return ticketEnded();
  const forbidden = (why: string) => new ApiError(403, "FORBIDDEN", why);
  const origin = header(req, "origin");
  if (origin !== undefined && !SHELL_ORIGINS.has(origin)) return forbidden("Requests from this origin are not allowed.");
  const mode = header(req, "sec-fetch-mode");
  const dest = header(req, "sec-fetch-dest");
  const site = header(req, "sec-fetch-site");
  if (mode === "navigate" || mode === "nested-navigate" || header(req, "sec-fetch-user") !== undefined || site === "none") {
    return forbidden("A media address is played by the app, not opened as a page.");
  }
  if (mode === "cors" && origin === undefined) return forbidden("Requests from this origin are not allowed.");
  if (dest !== undefined && !MEDIA_DESTS.has(dest)) return forbidden("A media address is played by the app, not opened as a page.");
  const referer = header(req, "referer");
  if (referer !== undefined) {
    const from = originOf(referer);
    if (!from || !SHELL_ORIGINS.has(from)) return forbidden("Requests from this page are not allowed.");
  }
  return undefined;
}

/**
 * The byte range to send for a `Range` header (RFC 9110 14): undefined → the whole file (200).
 * One range of the `bytes` unit is honoured; several ranges, another unit, a malformed header or
 * an If-Range (we give no validators, so it never matches) mean the header is ignored, which
 * RFC 9110 allows, and the whole file is streamed. "unsatisfiable" → 416.
 */
export function parseRange(range: string | undefined, ifRange: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  if (range === undefined || ifRange !== undefined) return undefined;
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/.exec(range.trim());
  if (!m) return undefined; // several ranges (a comma), another unit, or not understood
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return undefined;
  if (a === "") {
    const n = Number(b);
    if (!Number.isSafeInteger(n) || n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return "unsatisfiable";
  if (b !== "" && Number(b) < start) return undefined; // invalid: ignored
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(size - 1, Number(b));
  return { start, end };
}

/** Headers every response with a file's bytes carries (R135 3). */
function contentHeaders(reply: FastifyReply, mime: string, length: number): void {
  reply
    .header("Content-Type", mime)
    .header("Content-Length", String(length))
    .header("X-Content-Type-Options", "nosniff")
    .header("Cache-Control", "no-store")
    .header("Content-Disposition", "inline")
    // If it were ever opened as a document anyway: nothing in it may run or load.
    .header("Content-Security-Policy", "default-src 'none'; sandbox");
}

export function registerMedia(app: FastifyInstance, ctx: Ctx & { pictureMaxBytes?: number; mediaBeforeSend?: () => Promise<void> }): void {
  const { state } = ctx;
  const tickets = state.media;
  const pictureMax = ctx.pictureMaxBytes ?? PICTURE_MAX_BYTES;

  const assetParams = (req: FastifyRequest) => {
    const projectId = projectParam(ctx, req);
    const { sid = "", aid = "" } = paramsOf(req);
    return { projectId, sid, aid };
  };

  // ---- pictures ----
  app.get("/projects/:id/sources/:sid/assets/:aid/content", async (req, reply) => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const s = state.requireSession();
    const { projectId, sid, aid } = assetParams(req);
    if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
    const c = await openAssetContent(s.repo, projectId, sid, aid, (a) => isPictureMime(a.mime));
    if (c.size > pictureMax) {
      await c.close();
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "This picture is too large to show.");
    }
    return sendContent(req, reply, c, c.size === 0 ? undefined : { start: 0, end: c.size - 1 }, 200, {});
  });

  // ---- media tickets ----
  app.post("/projects/:id/sources/:sid/assets/:aid/media-ticket", async (req): Promise<MediaTicketResponse> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const s = state.requireSession();
    state.assertNotMoving();
    const { projectId, sid, aid } = assetParams(req);
    if (!s.repo.listSourceIds(projectId).includes(sid)) throw notFound("That source");
    // Opened once to check it (type, lock, file present) and to give its size; then released.
    const c = await openAssetContent(s.repo, projectId, sid, aid, (a) => isMediaMime(a.mime));
    await c.close();
    const { ticket, issuedAt } = tickets.issue({ lib: s.lib, projectId, sourceId: sid, assetId: aid });
    return { path: `/media/${ticket}`, mime: c.mime, size: c.size, ...tickets.expiry({ issuedAt, lastUsed: issuedAt }) };
  });

  app.post("/media-tickets/revoke", async (req): Promise<MediaTicketRevokeResponse> => {
    if (req.caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
    const path = str(bodyAs<MediaTicketRevokeRequest>(req), "path", 128);
    if (!isMediaTicketPath(path)) throw badRequest('"path" must be a media address (/media/…).');
    return { revoked: tickets.revoke(path.slice("/media/".length)) };
  });

  // ---- the media route (no token: the ticket is the credential; checks in server.ts) ----
  const ended = ticketEnded;
  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    const ticket = paramsOf(req).ticket ?? "";
    if (!isMediaTicketPath(`/media/${ticket}`)) throw ended();
    const t = tickets.use(ticket);
    if (!t) throw ended();
    const s = state.session;
    if (!s || s.lib !== t.lib || state.moving) {
      tickets.revoke(ticket);
      throw ended();
    }
    if (!s.repo.listProjects().some((p) => p.id === t.projectId)) {
      tickets.revoke(ticket);
      throw ended();
    }
    if (!s.repo.isUnlocked(t.projectId)) {
      // Locked some other way than the lock route: refused, and the ticket ends.
      tickets.revoke(ticket);
      throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
    }
    let c: AssetContent;
    try {
      c = await openAssetContent(s.repo, t.projectId, t.sourceId, t.assetId, (a) => isMediaMime(a.mime));
    } catch (err) {
      tickets.revoke(ticket);
      throw err;
    }
    const r = parseRange(header(req, "range"), header(req, "if-range"), c.size);
    reply.header("Accept-Ranges", "bytes");
    if (r === "unsatisfiable") {
      await c.close();
      tickets.sentBytes(t, 0);
      return reply.status(416).header("Content-Range", `bytes */${c.size}`).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").send();
    }
    const range = r ?? (c.size === 0 ? undefined : { start: 0, end: c.size - 1 });
    if (r) reply.header("Content-Range", `bytes ${r.start}-${r.end}/${c.size}`);
    if (req.method === "HEAD") {
      contentHeaders(reply, c.mime, range ? range.end - range.start + 1 : 0);
      await c.close();
      tickets.sentBytes(t, 0);
      return reply.status(r ? 206 : 200).send();
    }
    return sendContent(req, reply, c, range, r ? 206 : 200, {
      track: (stream) => tickets.track(t, stream),
      sent: (n) => tickets.sentBytes(t, n),
      // Between the first read and the first byte: the ticket must still be live and its project unlocked.
      check: () => {
        if (!tickets.isLive(ticket) || state.session !== s) throw ended();
        if (!s.repo.isUnlocked(t.projectId)) {
          tickets.revoke(ticket);
          throw new ApiError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.");
        }
      },
      ...(ctx.mediaBeforeSend ? { beforeSend: ctx.mediaBeforeSend } : {}),
    });
  };
  app.route({ method: "GET", url: "/media/:ticket", exposeHeadRoute: false, config: MEDIA_ROUTE_CONFIG, handler: serve });
  app.route({ method: "HEAD", url: "/media/:ticket", config: MEDIA_ROUTE_CONFIG, handler: serve });
}

/** How much is read before any header is sent: an unreadable file is refused with a proper error. */
const FIRST_SLICE = 64 * 1024;

/**
 * A stored file that could not be read for display, as the service's own error (R140 5): locked
 * → 423, damaged or unreadable → 409 with a fixed message. Logged by the caller without a stack.
 */
function readFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ProjectLockedError || err instanceof KeyNotAvailableError) return toApiError(err);
  if (err instanceof DecryptionError || err instanceof EncryptionFormatError) return toApiError(err);
  return new ApiError(409, "CONFLICT", "This file could not be read. The library's integrity check can tell more.");
}

const logFailure = (req: FastifyRequest, e: ApiError, when: "before the first byte" | "while sending") => {
  if (e.code === "NOT_FOUND" || e.code === "PROJECT_LOCKED") req.log.info({ code: e.code, when }, "a media address ended");
  else req.log.warn({ code: e.code, when }, "a stored file could not be read for display");
};

export interface SendHooks {
  track?: (s: Stream) => () => void;
  sent?: (bytes: number) => void;
  check?: () => void;
  beforeSend?: () => Promise<void>;
}

/**
 * Streams `range` of `c` (nothing for an empty file). The first slice is read before any header
 * is set, so a damaged file or a lock answers with the service's error shape (R140 5). The file is
 * released when the response ends, however it ends (finished, aborted by the client, or ended by
 * a revocation, after which nothing more is sent).
 */
export async function sendContent(req: FastifyRequest, reply: FastifyReply, c: AssetContent, range: { start: number; end: number } | undefined, status: number, hooks: SendHooks): Promise<FastifyReply> {
  if (!range) {
    contentHeaders(reply, c.mime, 0);
    await c.close();
    return reply.status(status).send(Buffer.alloc(0));
  }
  const length = range.end - range.start + 1;
  let first: Buffer;
  try {
    first = await c.read(range.start, Math.min(FIRST_SLICE, length));
    hooks.check?.();
  } catch (err) {
    await c.close();
    const e = readFailure(err);
    logFailure(req, e, "before the first byte");
    throw e;
  }
  contentHeaders(reply, c.mime, length);
  reply.status(status);

  // Every byte goes through `out`, which counts it (the ticket's idle clock, R140) and can be cut off.
  const out = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hooks.sent?.(chunk.length);
      cb(null, chunk);
    },
  });
  const rest = first.length < length ? c.range(range.start + first.length, range.end) : undefined;
  let stopped = false;
  /** Ends the response: before the first byte with the service's error, after it by cutting the connection. */
  const stop = (err: ApiError) => {
    if (stopped) return;
    stopped = true;
    rest?.unpipe(out);
    rest?.destroy();
    if (reply.raw.headersSent) out.destroy();
    else out.destroy(err);
  };
  const done = hooks.track?.({ destroy: (err?: Error) => stop(err instanceof ApiError ? err : ticketEnded()) }) ?? (() => {});
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    done();
    rest?.destroy();
    if (!out.destroyed) out.destroy();
    void c.close();
  };
  reply.raw.once("close", release);
  rest?.once("error", (err) => {
    if (stopped) return;
    const e = readFailure(err);
    logFailure(req, e, reply.raw.headersSent ? "while sending" : "before the first byte");
    stop(e);
  });
  out.write(first);
  if (rest) rest.pipe(out);
  else out.end();
  if (hooks.beforeSend) await hooks.beforeSend();
  return reply.send(out);
}

