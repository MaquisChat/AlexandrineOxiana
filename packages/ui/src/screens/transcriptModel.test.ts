import { describe, expect, it } from "vitest";
import type { TranscriptVersionSummary } from "@ao/shared";
import { buildVtt, carriedFlags, flagLabel, formatTime, machineBaseOf, segmentAt, versionEntries } from "./transcriptModel";

const machine = (id: string, at: string, format: "vtt" | "json", model = "small"): TranscriptVersionSummary => ({
  id,
  path: `p/${id}`,
  mime: format === "json" ? "application/json" : "text/vtt",
  bytes: 10,
  tool: "faster-whisper",
  derivation: { operation: "transcribe", provider: "faster-whisper", model, at, parents: ["m1"] },
  origin: "machine",
  format,
  flaggedSegments: 1,
});

describe("transcript model", () => {
  it("names every flag the worker can produce in words, and an unknown flag safely", () => {
    expect(flagLabel("no-speech")).toBe("Possibly invented text over silence");
    expect(flagLabel("repetition")).toBe("Repeated text");
    expect(flagLabel("low-confidence")).toBe("Low confidence");
    expect(flagLabel("outside-speech")).toBe("Outside detected speech");
    expect(flagLabel("known-phrase")).toMatch(/phrase speech recognition is known to invent/);
    expect(flagLabel("stock-phrase")).toBe(flagLabel("known-phrase"));
    expect(flagLabel("<b>new-check</b>")).toBe("Another check flagged this segment");
  });

  it("lists one entry per machine run (its WebVTT and segments file are one version) and each human edit", () => {
    const human: TranscriptVersionSummary = {
      id: "h1",
      path: "p/h1",
      mime: "text/vtt",
      bytes: 5,
      tool: "researcher",
      derivation: { operation: "human-edit", provider: "researcher", at: "2026-11-02T10:00:00.000Z", parents: ["m1"] },
      origin: "human-edit",
      format: "vtt",
    };
    const e = versionEntries([machine("v1", "2026-11-01T10:00:00.000Z", "vtt"), machine("j1", "2026-11-01T10:00:00.000Z", "json"), human]);
    expect(e.map((x) => x.id)).toEqual(["v1", "h1"]);
    expect(e[0]!.madeBy).toBe("Speech recognition (faster-whisper, model small)");
    expect(e[1]!.madeBy).toBe("Edited by a person");
    expect(e[0]!.at).toBe("2026-11-01T10:00:00.000Z");
  });

  it("a run with only its segments file still appears", () => {
    expect(versionEntries([machine("j1", "2026-11-01T10:00:00.000Z", "json")]).map((x) => x.id)).toEqual(["j1"]);
  });

  it("finds a human edit's machine base through earlier edits, or the newest machine version before it", () => {
    const edit = (id: string, at: string, basedOn?: string): TranscriptVersionSummary => ({
      id,
      path: `p/${id}`,
      mime: "text/vtt",
      bytes: 1,
      derivation: { operation: "human-edit", at, params: basedOn ? { basedOn } : {} },
      origin: "human-edit",
      format: "vtt",
    });
    const list = [machine("v1", "2026-11-01T10:00:00.000Z", "vtt"), machine("j1", "2026-11-01T10:00:00.000Z", "json"), edit("h1", "2026-11-02T10:00:00.000Z", "j1"), edit("h2", "2026-11-03T10:00:00.000Z", "h1"), machine("v2", "2026-11-04T10:00:00.000Z", "vtt"), edit("h3", "2026-11-05T10:00:00.000Z"), edit("h4", "2026-11-05T11:00:00.000Z", "gone")];
    expect(machineBaseOf("h2", list)).toEqual({ id: "j1", at: "2026-11-01T10:00:00.000Z", guessed: false });
    expect(machineBaseOf("h3", list)).toEqual({ id: "v2", at: "2026-11-04T10:00:00.000Z", guessed: true });
    expect(machineBaseOf("h4", list)).toBeUndefined();
    expect(machineBaseOf("v1", list)?.id).toBe("v1");
  });

  it("carries machine flags only to segments identical in start, end and text", () => {
    const m = [
      { start: 0.0004, end: 2.3456, text: " Hello", flags: ["low-confidence"] },
      { start: 3, end: 4, text: "Two", flags: [] },
    ];
    expect(carriedFlags([{ start: 0, end: 2.346, text: "Hello" }, { start: 3, end: 4, text: "Two!" }, { start: 3, end: 4.1, text: "Two" }, { start: 3, end: 4, text: "Two" }], m)).toEqual([
      ["low-confidence"],
      "edited",
      "edited",
      [],
    ]);
  });

  it("formats times and finds the segment playing", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(72.4)).toBe("1:12");
    expect(formatTime(3723)).toBe("1:02:03");
    const segs = [
      { start: 0, end: 2 },
      { start: 2, end: 5 },
      { start: 7, end: 9 },
    ];
    expect(segmentAt(segs, 0)).toBe(0);
    expect(segmentAt(segs, 2)).toBe(1);
    expect(segmentAt(segs, 6)).toBe(-1);
    expect(segmentAt(segs, 8.5)).toBe(2);
  });

  it("writes a WebVTT the service reads back as the same cues: markup escaped, no blank lines inside a cue", () => {
    const vtt = buildVtt([
      { start: 1.5, end: 3, text: "a <b> & c --> d" },
      { start: 3723.25, end: 3724, text: "line one\n\n\nline two" },
    ]);
    expect(vtt).toBe("WEBVTT\n\n00:00:01.500 --> 00:00:03.000\na &lt;b&gt; &amp; c --&gt; d\n\n01:02:03.250 --> 01:02:04.000\nline one\nline two\n");
  });
});
