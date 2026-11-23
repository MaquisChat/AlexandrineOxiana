import { describe, expect, it } from "vitest";
import { CaptureTooLargeError, MAX_BODY_BYTES, fitCaptureBody, utf8Bytes } from "./body-size.js";
import type { BrowserCaptureBody } from "./types.js";

const MB = 1024 * 1024;
const base: Omit<BrowserCaptureBody, "screenshotPng" | "html"> = {
  projectId: "p1",
  url: "https://www.instagram.com/p/C0FAKEPOST1/",
  extracted: { platform: "instagram", kind: "post", canonicalUrl: "https://www.instagram.com/p/C0FAKEPOST1/", caption: "c", mediaUrls: ["https://www.instagram.com/media/a.jpg"] },
  alsoDownload: false,
};
/** The base64 text of an 18 MB PNG (its length is what matters here). */
const png18 = "A".repeat(Math.ceil((18 * MB) / 3) * 4);

describe("fitCaptureBody (POST /capture/browser takes at most 32 MB)", () => {
  it("measures UTF-8 bytes, not characters", () => {
    expect(utf8Bytes({ a: "漢" })).toBe(new TextEncoder().encode('{"a":"漢"}').length);
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(32 * MB);
  });

  it("leaves a body that fits as it is", () => {
    const body = { ...base, screenshotPng: "AAAA", html: "<html></html>" };
    expect(fitCaptureBody(body)).toEqual({ body, notes: [] });
  });

  it("drops the HTML when an 18 MB PNG plus 4.5 million CJK characters of HTML is over the limit in bytes", () => {
    const html = "漢".repeat(4_500_000); // 13.5 MB in UTF-8, though only 4.5 M characters
    const body = { ...base, screenshotPng: png18, html };
    expect(JSON.stringify(body).length).toBeLessThan(31 * MB); // a character count would have let it through
    const r = fitCaptureBody(body);
    expect(r.body.html).toBeUndefined();
    expect(r.body.screenshotPng).toBe(png18);
    expect(r.body.extracted.mediaUrls).toEqual(base.extracted.mediaUrls);
    expect(utf8Bytes(r.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(r.notes.join(" ")).toMatch(/HTML/);
    // Its honest work is measuring bodies of 31.5 MB (the limit is the service's): 2.5 to 2.9 s on one busy core, so
    // a limit of 15 s.
  }, 15_000);

  it("then drops the extracted media links", () => {
    const mediaUrls = Array.from({ length: 50 }, (_, i) => `https://news.example/${"a".repeat(MB)}${i}`);
    const body = { ...base, extracted: { ...base.extracted, mediaUrls }, screenshotPng: png18, html: "<p>x</p>" };
    const r = fitCaptureBody(body);
    expect(r.body.html).toBeUndefined();
    expect(r.body.extracted.mediaUrls).toEqual([]);
    expect(r.body.extracted.caption).toBe("c");
    expect(utf8Bytes(r.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(r.notes.join(" ")).toMatch(/media/);
    // Its honest work is measuring bodies over 32 MB again and again (the limit is the service's; 16 links instead of
    // 50 costs the same): 3 s on one busy core, so a limit of 15 s.
  }, 15_000);

  it("refuses locally, with a clear message, when even the screenshot and fields are too big", () => {
    const body = { ...base, screenshotPng: "A".repeat(33 * MB) };
    // One fitting, its error read whole (each fitting of 33 MB is the test's whole cost).
    let thrown: unknown;
    try {
      fitCaptureBody(body);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CaptureTooLargeError);
    expect((thrown as Error).message).toMatch(/too large/);
  });
});
