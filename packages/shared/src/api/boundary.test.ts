// Task 47: the constants both the service and the interface used to keep their own copy of, now
// declared once here. The shapes themselves are checked by the compiler on both sides.
import { describe, expect, it } from "vitest";
import { ANNOTATION_ANCHORS_MAX, ANNOTATION_NOTE_MAX_CHARS, ANNOTATION_QUOTE_MAX_CHARS, ANNOTATION_RECTS_MAX, HIGHLIGHT_COLOUR_NAMES, SOURCE_ANNOTATIONS_MAX, SOURCE_ANNOTATION_TEXT_MAX, CAPTURE_BROWSERS, CAPTURE_CONTENT_TYPES, CAPTURE_ITEM_STATUSES, CAPTURE_LINKS_MAX, REVIEW_DECISION_ACTIONS, SERVICE_ERROR_CODES, WATCH_FILE_KINDS, WATCHED_FILE_LIST_KINDS, WATCHED_FILES_LIMIT_MAX } from "../index.js";

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
  });
});
