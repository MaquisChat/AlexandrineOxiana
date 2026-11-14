// Task 47: the constants both the service and the interface used to keep their own copy of, now
// declared once here. The shapes themselves are checked by the compiler on both sides.
import { describe, expect, it } from "vitest";
import { ANNOTATION_ANCHORS_MAX, ANNOTATION_NOTE_MAX_CHARS, ANNOTATION_QUOTE_MAX_CHARS, ANNOTATION_RECTS_MAX, HIGHLIGHT_COLOUR_NAMES, SOURCE_ANNOTATIONS_MAX, SOURCE_ANNOTATION_TEXT_MAX, CAPTURE_BROWSERS, CAPTURE_CONTENT_TYPES, CAPTURE_ITEM_STATUSES, CAPTURE_LINKS_MAX, REVIEW_DECISION_ACTIONS, SERVICE_ERROR_CODES, WATCH_FILE_KINDS, WATCHED_FILE_LIST_KINDS, WATCHED_FILES_LIMIT_MAX, WATCHED_FILE_ACTION_DONE, FIND_ADD_LINES_MAX, FIND_BODY_MAX_BYTES, FIND_CANDIDATES_SENT, FIND_LINE_MAX_CHARS, FIND_LINE_MIN_CHARS, FIND_QUEUE_MAX, FIND_REASON_CODES, FIND_REASON_TEXT, FIND_ROUTE_TEXT, FIND_STATES, FIND_STOPPED_CODES, FIND_STOPPED_TEXT, findLineRefusal, ZOTERO_SYNC_EVERY_MINUTES, type ZoteroSyncSettingsRequest } from "../index.js";

describe("declarations shared by the service and the interface (Task 47)", () => {
  it("the service's error codes, each once", () => {
    expect(new Set(SERVICE_ERROR_CODES).size).toBe(SERVICE_ERROR_CODES.length);
    for (const c of ["VALIDATION", "PROJECT_LOCKED", "ACKNOWLEDGEMENT_REQUIRED", "TOOL_NOT_INSTALLED", "TOOL_FAILED", "MOVE_IN_PROGRESS"]) expect(SERVICE_ERROR_CODES).toContain(c);
  });

  it("capture: browsers, profile content types, item statuses and the links limit", () => {
    expect([...CAPTURE_BROWSERS]).toEqual(["chrome", "firefox", "safari", "edge", "brave"]);
    expect([...CAPTURE_CONTENT_TYPES]).toEqual(["posts", "reels", "videos", "shorts", "highlights"]);
    expect([...CAPTURE_ITEM_STATUSES]).toEqual(["created", "duplicate", "refreshed", "incomplete", "failed", "needs-review"]);
    expect(CAPTURE_LINKS_MAX).toBe(500);
  });

  it("review: the decisions an import entry takes", () => {
    expect([...REVIEW_DECISION_ACTIONS]).toEqual(["accept", "accept-candidate", "merge", "skip", "keep-both"]);
  });

  it("annotations: the colour names and the limits (the library package checks them against the model)", () => {
    expect([...HIGHLIGHT_COLOUR_NAMES]).toEqual(["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"]);
    expect([ANNOTATION_NOTE_MAX_CHARS, ANNOTATION_QUOTE_MAX_CHARS, ANNOTATION_ANCHORS_MAX, ANNOTATION_RECTS_MAX, SOURCE_ANNOTATIONS_MAX, SOURCE_ANNOTATION_TEXT_MAX]).toEqual([65536, 65536, 50, 1000, 10000, 16777216]);
  });

  it("watched folders: the file kinds", () => {
    expect([...WATCH_FILE_KINDS]).toEqual(["not-downloaded", "online-only-document", "not-supported", "could-not-import", "not-permitted", "could-not-download", "removed-here"]);
    expect([...WATCHED_FILE_LIST_KINDS]).toEqual([...WATCH_FILE_KINDS, "changed", "gone"]);
    expect(WATCHED_FILES_LIMIT_MAX).toBe(200);
    expect([...WATCHED_FILE_ACTION_DONE]).toEqual(["attached", "settled", "already-there"]);
  });

  it("Zotero sync: the intervals offered (Task Z8)", () => {
    expect([...ZOTERO_SYNC_EVERY_MINUTES]).toEqual([30, 60, 240]);
  });

  it("Zotero sync: a settings link may say resume: true, and nothing else (R265, D26)", () => {
    type Link = ZoteroSyncSettingsRequest["links"][number];
    // Only `true` or absent, checked by the compiler (pnpm -r typecheck covers this file).
    const resumed: Link = { ref: "user:42", projectId: "p", structure: "collections", duplicates: "merge", resume: true };
    const plain: Link = { ref: "group:9", projectId: "p", structure: "none", duplicates: "skip" };
    // @ts-expect-error a resume of false is not part of the request
    const wrong: Link = { ...plain, resume: false };
    const req: ZoteroSyncSettingsRequest = { automatic: false, everyMinutes: 60, links: [resumed, plain] };
    expect(req.links.map((l) => l.resume)).toEqual([true, undefined]);
    expect(wrong.resume).toBe(false);
  });

  it("find and acquire: states, every reason code and every stop code has its one sentence, and the bounds", () => {
    expect(FIND_STATES).toHaveLength(15);
    expect([...FIND_REASON_CODES]).toEqual(["not-allowed", "no-legal-basis", "switched-off", "unreachable", "locked", "queue-full", "budget", "unexpected"]);
    // Exhaustive by type (Record<FindReasonCode, string>) and checked here at run time: one plain sentence each.
    expect(Object.keys(FIND_REASON_TEXT).sort()).toEqual([...FIND_REASON_CODES].sort());
    for (const c of FIND_REASON_CODES) expect(FIND_REASON_TEXT[c]).toMatch(/^[A-Z].*\.$/);
    expect(FIND_REASON_TEXT["not-allowed"]).toBe("This project's rules do not allow this.");
    expect(FIND_REASON_TEXT["switched-off"]).toBe("Switched off in Search sources.");
    expect(FIND_REASON_TEXT.unreachable).toBe("The search services could not be reached. Try again later.");
    expect(FIND_REASON_TEXT.locked).toBe("The project is locked. Unlock it, and the queue goes on.");
    expect(FIND_REASON_TEXT["queue-full"]).toBe("The queue holds 500 entries. Remove some finished ones first.");
    expect(FIND_REASON_TEXT.budget).toBe("OpenAlex's free daily allowance is used up; searching Crossref only until tomorrow.");
    expect(FIND_REASON_TEXT.unexpected).toBe("Something went wrong while looking this up. Try again.");
    expect(FIND_REASON_TEXT["no-legal-basis"]).toBe("This project's rules need a legal basis for records made from typed references. Record one in the project's Governance settings.");
    expect(Object.keys(FIND_STOPPED_TEXT).sort()).toEqual([...FIND_STOPPED_CODES].sort());
    for (const c of FIND_STOPPED_CODES) expect(FIND_STOPPED_TEXT[c]).toMatch(/^[A-Z].*\.$/);
    expect(FIND_ROUTE_TEXT.readOnly).toBe("This library is open read-only, so nothing can be added.");
    expect(findLineRefusal(7)).toContain("Line 7");
    expect([FIND_ADD_LINES_MAX, FIND_LINE_MIN_CHARS, FIND_LINE_MAX_CHARS, FIND_BODY_MAX_BYTES, FIND_QUEUE_MAX, FIND_CANDIDATES_SENT]).toEqual([50, 2, 500, 65536, 500, 10]);
  });
});
