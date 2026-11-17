/**
 * The one definition of the address classifier and of the browser-session acknowledgement (R146,
 * Task 63): imported by the library (capture) and the interface (the capture screen's preview).
 * The table of addresses below was the parity table of Task 34b; it now tests the single definition.
 */
import { describe, expect, it } from "vitest";
import { COOKIES_ACKNOWLEDGEMENT } from "./acknowledgement.js";
import { classifyUrl, isCollectionLink, isPostLink, isWebAddress, type LinkKind, type Platform } from "./platforms.js";

const PLATFORM_FORMS: Array<[string, Platform, LinkKind]> = [
  // YouTube
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567", "youtube", "video"],
  ["https://www.youtube.com/watch?list=PL1234567&v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://www.youtube.com/watch?list=PL1234567", "youtube", "unknown"],
  ["https://youtu.be/dQw4w9WgXcQ", "youtube", "video"],
  ["https://youtu.be/dQw4w9WgXcQ?t=42", "youtube", "video"],
  ["https://www.youtube.com/shorts/abcdefgh", "youtube", "short"],
  ["https://www.youtube.com/live/abcdefgh", "youtube", "video"],
  ["https://www.youtube.com/embed/abcdefgh", "youtube", "video"],
  ["https://www.youtube.com/playlist?list=PL123", "youtube", "playlist"],
  ["https://www.youtube.com/playlist", "youtube", "unknown"],
  ["https://www.youtube.com/@someone", "youtube", "profile"],
  ["https://www.youtube.com/@someone/videos", "youtube", "profile"],
  ["https://www.youtube.com/channel/UC123", "youtube", "profile"],
  ["https://www.youtube.com/c/SomeName", "youtube", "profile"],
  ["https://www.youtube.com/user/somebody", "youtube", "profile"],
  ["https://www.youtube.com/feed/trending", "youtube", "unknown"],
  // Instagram
  ["https://www.instagram.com/p/Cabc123/", "instagram", "post"],
  ["https://www.instagram.com/someone/p/Cabc123/", "instagram", "post"],
  ["https://www.instagram.com/reel/Cxyz/", "instagram", "reel"],
  ["https://www.instagram.com/reels/Cxyz/", "instagram", "reel"],
  ["https://www.instagram.com/someone/reel/Cxyz/", "instagram", "reel"],
  ["https://www.instagram.com/tv/Ctv1/", "instagram", "video"],
  ["https://www.instagram.com/stories/highlights/1789/", "instagram", "story-highlight"],
  ["https://www.instagram.com/stories/someone/123/", "instagram", "unknown"],
  ["https://www.instagram.com/someone/", "instagram", "profile"],
  ["https://www.instagram.com/some.one_2", "instagram", "profile"],
  // Handle characters (review N4): a hyphen, a dot, an underscore.
  ["https://www.instagram.com/some-one/", "instagram", "unknown"],
  ["https://www.instagram.com/some.one/", "instagram", "profile"],
  ["https://www.instagram.com/some_one/", "instagram", "profile"],
  ["https://www.tiktok.com/@some-one", "tiktok", "profile"],
  ["https://www.tiktok.com/@some.one/video/7234567890", "tiktok", "video"],
  ["https://www.instagram.com/explore/", "instagram", "unknown"],
  ["https://www.instagram.com/accounts/login/", "instagram", "unknown"],
  // TikTok
  ["https://www.tiktok.com/@someone/video/7234567890", "tiktok", "video"],
  ["https://www.tiktok.com/@someone/photo/7234567890", "tiktok", "carousel"],
  ["https://www.tiktok.com/@someone/video/notanumber", "tiktok", "unknown"],
  ["https://www.tiktok.com/@someone", "tiktok", "profile"],
  ["https://www.tiktok.com/@", "tiktok", "unknown"],
  ["https://www.tiktok.com/t/ZTabc/", "tiktok", "unknown"],
  ["https://vm.tiktok.com/ZMabc/", "tiktok", "unknown"],
  ["https://vt.tiktok.com/ZSabc/", "tiktok", "unknown"],
];

