import { describe, expect, it } from "vitest";
// Parity guards (test only): the UI keeps its own copies so the bundle never pulls in the library,
// and these tests fail the moment the library's wording or link rules change.
import { COOKIES_ACKNOWLEDGEMENT as LIBRARY_ACK, plainReason } from "../../../library/src/capture/errors";
import { classifyUrl } from "../../../library/src/capture/platforms";
import {
  applyProgress,
  capturePolicyFromYaml,
  captureProgress,
  COOKIES_ACKNOWLEDGEMENT,
  isWebAddress,
  KNOWN_OUTCOME_CODES,
  linkQueue,
  outcomeText,
  parseLinks,
  previewLink,
  profileQueue,
  queueErrorText,
  UNKNOWN_OUTCOME_TEXT,
} from "./capture";

const P = "019a6f00-0000-7000-8000-000000000001";
const OTHER = "019a6f00-0000-7000-8000-000000000002";

describe("capture: what the UI shares with the library", () => {
  it("shows the library's exact browser-session acknowledgement", () => {
    expect(COOKIES_ACKNOWLEDGEMENT).toBe(LIBRARY_ACK);
  });

  it("previews every kind of link as the library classifies it", () => {
    const links = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtube.com/shorts/abcdefgh",
      "https://www.youtube.com/live/abcdefgh",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/@someone",
      "https://www.youtube.com/channel/UC123",
      "https://www.youtube.com/feed/trending",
      "https://m.youtube.com/watch?v=abc",
      "https://www.instagram.com/p/Cabc123/",
      "https://www.instagram.com/someone/p/Cabc123/",
      "https://www.instagram.com/reel/Cxyz/",
      "https://www.instagram.com/tv/Ctv1/",
      "https://www.instagram.com/stories/highlights/1789/",
      "https://www.instagram.com/someone/",
      "https://www.instagram.com/explore/",
      "https://www.tiktok.com/@someone/video/7234567890",
      "https://www.tiktok.com/@someone/photo/7234567890",
      "https://www.tiktok.com/@someone",
      "https://vm.tiktok.com/ZMabc/",
      "https://example.org/article",
      "ftp://example.org/file",
      "not a link",
      "",
    ];
    for (const u of links) {
      const c = classifyUrl(u);
      expect(previewLink(u), u).toMatchObject({ platform: c.platform, kind: c.kind });
    }
  });

  it("explains every reason code the library has, in the UI's own words", () => {
    // The library's sentence for an unknown code is its fallback: every code it knows has its own.
    const fallback = plainReason("NO_SUCH_CODE");
    for (const code of KNOWN_OUTCOME_CODES) expect(outcomeText(code).length, code).toBeGreaterThan(10);
    for (const code of ["LOGIN_REQUIRED", "PRIVATE", "RATE_LIMITED", "NOT_FOUND_OR_REMOVED", "GEO_BLOCKED", "EXTRACTOR_ERROR", "WORKER_UNAVAILABLE", "UNSUPPORTED_URL", "PROFILE_CAPTURE_UNAVAILABLE", "NOTHING_SAVED", "CANCELLED", "NO_MEDIA", "LEGAL_BASIS_REQUIRED", "INTERRUPTED", "POLICY_CHANGED", "INVALID_OPTIONS"]) {
      expect(plainReason(code), code).not.toBe(fallback);
      expect(KNOWN_OUTCOME_CODES, code).toContain(code);
    }
  });
});

