/**
 * Reading a profile enumeration (spec 5.5): yt-dlp's flat playlist info JSON (TikTok, YouTube) or
 * gallery-dl's per-post metadata (Instagram) → the profile's details and its list of posts, and the
 * dated profile snapshot (display name, bio, links, avatar, counts, verification) that is stored.
 *
 * Everything returned here comes from the platform JSON. Stored values go through `stripSnapshot`
 * (no secrets, no local paths; links lose their query and fragment).
 */
import type { ClassifiedUrl, Platform } from "./platforms.js";
import { classifyUrl } from "./platforms.js";
import { stripSnapshot, type CaptureTool } from "./snapshot.js";

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface ProfileMeta {
  /** As the platform shows it: `@name` on YouTube and TikTok, `name` on Instagram. */
  handle?: string;
  displayName?: string;
  bio?: string;
  links: string[];
  avatar?: string;
  followers?: number;
  following?: number;
  posts?: number;
  verified?: boolean;
}

export interface ProfileEntry {
  /** The platform's post id (YouTube video id, TikTok id, Instagram shortcode). */
  id: string;
  /** The post's canonical link (no query, except YouTube's `v`). */
  url: string;
  /** The caption as listed (undefined when the listing has none). */
  caption?: string;
  /** The title as listed (YouTube). */
  title?: string;
  /** Unix seconds, when listed. */
  timestamp?: number;
  /** The listing's own JSON for this post. */
  raw: Record<string, unknown>;
}

/** gallery-dl dates are UTC `YYYY-MM-DD HH:MM:SS`. */
function gdlTime(v: unknown): number | undefined {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v) : null;
  if (!m) return undefined;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
  return Number.isFinite(t) ? t : undefined;
}

/** The caption of a post's platform JSON (description, TikTok's desc, or caption). */
export function captionOf(raw: Record<string, unknown>): string | undefined {
  for (const k of ["description", "desc", "caption"]) if (typeof raw[k] === "string") return raw[k] as string;
  return undefined;
}

/** A post's canonical link from its id when the listing's own link is not usable. */
export function postUrl(platform: Platform, id: string, handle: string | undefined): string | undefined {
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  if (platform === "instagram") return `https://www.instagram.com/p/${encodeURIComponent(id)}/`;
  if (platform === "tiktok" && handle) return `https://www.tiktok.com/@${handle.replace(/^@+/, "")}/video/${encodeURIComponent(id)}`;
  return undefined;
}

function entryLink(platform: Platform, id: string, given: unknown, handle: string | undefined): string | undefined {
  const g = str(given);
  if (g) {
    const c = classifyUrl(g);
    if (c.platform === platform && c.postId === id) return c.canonicalUrl;
  }
  return postUrl(platform, id, handle);
}

const linksOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" ? [x] : isRecord(x) && typeof x.url === "string" ? [x.url] : [])).filter((x) => /^https?:\/\//i.test(x));

/**
 * The profile and its posts from the enumeration's metadata files (already parsed). Posts keep the
 * listing's order; a post listed twice (gallery-dl writes one file per image of a carousel) once.
 */
