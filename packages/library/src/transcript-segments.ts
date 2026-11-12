/**
 * A transcript version as segments (Task 34a c), for the transcript viewer, and how a person's edit
 * is stored (Task 62, R143).
 *
 * How versions are stored: a machine run (link-capture.ts `runTranscription`, transcription-jobs.ts)
 * stores two derived assets of kind `transcript` with the same derivation (operation `transcribe`):
 * the WebVTT and the worker's `segments.json` (start, end, text, lang, flags and the scores behind
 * the flags; a flagged cue is preceded in the WebVTT by `NOTE flags: a, b`). A human edit
 * (`addTranscriptVersion`, operation `human-edit`) is one WebVTT or plain-text asset.
 *
 * A human edit's WebVTT carries, before each cue, what the service found when it was saved (Task
 * 62): `NOTE ao-segment: unchanged | edited | added`, and for an unchanged cue the machine flags it
 * carries over as `NOTE flags: a, b` — computed by comparing the edit with the version it was
 * edited from (same start, end and text to the millisecond: unchanged; overlapping a segment of
 * that version: edited; anything else: added). It is part of the version's one governed, audited
 * write, and `derivation.params.segmentFlags: 1` says the file has it. A person cannot set these
 * marks: such NOTE lines in the text sent are dropped before the service writes its own.
 *
 * What a version reads as:
 *  - machine: the segments of its segments.json (either asset of the run gives the same); without
 *    a usable segments.json, the WebVTT's cues with flags from its NOTE lines. Flags are always a
 *    list (empty: checked, nothing found). `flagsStored: true`.
 *  - human edit saved with marks: each cue with `edit`; an unchanged cue has the machine flags it
 *    carried over (a list), an edited or added one `flags: null` — the hallucination checks ran on
 *    the machine's text, not on what a person wrote, so "no flags" would claim a check that never
 *    happened. `flagsStored: true`. The text returned is the person's, without the marks.
 *  - human edit saved before Task 62 (no marks): every cue `flags: null`, no `edit`, and
 *    `flagsStored: false` — the reader cannot tell what was checked ("not checked", never "clean").
 *  - Language of a human edit's cue: the one it was saved with, else that of the overlapping
 *    segment of the version it was edited from, else "und". A plain-text edit has no timings:
 *    `timed: false` and no segments (its text is still given whole).
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Asset } from "@ao/core";
import type { Repo } from "./repo/repo.js";
import { repoLibrary } from "./repo/repo.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";
import { ASSET_TEXT_MAX_BYTES, readAssetText, transcriptVersions } from "./source-actions.js";
import { activeTemp } from "./tmp-registry.js";

/** What became of a segment of a human edit, compared with the version it was edited from. */
export type SegmentEdit = "unchanged" | "edited" | "added";

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** BCP 47 language of the segment ("und" when not known). */
  lang: string;
  text: string;
  /** Hallucination-check flags; null where no check ran (a person's text, or an edit without stored flags). */
  flags: string[] | null;
  /** Human edits with stored flags only: unchanged (machine flags carried over), edited or added by a person. */
  edit?: SegmentEdit;
}

export interface TranscriptRead {
  id: string;
  /** The stored text of this version (the WebVTT, plain text, or segments.json as stored). */
  text: string;
  format: "vtt" | "txt" | "json";
  origin: "machine" | "human-edit";
  /** For a human edit: the version it was edited from. */
  basedOn?: string;
  /** False for a plain-text edit (no timings, so no segments). */
  timed: boolean;
  /**
   * Whether each segment's flags are known: true for a machine version and for a human edit saved
   * with its marks (Task 62); false for an edit saved before (its segments were never matched).
   */
  flagsStored: boolean;
  segments: TranscriptSegment[];
}

export interface VttCue {
  start: number;
  end: number;
  text: string;
  flags: string[];
  /** From a `NOTE ao-segment:` line (human edits saved by the service). */
  edit?: SegmentEdit;
}

