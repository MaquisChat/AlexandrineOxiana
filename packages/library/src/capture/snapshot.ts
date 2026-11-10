/**
 * The platform's metadata JSON (yt-dlp info JSON, gallery-dl metadata) → the stored snapshot and a
 * SourceDraft with field evidence (spec 5.1, 5.8).
 *
 * The stored snapshot drops what must never be kept: request headers, cookies, format/URL lists
 * with signed links, the tool's local file paths, and any key whose name contains cookie, token,
 * auth or header (at any depth).
 */
import type { FieldEvidence, SourceDraft } from "@ao/core";
import type { ClassifiedUrl } from "./platforms.js";
import { classifyUrl } from "./platforms.js";

export type CaptureTool = "yt-dlp" | "gallery-dl";

const DROP_KEYS = new Set(["formats", "http_headers", "cookies", "filepath", "filename", "_filename", "infojson_filename", "thumbnail_filepath"]);
const DROP_PATTERN = /cookie|token|auth|header/i;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function dropKey(k: string): boolean {
  return DROP_KEYS.has(k) || k.startsWith("requested_") || k.startsWith("__") || k.endsWith("_filename") || DROP_PATTERN.test(k);
}

/** A deep copy without the keys that must never be stored (see the module comment). */
export function stripSnapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSnapshot(v)) as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!dropKey(k)) out[k] = stripSnapshot(v);
    return out as T;
  }
  return value;
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
    add("id", str(s.post_shortcode) ?? (c.kind === "story-highlight" ? c.postId : undefined) ?? str(s.shortcode) ?? str(s.id));
    add("owner_username", str(s.username));
    add("timestamp", gdlTimestamp(s.post_date) ?? gdlTimestamp(s.date));
  }
  if (c.platform === "tiktok") add("owner_username", str(s.uploader)); // TikTok's uploader is the handle; uploader_id is numeric
  return s;
}

function firstLine(text: string | undefined, max = 120): string | undefined {
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
    const key = str(snap.description) ? "description" : str(snap.caption) ? "caption" : undefined;
    title = key ? firstLine(snap[key] as string) : undefined;
    if (title) ev("/title", title, `/${key}`);
    else if ((title = str(snap.title))) ev("/title", title, "/title");
  }
  const lang = language(snap.language);

  // Creator: display name plus handle.
  let handle: string | undefined;
  let handleRef: string | undefined;
  let name: string | undefined;
  let nameRef: string | undefined;
  const pick = (keys: string[]): [string | undefined, string | undefined] => {
    for (const k of keys) {
      const v = str(raw[k]) ?? str(snap[k]);
      if (v) return [v, `/${k}`];
    }
    return [undefined, undefined];
  };
  if (p === "youtube") {
    [name, nameRef] = pick(["channel", "uploader"]);
    [handle, handleRef] = pick(["uploader_id"]);
  } else if (p === "tiktok") {
    [name, nameRef] = pick(["channel", "creator"]);
    [handle, handleRef] = pick(["uploader", "owner_username"]);
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
  const tsKey = typeof raw.timestamp === "number" ? "timestamp" : raw.post_date ? "post_date" : raw.date ? "date" : undefined;
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
