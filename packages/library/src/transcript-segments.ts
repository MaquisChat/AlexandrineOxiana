/**
 * A transcript version as segments (Task 34a c), for the transcript viewer.
 *
 * How versions are stored: a machine run (link-capture.ts `runTranscription`) stores two derived
 * assets of kind `transcript` with the same derivation (operation `transcribe`): the WebVTT and the
 * worker's `segments.json` (start, end, text, lang, flags and the scores behind the flags; a
 * flagged cue is preceded in the WebVTT by `NOTE flags: a, b`). A human edit (source-actions.ts
 * `addTranscriptVersion`, operation `human-edit`) is one WebVTT or plain-text asset.
 *
 * What a version reads as:
 *  - machine: the segments of its segments.json (either asset of the run gives the same); without
 *    a usable segments.json, the WebVTT's cues with flags from its NOTE lines. Flags are always a
 *    list (empty: checked, nothing found).
 *  - human edit: the WebVTT's cues with `flags: null` — the hallucination checks ran on the
 *    machine's text, not on what a person wrote, so "no flags" would claim a check that never
 *    happened. Language: the one it was saved with, else that of the overlapping segment of the
 *    version it was edited from, else "und". A plain-text edit has no timings: `timed: false` and
 *    no segments (its text is still given whole).
 */
import type { Asset } from "@ao/core";
import type { Repo } from "./repo/repo.js";
import { NotFoundError } from "./repo/errors.js";
import { readAssetText, transcriptVersions } from "./source-actions.js";

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** BCP 47 language of the segment ("und" when not known). */
  lang: string;
  text: string;
  /** Hallucination-check flags; null for a human edit (not checked). */
  flags: string[] | null;
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
  segments: TranscriptSegment[];
}

export interface VttCue {
  start: number;
  end: number;
  text: string;
  flags: string[];
}

const TIME = String.raw`(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{3})`;
const TIMING = new RegExp(`^${TIME}\\s+-->\\s+${TIME}(?:\\s+.*)?$`);
const MAX_SEGMENTS = 100_000;
const MAX_FLAGS = 16;

const secondsOf = (h: string | undefined, m: string, s: string, ms: string): number => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

/** Cue text for display: tags removed, the common character references decoded. */
function cueText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The cues of a WebVTT text; `NOTE flags: a, b` gives the flags of the cue after it. Malformed blocks are skipped. */
export function parseVtt(text: string): VttCue[] {
  const blocks = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const out: VttCue[] = [];
  let pending: string[] = [];
  let block: string[] = [];
  const flush = () => {
    const b = block;
    block = [];
    if (!b.length) return;
    const head = b[0]!;
    if (/^WEBVTT\b/.test(head) || head === "STYLE" || head === "REGION") return;
    if (/^NOTE\b/.test(head)) {
      const m = /^NOTE flags:\s*(.*)$/.exec(head);
      if (m) pending = m[1]!.split(",").map((f) => f.trim()).filter(Boolean).slice(0, MAX_FLAGS);
      return;
    }
    const at = TIMING.test(head) ? 0 : b[1] !== undefined && TIMING.test(b[1]) ? 1 : -1;
    if (at < 0) return;
    const m = TIMING.exec(b[at]!)!;
    const start = secondsOf(m[1], m[2]!, m[3]!, m[4]!);
    const end = secondsOf(m[5], m[6]!, m[7]!, m[8]!);
    if (out.length < MAX_SEGMENTS) out.push({ start, end, text: cueText(b.slice(at + 1)), flags: pending });
    pending = [];
  };
  for (const line of blocks) {
    if (line.trim() === "") flush();
    else block.push(line);
  }
  flush();
  return out;
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
      if (segs) return { id: assetId, text, format, origin: "machine", timed: true, segments: segs };
    }
    const vtt = format === "vtt" ? text : await (async () => {
      const v = sibling(all, asset, false);
      return v ? readAssetText(repo, projectId, sourceId, v.id).catch(() => "") : "";
    })();
    const lang = runLang(asset);
    return { id: assetId, text, format, origin: "machine", timed: true, segments: parseVtt(vtt).map((c) => ({ ...c, lang })) };
  }

  const basedOn = typeof asset.derivation?.params.basedOn === "string" ? asset.derivation.params.basedOn : undefined;
  const base = { id: assetId, text, format, origin: "human-edit" as const, ...(basedOn ? { basedOn } : {}) };
  if (format !== "vtt") return { ...base, timed: false, segments: [] };
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
  return { ...base, timed: true, segments: parseVtt(text).map((c) => ({ start: c.start, end: c.end, lang: langAt(c.start, c.end), text: c.text, flags: null })) };
}
