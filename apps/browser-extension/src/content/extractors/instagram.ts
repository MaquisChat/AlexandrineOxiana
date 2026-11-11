/** Instagram: which page this is comes from the address; everything else from selectors.json. */
import type { PlatformExtractor } from "./platform.js";

const HOSTS = ["instagram.com", "www.instagram.com"];
const POST = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?|tv)\/([A-Za-z0-9_-]{5,64})\/?$/;
const PROFILE = /^\/([A-Za-z0-9._]{1,30})\/?$/;
/** First path segments that are Instagram's own pages, not accounts. */
const RESERVED = new Set(["p", "reel", "reels", "tv", "explore", "accounts", "direct", "stories", "about", "developer", "legal", "web", "emails", "challenge", "privacy", "terms", "session", "api", "graphql", "static"]);

const postPath = (type: string, id: string) => `https://www.instagram.com/${type === "p" || type === "tv" ? type : "reel"}/${id}/`;

export const instagram: PlatformExtractor = {
  name: "instagram",
  hosts: HOSTS,
  identify(u) {
    const post = POST.exec(u.pathname);
    if (post) return { kind: "post", postId: post[2]!, canonical: postPath(post[1]!, post[2]!) };
    const profile = PROFILE.exec(u.pathname);
    if (profile && !RESERVED.has(profile[1]!.toLowerCase())) return { kind: "profile", handle: profile[1]!, canonical: `https://www.instagram.com/${profile[1]}/` };
    return undefined;
  },
  postLink(u) {
    if (!HOSTS.includes(u.hostname)) return undefined;
    const post = POST.exec(u.pathname);
    return post ? postPath(post[1]!, post[2]!) : undefined;
  },
};
