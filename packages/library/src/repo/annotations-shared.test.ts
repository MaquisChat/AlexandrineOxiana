/**
 * Task R4: the names and limits the service and the interface share (@ao/shared) equal the model's
 * and the library's own. This package sees both sides, so the check lives here.
 */
import { HIGHLIGHT_COLOURS } from "@ao/core";
import { ANNOTATION_ANCHORS_MAX, ANNOTATION_NOTE_MAX_CHARS, ANNOTATION_QUOTE_MAX_CHARS, ANNOTATION_RECTS_MAX, HIGHLIGHT_COLOUR_NAMES, SOURCE_ANNOTATIONS_MAX, SOURCE_ANNOTATION_TEXT_MAX } from "@ao/shared";
import { describe, expect, it } from "vitest";
import { MAX_SOURCE_ANNOTATION_TEXT, MAX_SOURCE_ANNOTATIONS } from "../import/bulk/update.js";

describe("what the shared declarations say equals the model and the library", () => {
  it("shared colour names equal the model's", () => {
    expect([...HIGHLIGHT_COLOUR_NAMES]).toEqual([...HIGHLIGHT_COLOURS]);
  });

  it("the shared limits equal the library's", () => {
    expect(SOURCE_ANNOTATIONS_MAX).toBe(MAX_SOURCE_ANNOTATIONS);
    expect(SOURCE_ANNOTATION_TEXT_MAX).toBe(MAX_SOURCE_ANNOTATION_TEXT);
    expect(ANNOTATION_NOTE_MAX_CHARS).toBe(65_536);
    expect(ANNOTATION_QUOTE_MAX_CHARS).toBe(65_536);
    expect(ANNOTATION_ANCHORS_MAX).toBe(50);
    expect(ANNOTATION_RECTS_MAX).toBe(1000);
  });
});
