/**
 * Task F20a (Ruling R348 f): the paired browser extension's two routes for "Get through my library in my own browser".
 * They are here, in a file of their own, because they are the extension's — reached with ITS token and its paired
 * Origin only (server.ts's EXTENSION_ROUTES; neither is in EXTENSION_NO_ORIGIN_ROUTES, R111), never the desktop app's —
 * while the app's start beside them (`POST …/browser/start`) is the library start's and lives with it in
 * routes/your-library.ts. Both answers are `Cache-Control: no-store`.
 *
 *   POST /find/browser/waiting        body exactly `{}` → { waiting: [{ ticket, label }] } — none or one: the open
 *                                     browser ticket if its project is unlocked; `label` the record's title cut to
 *                                     FIND_BROWSER_LABEL_MAX characters. Nothing else of the record or the project.
 *   POST /find/browser/file/:ticket   the PDF's bytes (`Content-Type: application/pdf`), header `x-ao-page` (the tab's
 *                                     address) → { outcome, sentence }. In this order: (i) the ticket (the open
 *                                     browser's, constant time) else 404 "browser-not-waiting", the body not taken;
 *                                     (ii) the page (given once, no ", " in it — R353 f) else 400 "browser-page";
 *                                     (iii) one file at a time for the whole service else 409 "browser-busy"; the
 *                                     inbox a private folder of the user's, else 503 "browser-inbox" (R353 g, nothing
 *                                     written); (iv) the body STREAMED into
 *                                     `<AO_CONFIG_DIR>/browser-inbox/<32 hex>.pdf` (folder 0700, file 0600, created
 *                                     exclusively): over LIBRARY_FILE_MAX_BYTES 413 "browser-too-large", not `%PDF-`
 *                                     400 "browser-not-pdf", cut off, stalled or not ended FIND_BROWSER_TAKE_MS after
 *                                     the ticket's check (R353 a) 400 "browser-cut-off" — in each the
 *                                     ticket stays open; (v) only then the seam (`libraryHandedOver(ticket,
 *                                     "browser")`; null is (i)'s answer) and F17's path (`acceptLibraryFile`, via
 *                                     "browser-extension", the tab's address), which HOLDS the file for the
 *                                     researcher's check (R301); (vi) 200 with how it ended. The inbox file is removed
 *                                     in every outcome.
 *
 * The body is never held whole in memory: this route's own content-type parser (registered in an encapsulated plugin,
 * so that `application/pdf` is accepted nowhere else) hands the handler the request stream unread; the handler writes
 * it piece by piece, pausing the stream while each piece is written — no `Buffer.concat`, no buffering parser.
 *
 * Nothing of the ticket, the tab's address or the title is logged, audited, put in an event or an error: every refusal
 * is a fixed sentence, and server.ts's `logUrl` writes the path as `/find/browser/file/[redacted]`.
 */
import { randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FindHandOverEnd, HandedFile } from "@ao/library";
import {
  FIND_BROWSER_FILE_TEXT,
  FIND_BROWSER_LABEL_MAX,
  FIND_BROWSER_NO_TITLE,
  FIND_BROWSER_PAGE_HEADER,
  FIND_BROWSER_PAGE_MAX,
  FIND_BROWSER_STALL_MS,
  FIND_BROWSER_TAKE_MS,
  FIND_BROWSER_TEXT,
  LIBRARY_FILE_MAX_BYTES,
  type FindBrowserFileResponse,
  type FindBrowserWaitingResponse,
} from "@ao/shared";
import { ApiError } from "../errors.js";
import { discardInboxFile, emptyInbox, privateInboxReal, takeInboxFile } from "../file-grants.js";
import { paramsOf, type Ctx } from "./util.js";

/** The browser's inbox, under the app's settings folder (beside the shell's `library-inbox`). */
export const BROWSER_INBOX = "browser-inbox";
export const browserInboxOf = (appConfigDir: string): string => join(appConfigDir, BROWSER_INBOX);

