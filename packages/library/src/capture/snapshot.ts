/**
 * The platform's metadata JSON (yt-dlp info JSON, gallery-dl metadata) → the stored snapshot and a
 * SourceDraft with field evidence (spec 5.1, 5.8).
 *
 * The stored snapshot (`stripSnapshot`) never keeps:
 * - request headers, cookies, tokens, signatures, sessions, passwords, credentials or JWTs: any key
 *   one of whose words (split on `_ - .` and camelCase) is in SECRET_WORDS, or that has the word pair
 *   api/access/private/secret + key (a bare `key`, e.g. `extractor_key`, is kept), plus
 *   `headers`/`http_headers`;
 * - signed, expiring or tracking media links: `url`, `formats`, `requested_*`, `subtitles`,
 *   `automatic_captions`, `thumbnail(s)`, `manifest_url`, `fragment_base_url`, `fragments`,
 *   gallery-dl's `display_url`/`video_url`;
 * - the tool's local file paths (`filepath`, `*_filename`, `__*`, and any string value that starts
 *   with the home folder, a temp folder or the library);
 * and every remaining string that is an http(s) URL loses its query and fragment (a platform page
 * link becomes its canonical form, which keeps only YouTube's `v`/`list`).
 */
import { homedir, tmpdir } from "node:os";
import type { FieldEvidence, SourceDraft } from "@ao/core";
import type { ClassifiedUrl } from "./platforms.js";
import { classifyUrl } from "./platforms.js";

export type CaptureTool = "yt-dlp" | "gallery-dl";

const DROP_KEYS = new Set([
  "formats", "http_headers", "headers", "_http_headers", "filepath", "filename", "infojson_filename",
  "url", "manifest_url", "fragment_base_url", "fragments", "subtitles", "automatic_captions",
  "thumbnail", "thumbnails", "display_url", "video_url",
]);
const SECRET_WORDS = new Set([
  "cookie", "cookies", "token", "tokens", "auth", "authorization", "authentication", "bearer", "csrf", "xsrf",
  "password", "passwd", "secret", "signature", "sig", "session", "sessionid", "apikey", "accesskey", "privatekey", "secretkey",
  "credential", "credentials", "jwt",
]);
/** Words that name a secret when directly followed by `key` (`api_key`, `AccessKeyId`); a bare `key` is kept (`extractor_key`). */
const KEY_PREFIXES = new Set(["api", "access", "private", "secret"]);
/** Absolute paths that point into a user's home, a temp folder or a library (never stored). */
const LOCAL_PATH = /^(\/home\/|\/Users\/|\/root\/|\/tmp\/|\/var\/folders\/|\/private\/(var|tmp)\/|[A-Za-z]:\\(Users|Windows\\Temp)\\|~\/)/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The words of a key: split on `_`, `-`, `.` and camelCase, lower-cased. */
export function keyWords(k: string): string[] {
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function dropKey(k: string): boolean {
  const lower = k.toLowerCase();
  if (DROP_KEYS.has(lower) || lower.startsWith("requested_") || k.startsWith("__") || lower.endsWith("_filename") || lower.endsWith("_filepath")) return true;
  const words = keyWords(k);
  return words.some((w, i) => SECRET_WORDS.has(w) || (w === "key" && i > 0 && KEY_PREFIXES.has(words[i - 1]!)));
}

/** A URL without credentials, query or fragment; a platform page link in its canonical form. */
function cleanUrl(s: string): string | undefined {
  if (!/^https?:\/\/\S+$/i.test(s)) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const c = classifyUrl(s);
  if (c.platform !== "other" && c.kind !== "unknown") return c.canonicalUrl;
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export interface StripOptions {
  /** Further absolute folders whose paths must not be stored (e.g. the library root). */
  localPrefixes?: string[];
}

/** A deep copy without anything that must never be stored (see the module comment). */
export function stripSnapshot<T>(value: T, opts: StripOptions = {}): T {
  const prefixes = [homedir(), tmpdir(), ...(opts.localPrefixes ?? [])].filter((p) => p && p.length > 1);
  const local = (s: string) => LOCAL_PATH.test(s) || prefixes.some((p) => s.startsWith(p));
  const DROP = Symbol("drop");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return local(v) ? DROP : (cleanUrl(v) ?? v);
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== DROP);
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (dropKey(k)) continue;
        const w = walk(x);
        if (w !== DROP) out[k] = w;
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);

/** gallery-dl dates are UTC `YYYY-MM-DD HH:MM:SS`. */
function gdlTimestamp(v: unknown): number | undefined {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v) : null;
  if (!m) return undefined;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * The snapshot used for verification and kept in provenance: the stripped platform JSON plus the
 * identity keys the checks read (`id`, `owner_username`, `timestamp`) when the tool names them
 * differently. Added keys are derived only from the tool's own fields, and never overwrite.
 */
export function verificationSnapshot(stripped: Record<string, unknown>, c: ClassifiedUrl, tool: CaptureTool): Record<string, unknown> {
  const s: Record<string, unknown> = { ...stripped };
  const add = (k: string, v: unknown) => {
    if (s[k] === undefined && v !== undefined) s[k] = v;
  };
  if (tool === "gallery-dl") {
    const author = isRecord(s.author) ? s.author : {};
    add("id", str(s.post_shortcode) ?? (c.kind === "story-highlight" ? c.postId : undefined) ?? str(s.shortcode) ?? str(s.id));
    add("owner_username", str(s.username) ?? str(author.uniqueId));
    add("timestamp", gdlTimestamp(s.post_date) ?? gdlTimestamp(s.date) ?? (typeof s.createTime === "number" ? s.createTime : undefined));
    add("description", str(s.desc));
  }
  if (c.platform === "tiktok") add("owner_username", str(s.uploader)); // TikTok's uploader is the handle; uploader_id is numeric
  return s;
}

export function firstLine(text: string | undefined, max = 120): string | undefined {
  const line = text?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length <= max ? line : chars.slice(0, max).join("").trimEnd();
}

function language(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(v)) return "und";
  try {
    return Intl.getCanonicalLocales(v)[0] ?? "und";
  } catch {
    return "und";
  }
}

