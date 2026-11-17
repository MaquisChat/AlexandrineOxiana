/**
 * Browser capture (spec 5.1; Task 30 route `POST /capture/browser`, consumed by the Task 31
 * extension): the page as the researcher sees it — a full-page screenshot (PNG) and the HTML
 * snapshot (scripts removed by the extension) — stored as originals with provenance
 * `browser_capture`, and what the extension read from the page stored as `page-dom` field evidence.
 *
 * With `alsoDownload`, the link is first captured with the downloader (link capture, Task 17); the
 * screenshot and HTML are then added to that same source (their capture method evaluated and
 * audited) and the `page-dom` evidence joins its `platform-json` evidence, so the recheck compares
 * the two (disagreements become `conflict`). If the download fails, the page is still stored as its
 * own browser-captured source and the download's outcome is reported.
 *
 * Everything goes through the governed repository; the inputs are written only to a private work
 * folder under the library's `.tmp/` (0700, swept if the process dies).
 *
 * SECURITY (R101, binding for Tasks 33/34): a stored HTML snapshot is only ever rendered in a
 * sandboxed iframe (no allow-scripts, no allow-same-origin, CSP script-src 'none', separate origin
 * or blob), never in the app's webview. See stripHtmlSnapshot.
 */
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { cleanAddress, nonBlank, recheckSourceFile, type FieldEvidence, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { InvalidInputError } from "../repo/errors.js";
import { addCapturedOriginal, projectPolicy, repoLibrary, updateSourceRechecked, type Repo } from "../repo/repo.js";
import { htmlStripWorkerUrl } from "../resources.js";
import { activeTemp } from "../tmp-registry.js";
import { classifyUrl } from "./platforms.js";
import { stripSnapshot } from "./snapshot.js";
import type { CaptureOutcome, LinkCapture } from "./link-capture.js";

export const BROWSER_CAPTURE_LIMITS = {
  /** Decoded screenshot bytes. */
  screenshotBytes: 25 * 1024 * 1024,
  /** HTML snapshot characters (R101 N2). */
  htmlChars: 5 * 1024 * 1024,
  /** Each extracted text field. */
  fieldChars: 20_000,
} as const;

export interface ExtractedPage {
  platform?: string;
  kind?: string;
  canonicalUrl?: string;
  postId?: string;
  handle?: string;
  displayName?: string;
  caption?: string;
  postedAt?: string;
  counts?: { likes?: number; comments?: number; views?: number; shares?: number };
  mediaUrls?: string[];
}

export interface BrowserCaptureInput {
  url: string;
  extracted?: ExtractedPage;
  /** The full-page screenshot, PNG, base64. */
  screenshotPng?: string;
  /** The page's HTML snapshot. */
  html?: string;
  legalBasis?: string;
}

export interface BrowserCaptureResult {
  sourceId: string;
  /** Why the page's HTML was not stored (its screenshot was), if so. */
  htmlNote?: string;
  /** "created": a browser-captured source; "merged": added to the source the downloader made. */
  status: "created" | "merged";
  /** The downloader's outcome, when `alsoDownload` was asked for. */
  download?: CaptureOutcome;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const text = (v: unknown, max: number = BROWSER_CAPTURE_LIMITS.fieldChars): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** Validates the request; TypeError with a plain message when something is wrong. */
function validate(input: BrowserCaptureInput): { url: URL; png?: Buffer; html?: string; ex: ExtractedPage } {
  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new InvalidInputError("url must be a web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidInputError("url must be an http(s) address");
  let png: Buffer | undefined;
  if (input.screenshotPng !== undefined) {
    if (typeof input.screenshotPng !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.screenshotPng)) throw new InvalidInputError("screenshotPng must be base64");
    png = Buffer.from(input.screenshotPng, "base64");
    if (png.length > BROWSER_CAPTURE_LIMITS.screenshotBytes) throw new InvalidInputError("the screenshot is too large");
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new InvalidInputError("the screenshot must be a PNG image");
  }
  if (input.html !== undefined && (typeof input.html !== "string" || input.html.length > BROWSER_CAPTURE_LIMITS.htmlChars)) throw new InvalidInputError("html must be text of at most 5 MB");
  if (!png && !input.html) throw new InvalidInputError("a screenshot or the page's HTML is needed");
  // What the extension read goes through the same stripping as a platform snapshot (R41/R42, R99 I8).
  const e = stripSnapshot((input.extracted ?? {}) as Record<string, unknown>);
  const ex: ExtractedPage = {};
  for (const k of ["platform", "kind", "canonicalUrl", "postId", "handle", "displayName", "caption", "postedAt"] as const) {
    const v = text(e[k]);
    if (v) ex[k] = v;
  }
  return { url, ...(png ? { png } : {}), ...(input.html ? { html: input.html } : {}), ex };
}

const DAY = /^(\d{4}-\d{2}-\d{2})/;

/** The page's data as `page-dom` field evidence (only what the extension read; nothing guessed). */
function pageEvidence(ex: ExtractedPage, at: string): FieldEvidence[] {
  const src = { kind: "page-dom" as const, provider: "browser-extension" };
  const out: FieldEvidence[] = [];
  if (ex.caption) out.push({ field: "/title", value: ex.caption.split("\n")[0]!.slice(0, 500), source: src, quote: ex.caption.slice(0, 2000), at });
  if (ex.handle) out.push({ field: "/creators", value: [{ handle: ex.handle, ...(ex.displayName ? { literal: ex.displayName } : {}), role: "author" }], source: src, at });
  const day = ex.postedAt ? DAY.exec(ex.postedAt)?.[1] : undefined;
  if (day) out.push({ field: "/issued", value: day, source: src, at });
  return out;
}

/** Stores the page; with `linkCapture`, the downloader runs first and the page joins its source. */
export async function captureBrowserPage(
  repo: Repo,
  projectId: string,
  input: BrowserCaptureInput,
  opts: { linkCapture?: LinkCapture } = {},
): Promise<BrowserCaptureResult> {
  const v = validate(input);
  const { url, png, ex } = v;
  let html: string | undefined;
  let htmlNote: string | undefined;
  if (v.html !== undefined) {
    try {
      html = await stripHtmlSnapshot(v.html);
    } catch (err) {
      // The HTML is refused; the screenshot (if any) is still the page as seen (R104).
      if (!(err instanceof HtmlSnapshotRefusedError) || !png) throw err;
      htmlNote = err.message;
    }
  }
  const root = repoLibrary(repo).root;
  const name = `capture-${randomUUID()}`;
  const work = join(root, ".tmp", name);
  activeTemp.add(name);
  try {
    await fsp.mkdir(work, { recursive: true, mode: 0o700 });
    const files: Array<{ path: string; kind: string; ext: string; mime: string; label: string }> = [];
    if (png) {
      const p = join(work, "screenshot.png");
      await fsp.writeFile(p, png, { mode: 0o600 });
      files.push({ path: p, kind: "screenshot", ext: "png", mime: "image/png", label: "page screenshot" });
    }
    if (html) {
      const p = join(work, "page.html");
      await fsp.writeFile(p, html, { mode: 0o600 });
      files.push({ path: p, kind: "html-snapshot", ext: "html", mime: "text/html", label: "page snapshot" });
    }
    const at = new Date().toISOString();
    const evidence = pageEvidence(ex, at);

    let download: CaptureOutcome | undefined;
    if (opts.linkCapture) {
      download = await opts.linkCapture.captureUrl(projectId, url.href, { transcribe: "project-default", ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}) });
      if (download.sourceId && download.status !== "failed") {
        const sourceId = download.sourceId;
        for (const f of files) {
          await addCapturedOriginal(repo, projectId, sourceId, { fromPath: f.path, kind: f.kind, ext: f.ext, mime: f.mime, label: `${f.label} ${at.slice(0, 10)}` }, "browser_capture", {
            platform: classifyUrl(url.href).platform,
          });
        }
        if (evidence.length) {
          await updateSourceRechecked(repo, projectId, sourceId, {}, {
            fieldEvidence: (cur) => [...cur.fieldEvidence, ...evidence],
            verification: (next) => recheckSourceFile(next, {}).verification,
          });
        }
        return { sourceId, status: "merged", download, ...(htmlNote ? { htmlNote } : {}) };
      }
    }

    // A source of its own, captured in the browser.
    const c = classifyUrl(url.href);
    const policy = await projectPolicy(repo, projectId);
    const identifiable = policy?.identifiability.containsIdentifiable ?? true;
    // A blank basis (invisible characters only) is none: core's one `blank()` (R391 c, R415 d).
    const legalBasis = nonBlank(input.legalBasis)?.slice(0, 2000) ?? nonBlank(policy?.consent.defaultLegalBasis?.["social-media"]);
    const social = c.platform !== "other";
    // The title (and so the folder name) from the CLEANED address: a `;jsessionid=…` in the path never reaches it (R391 a).
    const shown = URL.canParse(c.canonicalUrl) ? new URL(c.canonicalUrl) : undefined;
    const title = ex.caption?.split("\n")[0]?.slice(0, 500) || (c.postId ? `${c.platform} post ${c.postId}` : shown ? shown.hostname + shown.pathname : url.hostname);
    const day = ex.postedAt ? DAY.exec(ex.postedAt)?.[1] : undefined;
    const draft: SourceDraft = {
      projectIds: [projectId],
      type: social ? "social-post" : "webpage",
      title: { variants: [{ lang: "und", kind: "original", value: title }] },
      creators: ex.handle ? [{ handle: ex.handle, ...(ex.displayName ? { literal: ex.displayName } : {}), role: "author" }] : [],
      ...(day ? { issued: day } : {}),
      // The platform from the URL ("other" for a web page), so a protocol's platform list applies (R99 I8).
      identifiers: { url: c.canonicalUrl || cleanAddress(url.href), platform: c.platform, ...(c.postId ? { platformPostId: c.postId } : {}) },
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    const provenance: Provenance = {
      captureMethod: "browser_capture",
      capturedAt: at,
      // Never the address as given (R391 f).
      originalUrl: c.canonicalUrl || cleanAddress(url.href),
      tool: { name: "ao-browser-extension", version: "1" },
      fileHashes: {},
      legal: { status: "unknown", ...(legalBasis ? { basis: legalBasis } : {}) },
      identifiable,
      access: "signed-in-session",
    };
    const sf: SourceFile = await repo.createSource(
      projectId,
      draft,
      files.map((f) => ({ path: f.path, role: "original" as const, handling: "copy" as const, kind: f.kind, ext: f.ext, mime: f.mime })),
      { provenance, fieldEvidence: evidence },
    );
    await repo.recheckSource(projectId, sf.source.id);
    return { sourceId: sf.source.id, status: "created", ...(download ? { download } : {}), ...(htmlNote ? { htmlNote } : {}) };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(name);
  }
}

// ------------------------------------------------------------------------------------------
// HTML snapshot stripping (R41/R42 applied to markup; R101 N1/N2, R102 N4)

/** The time budget of one snapshot in its worker (R107), and each worker's heap cap (R104 I2). */
export const HTML_STRIP_TIMEOUT_MS = 10_000;
const HTML_STRIP_HEAP_MB = 256;
/** Workers stripping at the same time; more requests wait their turn (R104 I2) … */
export const HTML_STRIP_MAX_WORKERS = 2;
/** … at most this many (R107); beyond that a snapshot is refused at once (its screenshot kept). */
export const HTML_STRIP_MAX_WAITING = 8;
/** A page that ran out of time is refused at once if sent again within this long (R107). */
export const HTML_STRIP_RETRY_AFTER_TIMEOUT_MS = 10 * 60_000;
/** Test seam: the time budget in force (HTML_STRIP_TIMEOUT_MS). */
export const htmlStripTuning = { timeoutMs: HTML_STRIP_TIMEOUT_MS };

/** The page's HTML was not stored (too large or deep, or markup that does not settle); the screenshot still is. */
export class HtmlSnapshotRefusedError extends InvalidInputError {
  override name = "HtmlSnapshotRefusedError";
}

let active = 0;
let peak = 0;
let started = 0;
const waiting: Array<() => void> = [];
/** Pages (sha256 of their HTML) that ran out of time, and when (R107). */
const timedOut = new Map<string, number>();

/** Workers running now, the most seen at once, those waiting, and workers started so far (tests, diagnostics). */
export function htmlStripStats(): { active: number; peak: number; queued: number; started: number } {
  return { active, peak, queued: waiting.length, started };
}

const BUSY = "The service is busy, so the page's HTML was not kept; its screenshot was.";
const TIMED_OUT = "The page's HTML could not be processed in time, so only its screenshot was kept.";

async function slot(): Promise<() => void> {
  if (active >= HTML_STRIP_MAX_WORKERS) {
    if (waiting.length >= HTML_STRIP_MAX_WAITING) throw new HtmlSnapshotRefusedError(BUSY);
    await new Promise<void>((r) => waiting.push(r));
  }
  active++;
  peak = Math.max(peak, active);
  return () => {
    active--;
    waiting.shift()?.();
  };
}

function runWorker(html: string, hash: string): Promise<string> {
  return new Promise((resolve, reject) => {
    started++;
    const worker = new Worker(htmlStripWorkerUrl(), { workerData: { html }, resourceLimits: { maxOldGenerationSizeMb: HTML_STRIP_HEAP_MB } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          timedOut.set(hash, Date.now());
          reject(new HtmlSnapshotRefusedError(TIMED_OUT));
        }),
      htmlStripTuning.timeoutMs,
    );
    worker.once("message", (m: { ok: boolean; html?: string; refused?: boolean; reason?: string }) =>
      finish(() =>
        m.ok && typeof m.html === "string"
          ? resolve(m.html)
          : reject(new HtmlSnapshotRefusedError(m.refused ? `The page's HTML was not kept (${m.reason ?? "refused"}); its screenshot was.` : "The page's HTML could not be processed, so only its screenshot was kept.")),
      ),
    );
    worker.once("error", () => finish(() => reject(new HtmlSnapshotRefusedError("The page's HTML could not be processed, so only its screenshot was kept."))));
    worker.once("exit", () => finish(() => reject(new HtmlSnapshotRefusedError("The page's HTML could not be processed, so only its screenshot was kept."))));
  });
}

