import { describe, expect, it } from "vitest";
import { COOKIES_ACKNOWLEDGEMENT as CORE_ACK } from "@ao/core/src/capture/acknowledgement";
import { classifyUrl, isWebAddress as coreIsWebAddress } from "@ao/core/src/capture/platforms";
import type { CaptureQueueDetail } from "@ao/shared";
import errorsSource from "../../../library/src/capture/errors.ts?raw";
import captureSource from "./capture.ts?raw";
import {
  applyProgress,
  COOKIES_ACKNOWLEDGEMENT,
  KNOWN_OUTCOME_CODES,
  mergeRead,
  queueFromDetail,
  capturePolicyFromYaml,
  captureProgress,
  isWebAddress,
  linkQueue,
  markGap,
  outcomeText,
  parseLinks,
  previewLink,
  profileQueue,
  queueCounts,
  queueErrorText,
  UNKNOWN_OUTCOME_TEXT,
  type CaptureQueueState,
} from "./capture";

const P = "019a6f00-0000-7000-8000-000000000001";
const OTHER = "019a6f00-0000-7000-8000-000000000002";

const REPORT = { listComplete: false, created: 0, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [] };

/** Seen done + seen failed + not known + not tried + still to come = total. */
function addsUp(q: CaptureQueueState) {
  const c = queueCounts(q);
  expect(c.done + c.failed + c.unknown + c.notTried + c.pending).toBe(c.total);
  return c;
}

describe("capture: progress that was missed (R146, review I1)", () => {
  const three = ["https://a/1", "https://a/2", "https://a/3"];

  it("an outcome the screen did not see is not known, never 'not tried'; counts only what was seen", () => {
    let q = linkQueue("q1", three);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: three[0]!, status: "created" } });
    // done=2 is lost; done=3 arrives and finishes the queue.
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 3, total: 3, finished: true, outcome: { url: three[2]!, status: "failed", errorCode: "LOGIN_REQUIRED" } });
    expect(q.items.map((i) => i.state)).toEqual(["created", "unknown", "failed"]);
    expect(addsUp(q)).toMatchObject({ total: 3, done: 1, failed: 1, unknown: 1, notTried: 0 });
  });

  it("a missed outcome is not known while the queue is still running too", () => {
    let q = linkQueue("q1", three);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 2, total: 3, finished: false, outcome: { url: three[1]!, status: "created" } });
    expect(q.items.map((i) => i.state)).toEqual(["unknown", "created", "capturing"]);
    expect(addsUp(q)).toMatchObject({ done: 1, unknown: 1, pending: 1 });
  });

  it("after a gap in the stream, links not reached when the queue stops are not known either", () => {
    let q = linkQueue("q1", three);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: three[0]!, status: "created" } });
    q = markGap(q);
    expect(q.gap).toBe(true);
    q = applyProgress(q, { queueId: "q1", projectId: P, finished: true, error: "WorkerUnavailableError: gone" });
    expect(q.items.map((i) => i.state)).toEqual(["created", "unknown", "unknown"]);
    expect(addsUp(q)).toMatchObject({ done: 1, unknown: 2, notTried: 0 });
  });

  it("without a gap, links after a queue that stopped were not tried", () => {
    let q = linkQueue("q1", three);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: three[0]!, status: "created" } });
    q = applyProgress(q, { queueId: "q1", projectId: P, finished: true, error: "WorkerUnavailableError: gone" });
    expect(q.items.map((i) => i.state)).toEqual(["created", "not-captured", "not-captured"]);
    expect(addsUp(q)).toMatchObject({ done: 1, notTried: 2 });
  });

  it("a finished queue is not marked by a later gap", () => {
    let q = linkQueue("q1", ["https://a/1"]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: "https://a/1", status: "created" } });
    expect(markGap(q)).toBe(q);
  });
});