/** The reviewer's edge cases (task-34b-review I3) and more. */
const EDGE_CASES: Array<[string, Platform, LinkKind]> = [
  // host prefixes and mobile / music / no-cookie hosts
  ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://mobile.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "youtube", "video"],
  ["https://m.instagram.com/p/Cabc123/", "instagram", "post"],
  ["https://instagram.com/someone", "instagram", "profile"],
  ["https://m.tiktok.com/@someone/video/7234567890", "tiktok", "video"],
  ["https://tiktok.com/@someone", "tiktok", "profile"],
  // upper case
  ["HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://WWW.Instagram.COM/p/Cabc123/", "instagram", "post"],
  ["https://www.TikTok.com/@someone", "tiktok", "profile"],
  ["https://www.instagram.com/EXPLORE/", "instagram", "unknown"],
  // trailing slashes, query strings, fragments, ports, trailing-dot hosts
  ["https://www.youtube.com/@someone/", "youtube", "profile"],
  ["https://www.instagram.com/p/Cabc123", "instagram", "post"],
  ["https://www.instagram.com/p/Cabc123/?igsh=abc&utm_source=x", "instagram", "post"],
  ["https://www.tiktok.com/@someone/video/7234567890?is_from_webapp=1#comments", "tiktok", "video"],
  ["https://youtu.be/dQw4w9WgXcQ#t=10", "youtube", "video"],
  ["https://www.youtube.com:443/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://www.youtube.com./watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["https://www.youtube.com/playlist?list=", "youtube", "unknown"],
  // ID length and odd ids
  ["https://www.youtube.com/watch?v=abc12", "youtube", "unknown"],
  ["https://www.youtube.com/watch?v=abc123", "youtube", "video"],
  ["https://youtu.be/abc12", "youtube", "unknown"],
  ["https://www.youtube.com/watch?v=", "youtube", "unknown"],
  ["https://www.youtube.com/shorts/abc", "youtube", "unknown"],
  // handles
  ["https://www.youtube.com/@", "youtube", "unknown"],
  ["https://www.youtube.com/@some%20one", "youtube", "profile"],
  ["https://www.tiktok.com/@some%20one", "tiktok", "profile"],
  // credentials
  ["https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["https://user@www.instagram.com/someone/", "instagram", "profile"],
  // look-alike and internationalised hosts
  ["https://www.tiktok.com.evil.org/@someone", "other", "unknown"],
  ["https://youtube.com.example.org/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["https://xn--yutube-wqf.com/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["https://уoutube.com/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["https://ınstagram.com/someone", "other", "unknown"],
  ["https://[::1]/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["https://127.0.0.1/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  // other schemes and malformed input
  ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video"],
  ["ftp://www.youtube.com/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["javascript:alert(1)", "other", "unknown"],
  ["data:text/html,hi", "other", "unknown"],
  ["mailto:a@b.c", "other", "unknown"],
  ["//www.youtube.com/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["www.youtube.com/watch?v=dQw4w9WgXcQ", "other", "unknown"],
  ["  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ", "youtube", "video"],
  ["https://example.org/article", "other", "unknown"],
  ["not a link", "other", "unknown"],
  ["", "other", "unknown"],
];


describe("classifyUrl: platform and kind", () => {
  it("has enough cases", () => {
    expect(PLATFORM_FORMS.length + EDGE_CASES.length).toBeGreaterThanOrEqual(87);
  });

  it.each([...PLATFORM_FORMS, ...EDGE_CASES])("%j is %s %s", (url, platform, kind) => {
    const c = classifyUrl(url);
    expect({ platform: c.platform, kind: c.kind }).toEqual({ platform, kind });
  });
});

describe("classifyUrl: canonical form", () => {
  const cases: Array<[string, ReturnType<typeof classifyUrl>]> = [
    ["https://www.youtube.com/watch?v=aoTest00001&si=abc&utm_source=x&feature=share", { platform: "youtube", kind: "video", canonicalUrl: "https://www.youtube.com/watch?v=aoTest00001", postId: "aoTest00001" }],
    ["https://m.youtube.com/watch?v=aoTest00001&list=PLfake123&index=2", { platform: "youtube", kind: "video", canonicalUrl: "https://www.youtube.com/watch?v=aoTest00001&list=PLfake123", postId: "aoTest00001" }],
    ["https://youtu.be/aoTest00001?si=xyz", { platform: "youtube", kind: "video", canonicalUrl: "https://www.youtube.com/watch?v=aoTest00001", postId: "aoTest00001" }],
    ["https://www.youtube.com/shorts/aoShort0001?feature=share", { platform: "youtube", kind: "short", canonicalUrl: "https://www.youtube.com/shorts/aoShort0001", postId: "aoShort0001" }],
    ["https://www.youtube.com/playlist?list=PLfake123&si=x", { platform: "youtube", kind: "playlist", canonicalUrl: "https://www.youtube.com/playlist?list=PLfake123" }],
    ["https://www.youtube.com/@amatest_fake/videos", { platform: "youtube", kind: "profile", canonicalUrl: "https://www.youtube.com/@amatest_fake", handle: "@amatest_fake" }],
    ["https://www.youtube.com/channel/UCfakeChannel000000000001", { platform: "youtube", kind: "profile", canonicalUrl: "https://www.youtube.com/channel/UCfakeChannel000000000001" }],
    ["https://www.instagram.com/p/CfAkEcArO01/?igsh=abcdef", { platform: "instagram", kind: "post", canonicalUrl: "https://www.instagram.com/p/CfAkEcArO01/", postId: "CfAkEcArO01" }],
    ["https://instagram.com/reel/CrEeL000001", { platform: "instagram", kind: "reel", canonicalUrl: "https://www.instagram.com/reel/CrEeL000001/", postId: "CrEeL000001" }],
    ["https://www.instagram.com/reels/CrEeL000001/?igsh=x", { platform: "instagram", kind: "reel", canonicalUrl: "https://www.instagram.com/reel/CrEeL000001/", postId: "CrEeL000001" }],
    ["https://www.instagram.com/stories/highlights/17900000000000001/", { platform: "instagram", kind: "story-highlight", canonicalUrl: "https://www.instagram.com/stories/highlights/17900000000000001/", postId: "17900000000000001" }],
    ["https://www.instagram.com/fake_photographer/?hl=en", { platform: "instagram", kind: "profile", canonicalUrl: "https://www.instagram.com/fake_photographer/", handle: "fake_photographer" }],
    ["https://www.tiktok.com/@fake.dancer/video/7000000000000000001?is_from_webapp=1&sender_device=pc", { platform: "tiktok", kind: "video", canonicalUrl: "https://www.tiktok.com/@fake.dancer/video/7000000000000000001", postId: "7000000000000000001", handle: "@fake.dancer" }],
    ["https://www.tiktok.com/@fake.dancer", { platform: "tiktok", kind: "profile", canonicalUrl: "https://www.tiktok.com/@fake.dancer", handle: "@fake.dancer" }],
    ["https://vm.tiktok.com/ZMfake123/", { platform: "tiktok", kind: "unknown", canonicalUrl: "https://vm.tiktok.com/ZMfake123/" }],
    ["https://example.org/page?utm_source=x&id=5&fbclid=abc#frag", { platform: "other", kind: "unknown", canonicalUrl: "https://example.org/page?id=5" }],
    ["not a url", { platform: "other", kind: "unknown", canonicalUrl: "not a url" }],
  ];
  it.each(cases)("%s", (url, expected) => {
    expect(classifyUrl(url)).toEqual(expected);
  });
});

describe("what may be captured", () => {
  it("a single post or video, or a whole collection", () => {
    expect(isPostLink(classifyUrl("https://www.instagram.com/p/Cabc123/"))).toBe(true);
    expect(isPostLink(classifyUrl("https://www.tiktok.com/@someone/photo/7234567890"))).toBe(true);
    expect(isPostLink(classifyUrl("https://www.instagram.com/stories/highlights/1789/"))).toBe(false);
    expect(isPostLink(classifyUrl("https://example.org/article"))).toBe(false);
    expect(isCollectionLink(classifyUrl("https://www.youtube.com/playlist?list=PL123"))).toBe(true);
    expect(isCollectionLink(classifyUrl("https://www.tiktok.com/@someone"))).toBe(true);
    expect(isCollectionLink(classifyUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))).toBe(false);
  });

  it("a web address: http or https with a host, at most 2048 characters", () => {
    const long = (n: number) => `https://e.org/${"x".repeat(n - "https://e.org/".length)}`;
    for (const ok of ["https://example.org/", "http://a.b/c", "HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ", long(2048)]) expect(isWebAddress(ok), ok).toBe(true);
    for (const bad of ["", "not a link", "ftp://e.org/", "javascript:alert(1)", "//e.org/x", "www.e.org", "https://", "mailto:a@b.c", " https://e.org/", long(2049)]) {
      expect(isWebAddress(bad), bad).toBe(false);
    }
  });
});

describe("the browser-session acknowledgement", () => {
  it("is the exact wording the researcher acknowledges (spec 5.1)", () => {
    expect(COOKIES_ACKNOWLEDGEMENT).toBe(
      "Using your browser's signed-in session lets the downloader see what you can see. Platforms may restrict or suspend accounts they detect using automated tools. This choice is recorded in the project's audit log.",
    );
  });
});

describe("classifyUrl never throws (R379, WB1 I4)", () => {
  it("a handle that cannot be decoded is the platform's unrecognised path", () => {
    expect(classifyUrl("https://www.tiktok.com/@%ZZ")).toEqual({ platform: "tiktok", kind: "unknown", canonicalUrl: "https://www.tiktok.com/@%ZZ" });
    expect(classifyUrl("https://www.youtube.com/@%E0%A4%A")).toEqual({ platform: "youtube", kind: "unknown", canonicalUrl: "https://www.youtube.com/@%E0%A4%A" });
    expect(classifyUrl("https://www.tiktok.com/@%ZZ/video/123")).toEqual({ platform: "tiktok", kind: "unknown", canonicalUrl: "https://www.tiktok.com/@%ZZ/video/123" });
  });

  /** Thirty malformed strings: none throws, and each gets a classification. */
  const MALFORMED: string[] = [
    "%",
    "https://www.tiktok.com/@%",
    "https://www.youtube.com/@%",
    "https://www.tiktok.com/@%E0%A4",
    "https://www.youtube.com/@%E0%A4",
    "https://www.tiktok.com/@%E0%A4/photo/7234567890",
    "https://www.youtube.com/@%ZZ/videos",
    "https://www.tiktok.com/@%C0%AF",
    "https://www.youtube.com/@%ED%A0%80",
    "https://www.tiktok.com/@%FF%FE",
    "https://www.tiktok.com/@\u0000\u0001",
    "https://www.youtube.com/@a\u0007b",
    "\u0000\u0001\u0002",
    "https://\u0000www.youtube.com/",
    "\t\n\r",
    `https://www.tiktok.com/@${"%".repeat(10_000)}`,
    `https://www.youtube.com/@${"%E0".repeat(3_333)}`,
    "x".repeat(10_000),
    "@",
    "https://www.tiktok.com/@",
    "https://www.youtube.com/@@",
    "https://",
    "http://[",
    "https://%%%/",
    "::::",
    "javascript:decodeURIComponent('%')",
    "https://www.youtube.com/watch?v=%ZZ",
    "https://www.instagram.com/%ZZ/",
    "https://vm.tiktok.com/%ZZ/",
    "\ud800",
  ];

  it("has thirty malformed strings", () => {
    expect(MALFORMED).toHaveLength(30);
  });

  it.each(MALFORMED.map((s) => [s.length > 60 ? `${s.slice(0, 60)}… (${s.length})` : s, s]))("%j does not throw", (_label, s) => {
    let c: ReturnType<typeof classifyUrl> | undefined;
    expect(() => (c = classifyUrl(s))).not.toThrow();
    expect(typeof c!.canonicalUrl).toBe("string");
    expect(c!.kind === "unknown" || c!.platform !== "other").toBe(true);
  });

  it("a non-string input is the generic unknown address", () => {
    for (const v of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => classifyUrl(v as string)).not.toThrow();
      expect(classifyUrl(v as string)).toEqual({ platform: "other", kind: "unknown", canonicalUrl: "" });
    }
  });
});

describe("the stored address holds no credentials and no secret parameters (R379, WB3 I1, WB1 M7; R41 C1, R99 I8)", () => {
  const PROBE = "https://ana:hunter2@portal.example.org/case/7?access_token=SECRETTOKEN&sessionid=SESS#frag";

  it("the reviewer's probe: user name, password, token and session go; the path stays", () => {
    const c = classifyUrl(PROBE);
    expect(c).toEqual({ platform: "other", kind: "unknown", canonicalUrl: "https://portal.example.org/case/7" });
    for (const bad of ["ana", "hunter2", "SECRETTOKEN", "SESS", "frag"]) expect(c.canonicalUrl).not.toContain(bad);
  });

  it("ordinary parameters stay, in their order, so the address still leads to the page", () => {
    expect(classifyUrl("https://user:pw@example.org/a/b?id=7&token=T0K&page=2&utm_source=x&lang=en#top").canonicalUrl).toBe("https://example.org/a/b?id=7&page=2&lang=en");
  });

  const SECRET_PARAMS = [
    "Signature", "X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token", "sig", "token", "auth", "apikey", "api_key",
    "sessionid", "PHPSESSID", "jsessionid", "access_token", "id_token", "refresh_token", "password", "client_secret", "AWSAccessKeyId",
  ];
  it.each(SECRET_PARAMS)("the parameter %s goes", (name) => {
    const c = classifyUrl(`https://files.example.org/doc.pdf?id=7&${name}=S3CR3T&page=2`);
    expect(c.canonicalUrl).toBe("https://files.example.org/doc.pdf?id=7&page=2");
  });

  it("a bare `key` and a bare `code` stay (they name a record, a document or a country far more often than a secret)", () => {
    expect(classifyUrl("https://example.org/sheet?key=abc&code=FR").canonicalUrl).toBe("https://example.org/sheet?key=abc&code=FR");
  });

  it("a user name alone goes too, on every platform's unrecognised path", () => {
    expect(classifyUrl("https://ana@example.org/x").canonicalUrl).toBe("https://example.org/x");
    expect(classifyUrl("https://ana:pw@www.youtube.com/feed/trending?token=T").canonicalUrl).toBe("https://www.youtube.com/feed/trending");
    expect(classifyUrl("https://ana:pw@www.instagram.com/explore/?sessionid=S").canonicalUrl).toBe("https://www.instagram.com/explore/");
    expect(classifyUrl("https://ana:pw@www.tiktok.com/t/ZTabc/?sig=S").canonicalUrl).toBe("https://www.tiktok.com/t/ZTabc/");
  });

  it("platform addresses are unchanged", () => {
    expect(classifyUrl("https://ana:pw@www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&token=T").canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123");
    expect(classifyUrl("https://www.youtube.com/playlist?list=PL123").canonicalUrl).toBe("https://www.youtube.com/playlist?list=PL123");
    expect(classifyUrl("https://www.tiktok.com/@someone/video/7234567890").canonicalUrl).toBe("https://www.tiktok.com/@someone/video/7234567890");
    expect(classifyUrl("https://www.instagram.com/p/Cabc123/").canonicalUrl).toBe("https://www.instagram.com/p/Cabc123/");
    expect(classifyUrl("https://vm.tiktok.com/ZMabc/").canonicalUrl).toBe("https://vm.tiktok.com/ZMabc/");
  });
});