const TIME = String.raw`(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{3})`;
const TIMING = new RegExp(`^${TIME}\\s+-->\\s+${TIME}(?:\\s+.*)?$`);
const MAX_SEGMENTS = 100_000;
const MAX_FLAGS = 16;
/** The NOTE lines only the service writes (a person's text has them removed). */
const RESERVED_NOTE = /^NOTE (?:flags|ao-segment):/;
const EDIT_NOTE = /^NOTE ao-segment:\s*(unchanged|edited|added)\s*$/;
/** derivation.params.segmentFlags of a human edit whose WebVTT carries the marks. */
export const SEGMENT_FLAGS_VERSION = 1;

const secondsOf = (h: string | undefined, m: string, s: string, ms: string): number => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

/** Cue text for display: tags removed, the common character references decoded. */
function cueText(lines: string[], keepTags = false): string {
  const joined = lines.join("\n");
  return (keepTags ? joined : joined.replace(/<[^>]*>/g, ""))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

const isBlank = (line: string) => line.trim() === "";
const splitLines = (text: string) => text.replace(/^﻿/, "").split(/\r\n|\r|\n/);

/** Where a block's timing line is (0 or 1), or -1 when the block is not a cue. */
function cueTimingAt(block: string[]): number {
  const head = block[0]!;
  if (/^WEBVTT\b/.test(head) || head === "STYLE" || head === "REGION" || /^NOTE\b/.test(head)) return -1;
  return TIMING.test(head) ? 0 : block[1] !== undefined && TIMING.test(block[1]) ? 1 : -1;
}

/** The cues of a WebVTT text; `NOTE flags: a, b` (and `NOTE ao-segment: …`) describe the cue after it. Malformed blocks are skipped. */
export function parseVtt(text: string): VttCue[] {
  return parseCues(text, false);
}

/** parseVtt's cues; with `keepTags` the text keeps its markup (what the person wrote, for the comparison). */
function parseCues(text: string, keepTags: boolean): VttCue[] {
  const out: VttCue[] = [];
  let pending: string[] = [];
  let pendingEdit: SegmentEdit | undefined;
  let block: string[] = [];
  const flush = () => {
    const b = block;
    block = [];
    if (!b.length) return;
    const head = b[0]!;
    if (/^NOTE\b/.test(head)) {
      const m = /^NOTE flags:\s*(.*)$/.exec(head);
      if (m) pending = m[1]!.split(",").map((f) => f.trim()).filter(Boolean).slice(0, MAX_FLAGS);
      const e = EDIT_NOTE.exec(head);
      if (e) pendingEdit = e[1] as SegmentEdit;
      return;
    }
    const at = cueTimingAt(b);
    if (at < 0) return;
    const m = TIMING.exec(b[at]!)!;
    const start = secondsOf(m[1], m[2]!, m[3]!, m[4]!);
    const end = secondsOf(m[5], m[6]!, m[7]!, m[8]!);
    if (out.length < MAX_SEGMENTS) out.push({ start, end, text: cueText(b.slice(at + 1), keepTags), flags: pending, ...(pendingEdit ? { edit: pendingEdit } : {}) });
    pending = [];
    pendingEdit = undefined;
  };
  for (const line of splitLines(text)) {
    if (isBlank(line)) flush();
    else block.push(line);
  }
  flush();
  return out;
}

/**
 * The text without the NOTE blocks only the service writes (`NOTE flags:`, `NOTE ao-segment:`),
 * each with the blank line after it; line ends become "\n". Undoes `annotateVtt` exactly.
 */
export function stripReservedNotes(text: string): string {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const lines = splitLines(text);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const atBlockStart = i === 0 || isBlank(lines[i - 1]!);
    if (atBlockStart && RESERVED_NOTE.test(lines[i]!)) {
      while (i < lines.length && !isBlank(lines[i]!)) i++; // the block
      continue; // and the one blank line after it
    }
    out.push(lines[i]!);
  }
  return bom + out.join("\n");
}

/** A flag as written in a NOTE line: a plain name; anything else is kept as a flag, never dropped. */
const noteFlag = (f: string) => (/^[A-Za-z0-9-]{1,40}$/.test(f) ? f : "unrecognised-flag");

/**
 * The WebVTT with, before each cue, what was found for it (`marks[i]` for the i-th cue): a
 * `NOTE ao-segment:` line, and `NOTE flags:` for an unchanged cue that carries flags. Expects a
 * text without reserved NOTE lines (`stripReservedNotes`); line ends become "\n".
 */
