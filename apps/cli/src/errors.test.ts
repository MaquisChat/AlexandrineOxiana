import { describe, expect, it } from "vitest";
import { rateLimitWaitOverride, exitForItems } from "./commands/common.js";
import { EXIT, rememberRoot, scrubPaths } from "./errors.js";

describe("scrubPaths", () => {
  it("leaves links alone but hides file paths", () => {
    rememberRoot("/data/My Lib");
    expect(scrubPaths("Could not read https://www.youtube.com/watch?v=abc and http://x.org/a/b/c")).toBe("Could not read https://www.youtube.com/watch?v=abc and http://x.org/a/b/c");
    expect(scrubPaths("No file /home/me/notes/a.txt here")).toBe("No file <path> here");
    expect(scrubPaths("In /data/My Lib/Projects/P failed")).toBe("In Projects/P failed");
    expect(scrubPaths("C:\\Users\\me\\x.txt")).toBe("<path>");
  });
});

describe("rateLimitWaitOverride", () => {
  it("is honoured under test only", () => {
    expect(rateLimitWaitOverride({ AO_RATE_LIMIT_WAIT_MS: "0" })).toBeUndefined();
    expect(rateLimitWaitOverride({ NODE_ENV: "production", AO_RATE_LIMIT_WAIT_MS: "0" })).toBeUndefined();
    expect(rateLimitWaitOverride({ VITEST: "true", AO_RATE_LIMIT_WAIT_MS: "5" })).toBeDefined();
    expect(rateLimitWaitOverride({ NODE_ENV: "test", AO_RATE_LIMIT_WAIT_MS: "5" })).toBeDefined();
    expect(rateLimitWaitOverride({ NODE_ENV: "test" })).toBeUndefined();
    expect(rateLimitWaitOverride({ NODE_ENV: "test", AO_RATE_LIMIT_WAIT_MS: "-1" })).toBeUndefined();
  });
});

describe("exitForItems", () => {
  it("a profile paused by the rate limit needs the researcher (4); denial still wins; other failures are 1", () => {
    const paused = { status: "incomplete" as const, errorCode: "RATE_LIMITED" };
    expect(exitForItems([paused])).toBe(EXIT.needsAction);
    expect(exitForItems([paused, { status: "failed", errorCode: "X" }])).toBe(EXIT.needsAction);
    expect(exitForItems([paused, { status: "failed", errorCode: "POLICY_DENIED" }])).toBe(EXIT.denied);
    expect(exitForItems([{ status: "failed", errorCode: "X" }])).toBe(EXIT.failure);
    expect(exitForItems([{ status: "incomplete", errorCode: "EXTRACTOR_ERROR" }])).toBe(EXIT.ok);
  });
});
