import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import rawSelectors from "../selectors.json";
import { validateSelectors } from "../selectors-schema.js";
import { collectPostLinks, extractPage } from "./index.js";

const selectors = validateSelectors(rawSelectors);
const fixture = (name: string): Document => {
  const html = readFileSync(join(process.env.AO_FIXTURE_PAGES!, name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
};
const page = (body: string, head = ""): Document => new DOMParser().parseFromString(`<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`, "text/html");

describe("extractPage", () => {
  it("reads an Instagram post", () => {
    const r = extractPage(fixture("instagram-post.html"), "https://www.instagram.com/p/C0FAKEPOST1/", selectors);
    expect(r).toEqual({
      platform: "instagram",
      kind: "post",
      canonicalUrl: "https://www.instagram.com/p/C0FAKEPOST1/",
      postId: "C0FAKEPOST1",
      handle: "fieldnotes.example",
      displayName: "Fieldnotes Example",
      caption: "Morning light over the estuary. Notes on tide levels to follow. #fieldwork #tides",
      postedAt: "2026-03-14T08:21:05.000Z",
      counts: { likes: 1204 },
      mediaUrls: ["https://www.instagram.com/media/ig-post-1.svg"],
    });
  });

  it("leaves the caption out when the markup changed (renamed classes), never picking other text", () => {
    const r = extractPage(fixture("instagram-post-renamed.html"), "https://www.instagram.com/p/C0FAKEPOST1/", selectors);
    expect(r.platform).toBe("instagram");
    expect(r.kind).toBe("post");
    expect(r.postId).toBe("C0FAKEPOST1");
    expect(r.caption).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("Suggested for you");
    expect(r.counts?.likes).toBeUndefined();
  });

  it("reads a TikTok video; abbreviated counts (12.4K) are left out, blob: media dropped", () => {
    const r = extractPage(fixture("tiktok-video.html"), "https://www.tiktok.com/@riverwatch.example/video/7300000000000000001", selectors);
    expect(r).toEqual({
      platform: "tiktok",
      kind: "video",
      canonicalUrl: "https://www.tiktok.com/@riverwatch.example/video/7300000000000000001",
      postId: "7300000000000000001",
      handle: "riverwatch.example",
      displayName: "River Watch",
      caption: "River crossing at low tide. Counting the herons today #fieldwork",
      counts: { comments: 318, shares: 1050 },
      mediaUrls: ["https://www.tiktok.com/media/tt-cover-1.svg"],
    });
  });

  it("reads a YouTube watch page", () => {
    const r = extractPage(fixture("youtube-watch.html"), "https://www.youtube.com/watch?v=FAKEvid0001&t=42s", selectors);
    expect(r).toEqual({
      platform: "youtube",
      kind: "video",
      canonicalUrl: "https://www.youtube.com/watch?v=FAKEvid0001",
      postId: "FAKEvid0001",
      handle: "coastlab.example",
      displayName: "Coast Lab Example",
      caption: "Estuary sediment survey, part 2",
      postedAt: "2026-02-01T09:00:00-08:00",
      counts: { views: 48213, likes: 3456, comments: 27 },
      mediaUrls: ["https://www.youtube.com/media/yt-thumb-1.svg"],
    });
  });

  it("reads an Instagram profile page", () => {
    const r = extractPage(fixture("instagram-profile.html"), "https://www.instagram.com/fieldnotes.example/", selectors);
    expect(r).toEqual({
      platform: "instagram",
      kind: "profile",
      canonicalUrl: "https://www.instagram.com/fieldnotes.example/",
      handle: "fieldnotes.example",
      displayName: "Fieldnotes Example",
      mediaUrls: [],
    });
  });

  it("falls back to the generic reader on other sites", () => {
    const doc = page(
      "<article><h1>Ignored heading</h1><img src='/a.png'></article>",
      `<title>A page</title><link rel="canonical" href="https://news.example/story/1"><meta property="og:title" content="Tide tables published"><meta property="article:published_time" content="2026-01-05T10:00:00Z"><meta property="og:image" content="https://news.example/img/cover.jpg">`,
    );
    expect(extractPage(doc, "https://news.example/story/1?utm=x#top", selectors)).toEqual({
      platform: "web",
      kind: "page",
      canonicalUrl: "https://news.example/story/1",
      caption: "Tide tables published",
      postedAt: "2026-01-05T10:00:00Z",
      mediaUrls: ["https://news.example/img/cover.jpg"],
    });
  });

  it("omits a field whose selector matches more than one element (ambiguous, not guessed)", () => {
    const doc = page(`<main><article><ul class="_a9z6"><li><h1 class="_ap3a">first</h1></li><li><h1 class="_ap3a">second</h1></li></ul></article></main>`);
    expect(extractPage(doc, "https://www.instagram.com/p/C0FAKEPOST1/", selectors).caption).toBeUndefined();
  });

  it("does not accept a canonical link that points to another site, or a non-ISO date", () => {
    const doc = page(
      `<main><article><a href="/p/C0FAKEPOST1/"><time datetime="March 14">March 14</time></a></article></main>`,
      `<link rel="canonical" href="https://elsewhere.example/p/C0FAKEPOST1/">`,
    );
    const r = extractPage(doc, "https://www.instagram.com/p/C0FAKEPOST1/?igsh=abc#x", selectors);
    expect(r.canonicalUrl).toBe("https://www.instagram.com/p/C0FAKEPOST1/");
    expect(r.postedAt).toBeUndefined();
  });

  it("keeps line breaks of a caption written with <br>", () => {
    const doc = page(`<main><article><ul class="_a9z6"><li><h1 class="_ap3a">line one<br>line   two</h1></li></ul></article></main>`);
    expect(extractPage(doc, "https://www.instagram.com/p/C0FAKEPOST1/", selectors).caption).toBe("line one\nline two");
  });
});

describe("collectPostLinks", () => {
  it("collects the post and reel links visible on a profile, deduplicated, on the platform only", () => {
    const links = collectPostLinks(fixture("instagram-profile.html"), "https://www.instagram.com/fieldnotes.example/", selectors);
    expect(links).toEqual([
      "https://www.instagram.com/p/C0FAKEPOST1/",
      "https://www.instagram.com/p/C0FAKEPOST2/",
      "https://www.instagram.com/reel/C0FAKEREEL3/",
      "https://www.instagram.com/p/C0FAKEPOST4/",
      "https://www.instagram.com/p/C0FAKEPOST5/",
      "https://www.instagram.com/p/C0FAKEPOST6/",
    ]);
  });

  it("collects nothing on a site it does not know", () => {
    expect(collectPostLinks(page(`<a href="/p/X1/">x</a>`), "https://news.example/", selectors)).toEqual([]);
  });
});

describe("limits (R112)", () => {
  it("drops media links longer than 2,048 characters (50 og:image tags of 1 MB each → none)", () => {
    const huge = `https://news.example/${"a".repeat(1024 * 1024)}`;
    const doc = page("<p>x</p>");
    for (let i = 0; i < 50; i++) {
      // Built with the DOM API: parsing 50 MB of markup in jsdom takes longer than the test itself.
      const m = doc.createElement("meta");
      m.setAttribute("property", "og:image");
      m.setAttribute("content", `${huge}${i}`);
      doc.head.append(m);
    }
    const r = extractPage(doc, "https://news.example/story", selectors);
    expect(r.mediaUrls).toEqual([]);
  });

  it("keeps at most 50 media links", () => {
    const head = Array.from({ length: 80 }, (_, i) => `<meta property="og:image" content="https://news.example/img/${i}.jpg">`).join("");
    const r = extractPage(page("<p>x</p>", head), "https://news.example/story", selectors);
    expect(r.mediaUrls).toHaveLength(50);
    expect(r.mediaUrls[49]).toBe("https://news.example/img/49.jpg");
  });

  it("ignores a canonical link to another post on the same platform", () => {
    const doc = page(`<main></main>`, `<link rel="canonical" href="https://www.instagram.com/p/C0OTHERPOST/">`);
    const r = extractPage(doc, "https://www.instagram.com/p/C0FAKEPOST1/", selectors);
    expect(r.canonicalUrl).toBe("https://www.instagram.com/p/C0FAKEPOST1/");
    const yt = page(`<main></main>`, `<link rel="canonical" href="https://www.youtube.com/watch?v=OTHERvid001">`);
    expect(extractPage(yt, "https://www.youtube.com/watch?v=FAKEvid0001", selectors).canonicalUrl).toBe("https://www.youtube.com/watch?v=FAKEvid0001");
    const profile = page(`<main></main>`, `<link rel="canonical" href="https://www.instagram.com/someone.else/">`);
    expect(extractPage(profile, "https://www.instagram.com/fieldnotes.example/", selectors).canonicalUrl).toBe("https://www.instagram.com/fieldnotes.example/");
  });

  it("matches selector patterns against at most the first 20,000 characters", () => {
    const custom = validateSelectors({
      ...rawSelectors,
      platforms: { ...rawSelectors.platforms, generic: { pages: { page: { fields: { caption: [{ css: "p#v", pattern: "(x)$" }] } } } } },
    });
    const short = page(`<p id="v">${"a".repeat(100)}x</p>`);
    expect(extractPage(short, "https://news.example/", custom).caption).toBe("x");
    const long = page(`<p id="v">${"a".repeat(30_000)}x</p>`);
    expect(extractPage(long, "https://news.example/", custom).caption).toBeUndefined();
  });
});