export function annotateVtt(text: string, marks: ReadonlyArray<{ edit: SegmentEdit; flags: readonly string[] | null }>): string {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const lines = splitLines(text);
  const out: string[] = [];
  let cue = 0;
  for (let i = 0; i < lines.length; ) {
    if (isBlank(lines[i]!)) {
      out.push(lines[i++]!);
      continue;
    }
    let j = i;
    while (j < lines.length && !isBlank(lines[j]!)) j++;
    const block = lines.slice(i, j);
    if (cueTimingAt(block) >= 0 && cue < MAX_SEGMENTS) {
      const mark = marks[cue++];
      if (mark) {
        out.push(`NOTE ao-segment: ${mark.edit}`, "");
        if (mark.edit === "unchanged" && mark.flags?.length) out.push(`NOTE flags: ${[...new Set(mark.flags.map(noteFlag))].slice(0, MAX_FLAGS).join(", ")}`, "");
      }
    }
    out.push(...block);
    i = j;
  }
  return bom + out.join("\n");
}

const ms = (s: number) => Math.round(s * 1000);
/** Cue text compared as the viewer saves it: blank lines dropped, ends trimmed. */
const textKey = (t: string) =>
  t
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();

/**
 * What each cue of a person's edit is, against the segments of the version it was edited from: the
 * identical segment (start, end and text to the millisecond), each used once, gives "unchanged" with
 * its flags — when that segment's flags are known; a segment that was itself a person's text stays
 * edited (or added). A cue overlapping a segment of the base in time is "edited", any other "added".
 */
export function compareWithBase(cues: ReadonlyArray<{ start: number; end: number; text: string }>, base: readonly TranscriptSegment[] | undefined): Array<{ edit: SegmentEdit; flags: string[] | null }> {
  const pool = new Map<string, TranscriptSegment[]>();
  for (const b of base ?? []) {
    const key = `${ms(b.start)}|${ms(b.end)}|${textKey(b.text)}`;
    pool.set(key, [...(pool.get(key) ?? []), b]);
  }
  // For "edited or added": the base sorted by start, with the latest end so far (M6: a binary
  // search per cue, not a scan of the whole base), and the exact timings (zero-length segments).
  const sorted = [...(base ?? [])].sort((a, b) => a.start - b.start);
  const starts = sorted.map((x) => x.start);
  const maxEnd: number[] = [];
  for (const [i, x] of sorted.entries()) maxEnd.push(Math.max(i ? maxEnd[i - 1]! : -Infinity, x.end));
  const timings = new Set(sorted.map((x) => `${ms(x.start)}|${ms(x.end)}`));
  const overlaps = (c: { start: number; end: number }): boolean => {
    if (timings.has(`${ms(c.start)}|${ms(c.end)}`)) return true;
    let lo = 0;
    let hi = starts.length; // first index whose start is >= c.end
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! < c.end) lo = mid + 1;
      else hi = mid;
    }
    // Some segment starting before the cue ends overlaps it when one of them ends after the cue starts.
    return lo > 0 && maxEnd[lo - 1]! > c.start;
  };
  return cues.map((c) => {
    const same = pool.get(`${ms(c.start)}|${ms(c.end)}|${textKey(c.text)}`);
    const b = same?.shift();
    if (b) {
      if (b.flags !== null) return { edit: "unchanged", flags: [...b.flags] };
      return { edit: b.edit === "added" ? "added" : "edited", flags: null };
    }
    return { edit: overlaps(c) ? "edited" : "added", flags: null };
  });
}

/** The worker's segments.json, or undefined when it is not a list of well-formed segments. */
function parseSegmentsJson(raw: string, fallbackLang: string): TranscriptSegment[] | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(v) || v.length > MAX_SEGMENTS) return undefined;
  const out: TranscriptSegment[] = [];
  for (const s of v) {
    if (typeof s !== "object" || s === null) return undefined;
    const o = s as Record<string, unknown>;
    if (typeof o.start !== "number" || typeof o.end !== "number" || !Number.isFinite(o.start) || !Number.isFinite(o.end) || typeof o.text !== "string") return undefined;
    const flags = Array.isArray(o.flags) ? o.flags.filter((f): f is string => typeof f === "string").slice(0, MAX_FLAGS) : [];
    out.push({ start: o.start, end: o.end, lang: typeof o.lang === "string" && o.lang ? o.lang : fallbackLang, text: o.text, flags });
  }
  return out;
}