describe("capture: links", () => {
  it("reads one link per line, trimmed, blank lines left out", () => {
    expect(parseLinks("  https://a.example/1 \n\n\thttps://b.example/2\r\n  \n")).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("accepts web addresses only, as the service does", () => {
    expect(isWebAddress("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(isWebAddress("http://example.org")).toBe(true);
    expect(isWebAddress("ftp://example.org")).toBe(false);
    expect(isWebAddress("www.youtube.com/watch?v=x")).toBe(false);
    expect(isWebAddress("javascript:alert(1)")).toBe(false);
    expect(isWebAddress(`https://example.org/${"a".repeat(2050)}`)).toBe(false);
  });

  it("names the platform and the kind in words", () => {
    expect(previewLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ").label).toBe("YouTube — video");
    expect(previewLink("https://www.instagram.com/someone/").label).toBe("Instagram — whole profile");
    expect(previewLink("https://example.org/a").label).toMatch(/not a YouTube, Instagram or TikTok link/);
    expect(previewLink("nonsense").label).toMatch(/not a web address/);
  });
});

describe("capture: reasons in plain words", () => {
  it("LOGIN_REQUIRED says to use the browser session", () => {
    expect(outcomeText("LOGIN_REQUIRED")).toBe("This post needs a signed-in session. Try again with “Use my browser session”.");
  });

  it("an unknown code gets a safe sentence, never the code itself", () => {
    const t = outcomeText("SOMETHING_NEW_FROM_THE_WORKER");
    expect(t).toBe(UNKNOWN_OUTCOME_TEXT);
    expect(t).not.toMatch(/SOMETHING_NEW/);
    expect(outcomeText(undefined)).toBe(UNKNOWN_OUTCOME_TEXT);
  });

  it("an unknown code keeps the service's own sentence when it sent one", () => {
    expect(outcomeText("SOMETHING_NEW", "The platform asked for a puzzle.")).toBe("The platform asked for a puzzle.");
  });

  it("a policy refusal carries the rule's reason", () => {
    expect(outcomeText("POLICY_DENIED", "The downloader is not allowed in this project.")).toMatch(/rules do not allow.*The downloader is not allowed in this project\./);
  });

  it("a queue that stopped is explained without the error's name or message", () => {
    expect(queueErrorText("WorkerUnavailableError: the media worker is not reachable (ECONNREFUSED)")).toMatch(/media helper is not running/);
    expect(queueErrorText("TypeError: x is undefined at /home/r/lib.js")).not.toMatch(/TypeError|home/);
    expect(queueErrorText("ProjectLockedError: locked")).toMatch(/locked/);
  });
});

describe("capture: the project's rules", () => {
  it("default rules need a legal basis and have no default", () => {
    expect(capturePolicyFromYaml("")).toMatchObject({ legalBasisRequired: true, defaultLegalBasis: undefined, downloaderAllowed: false });
  });
  it("a default legal basis for social media is used when none is typed", () => {
    expect(capturePolicyFromYaml("consent:\n  requireLegalBasis: true\n  defaultLegalBasis:\n    social-media: Public task (Art. 6(1)(e))\n")).toMatchObject({
      legalBasisRequired: true,
      defaultLegalBasis: "Public task (Art. 6(1)(e))",
    });
  });
  it("non-identifiable data needs none", () => {
    expect(capturePolicyFromYaml("identifiability:\n  containsIdentifiable: false\n").legalBasisRequired).toBe(false);
  });
  it("unreadable rules are read strictly", () => {
    expect(capturePolicyFromYaml("profiles: [nonsense\n")).toMatchObject({ legalBasisRequired: true, readable: false });
  });
});

describe("capture: progress events", () => {
  const ev = (data: unknown) => ({ type: "capture.progress", data });

  it("keeps only well-formed events of this project", () => {
    expect(captureProgress(ev({ queueId: "q1", projectId: P, done: 1, total: 2, finished: false, outcome: { url: "u", status: "created" } }), P)).toBeTruthy();
    expect(captureProgress(ev({ queueId: "q1", projectId: OTHER, done: 1, total: 2, finished: false }), P)).toBeUndefined();
    expect(captureProgress({ type: "import.progress", data: { queueId: "q1", projectId: P, finished: false } }, P)).toBeUndefined();
    expect(captureProgress(ev({ projectId: P, finished: true, kind: "browser" }), P)).toBeUndefined();
    expect(captureProgress(ev("nonsense"), P)).toBeUndefined();
    expect(captureProgress(ev({ queueId: "q1", projectId: P, done: "1", finished: false }), P)).toBeUndefined();
  });

  it("fills a link queue item by item, in order", () => {
    let q = linkQueue("q1", ["https://a/1", "https://a/2", "https://a/3"]);
    expect(q.items.map((i) => i.state)).toEqual(["capturing", "waiting", "waiting"]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: "https://a/1", status: "created", sourceId: "s1" } });
    expect(q.items.map((i) => i.state)).toEqual(["created", "capturing", "waiting"]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 2, total: 3, finished: false, outcome: { url: "https://a/2", status: "failed", errorCode: "LOGIN_REQUIRED" } });
    expect(q.items[1]).toMatchObject({ state: "failed", errorCode: "LOGIN_REQUIRED" });
    q = applyProgress(q, { queueId: "q1", projectId: P, finished: true, error: "WorkerUnavailableError: gone" });
    expect(q.finished).toBe(true);
    expect(q.items[2]!.state).toBe("not-captured");
    expect(q.error).toMatch(/media helper/);
  });

  it("ignores another queue's events", () => {
    const q = linkQueue("q1", ["https://a/1"]);
    expect(applyProgress(q, { queueId: "q2", projectId: P, done: 1, total: 1, finished: true, outcome: { url: "https://a/1", status: "created" } })).toBe(q);
  });

  it("a profile queue lists posts as they come and ends with the run's report", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, done: 1, total: 2, finished: false, outcome: { url: "https://www.instagram.com/p/A/", status: "created" } });
    expect(q.items).toHaveLength(1);
    expect(q.total).toBe(2);
    q = applyProgress(q, {
      queueId: "q9",
      projectId: P,
      finished: true,
      report: { status: "failed", listComplete: false, created: 1, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [], errorCode: "LEGAL_BASIS_REQUIRED" },
    });
    expect(q.finished).toBe(true);
    expect(q.error).toMatch(/legal basis/);
    expect(q.errorCode).toBe("LEGAL_BASIS_REQUIRED");
  });
});