/** At the service's start: the regular files left directly in the browser's inbox are removed (file-grants.ts). */
export function emptyBrowserInbox(appConfigDir: string): Promise<void> {
  return emptyInbox(browserInboxOf(appConfigDir));
}

/**
 * The list's label: the record's title cut to FIND_BROWSER_LABEL_MAX characters counted as code points (never half of
 * a surrogate pair at the cut), passed as it is otherwise — markup, control characters and direction marks included
 * (the popup shows it as text) — or FIND_BROWSER_NO_TITLE without one.
 */
export function browserLabel(title: string): string {
  if (!title) return FIND_BROWSER_NO_TITLE;
  let out = "";
  let n = 0;
  for (const ch of title) {
    if (n === FIND_BROWSER_LABEL_MAX) break;
    out += ch;
    n++;
  }
  return out;
}

/**
 * The tab's address when it can be the record's: text of at most FIND_BROWSER_PAGE_MAX that parses as https, no user
 * name or password. R353 f: the header given once only (`rawHeaders`), and no comma followed by a space in it (how Node
 * joins a header given twice).
 */
function pageOf(req: FastifyRequest): string | null {
  const h: unknown = req.headers[FIND_BROWSER_PAGE_HEADER];
  const raw = req.raw.rawHeaders;
  let given = 0;
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === FIND_BROWSER_PAGE_HEADER) given++;
  if (given > 1) return null;
  if (typeof h !== "string" || h.length === 0 || h.length > FIND_BROWSER_PAGE_MAX || h.includes(", ")) return null;
  try {
    const u = new URL(h);
    return u.protocol === "https:" && u.username === "" && u.password === "" ? h : null;
  } catch {
    return null;
  }
}

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

type Received = { ok: true } | { ok: false; why: "too-large" | "not-pdf" | "cut-off"; whole: boolean };

/**
 * Writes the request stream into `fh` piece by piece (the stream paused while a piece is written), counting the bytes:
 * past LIBRARY_FILE_MAX_BYTES "too-large"; first five bytes not `%PDF-` "not-pdf" (said as soon as they are known);
 * no byte for `stallMs`, not ended within `takeMs` (R353 a: the overall end, what is left of it from the ticket's check),
 * an error, a close before the end, or fewer bytes than declared "cut-off". `whole`: the request's body was read to its
 * end (else the connection is closed after the answer).
 */
function pump(src: Readable, fh: fsp.FileHandle, declared: number | undefined, stallMs: number, takeMs: number): Promise<Received> {
  return new Promise((resolve) => {
    let total = 0;
    const head = Buffer.alloc(PDF_MAGIC.length);
    let headLen = 0;
    let settled = false;
    let ended = false;
    let writing: Promise<unknown> = Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    let overall: NodeJS.Timeout | undefined;
    const settle = (r: Received) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (overall) clearTimeout(overall);
      src.off("data", onData);
      src.off("end", onEnd);
      src.off("error", onFail);
      src.off("aborted", onFail);
      src.off("close", onClose);
      if (!r.ok) {
        src.pause();
        // A late error of a stream no longer read is no one's to throw.
        src.on("error", () => undefined);
      }
      // The answer waits for the pieces already being written (the file is then closed and removed by the caller).
      void writing.then(
        () => resolve(r),
        () => resolve(r.ok ? { ok: false, why: "cut-off", whole: true } : r),
      );
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => settle({ ok: false, why: "cut-off", whole: false }), stallMs);
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      arm();
      total += chunk.length;
      if (total > LIBRARY_FILE_MAX_BYTES) return settle({ ok: false, why: "too-large", whole: false });
      if (headLen < head.length) {
        headLen += chunk.copy(head, headLen, 0, Math.min(chunk.length, head.length - headLen));
        if (headLen === head.length && !head.equals(PDF_MAGIC)) return settle({ ok: false, why: "not-pdf", whole: false });
      }
      src.pause();
      writing = writing
        .then(() => fh.write(chunk))
        .then(() => {
          if (!settled) src.resume();
        });
      writing.catch(() => settle({ ok: false, why: "cut-off", whole: false }));
    };
    const onEnd = () => {
      ended = true;
      void writing.then(
        () => {
          if (headLen < head.length || !head.equals(PDF_MAGIC)) settle({ ok: false, why: "not-pdf", whole: true });
          else if (declared !== undefined && total !== declared) settle({ ok: false, why: "cut-off", whole: true });
          else settle({ ok: true });
        },
        () => settle({ ok: false, why: "cut-off", whole: true }),
      );
    };
    const onFail = () => settle({ ok: false, why: "cut-off", whole: false });
    const onClose = () => {
      if (!ended) settle({ ok: false, why: "cut-off", whole: false });
    };
    src.on("data", onData);
    src.on("end", onEnd);
    src.on("error", onFail);
    src.on("aborted", onFail);
    src.on("close", onClose);
    arm();
    overall = setTimeout(() => settle({ ok: false, why: "cut-off", whole: false }), Math.max(0, takeMs));
    src.resume();
  });
}

