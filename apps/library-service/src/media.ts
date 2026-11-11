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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isMediaMime, isPictureMime, openAssetContent, type AssetContent } from "@ao/library";
import {
  MEDIA_TICKETS_MAX,
  MEDIA_TICKET_IDLE_MS,
  MEDIA_TICKET_LIFETIME_MS,
  PICTURE_MAX_BYTES,
  isMediaTicketPath,
  type MediaTicketResponse,
  type MediaTicketRevokeResponse,
} from "@ao/shared";
import { SHELL_ORIGINS } from "./auth.js";
import { ApiError, badRequest, notFound } from "./errors.js";
import { bodyOf, paramsOf, projectParam, str, type Ctx } from "./routes/util.js";

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
  /** When the last request started or ended. */
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

  /** The live ticket, its use recorded; undefined when unknown or ended. */
  use(ticket: string): Ticket | undefined {
    this.sweep();
    const t = this.tickets.get(digest(ticket));
    if (t) t.lastUsed = this.now();
    return t;
  }

  /** Tracks a response of `t` until `done` is called. */
  track(t: Ticket, s: Stream): () => void {
    t.streams.add(s);
    return () => {
      t.streams.delete(s);
      this.orphans.delete(s);
      t.lastUsed = this.now();
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

  /** Ends tickets past their idle time (none in progress) or their lifetime. */
  sweep(): void {
    const now = this.now();
    for (const [k, t] of this.tickets) {
      const idle = t.streams.size === 0 && now - t.lastUsed >= MEDIA_TICKET_IDLE_MS;
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
      s.destroy(new Error("the media address has ended"));
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

/**
 * Whether a `/media/…` request may be answered at all (before the ticket is looked up), and the
 * refusal if not. Host is checked by the caller.
 */
export function mediaRequestRefusal(req: FastifyRequest): ApiError | undefined {
  if (req.method !== "GET" && req.method !== "HEAD") return new ApiError(404, "NOT_FOUND", "There is no such route.");
  if (req.url.includes("?")) return badRequest("A media address carries nothing after its path.");
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

export function registerMedia(app: FastifyInstance, ctx: Ctx & { pictureMaxBytes?: number }): void {
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
    return sendContent(reply, c, c.size === 0 ? undefined : { start: 0, end: c.size - 1 }, 200, () => () => {});
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
    const path = str(bodyOf(req), "path", 128);
    if (!isMediaTicketPath(path)) throw badRequest('"path" must be a media address (/media/…).');
    return { revoked: tickets.revoke(path.slice("/media/".length)) };
  });

  // ---- the media route (no token: the ticket is the credential; checks in server.ts) ----
  const ended = () => new ApiError(404, "NOT_FOUND", "This media address has ended. Open the recording again.");
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
      return reply.status(416).header("Content-Range", `bytes */${c.size}`).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").send();
    }
    const range = r ?? (c.size === 0 ? undefined : { start: 0, end: c.size - 1 });
    if (r) reply.header("Content-Range", `bytes ${r.start}-${r.end}/${c.size}`);
    if (req.method === "HEAD") {
      contentHeaders(reply, c.mime, range ? range.end - range.start + 1 : 0);
      await c.close();
      return reply.status(r ? 206 : 200).send();
    }
    return sendContent(reply, c, range, r ? 206 : 200, (stream) => tickets.track(t, stream));
  };
  app.route({ method: "GET", url: "/media/:ticket", exposeHeadRoute: false, handler: serve });
  app.route({ method: "HEAD", url: "/media/:ticket", handler: serve });
}

/**
 * Streams `range` of `c` (nothing for an empty file); the file is released when the response ends,
 * however it ends (finished, aborted by the client, or destroyed by a revocation).
 */
function sendContent(reply: FastifyReply, c: AssetContent, range: { start: number; end: number } | undefined, status: number, track: (s: Stream) => () => void): FastifyReply {
  const length = range ? range.end - range.start + 1 : 0;
  contentHeaders(reply, c.mime, length);
  reply.status(status);
  if (!range) {
    void c.close();
    return reply.send(Buffer.alloc(0));
  }
  const body = c.range(range.start, range.end);
  // Errors reading (a revoked ticket, a damaged file) end the response; their text names no path or ticket.
  const done = track(body);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    done();
    if (!body.destroyed) body.destroy();
    void c.close();
  };
  reply.raw.once("close", release);
  body.once("error", release);
  return reply.send(body);
}
