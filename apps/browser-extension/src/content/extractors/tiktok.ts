/** TikTok: which page this is comes from the address; everything else from selectors.json. */
import type { PlatformExtractor } from "./platform.js";

const HOSTS = ["tiktok.com", "www.tiktok.com", "m.tiktok.com"];
const VIDEO = /^\/@([A-Za-z0-9._]{2,24})\/(video|photo)\/(\d{5,25})\/?$/;
const PROFILE = /^\/@([A-Za-z0-9._]{2,24})\/?$/;

export const tiktok: PlatformExtractor = {
  name: "tiktok",
  hosts: HOSTS,
  identify(u) {
    const v = VIDEO.exec(u.pathname);
    if (v) return { kind: "video", postId: v[3]!, handle: v[1]!, canonical: `https://www.tiktok.com/@${v[1]}/${v[2]}/${v[3]}` };
    const p = PROFILE.exec(u.pathname);
    if (p) return { kind: "profile", handle: p[1]!, canonical: `https://www.tiktok.com/@${p[1]}` };
    return undefined;
  },
  postLink(u) {
    if (!HOSTS.includes(u.hostname)) return undefined;
    const v = VIDEO.exec(u.pathname);
    return v ? `https://www.tiktok.com/@${v[1]}/${v[2]}/${v[3]}` : undefined;
  },
};
