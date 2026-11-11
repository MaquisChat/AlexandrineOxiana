/**
 * Parity of the UI's copies with the library (R146; until Task 63 gives both one shared definition).
 * Test only: the library's files are read by relative path and never bundled into the UI.
 *
 * 1. The link classifier: the SAME table of addresses goes through the UI's preview copy and the
 *    library's classifyUrl; platform and kind must agree for every one.
 * 2. The acknowledgement text: identical character for character.
 * 3. The reason codes: every code in the library's own table (read from its source) has a UI sentence.
 */
import { describe, expect, it } from "vitest";
import errorsSource from "../../../library/src/capture/errors.ts?raw";
import { COOKIES_ACKNOWLEDGEMENT as LIBRARY_ACK } from "../../../library/src/capture/errors";
import { classifyUrl } from "../../../library/src/capture/platforms";
import { COOKIES_ACKNOWLEDGEMENT, KNOWN_OUTCOME_CODES, previewLink } from "./capture";

/** Each platform's forms (profile, post, video, playlist, reel, short …). */
const PLATFORM_FORMS = [
  // YouTube
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567",
  "https://www.youtube.com/watch?list=PL1234567&v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?list=PL1234567",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://youtu.be/dQw4w9WgXcQ?t=42",
  "https://www.youtube.com/shorts/abcdefgh",
  "https://www.youtube.com/live/abcdefgh",
  "https://www.youtube.com/embed/abcdefgh",
  "https://www.youtube.com/playlist?list=PL123",
  "https://www.youtube.com/playlist",
  "https://www.youtube.com/@someone",
  "https://www.youtube.com/@someone/videos",
  "https://www.youtube.com/channel/UC123",
  "https://www.youtube.com/c/SomeName",
  "https://www.youtube.com/user/somebody",
  "https://www.youtube.com/feed/trending",
  // Instagram
  "https://www.instagram.com/p/Cabc123/",
  "https://www.instagram.com/someone/p/Cabc123/",
  "https://www.instagram.com/reel/Cxyz/",
  "https://www.instagram.com/reels/Cxyz/",
  "https://www.instagram.com/someone/reel/Cxyz/",
  "https://www.instagram.com/tv/Ctv1/",
  "https://www.instagram.com/stories/highlights/1789/",
  "https://www.instagram.com/stories/someone/123/",
  "https://www.instagram.com/someone/",
  "https://www.instagram.com/some.one_2",
  // Handle characters (review N4): a hyphen, a dot, an underscore.
  "https://www.instagram.com/some-one/",
  "https://www.instagram.com/some.one/",
  "https://www.instagram.com/some_one/",
  "https://www.tiktok.com/@some-one",
  "https://www.tiktok.com/@some.one/video/7234567890",
  "https://www.instagram.com/explore/",
  "https://www.instagram.com/accounts/login/",
  // TikTok
  "https://www.tiktok.com/@someone/video/7234567890",
  "https://www.tiktok.com/@someone/photo/7234567890",
  "https://www.tiktok.com/@someone/video/notanumber",
  "https://www.tiktok.com/@someone",
  "https://www.tiktok.com/@",
  "https://www.tiktok.com/t/ZTabc/",
  "https://vm.tiktok.com/ZMabc/",
  "https://vt.tiktok.com/ZSabc/",
];

/** The reviewer's edge cases (task-34b-review I3) and more. */
const EDGE_CASES = [
  // host prefixes and mobile / music / no-cookie hosts
  "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://mobile.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  "https://m.instagram.com/p/Cabc123/",
  "https://instagram.com/someone",
  "https://m.tiktok.com/@someone/video/7234567890",
  "https://tiktok.com/@someone",
  // upper case
  "HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ",
  "https://WWW.Instagram.COM/p/Cabc123/",
  "https://www.TikTok.com/@someone",
  "https://www.instagram.com/EXPLORE/",
  // trailing slashes, query strings, fragments, ports, trailing-dot hosts
  "https://www.youtube.com/@someone/",
  "https://www.instagram.com/p/Cabc123",
  "https://www.instagram.com/p/Cabc123/?igsh=abc&utm_source=x",
  "https://www.tiktok.com/@someone/video/7234567890?is_from_webapp=1#comments",
  "https://youtu.be/dQw4w9WgXcQ#t=10",
  "https://www.youtube.com:443/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com./watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/playlist?list=",
  // ID length and odd ids
  "https://www.youtube.com/watch?v=abc12",
  "https://www.youtube.com/watch?v=abc123",
  "https://youtu.be/abc12",
  "https://www.youtube.com/watch?v=",
  "https://www.youtube.com/shorts/abc",
  // handles
  "https://www.youtube.com/@",
  "https://www.youtube.com/@some%20one",
  "https://www.tiktok.com/@some%20one",
  // credentials
  "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://user@www.instagram.com/someone/",
  // look-alike and internationalised hosts
  "https://www.tiktok.com.evil.org/@someone",
  "https://youtube.com.example.org/watch?v=dQw4w9WgXcQ",
  "https://xn--yutube-wqf.com/watch?v=dQw4w9WgXcQ",
  "https://уoutube.com/watch?v=dQw4w9WgXcQ",
  "https://ınstagram.com/someone",
  "https://[::1]/watch?v=dQw4w9WgXcQ",
  "https://127.0.0.1/watch?v=dQw4w9WgXcQ",
  // other schemes and malformed input
  "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "ftp://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "javascript:alert(1)",
  "data:text/html,hi",
  "mailto:a@b.c",
  "//www.youtube.com/watch?v=dQw4w9WgXcQ",
  "www.youtube.com/watch?v=dQw4w9WgXcQ",
  "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
  "https://example.org/article",
  "not a link",
  "",
];

describe("capture parity with the library", () => {
  it("has enough cases", () => {
    expect(EDGE_CASES.length).toBeGreaterThanOrEqual(41);
  });

  it.each([...PLATFORM_FORMS, ...EDGE_CASES].map((u) => [u]))("classifies %j as the library does", (u) => {
    const c = classifyUrl(u);
    const p = previewLink(u);
    expect({ platform: p.platform, kind: p.kind }).toEqual({ platform: c.platform, kind: c.kind });
  });

  it("shows the acknowledgement text identical character for character", () => {
    expect(COOKIES_ACKNOWLEDGEMENT.length).toBe(LIBRARY_ACK.length);
    for (let i = 0; i < LIBRARY_ACK.length; i++) expect(COOKIES_ACKNOWLEDGEMENT.charCodeAt(i), `character ${i}`).toBe(LIBRARY_ACK.charCodeAt(i));
  });

  it("has a sentence for every reason code in the library's own table", () => {
    const table = /const REASONS[^{]*\{([\s\S]*?)\n\};/.exec(errorsSource)?.[1] ?? "";
    const codes = [...table.matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) expect(KNOWN_OUTCOME_CODES, code).toContain(code);
  });
});
