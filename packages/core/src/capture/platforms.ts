/**
 * Recognizing YouTube, Instagram and TikTok links (spec 5.1). Pure: never touches the network. Short
 * links (`vm.tiktok.com`) stay `unknown` and are resolved by the download tool.
 *
 * The one definition (R146, Task 63): the library captures by it, the service checks the extension's
 * link lists by it, and the interface previews pasted links by it (a hint there; the service decides).
 * No Node or DOM APIs beyond the WHATWG URL, which both have.
 */

/** Longest address the service accepts (routes/capture.ts). */
export const MAX_ADDRESS_LENGTH = 2048;

/** What may be sent for capture at all: http or https with a host, at most 2048 characters. */
export function isWebAddress(u: string): boolean {
  if (typeof u !== "string" || u.length > MAX_ADDRESS_LENGTH || !/^https?:\/\//i.test(u)) return false;
  try {
    const p = new URL(u);
    return (p.protocol === "http:" || p.protocol === "https:") && p.hostname.length > 0;
  } catch {
    return false;
  }
}

export type Platform = "youtube" | "instagram" | "tiktok" | "other";
export type LinkKind = "video" | "short" | "post" | "reel" | "carousel" | "story-highlight" | "playlist" | "profile" | "unknown";

export interface ClassifiedUrl {
  platform: Platform;
  kind: LinkKind;
  /** The link without tracking parameters or fragment (platform links in their canonical form). */
  canonicalUrl: string;
  postId?: string;
  handle?: string;
}

/** The kinds that name one post or video (R116: all a list of links may hold). */
const POST_KINDS: ReadonlySet<LinkKind> = new Set<LinkKind>(["video", "short", "post", "reel", "carousel"]);

/** A whole profile, channel or playlist: captured as a profile run (`captureProfile`), never as one link. */
export function isCollectionLink(c: ClassifiedUrl): boolean {
  return c.kind === "profile" || c.kind === "playlist";
}

/** One post or video on a known platform. */
export function isPostLink(c: ClassifiedUrl): boolean {
  return c.platform !== "other" && POST_KINDS.has(c.kind);
}

/** Query parameters that only track how a link was shared. */
const TRACKING = /^(utm_.*|igsh|igshid|si|feature|fbclid|gclid|mc_cid|mc_eid|is_from_webapp|sender_device|sender_web_id|_r|_t)$/i;

/** Instagram paths that are not profiles. */
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "developer", "legal", "web", "api"]);
const YT_ID = /^[\w-]{6,}$/;

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, "");
}

/** Strips tracking parameters and the fragment; everything else is kept as given. */
function stripTracking(u: URL): string {
  const out = new URL(u.href);
  out.hash = "";
  for (const k of [...out.searchParams.keys()]) if (TRACKING.test(k)) out.searchParams.delete(k);
  out.hostname = out.hostname.toLowerCase();
  return out.href;
}

/** A handle segment decoded, or undefined when its percent escapes are malformed (R379: not a handle). */
function decodeHandle(seg: string): string | undefined {
  try {
    return decodeURIComponent(seg);
  } catch {
    return undefined;
  }
}