const isJson = (a: Asset) => a.mime === "application/json";
const formatOf = (a: Asset): TranscriptRead["format"] => (isJson(a) ? "json" : /\.vtt(\.enc)?$/i.test(a.path) ? "vtt" : "txt");

/** The run's one language, when it found exactly one. */
function runLang(a: Asset): string {
  const langs = a.derivation?.params.detectedLanguages;
  return Array.isArray(langs) && langs.length === 1 && typeof langs[0] === "string" ? langs[0] : "und";
}

/** The other asset of the same machine run (the segments.json of a .vtt, or the reverse). */
function sibling(all: Asset[], a: Asset, wantJson: boolean): Asset | undefined {
  const d = a.derivation;
  return all.find(
    (b) =>
      b.id !== a.id &&
      isJson(b) === wantJson &&
      b.derivation?.operation === d?.operation &&
      b.derivation?.at === d?.at &&
      JSON.stringify(b.derivation?.parents ?? []) === JSON.stringify(d?.parents ?? []),
  );
}

/** Reads transcript version `assetId` of a source as segments (decrypted in encrypted projects). */
export async function readTranscript(repo: Repo, projectId: string, sourceId: string, assetId: string, depth = 0): Promise<TranscriptRead> {
  const sf = await repo.getSource(projectId, sourceId);
  const all = transcriptVersions(sf);
  const asset = all.find((a) => a.id === assetId);
  if (!asset) throw new NotFoundError("Transcript", assetId);
  const text = await readAssetText(repo, projectId, sourceId, assetId);
  const format = formatOf(asset);
  const human = asset.derivation?.operation === "human-edit";

  if (!human) {
    const json = isJson(asset) ? asset : sibling(all, asset, true);
    if (json) {
      const raw = json === asset ? text : await readAssetText(repo, projectId, sourceId, json.id).catch(() => undefined);
      const segs = raw === undefined ? undefined : parseSegmentsJson(raw, runLang(asset));
      if (segs) return { id: assetId, text, format, origin: "machine", timed: true, flagsStored: true, segments: segs };
    }
    const vtt = format === "vtt" ? text : await (async () => {
      const v = sibling(all, asset, false);
      return v ? readAssetText(repo, projectId, sourceId, v.id).catch(() => "") : "";
    })();
    const lang = runLang(asset);
    return { id: assetId, text, format, origin: "machine", timed: true, flagsStored: true, segments: parseVtt(vtt).map(({ edit: _e, ...c }) => ({ ...c, lang })) };
  }

  const basedOn = typeof asset.derivation?.params.basedOn === "string" ? asset.derivation.params.basedOn : undefined;
  if (format !== "vtt") return { id: assetId, text, format, origin: "human-edit", ...(basedOn ? { basedOn } : {}), timed: false, flagsStored: false, segments: [] };
  const stored = asset.derivation?.params.segmentFlags === SEGMENT_FLAGS_VERSION;
  const base = { id: assetId, text: stored ? stripReservedNotes(text) : text, format, origin: "human-edit" as const, ...(basedOn ? { basedOn } : {}) };
  const saved = asset.derivation?.params.lang;
  let langAt: (start: number, end: number) => string = () => "und";
  if (typeof saved === "string" && saved) {
    langAt = () => saved;
  } else if (basedOn && depth < 8 && all.some((a) => a.id === basedOn)) {
    const from = await readTranscript(repo, projectId, sourceId, basedOn, depth + 1).catch(() => undefined);
    const segs = from?.segments ?? [];
    langAt = (start, end) => {
      let best: TranscriptSegment | undefined;
      let most = 0;
      for (const s of segs) {
        const overlap = Math.min(end, s.end) - Math.max(start, s.start);
        if (overlap > most) {
          most = overlap;
          best = s;
        }
      }
      return best?.lang ?? "und";
    };
  }
  return {
    ...base,
    timed: true,
    flagsStored: stored,
    segments: parseVtt(text).map((c): TranscriptSegment => {
      const seg = { start: c.start, end: c.end, lang: langAt(c.start, c.end), text: c.text };
      if (!stored) return { ...seg, flags: null };
      // A cue without its mark is treated as a person's (not checked), never as clean.
      const edit = c.edit ?? "edited";
      return { ...seg, flags: edit === "unchanged" ? c.flags : null, edit };
    }),
  };
}

