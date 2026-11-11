/** YouTube: which page this is comes from the address; everything else from selectors.json. */
import type { PlatformExtractor } from "./platform.js";

const HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com"];
const ID = /^[A-Za-z0-9_-]{11}$/;
const SHORTS = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/;
const CHANNEL = /^\/(@[A-Za-z0-9._-]{3,30}|channel\/UC[A-Za-z0-9_-]{22})(\/(videos|shorts|streams|featured))?\/?$/;

function videoId(u: URL): string | undefined {
  if (u.pathname === "/watch") {
    const v = u.searchParams.get("v");
    return v && ID.test(v) ? v : undefined;
  }
  return SHORTS.exec(u.pathname)?.[1];
}

export const youtube: PlatformExtractor = {
  name: "youtube",
  hosts: HOSTS,
  identify(u) {
    const id = videoId(u);
    if (id) return { kind: "video", postId: id, canonical: `https://www.youtube.com/watch?v=${id}` };
    const c = CHANNEL.exec(u.pathname);
    if (c) return { kind: "channel", ...(c[1]!.startsWith("@") ? { handle: c[1]!.slice(1) } : {}), canonical: `https://www.youtube.com/${c[1]}` };
    return undefined;
  },
  postLink(u) {
    if (!HOSTS.includes(u.hostname)) return undefined;
    const id = videoId(u);
    return id ? `https://www.youtube.com/watch?v=${id}` : undefined;
  },
};
