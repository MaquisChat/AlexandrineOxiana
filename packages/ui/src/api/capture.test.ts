import { describe, expect, it } from "vitest";
import {
  applyProgress,
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
