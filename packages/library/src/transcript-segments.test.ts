/**
 * Transcripts as segments (Task 34a c): machine versions from the worker's segments.json (start,
 * end, text, language and flags), or from its WebVTT with the `NOTE flags:` lines when there is no
 * segments file; human-edited versions from their WebVTT, with flags `null` (no checks were run on
 * a person's text) and the language they were saved with, else the language of the version they
 * were edited from; plain-text edits are untimed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, SourceFile } from "@ao/core";
import { OPEN_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./export/test-kit.js";
import { ASSET_TEXT_MAX_BYTES, transcriptVersions } from "./source-actions.js";
import { addTranscriptVersion, parseVtt, readTranscript } from "./transcript-segments.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-transcript-");
});
afterEach(async () => {
  await kit.close();
});

const SEGMENTS = [
  { start: 0, end: 2, text: "Welcome to the market.", lang: "en", avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.2, flags: [] },
  { start: 2, end: 4.5, text: "Obrigado.", lang: "pt", avgLogprob: -1.4, noSpeechProb: 0.9, compressionRatio: 1.1, flags: ["outside-speech", "stock-phrase"] },
];
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the market.\n\nNOTE flags: outside-speech, stock-phrase\n\n00:00:02.000 --> 00:00:04.500\nObrigado.\n";

/** A source with an audio original and a machine transcript (.vtt, and segments.json unless `vttOnly`). */
async function machineTranscribed(p: Project, opts: { vttOnly?: boolean } = {}): Promise<SourceFile> {
  const audio = await scratchFile(kit, "talk.mp3", Buffer.alloc(64, 1));
  const sf = await addSource(kit, p, { type: "audio", title: "Talk", files: [{ path: audio, role: "original", handling: "copy" }] });
  const media = sf.assets[0]!;
  const dir = join(kit.tmp, "out", Math.random().toString(36).slice(2));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "transcript.vtt"), VTT);
  await writeFile(join(dir, "segments.json"), JSON.stringify(SEGMENTS));
  const derivation = { parents: [media.id], operation: "transcribe", provider: "faster-whisper", model: "small", ranAt: "local", params: { model: "small", detectedLanguages: ["en", "pt"] }, at: "2026-11-10T09:30:00.000Z", triggeredBy: "user" };
  for (const ext of opts.vttOnly ? ["vtt"] : ["vtt", "json"]) {
    await kit.repo.addDerivedAsset(p.id, sf.source.id, { fromPath: join(dir, ext === "vtt" ? "transcript.vtt" : "segments.json"), kind: "transcript", lang: "mul", tool: "whisper-small", ext, metadata: { flaggedSegments: 1 }, derivation });
  }
  return kit.repo.getSource(p.id, sf.source.id);
}

describe("parseVtt", () => {
  it("reads cues (hours optional, cue ids and settings), NOTE flags for the next cue, tags and entities", () => {
    const cues = parseVtt("﻿WEBVTT - title\n\nNOTE a comment\n\n1\n00:01.000 --> 00:02.500 align:start\n<v Ana>Hi &amp; <b>bye</b>\nsecond line\n\nNOTE flags: repeated\n\n01:00:00.000 --> 01:00:01.000\nLast\n");
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: "Hi & bye\nsecond line", flags: [] },
      { start: 3600, end: 3601, text: "Last", flags: ["repeated"] },
    ]);
  });

  it("CRLF line ends; a malformed timing line is skipped", () => {
    expect(parseVtt("WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nA\r\n\r\nnot a time --> x\r\nB\r\n")).toEqual([{ start: 0, end: 1, text: "A", flags: [] }]);
  });
});