/** The body's declared length (a plain number), or undefined. */
function declaredLength(req: FastifyRequest): number | undefined {
  const h = req.headers["content-length"];
  return typeof h === "string" && /^\d{1,15}$/u.test(h) ? Number(h) : undefined;
}

export function registerFindBrowser(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;
  // R47: the stall's time is a test's switch only under NODE_ENV=test or VITEST.
  const testing = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
  const stallMs = testing && ctx.browserStallMs !== undefined ? ctx.browserStallMs : FIND_BROWSER_STALL_MS;
  // R353 a: the body's overall end, counted from the ticket's check (the same switch rule).
  const takeMs = testing && ctx.browserTakeMs !== undefined ? ctx.browserTakeMs : FIND_BROWSER_TAKE_MS;
  /** One file at a time for the whole service (R348 f iii): set from the busy check to the answer. */
  let taking = false;

  const extensionOnly = (req: FastifyRequest) => {
    if (req.caller !== "extension") throw new ApiError(403, "FORBIDDEN", FIND_BROWSER_TEXT.extensionOnly);
  };
  const notWaiting = () => new ApiError(404, "NOT_FOUND", FIND_BROWSER_TEXT.notWaiting, "browser-not-waiting");

  app.post("/find/browser/waiting", { bodyLimit: 1024 }, async (req, reply): Promise<FindBrowserWaitingResponse> => {
    reply.header("Cache-Control", "no-store");
    extensionOnly(req);
    const b: unknown = req.body;
    if (typeof b !== "object" || b === null || Array.isArray(b) || Object.keys(b).length !== 0) throw new ApiError(400, "VALIDATION", FIND_BROWSER_TEXT.listBody);
    // No library open, a read-only one (no runner), nothing waiting, a window's wait, a locked project: none.
    const w = state.session?.find?.browserWaiting() ?? null;
    return { waiting: w ? [{ ticket: w.ticket, label: browserLabel(w.title) }] : [] };
  });

  // The file's route in a plugin of its own: `application/pdf` is parsed here and nowhere else (every other route of
  // the service still refuses it), and no other type is parsed here.
  void app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser("application/pdf", (_req, payload, done) => done(null, payload));
    sub.post("/find/browser/file/:ticket", { bodyLimit: LIBRARY_FILE_MAX_BYTES }, async (req, reply): Promise<FindBrowserFileResponse> => {
      reply.header("Cache-Control", "no-store");
      extensionOnly(req);
      const ticket = paramsOf(req).ticket ?? "";
      // (i) The ticket: the open browser's, before its end; nothing ended or changed. The same answer for every other.
      if (!state.session?.find?.browserTicketWaits(ticket)) throw notWaiting();
      const checkedAt = Date.now();
      // (ii) The tab's address.
      const page = pageOf(req);
      if (!page) throw new ApiError(400, "VALIDATION", FIND_BROWSER_TEXT.page, "browser-page");
      // (iii) One at a time (checked and claimed with no wait since the ticket's check).
      if (taking) throw new ApiError(409, "CONFLICT", FIND_BROWSER_TEXT.busy, "browser-busy");
      taking = true;
      const inbox = browserInboxOf(state.deps.appConfigDir);
      const id = randomBytes(16).toString("hex");
      const path = join(inbox, `${id}.pdf`);
      try {
        // (iv) The body, streamed into the inbox.
        const declared = declaredLength(req);
        // R353 g: the inbox must be a real folder of the service's user with mode 0700 (made so when absent); else
        // nothing is written: 503, a warning without the path, the ticket open (the flag goes in the finally).
        const real = await fsp
          .mkdir(inbox, { recursive: true, mode: 0o700 })
          .then(() => privateInboxReal(inbox))
          .catch(() => null);
        if (!real) {
          req.log.warn("The folder for files from the browser cannot be used (not a private folder of this user); nothing was written.");
          throw new ApiError(503, "UNAVAILABLE", FIND_BROWSER_TEXT.inbox, "browser-inbox");
        }
        const got = await (async (): Promise<Received> => {
          if (declared !== undefined && declared > LIBRARY_FILE_MAX_BYTES) return { ok: false, why: "too-large", whole: false };
          const fh = await fsp.open(join(real, `${id}.pdf`), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
          try {
            const body = req.body as Readable | undefined;
            if (!body || typeof body.on !== "function") return { ok: false, why: "not-pdf", whole: true };
            return await pump(body, fh, declared, stallMs, takeMs - (Date.now() - checkedAt));
          } finally {
            await fh.close().catch(() => undefined);
          }
        })();
        if (!got.ok) {
          // A body not read to its end: the connection goes with the answer (nothing more of it is read).
          if (!got.whole) reply.header("Connection", "close");
          if (got.why === "too-large") throw new ApiError(413, "PAYLOAD_TOO_LARGE", FIND_BROWSER_TEXT.tooLarge, "browser-too-large");
          if (got.why === "not-pdf") throw new ApiError(400, "VALIDATION", FIND_BROWSER_TEXT.notPdf, "browser-not-pdf");
          throw new ApiError(400, "VALIDATION", FIND_BROWSER_TEXT.cutOff, "browser-cut-off");
        }
        // (v) Only now the seam: the ticket ends, the pause starts; cancelled (or the library closed) meanwhile: (i)'s answer.
        const runner = state.session?.find;
        const t = runner ? runner.libraryHandedOver(ticket, "browser") : null;
        if (!runner || !t) throw notWaiting();
        const file: HandedFile = {
          take: async (from, to, maxBytes) => {
            const r = await takeInboxFile(inbox, { id, path: from }, to, { maxBytes });
            return r.ok ? r : { ok: false, why: r.why === "too-large" ? "too-large" : "unreadable" };
          },
          discard: (from) => discardInboxFile(inbox, from),
        };
        const end: FindHandOverEnd = await runner.acceptLibraryFile(t.projectId, t.entryId, path, "browser-extension", page, file);
        // (vi) How it ended.
        if (end.outcome === "held") return { outcome: "held", sentence: FIND_BROWSER_TEXT.held };
        if (end.outcome === "not-kept") return { outcome: "not-kept", sentence: FIND_BROWSER_FILE_TEXT[end.why] };
        return { outcome: "gone", sentence: FIND_BROWSER_TEXT.gone };
      } finally {
        // The inbox's file is removed in every outcome (the runner's take removes it already when it ran).
        await discardInboxFile(inbox, path).catch(() => undefined);
        taking = false;
      }
    });
  });
}