function youtube(u: URL, host: string): ClassifiedUrl {
  const seg = u.pathname.split("/").filter(Boolean);
  const unknown: ClassifiedUrl = { platform: "youtube", kind: "unknown", canonicalUrl: stripTracking(u) };
  if (host === "youtu.be") {
    const id = seg[0];
    return id && YT_ID.test(id) ? { platform: "youtube", kind: "video", canonicalUrl: `https://www.youtube.com/watch?v=${id}`, postId: id } : unknown;
  }
  const list = u.searchParams.get("list") ?? undefined;
  if (seg[0] === "watch") {
    const id = u.searchParams.get("v") ?? "";
    if (!YT_ID.test(id)) return unknown;
    const q = new URLSearchParams({ v: id });
    if (list) q.set("list", list);
    return { platform: "youtube", kind: "video", canonicalUrl: `https://www.youtube.com/watch?${q}`, postId: id };
  }
  if ((seg[0] === "shorts" || seg[0] === "live" || seg[0] === "embed") && seg[1] && YT_ID.test(seg[1])) {
    const id = seg[1];
    return seg[0] === "shorts"
      ? { platform: "youtube", kind: "short", canonicalUrl: `https://www.youtube.com/shorts/${id}`, postId: id }
      : { platform: "youtube", kind: "video", canonicalUrl: `https://www.youtube.com/watch?v=${id}`, postId: id };
  }
  if (seg[0] === "playlist" && list) {
    return { platform: "youtube", kind: "playlist", canonicalUrl: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` };
  }
  const handle = seg[0]?.startsWith("@") && seg[0].length > 1 ? decodeHandle(seg[0]) : undefined;
  if (handle !== undefined) {
    return { platform: "youtube", kind: "profile", canonicalUrl: `https://www.youtube.com/${seg[0]}`, handle };
  }
  if ((seg[0] === "channel" || seg[0] === "c" || seg[0] === "user") && seg[1]) {
    return { platform: "youtube", kind: "profile", canonicalUrl: `https://www.youtube.com/${seg[0]}/${seg[1]}` };
  }
  return unknown;
}

function instagram(u: URL): ClassifiedUrl {
  const seg = u.pathname.split("/").filter(Boolean);
  const unknown: ClassifiedUrl = { platform: "instagram", kind: "unknown", canonicalUrl: stripTracking(u) };
  // `/<handle>/p/<code>/` and `/<handle>/reel/<code>/` are newer forms of the same links.
  const i = seg[1] === "p" || seg[1] === "reel" || seg[1] === "reels" ? 1 : 0;
  const [a, b] = [seg[i], seg[i + 1]];
  if ((a === "p" || a === "tv") && b) return { platform: "instagram", kind: a === "tv" ? "video" : "post", canonicalUrl: `https://www.instagram.com/${a}/${b}/`, postId: b };
  if ((a === "reel" || a === "reels") && b) return { platform: "instagram", kind: "reel", canonicalUrl: `https://www.instagram.com/reel/${b}/`, postId: b };
  if (seg[0] === "stories" && seg[1] === "highlights" && seg[2]) {
    return { platform: "instagram", kind: "story-highlight", canonicalUrl: `https://www.instagram.com/stories/highlights/${seg[2]}/`, postId: seg[2] };
  }
  if (seg.length === 1 && !IG_RESERVED.has(seg[0]!.toLowerCase()) && /^[\w.]+$/.test(seg[0]!)) {
    return { platform: "instagram", kind: "profile", canonicalUrl: `https://www.instagram.com/${seg[0]}/`, handle: seg[0]! };
  }
  return unknown;
}

function tiktok(u: URL, host: string): ClassifiedUrl {
  const seg = u.pathname.split("/").filter(Boolean);
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    // A short link: the tool follows the redirect; its post id is known only after the download.
    return { platform: "tiktok", kind: "unknown", canonicalUrl: seg[0] ? `https://${host}/${seg[0]}/` : stripTracking(u) };
  }
  const unknown: ClassifiedUrl = { platform: "tiktok", kind: "unknown", canonicalUrl: stripTracking(u) };
  if (!seg[0]?.startsWith("@") || seg[0].length < 2) return unknown;
  const handle = decodeHandle(seg[0]);
  if (handle === undefined) return unknown;
  if ((seg[1] === "video" || seg[1] === "photo") && seg[2] && /^\d+$/.test(seg[2])) {
    return {
      platform: "tiktok",
      kind: seg[1] === "video" ? "video" : "carousel",
      canonicalUrl: `https://www.tiktok.com/${seg[0]}/${seg[1]}/${seg[2]}`,
      postId: seg[2],
      handle,
    };
  }
  if (seg.length === 1) return { platform: "tiktok", kind: "profile", canonicalUrl: `https://www.tiktok.com/${seg[0]}`, handle };
  return unknown;
}

/**
 * The platform and kind of `url`. Never throws, for any input (R379): an input that cannot be read
 * as an address, or anything unexpected while reading it, is the generic "other / unknown" with the
 * input as given.
 */
export function classifyUrl(url: string): ClassifiedUrl {
  const raw = typeof url === "string" ? url.trim() : "";
  try {
    return classify(raw);
  } catch {
    return { platform: "other", kind: "unknown", canonicalUrl: raw };
  }
}

function classify(raw: string): ClassifiedUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { platform: "other", kind: "unknown", canonicalUrl: raw };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { platform: "other", kind: "unknown", canonicalUrl: raw };
  const host = hostOf(u);
  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") return youtube(u, host);
  if (host === "instagram.com") return instagram(u);
  if (host === "tiktok.com" || host === "vm.tiktok.com" || host === "vt.tiktok.com") return tiktok(u, host);
  return { platform: "other", kind: "unknown", canonicalUrl: stripTracking(u) };
}