/**
 * Stores a human-edited transcript as a new version (derived asset, tool `human-edit`) next to the
 * versions it was edited from; `basedOn` is the version edited (its parents are inherited, so the
 * new version derives from the same media). A WebVTT edit is stored with its marks (see the module
 * comment): computed here against `basedOn` and written in the same governed, audited change as
 * the version itself (R26). The stored text, marks included, is held to ASSET_TEXT_MAX_BYTES.
 */
export async function addTranscriptVersion(
  repo: Repo,
  projectId: string,
  sourceId: string,
  input: { text: string; format: "vtt" | "txt"; basedOn?: string; lang?: string },
): Promise<Asset> {
  if (typeof input.text !== "string" || input.text.length === 0) throw new InvalidInputError("the transcript text is empty");
  if (Buffer.byteLength(input.text, "utf8") > ASSET_TEXT_MAX_BYTES) throw new InvalidInputError("the transcript is too long");
  if (input.format !== "vtt" && input.format !== "txt") throw new InvalidInputError('format must be "vtt" or "txt"');
  if (input.format === "vtt" && !/^﻿?WEBVTT/.test(input.text)) throw new InvalidInputError("a WebVTT transcript must start with WEBVTT");
  const sf = await repo.getSource(projectId, sourceId);
  let parents: string[];
  if (input.basedOn) {
    const base = transcriptVersions(sf).find((a) => a.id === input.basedOn);
    if (!base) throw new NotFoundError("Transcript", input.basedOn);
    parents = base.derivation?.parents?.length ? [...base.derivation.parents] : [base.id];
  } else {
    const media = sf.assets.find((a) => a.role === "original" && a.status !== "destroyed" && (a.mime.startsWith("audio/") || a.mime.startsWith("video/")));
    parents = media ? [media.id] : [];
  }
  let text = input.text;
  let flagged = 0;
  if (input.format === "vtt") {
    const clean = stripReservedNotes(input.text);
    const baseSegments = input.basedOn ? (await readTranscript(repo, projectId, sourceId, input.basedOn)).segments : undefined;
    // The person's text with its markup (M5): text added inside angle brackets is a change.
    const marks = compareWithBase(parseCues(clean, true), baseSegments);
    flagged = marks.filter((m) => m.edit === "unchanged" && m.flags?.length).length;
    text = annotateVtt(clean, marks);
    if (Buffer.byteLength(text, "utf8") > ASSET_TEXT_MAX_BYTES) {
      throw new InvalidInputError("the transcript is too long to store with the check result of each segment; split it into shorter versions");
    }
  }
  const root = repoLibrary(repo).root;
  const name = `worker-edit-${randomUUID()}`;
  const work = join(root, ".tmp", name);
  activeTemp.add(name);
  try {
    await fsp.mkdir(work, { recursive: true, mode: 0o700 });
    const file = join(work, `transcript.${input.format}`);
    await fsp.writeFile(file, text, { mode: 0o600 });
    return await repo.addDerivedAsset(projectId, sourceId, {
      fromPath: file,
      kind: "transcript",
      ...(input.lang ? { lang: input.lang } : {}),
      tool: "human-edit",
      ext: input.format,
      ...(input.format === "vtt" ? { metadata: { flaggedSegments: flagged } } : {}),
      derivation: {
        parents,
        operation: "human-edit",
        provider: "researcher",
        ranAt: "local",
        // The language is recorded here too (the file name alone carries it otherwise), so a
        // reader of the version's segments knows it; `segmentFlags`: the WebVTT carries the marks.
        params: {
          ...(input.basedOn ? { basedOn: input.basedOn } : {}),
          ...(input.lang ? { lang: input.lang } : {}),
          ...(input.format === "vtt" ? { segmentFlags: SEGMENT_FLAGS_VERSION } : {}),
        },
        at: new Date().toISOString(),
        triggeredBy: "user",
      },
    });
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(name);
  }
}