function utcDate(ts: number): string | undefined {
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export interface DraftResult {
  draft: SourceDraft;
  evidence: FieldEvidence[];
  postId?: string;
  canonicalUrl: string;
}

/**
 * Builds the draft from the verification snapshot. Every value comes from the platform JSON and
 * carries `platform-json` evidence with the JSON path it was read from.
 */
export function buildDraft(snap: Record<string, unknown>, raw: Record<string, unknown>, c: ClassifiedUrl, tool: CaptureTool, at: string): DraftResult {
  const evidence: FieldEvidence[] = [];
  const ev = (field: string, value: unknown, ref: string) => evidence.push({ field, value, source: { kind: "platform-json", provider: tool, ref }, at });
  const p = c.platform === "other" ? "other" : c.platform;

  // Title: YouTube's title; elsewhere the caption's first line (max 120 characters).
  let title: string | undefined;
  if (p === "youtube") {
    title = str(snap.title) ?? str(snap.fulltitle);
    if (title) ev("/title", title, str(snap.title) ? "/title" : "/fulltitle");
  } else {
    const key = str(raw.description) ? "description" : str(raw.desc) ? "desc" : str(raw.caption) ? "caption" : undefined;
    title = key ? firstLine(raw[key] as string) : undefined;
    if (title) ev("/title", title, `/${key}`);
    else if ((title = str(snap.title))) ev("/title", title, "/title");
  }
  const lang = language(snap.language);

  // Creator: display name plus handle.
  let handle: string | undefined;
  let handleRef: string | undefined;
  let name: string | undefined;
  let nameRef: string | undefined;
  /** First present value among JSON paths (`author/uniqueId` reads nested objects). */
  const pick = (paths: string[]): [string | undefined, string | undefined] => {
    for (const path of paths) {
      let cur: unknown = raw;
      for (const k of path.split("/")) cur = isRecord(cur) ? cur[k] : undefined;
      const v = str(cur);
      if (v) return [v, `/${path}`];
    }
    return [undefined, undefined];
  };
  if (p === "youtube") {
    [name, nameRef] = pick(["channel", "uploader"]);
    [handle, handleRef] = pick(["uploader_id"]);
  } else if (p === "tiktok") {
    [name, nameRef] = pick(["channel", "author/nickname", "creator"]);
    [handle, handleRef] = pick(["uploader", "author/uniqueId"]);
  } else if (tool === "gallery-dl") {
    [name, nameRef] = pick(["fullname"]);
    [handle, handleRef] = pick(["username", "owner_username"]);
  } else {
    [name, nameRef] = pick(["uploader"]);
    [handle, handleRef] = pick(["uploader_id", "owner_username", "channel"]);
  }
  const creators: SourceDraft["creators"] = [];
  if (name || handle) {
    creators.push({ ...(name ? { literal: name } : {}), role: p === "youtube" ? "channel" : "uploader", ...(handle ? { handle } : {}) });
    ev("/creators", creators, handleRef ?? nameRef!);
  }

  // Date: the timestamp (UTC), else upload_date; every date the platform gives is evidence.
  let issued: string | undefined;
  const tsKey = typeof raw.timestamp === "number" ? "timestamp" : raw.post_date ? "post_date" : raw.date ? "date" : typeof raw.createTime === "number" ? "createTime" : undefined;
  const ts = typeof snap.timestamp === "number" ? snap.timestamp : undefined;
  if (ts !== undefined && tsKey) {
    issued = utcDate(ts);
    if (issued) ev("/issued", issued, `/${tsKey}`);
  }
  const ud = typeof snap.upload_date === "string" ? /^(\d{4})(\d{2})(\d{2})$/.exec(snap.upload_date) : null;
  if (ud) {
    const d = `${ud[1]}-${ud[2]}-${ud[3]}`;
    issued ??= d;
    ev("/issued", d, "/upload_date");
  }

  // Identity: the post id and the link.
  const idRef = tool === "gallery-dl" ? (str(raw.post_shortcode) ? "/post_shortcode" : str(raw.shortcode) ? "/shortcode" : "/id") : "/id";
  const postId = str(snap.id) ?? c.postId;
  if (postId && str(snap.id)) ev("/identifiers/platformPostId", postId, idRef);
  let url = c.canonicalUrl;
  const pageKey = str(raw.webpage_url) ? "webpage_url" : str(raw.post_url) ? "post_url" : undefined;
  if (pageKey) {
    const page = classifyUrl(raw[pageKey] as string);
    if (page.platform === c.platform && page.postId && page.postId === postId) url = page.canonicalUrl;
  }
  if (pageKey) ev("/identifiers/url", url, `/${pageKey}`);

  const type: SourceDraft["type"] = p === "instagram" || c.kind === "carousel" ? "social-post" : "video";
  const draft: SourceDraft = {
    projectIds: [],
    type,
    title: { variants: [{ lang, kind: "original", value: title ?? "" }] },
    creators,
    ...(issued ? { issued } : {}),
    accessed: at,
    identifiers: { platform: p, ...(postId ? { platformPostId: postId } : {}), url },
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
  };
  return { draft, evidence, ...(postId ? { postId } : {}), canonicalUrl: url };
}