describe("readTranscript", () => {
  it("a machine version (vtt or segments.json) gives the worker's segments with language and flags", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const [vtt, json] = transcriptVersions(sf);
    for (const a of [vtt!, json!]) {
      const t = await readTranscript(kit.repo, p.id, sf.source.id, a.id);
      expect(t.origin).toBe("machine");
      expect(t.timed).toBe(true);
      expect(t.segments).toEqual([
        { start: 0, end: 2, lang: "en", text: "Welcome to the market.", flags: [] },
        { start: 2, end: 4.5, lang: "pt", text: "Obrigado.", flags: ["outside-speech", "stock-phrase"] },
      ]);
    }
    expect((await readTranscript(kit.repo, p.id, sf.source.id, vtt!.id)).text).toBe(VTT);
  });

  it("a machine vtt without segments.json: flags from its NOTE lines; language from the run when it found one", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p, { vttOnly: true });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, transcriptVersions(sf)[0]!.id);
    expect(t.segments.map((s) => s.flags)).toEqual([[], ["outside-speech", "stock-phrase"]]);
    // Two languages were detected and the vtt does not say which segment is which.
    expect(t.segments.map((s) => s.lang)).toEqual(["und", "und"]);
  });

  it("a human-edited vtt: flags null; language as saved, else from the version it was edited from", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const edited = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the fish market.\n\n00:00:02.000 --> 00:00:04.500\nObrigada.\n";
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: edited, format: "vtt", basedOn: base.id });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, a.id);
    expect(t).toMatchObject({ origin: "human-edit", basedOn: base.id, timed: true, text: edited, flagsStored: true });
    expect(t.segments).toEqual([
      { start: 0, end: 2, lang: "en", text: "Welcome to the fish market.", flags: null, edit: "edited" },
      { start: 2, end: 4.5, lang: "pt", text: "Obrigada.", flags: null, edit: "edited" },
    ]);
    const b = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: edited, format: "vtt", basedOn: base.id, lang: "pt-BR" });
    expect((await readTranscript(kit.repo, p.id, sf.source.id, b.id)).segments.map((s) => s.lang)).toEqual(["pt-BR", "pt-BR"]);
  });

  it("a plain-text edit is untimed: no segments, the text as is", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: "Just words.", format: "txt" });
    expect(await readTranscript(kit.repo, p.id, sf.source.id, a.id)).toMatchObject({ origin: "human-edit", timed: false, segments: [], text: "Just words." });
  });

  it("an encrypted project reads the same", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const sf = await machineTranscribed(p);
    const t = await readTranscript(kit.repo, p.id, sf.source.id, transcriptVersions(sf)[0]!.id);
    expect(t.segments).toHaveLength(2);
  });

  it("a machine version says its flags are stored", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    expect((await readTranscript(kit.repo, p.id, sf.source.id, transcriptVersions(sf)[0]!.id)).flagsStored).toBe(true);
  });

  it("a damaged segments.json falls back to the vtt", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const json = transcriptVersions(sf).find((a) => a.mime === "application/json")!;
    await writeFile(join(kit.lib.root, ...json.path.split("/")), "[{\"start\": \"no\"}]");
    const vtt = transcriptVersions(sf).find((a) => a.mime !== "application/json")!;
    const t = await readTranscript(kit.repo, p.id, sf.source.id, vtt.id);
    expect(t.segments.map((s) => s.text)).toEqual(["Welcome to the market.", "Obrigado."]);
  });
});