describe("capture: a profile run's own sentence (R146, review I2)", () => {
  it("a run stopped by a rules change keeps the library's sentence; nothing claims 'nothing was saved'", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, done: 1, total: 3, finished: false, outcome: { url: "https://www.instagram.com/p/A/", status: "created" } });
    const sentence = "This project's rules changed during the capture. Posts saved before the change are kept; nothing else was saved.";
    q = applyProgress(q, { queueId: "q9", projectId: P, finished: true, report: { ...REPORT, status: "failed", created: 1, errorCode: "POLICY_CHANGED", reason: sentence } });
    expect(q.stopReason).toBe(sentence);
    expect(q.error ?? "").not.toMatch(/nothing was saved/);
  });

  it("without the library's sentence, the run's own meaning is used, not the single link's", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, finished: true, report: { ...REPORT, status: "failed", created: 2, errorCode: "POLICY_CHANGED" } });
    expect(q.error).toMatch(/Posts saved before the change are kept/);
  });

  it("a rate-limit pause keeps the library's sentence", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    const sentence = "The platform is limiting requests, so the profile capture was paused. Run it again later; it continues where it stopped.";
    q = applyProgress(q, { queueId: "q9", projectId: P, finished: true, report: { ...REPORT, status: "paused-rate-limited", created: 4, reason: sentence } });
    expect(q.stopReason).toBe(sentence);
  });

  it("a run refused for want of a legal basis adds the UI's explanation to the library's sentence", () => {
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, finished: true, report: { ...REPORT, status: "failed", errorCode: "LEGAL_BASIS_REQUIRED", reason: "Record a legal basis for this project's social-media data, then try again." } });
    expect(q.stopReason).toMatch(/Record a legal basis/);
    expect(q.error).toMatch(/Enter the legal basis/);
    expect(q.errorCode).toBe("LEGAL_BASIS_REQUIRED");
  });

  it("a stopped run with no sentence from the library and a code the UI does not know gets a run-worded fallback (review N2)", () => {
    for (const status of ["failed", "something-new"]) {
      let q = profileQueue("q9", "https://www.instagram.com/someone/");
      q = applyProgress(q, { queueId: "q9", projectId: P, finished: true, report: { ...REPORT, status, created: 2, errorCode: "BRAND_NEW" } });
      expect(q.error, status).toMatch(/profile capture stopped/);
      expect(q.error, status).toMatch(/saved are kept/);
      expect(q.error, status).not.toMatch(/link|Nothing was saved/i);
    }
    let q = profileQueue("q9", "https://www.instagram.com/someone/");
    q = applyProgress(q, { queueId: "q9", projectId: P, finished: true, report: { ...REPORT, status: "failed", created: 2, errorCode: "CAPTURE_FAILED" } });
    expect(q.error).not.toMatch(/this link|Nothing was saved/i);
  });

  it("losing the stream ends what the screen can claim: unfinished links are not known (review N1)", () => {
    let q = linkQueue("q1", ["https://a/1", "https://a/2", "https://a/3"]);
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: "https://a/1", status: "created" } });
    q = markGap(q);
    expect(q.items.map((i) => i.state)).toEqual(["created", "unknown", "unknown"]);
    expect(addsUp(q)).toMatchObject({ done: 1, unknown: 2, pending: 0 });
    // A late event still resolves a link it reports.
    q = applyProgress(q, { queueId: "q1", projectId: P, done: 3, total: 3, finished: true, outcome: { url: "https://a/3", status: "created" } });
    expect(q.items.map((i) => i.state)).toEqual(["created", "unknown", "created"]);
  });

  it("a stopped profile run is not described in terms of links", () => {
    expect(queueErrorText("TypeError: x", "profile")).not.toMatch(/link/i);
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

  it("names the platform and the kind in words; what it cannot place is left to the app", () => {
    expect(previewLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ").label).toBe("YouTube — video");
    expect(previewLink("https://www.instagram.com/someone/").label).toBe("Instagram — whole profile");
    expect(previewLink("https://example.org/a").label).toMatch(/Not recognised here.*the app will check it/);
    expect(previewLink("https://example.org/a").label).not.toMatch(/cannot capture/);
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

// ---------------------------------------------------------------------------------------------
// Task 63: one classifier and one acknowledgement text; a queue's state read again

describe("capture: one definition of the classifier and the acknowledgement (Task 63, R146)", () => {
  it("the acknowledgement is the one in @ao/core, not a copy", () => {
    expect(COOKIES_ACKNOWLEDGEMENT).toBe(CORE_ACK);
  });

  it("the preview classifies with @ao/core's classifyUrl; the interface keeps no copy of its own", () => {
    for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.instagram.com/some-one/", "https://vm.tiktok.com/ZMabc/", "https://www.youtube.com./watch?v=dQw4w9WgXcQ"]) {
      const c = classifyUrl(u);
      expect({ platform: previewLink(u).platform, kind: previewLink(u).kind }).toEqual({ platform: c.platform, kind: c.kind });
    }
    expect(isWebAddress).toBe(coreIsWebAddress);
    expect(captureSource).not.toMatch(/IG_RESERVED|YT_ID|function classify\(/);
    expect(captureSource).not.toMatch(/"Using your browser's signed-in session/);
  });

  it("has a sentence for every reason code in the library's own table", () => {
    const table = /const REASONS[^{]*\{([\s\S]*?)\n\};/.exec(errorsSource)?.[1] ?? "";
    const codes = [...table.matchAll(/^\s*([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) expect(KNOWN_OUTCOME_CODES, code).toContain(code);
  });
});

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const IG = "https://www.instagram.com/p/Cabc123/";
const TT = "https://www.tiktok.com/@someone/video/7234567890";

function detail(over: Partial<CaptureQueueDetail> = {}): CaptureQueueDetail {
  return { queueId: "q1", projectId: P, kind: "links", startedBy: "desktop", done: 0, total: 3, finished: false, startedAt: "2026-11-12T10:00:00.000Z", urls: [YT, IG, TT], items: [], ...over };
}

describe("capture: a queue read again from the service (Task 63)", () => {
  it("a running links queue: outcomes so far, the next link being captured, the rest waiting; nothing is 'not known'", () => {
    const q = queueFromDetail(detail({ done: 1, items: [{ url: YT, status: "created", sourceId: "s1" }] }));
    expect(q.items.map((i) => i.state)).toEqual(["created", "capturing", "waiting"]);
    expect(q.gap).toBeFalsy();
    expect(q.startedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(addsUp(q)).toMatchObject({ done: 1, pending: 2, unknown: 0 });
  });

  it("a finished links queue that stopped: the links it did not reach were not tried, and why it stopped is said", () => {
    const q = queueFromDetail(detail({ done: 1, finished: true, error: "WorkerUnavailableError", items: [{ url: YT, status: "created" }] }));
    expect(q.items.map((i) => i.state)).toEqual(["created", "not-captured", "not-captured"]);
    expect(q.error).toMatch(/media helper is not running/);
    expect(q.finished).toBe(true);
  });

  it("carries a missing tool's code, sentence and id through unchanged", () => {
    const why = "The video downloader is not installed on this computer, so nothing was saved. Install it from the Optional tools screen, then capture the link again.";
    const q = queueFromDetail(detail({ done: 1, items: [{ url: YT, status: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: why, tool: "video-downloader" }] }));
    expect(q.items[0]).toEqual({ url: YT, state: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: why, tool: "video-downloader" });
    // From events too.
    const e = applyProgress(linkQueue("q1", [YT]), { queueId: "q1", projectId: P, done: 1, total: 1, finished: true, outcome: { url: YT, status: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: why, tool: "video-downloader" } });
    expect(e.items[0]!.tool).toBe("video-downloader");
  });

  it("a profile run: its address, its posts, its report with the library's stop sentence and the missing tool", () => {
    const q = queueFromDetail(
      detail({
        kind: "profile",
        url: "https://www.instagram.com/someone/",
        urls: undefined,
        total: 2,
        done: 1,
        finished: true,
        items: [{ url: IG, status: "created" }],
        report: { ...REPORT, status: "failed", created: 1, errorCode: "TOOL_NOT_INSTALLED", reason: "The image downloader is not installed on this computer, so nothing was saved.", tool: "image-downloader" },
      }),
    );
    expect(q.kind).toBe("profile");
    expect(q.url).toBe("https://www.instagram.com/someone/");
    expect(q.items).toEqual([{ url: IG, state: "created" }]);
    expect(q.stopReason).toMatch(/image downloader is not installed/);
    expect(q.errorCode).toBe("TOOL_NOT_INSTALLED");
    expect(q.tool).toBe("image-downloader");
    expect(q.report?.items).toEqual([{ url: IG, status: "created" }]);
  });

  it("a queue started from the browser extension says so", () => {
    expect(queueFromDetail(detail({ startedBy: "extension" })).startedBy).toBe("extension");
  });

  it("after a gap, the read replaces 'not known' by the truth (Minor O1): links not reached are waiting again, the gap is over", () => {
    let local = applyProgress(linkQueue("q1", [YT, IG, TT]), { queueId: "q1", projectId: P, done: 1, total: 3, finished: false, outcome: { url: YT, status: "created" } });
    local = markGap(local);
    expect(local.items.map((i) => i.state)).toEqual(["created", "unknown", "unknown"]);
    const merged = mergeRead(local, queueFromDetail(detail({ done: 2, items: [{ url: YT, status: "created" }, { url: IG, status: "failed", errorCode: "LOGIN_REQUIRED" }] })));
    expect(merged.items.map((i) => i.state)).toEqual(["created", "failed", "capturing"]);
    expect(merged.gap).toBe(false);
    expect(addsUp(merged)).toMatchObject({ done: 1, failed: 1, pending: 1, unknown: 0 });
  });

  it("an event newer than the read is kept: neither source goes backwards", () => {
    // The screen saw link 3 finish after the read was answered.
    let local = linkQueue("q1", [YT, IG, TT]);
    for (const [done, url] of [[1, YT], [2, IG], [3, TT]] as const) local = applyProgress(local, { queueId: "q1", projectId: P, done, total: 3, finished: done === 3, outcome: { url, status: "created" } });
    const merged = mergeRead(local, queueFromDetail(detail({ done: 1, items: [{ url: YT, status: "created" }] })));
    expect(merged.items.map((i) => i.state)).toEqual(["created", "created", "created"]);
    expect(merged.done).toBe(3);
    expect(merged.finished).toBe(true);
  });

  it("a queue the screen did not know is taken as read", () => {
    const read = queueFromDetail(detail());
    expect(mergeRead(undefined, read)).toBe(read);
  });
});

describe("capture: a queue ended by a close or a move (Task 63 fix round 2, N2)", () => {
  it("says the library was closed or moved, not that the project was locked", () => {
    const t = queueErrorText("LibraryClosedError: the library was closed or moved, so the capture stopped");
    expect(t).toMatch(/library was closed or moved/);
    expect(t).not.toMatch(/locked/);
    expect(queueErrorText("ProjectLockedError: x")).toMatch(/locked/);
  });
});