export function readEnumeration(docs: unknown[], c: ClassifiedUrl, tool: CaptureTool): { profile: ProfileMeta; entries: ProfileEntry[] } {
  const platform = c.platform;
  const entries: ProfileEntry[] = [];
  const seen = new Set<string>();
  const add = (e: ProfileEntry | undefined) => {
    if (!e || seen.has(e.id)) return;
    seen.add(e.id);
    entries.push(e);
  };
  const profile: ProfileMeta = { links: [] };
  if (tool === "yt-dlp") {
    const list = docs.filter(isRecord).find((d) => Array.isArray(d.entries)) ?? docs.find(isRecord);
    if (list) {
      const handle =
        platform === "youtube" ? (str(list.uploader_id)?.startsWith("@") ? str(list.uploader_id) : c.handle) : platform === "tiktok" ? (str(list.uploader) ? `@${str(list.uploader)!.replace(/^@+/, "")}` : c.handle) : c.handle;
      const thumbs = Array.isArray(list.thumbnails) ? list.thumbnails.filter(isRecord) : [];
      Object.assign(profile, {
        ...(handle ? { handle } : {}),
        ...(str(list.channel) ?? str(list.uploader) ? { displayName: str(list.channel) ?? str(list.uploader) } : {}),
        ...(typeof list.description === "string" ? { bio: list.description } : {}),
        links: linksOf(list.links),
        ...(str(thumbs.find((t) => /avatar/i.test(String(t.id ?? "")))?.url) ? { avatar: str(thumbs.find((t) => /avatar/i.test(String(t.id ?? "")))!.url) } : {}),
        ...(num(list.channel_follower_count) !== undefined ? { followers: num(list.channel_follower_count) } : {}),
        ...(num(list.playlist_count) !== undefined ? { posts: num(list.playlist_count) } : {}),
        ...(typeof list.channel_is_verified === "boolean" ? { verified: list.channel_is_verified } : {}),
      });
      for (const e of Array.isArray(list.entries) ? list.entries : []) {
        if (!isRecord(e)) continue;
        const id = str(e.id);
        const url = id ? entryLink(platform, id, e.url ?? e.webpage_url, handle) : undefined;
        if (!id || !url) continue;
        const ts = num(e.timestamp);
        add({ id, url, ...(typeof captionOf(e) === "string" ? { caption: captionOf(e) } : {}), ...(str(e.title) ? { title: str(e.title) } : {}), ...(ts !== undefined ? { timestamp: ts } : {}), raw: e });
      }
    }
  } else {
    for (const d of docs) {
      if (!isRecord(d)) continue;
      const user = isRecord(d.user) ? d.user : {};
      const count = (k: string, edge: string) => num(user[k]) ?? (isRecord(user[edge]) ? num((user[edge] as Record<string, unknown>).count) : undefined);
      if (profile.handle === undefined) {
        const handle = str(user.username) ?? str(d.username) ?? c.handle;
        Object.assign(profile, {
          ...(handle ? { handle } : {}),
          ...(str(user.full_name) ?? str(d.fullname) ? { displayName: str(user.full_name) ?? str(d.fullname) } : {}),
          ...(typeof user.biography === "string" ? { bio: user.biography } : {}),
          links: linksOf(user.external_url ?? user.bio_links),
          ...(str(user.profile_pic_url_hd) ?? str(user.profile_pic_url) ? { avatar: str(user.profile_pic_url_hd) ?? str(user.profile_pic_url) } : {}),
          ...(count("follower_count", "edge_followed_by") !== undefined ? { followers: count("follower_count", "edge_followed_by") } : {}),
          ...(count("following_count", "edge_follow") !== undefined ? { following: count("following_count", "edge_follow") } : {}),
          ...(count("media_count", "edge_owner_to_timeline_media") !== undefined ? { posts: count("media_count", "edge_owner_to_timeline_media") } : {}),
          ...(typeof user.is_verified === "boolean" ? { verified: user.is_verified } : {}),
        });
      }
      const id = str(d.post_shortcode) ?? str(d.shortcode);
      const url = id ? entryLink(platform, id, d.post_url, profile.handle) : undefined;
      if (!id || !url) continue;
      const ts = gdlTime(d.post_date) ?? gdlTime(d.date);
      add({ id, url, ...(typeof captionOf(d) === "string" ? { caption: captionOf(d) } : {}), ...(ts !== undefined ? { timestamp: ts } : {}), raw: d });
    }
  }
  return { profile, entries };
}

/** The stored, dated profile snapshot (stripped). */
export function profileSnapshot(platform: Platform, p: ProfileMeta, capturedAt: string, localPrefixes: string[]): Record<string, unknown> {
  return stripSnapshot(
    {
      platform,
      capturedAt,
      ...(p.handle ? { handle: p.handle } : {}),
      ...(p.displayName ? { displayName: p.displayName } : {}),
      ...(p.bio !== undefined ? { bio: p.bio } : {}),
      links: p.links,
      ...(p.avatar ? { avatar: p.avatar } : {}),
      ...(p.followers !== undefined ? { followers: p.followers } : {}),
      ...(p.following !== undefined ? { following: p.following } : {}),
      ...(p.posts !== undefined ? { posts: p.posts } : {}),
      ...(p.verified !== undefined ? { verified: p.verified } : {}),
    },
    { localPrefixes },
  );
}