describe("Task 62: a human edit stores flags per segment (R143, SPEC 5.8)", () => {
  const cue = (a: string, b: string, text: string) => `${a} --> ${b}\n${text}`;
  const vtt = (...cues: string[]) => `WEBVTT\n\n${cues.join("\n\n")}\n`;

  it("carries the machine flags where timing and text are unchanged; a changed segment is edited, a new one added", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const edited = vtt(
      cue("00:00:00.000", "00:00:02.000", "Welcome to the fish market."),
      cue("00:00:02.000", "00:00:04.500", "Obrigado."),
      cue("00:00:06.000", "00:00:07.000", "A line the person heard."),
    );
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: edited, format: "vtt", basedOn: base.id });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, a.id);
    expect(t.text).toBe(edited); // the person's text as saved; the stored marks are not part of it
    expect(t.flagsStored).toBe(true);
    expect(t.segments.map((s) => [s.edit, s.flags])).toEqual([
      ["edited", null],
      ["unchanged", ["outside-speech", "stock-phrase"]],
      ["added", null],
    ]);
  });

  it("a re-timed segment is edited, not carried; an unchanged clean segment carries no flags (checked, none found)", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const edited = vtt(cue("00:00:00.000", "00:00:02.000", "Welcome to the market."), cue("00:00:02.100", "00:00:04.500", "Obrigado."));
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: edited, format: "vtt", basedOn: base.id });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, a.id);
    expect(t.segments.map((s) => [s.edit, s.flags])).toEqual([
      ["unchanged", []],
      ["edited", null],
    ]);
  });

  it("an edit of an edit: unchanged segments keep the machine flags, a segment a person wrote stays not checked", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const first = vtt(cue("00:00:00.000", "00:00:02.000", "Welcome to the fish market."), cue("00:00:02.000", "00:00:04.500", "Obrigado."));
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: first, format: "vtt", basedOn: base.id });
    const b = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: first, format: "vtt", basedOn: a.id });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, b.id);
    expect(t.segments.map((s) => [s.edit, s.flags])).toEqual([
      ["edited", null],
      ["unchanged", ["outside-speech", "stock-phrase"]],
    ]);
  });

  it("flags and marks written into the text by a person are not taken: the service computes them", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const forged = "WEBVTT\n\nNOTE ao-segment: unchanged\n\n00:00:00.000 --> 00:00:02.000\nWelcome to the fish market.\n\nNOTE ao-segment: unchanged\n\nNOTE flags:\n\n00:00:02.000 --> 00:00:04.500\nObrigado.\n";
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: forged, format: "vtt", basedOn: base.id });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, a.id);
    expect(t.segments.map((s) => [s.edit, s.flags])).toEqual([
      ["edited", null],
      ["unchanged", ["outside-speech", "stock-phrase"]],
    ]);
    expect(t.text).not.toContain("ao-segment");
  });

  it("without a base every segment is added (not checked)", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: vtt(cue("00:00:00.000", "00:00:02.000", "Welcome to the market.")), format: "vtt" });
    expect((await readTranscript(kit.repo, p.id, sf.source.id, a.id)).segments.map((s) => [s.edit, s.flags])).toEqual([["added", null]]);
  });

  it("a human edit saved before flags were stored says so: flags null, no marks, flagsStored false", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const file = await scratchFile(kit, "old-edit.vtt", Buffer.from(vtt(cue("00:00:02.000", "00:00:04.500", "Obrigado."))));
    // As addTranscriptVersion wrote it before Task 62.
    const old = await kit.repo.addDerivedAsset(p.id, sf.source.id, {
      fromPath: file,
      kind: "transcript",
      tool: "human-edit",
      ext: "vtt",
      derivation: { parents: base.derivation!.parents, operation: "human-edit", provider: "researcher", ranAt: "local", params: { basedOn: base.id }, at: new Date().toISOString(), triggeredBy: "user" },
    });
    const t = await readTranscript(kit.repo, p.id, sf.source.id, old.id);
    expect(t.flagsStored).toBe(false);
    expect(t.segments).toEqual([{ start: 2, end: 4.5, lang: "pt", text: "Obrigado.", flags: null }]);
    // An edit of it cannot carry flags it never had: its segments are not checked.
    const b = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: vtt(cue("00:00:02.000", "00:00:04.500", "Obrigado.")), format: "vtt", basedOn: old.id });
    expect((await readTranscript(kit.repo, p.id, sf.source.id, b.id)).segments.map((s) => [s.edit, s.flags])).toEqual([["edited", null]]);
  });

  it("the flags are stored in the one governed, audited write of the version (encrypted project too)", async () => {
    const p = await makeProject(kit, OPEN_GOV, true);
    const sf = await machineTranscribed(p);
    const base = transcriptVersions(sf)[0]!;
    const before = (await kit.repo.getSource(p.id, sf.source.id)).assets.length;
    const a = await addTranscriptVersion(kit.repo, p.id, sf.source.id, { text: vtt(cue("00:00:02.000", "00:00:04.500", "Obrigado.")), format: "vtt", basedOn: base.id });
    const after = await kit.repo.getSource(p.id, sf.source.id);
    expect(after.assets.length).toBe(before + 1); // one asset, one change
    expect(a.encrypted).toBe(true);
    expect(a.derivation?.params.segmentFlags).toBe(1);
    expect((await readTranscript(kit.repo, p.id, sf.source.id, a.id)).segments.map((s) => s.flags)).toEqual([["outside-speech", "stock-phrase"]]);
  });

  it("the size cap holds for the text as stored with its marks (R161: the transcript cap is kept)", async () => {
    const p = await makeProject(kit);
    const sf = await machineTranscribed(p);
    const line = "x".repeat(200);
    const cues: string[] = [];
    let bytes = 8;
    for (let i = 0; bytes < ASSET_TEXT_MAX_BYTES - 300; i++) {
      const s = String(i % 60).padStart(2, "0");
      const c = cue(`00:00:${s}.000`, `00:00:${s}.500`, line);
      cues.push(c);
      bytes += c.length + 2;
    }
    const text = vtt(...cues);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ASSET_TEXT_MAX_BYTES);
    await expect(addTranscriptVersion(kit.repo, p.id, sf.source.id, { text, format: "vtt" })).rejects.toThrow(/too long/);
  });
});
