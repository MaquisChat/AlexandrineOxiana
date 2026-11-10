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
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { recheckSourceFile, type FieldEvidence, type Provenance, type SourceDraft, type SourceFile } from "@ao/core";
import { InvalidInputError } from "../repo/errors.js";
import { addCapturedOriginal, projectPolicy, repoLibrary, updateSourceRechecked, type Repo } from "../repo/repo.js";
import { activeTemp } from "../tmp-registry.js";
import { classifyUrl } from "./platforms.js";
import { keyWords, stripSnapshot } from "./snapshot.js";
import type { CaptureOutcome, LinkCapture } from "./link-capture.js";

export const BROWSER_CAPTURE_LIMITS = {
  /** Decoded screenshot bytes. */
  screenshotBytes: 25 * 1024 * 1024,
  /** HTML snapshot characters. */
  htmlChars: 10 * 1024 * 1024,
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
  if (input.html !== undefined && (typeof input.html !== "string" || input.html.length > BROWSER_CAPTURE_LIMITS.htmlChars)) throw new InvalidInputError("html must be text of at most 10 MB");
  if (!png && !input.html) throw new InvalidInputError("a screenshot or the page's HTML is needed");
  // What the extension read goes through the same stripping as a platform snapshot (R41/R42, R99 I8).
  const e = stripSnapshot((input.extracted ?? {}) as Record<string, unknown>);
  const ex: ExtractedPage = {};
  for (const k of ["platform", "kind", "canonicalUrl", "postId", "handle", "displayName", "caption", "postedAt"] as const) {
    const v = text(e[k]);
    if (v) ex[k] = v;
  }
  return { url, ...(png ? { png } : {}), ...(input.html ? { html: stripHtmlSnapshot(input.html) } : {}), ex };
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
  const { url, png, html, ex } = validate(input);
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
        return { sourceId, status: "merged", download };
      }
    }

    // A source of its own, captured in the browser.
    const c = classifyUrl(url.href);
    const policy = await projectPolicy(repo, projectId);
    const identifiable = policy?.identifiability.containsIdentifiable ?? true;
    const legalBasis = text(input.legalBasis, 2000) ?? policy?.consent.defaultLegalBasis?.["social-media"]?.trim() ?? undefined;
    const social = c.platform !== "other";
    const title = ex.caption?.split("\n")[0]?.slice(0, 500) || (c.postId ? `${c.platform} post ${c.postId}` : url.hostname + url.pathname);
    const day = ex.postedAt ? DAY.exec(ex.postedAt)?.[1] : undefined;
    const draft: SourceDraft = {
      projectIds: [projectId],
      type: social ? "social-post" : "webpage",
      title: { variants: [{ lang: "und", kind: "original", value: title }] },
      creators: ex.handle ? [{ handle: ex.handle, ...(ex.displayName ? { literal: ex.displayName } : {}), role: "author" }] : [],
      ...(day ? { issued: day } : {}),
      // The platform from the URL ("other" for a web page), so a protocol's platform list applies (R99 I8).
      identifiers: { url: c.canonicalUrl || url.href, platform: c.platform, ...(c.postId ? { platformPostId: c.postId } : {}) },
      caseAttributes: {},
      availability: { status: "available" },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
    };
    const provenance: Provenance = {
      captureMethod: "browser_capture",
      capturedAt: at,
      originalUrl: c.canonicalUrl || url.href,
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
    return { sourceId: sf.source.id, status: "created", ...(download ? { download } : {}) };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(name);
  }
}

// ------------------------------------------------------------------------------------------
// HTML snapshot stripping (R41/R42 applied to the page's HTML)

/** Words that make an attribute, meta or form field a credential (same rule as snapshot keys). */
const SECRET_WORDS = new Set(["csrf", "xsrf", "token", "tokens", "auth", "authorization", "session", "sessionid", "password", "passwd", "secret", "signature", "sig", "nonce", "jwt", "credential", "credentials", "apikey", "cookie", "cookies"]);
const secretName = (n: string) => keyWords(n).some((w) => SECRET_WORDS.has(w)) || /^authenticity_token$/i.test(n);
const URL_ATTRS = new Set(["href", "src", "action", "poster", "data-src", "data-href", "formaction", "cite", "background"]);
const ATTR = /([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g;

/** An http(s) link without its query and fragment (signed, expiring or tracking parameters). */
function bareUrl(v: string): string {
  const m = /^(\s*https?:\/\/[^?#\s]*)[?#][^\s]*/i.exec(v);
  return m ? m[1]! : v;
}

function cleanTag(tag: string): string {
  const m = /^<\s*([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)(\/?)>$/.exec(tag);
  if (!m) return tag; // closing tags, comments, doctype: kept as they are
  const name = m[1]!.toLowerCase();
  const attrs: Array<[string, string | undefined]> = [];
  for (const a of m[2]!.matchAll(ATTR)) {
    const raw = a[2];
    const value = raw === undefined ? undefined : raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    attrs.push([a[1]!, value]);
  }
  const get = (k: string) => attrs.find(([n]) => n.toLowerCase() === k)?.[1];
  // A meta or form field carrying a token is dropped whole.
  if (name === "meta" && secretName(get("name") ?? get("property") ?? get("http-equiv") ?? "")) return "";
  if (name === "input" && (secretName(get("name") ?? "") || (get("type") ?? "").toLowerCase() === "password")) return "";
  const out: string[] = [];
  for (const [k, v] of attrs) {
    const lk = k.toLowerCase();
    if (lk.startsWith("on")) continue; // inline event handlers
    if (lk === "nonce" || lk === "integrity" || secretName(lk.replace(/^data-/, ""))) continue;
    if (v === undefined) {
      out.push(k);
      continue;
    }
    let val = v;
    if (URL_ATTRS.has(lk)) val = bareUrl(val);
    else if (lk === "srcset") val = val.split(",").map((p) => bareUrl(p.trim()).trim() + (p.trim().split(/\s+/)[1] ? ` ${p.trim().split(/\s+/)[1]}` : "")).join(", ");
    else if (/^\s*javascript:/i.test(val)) val = "";
    out.push(`${k}="${val.replace(/"/g, "&quot;")}"`);
  }
  return `<${m[1]}${out.length ? ` ${out.join(" ")}` : ""}${m[3]}>`;
}

/**
 * The page's HTML as stored: scripts removed (with their contents; an unclosed one to the end),
 * inline event handlers, nonces and `javascript:` links dropped, meta tags and form fields that
 * carry tokens or passwords removed, and links lose their query and fragment (signed or tracking
 * parameters). Linear in the input's length.
 */
export function stripHtmlSnapshot(html: string): string {
  // 1. Scripts, found case-insensitively by position (no backtracking).
  const lower = html.toLowerCase();
  let noScripts = "";
  let i = 0;
  for (;;) {
    const open = lower.indexOf("<script", i);
    if (open < 0) {
      noScripts += html.slice(i);
      break;
    }
    noScripts += html.slice(i, open);
    const close = lower.indexOf("</script", open + 7);
    if (close < 0) break;
    const end = lower.indexOf(">", close);
    i = end < 0 ? html.length : end + 1;
  }
  // 2. Every remaining tag, attribute by attribute.
  return noScripts.replace(/<[^<>]*>/g, cleanTag);
}