/**
 * The page's HTML as stored (html-strip.mjs: pre-scan limits, parse5 to a fixpoint, CSP meta first
 * in its head), in a worker thread from a pool of HTML_STRIP_MAX_WORKERS so a large or adversarial
 * page never blocks the service's event loop or its memory. Each snapshot has HTML_STRIP_TIMEOUT_MS;
 * at most HTML_STRIP_MAX_WAITING wait for a worker, and a page that ran out of time is refused at
 * once for HTML_STRIP_RETRY_AFTER_TIMEOUT_MS (R107). HtmlSnapshotRefusedError when not kept.
 *
 * Archived snapshots are only ever rendered in a sandboxed iframe — no allow-scripts, no
 * allow-same-origin, CSP `script-src 'none'`, served from a separate origin or a blob — never in
 * the app's webview (R101, binding for Tasks 33/34). This stripping is defence in depth.
 */
export async function stripHtmlSnapshot(html: string): Promise<string> {
  const hash = createHash("sha256").update(html).digest("hex");
  const now = Date.now();
  for (const [h, at] of timedOut) if (now - at >= HTML_STRIP_RETRY_AFTER_TIMEOUT_MS) timedOut.delete(h);
  if (timedOut.has(hash)) throw new HtmlSnapshotRefusedError("The page's HTML ran out of time recently, so only its screenshot was kept.");
  const release = await slot();
  try {
    return await runWorker(html, hash);
  } finally {
    release();
  }
}
