/**
 * Pure helpers of the transcript viewer (Task 34c): flags in words, the version list as a person
 * sees it, times, the segment playing, and the WebVTT a person's edit is saved as.
 */
import type { TranscriptVersionSummary } from "@ao/shared";

/**
 * The hallucination checks' flags (services/media-worker/ao_worker/hallucination.py FLAG_ORDER),
 * in words (spec 5.8). "stock-phrase" is the name the shared type's comment uses for known-phrase.
 */
const FLAG_LABELS: Record<string, string> = {
  "no-speech": "Possibly invented text over silence",
  repetition: "Repeated text",
  "low-confidence": "Low confidence",
  "outside-speech": "Outside detected speech",
  "known-phrase": "A phrase speech recognition is known to invent over silence",
  "stock-phrase": "A phrase speech recognition is known to invent over silence",
};

/** A flag in words. A flag this screen does not know gets a generic label (its name is never shown raw). */
export function flagLabel(flag: string): string {
  return Object.prototype.hasOwnProperty.call(FLAG_LABELS, flag) ? FLAG_LABELS[flag]! : "Another check flagged this segment";
}

/** The labels of a segment's flags, each once, in order. */
export function flagLabels(flags: readonly string[]): string[] {
  return [...new Set(flags.map(flagLabel))];
}

export interface VersionEntry {
  /** The asset id to read. */
  id: string;
  origin: "machine" | "human-edit";
  /** Who or what made it, in words. */
  madeBy: string;
  /** ISO time it was made, when known. */
  at?: string;
  /** Machine versions: how many segments the checks flagged. */
  flagged?: number;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function madeBy(v: TranscriptVersionSummary): string {
  if (v.origin === "human-edit") return "Edited by a person";
  const d = rec(v.derivation);
  const provider = strOf(d.provider) ?? v.tool;
  const model = strOf(d.model);
  const detail = [provider, model ? `model ${model}` : undefined].filter(Boolean).join(", ");
  return detail ? `Speech recognition (${detail})` : "Speech recognition";
}

/**
 * The versions a person chooses between, oldest first: a machine run stores a WebVTT and a segments
 * file that read as the same segments, so a run is one entry (its WebVTT when present).
 */
export function versionEntries(versions: readonly TranscriptVersionSummary[]): VersionEntry[] {
  const out: VersionEntry[] = [];
  const runs = new Map<string, number>();
  for (const v of versions) {
    const d = rec(v.derivation);
    const at = strOf(d.at);
    const entry: VersionEntry = { id: v.id, origin: v.origin, madeBy: madeBy(v), ...(at ? { at } : {}), ...(v.flaggedSegments !== undefined ? { flagged: v.flaggedSegments } : {}) };
    if (v.origin === "machine" && at) {
      const key = `${at}\u0000${JSON.stringify(d.parents ?? [])}`;
      const seen = runs.get(key);
      if (seen !== undefined) {
        if (v.format === "vtt") out[seen] = entry;
        continue;
      }
      runs.set(key, out.length);
    }
    out.push(entry);
  }
  return out;
}

/** The machine version a human edit came from (R143; until Task 62 stores flags per segment). */
export interface MachineBase {
  id: string;
  /** When it was made (ISO), if recorded. */
  at?: string;
  /** True when the edit does not record its base and the newest machine version before it was used. */
  guessed: boolean;
}

/**
 * The machine version version `id` was edited from: follow `derivation.params.basedOn` through
 * earlier edits to a machine version. An edit that names no base: the newest machine version made
 * before it (`guessed`). A base named but not in the list: undefined (flags cannot be shown).
 */
export function machineBaseOf(id: string, versions: readonly TranscriptVersionSummary[]): MachineBase | undefined {
  let cur = versions.find((v) => v.id === id);
  for (let depth = 0; cur && depth < 16; depth++) {
    const d = rec(cur.derivation);
    if (cur.origin === "machine") return { id: cur.id, ...(strOf(d.at) ? { at: strOf(d.at)! } : {}), guessed: false };
    const basedOn = strOf(rec(d.params).basedOn);
    if (basedOn) {
      cur = versions.find((v) => v.id === basedOn);
      continue;
    }
    const at = strOf(d.at);
    const earlier = versions
      .filter((v) => v.origin === "machine")
      .map((v) => ({ v, at: strOf(rec(v.derivation).at) }))
      .filter((x) => x.at !== undefined && (at === undefined || x.at < at))
      .sort((a, b) => (a.at! < b.at! ? -1 : a.at! > b.at! ? 1 : 0))
      .at(-1);
    return earlier ? { id: earlier.v.id, at: earlier.at!, guessed: true } : undefined;
  }
  return undefined;
}

const ms = (s: number) => Math.round(s * 1000);
const cueTextKey = (t: string) =>
  t
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();

/**
 * For each segment of a person's edit: the machine flags of the identical segment (same start, end
 * and text, as stored to the millisecond) of its base version, or "edited" when there is none — the
 * person changed, added or re-timed it, so no check ran on it.
 */
export function carriedFlags(
  edit: ReadonlyArray<{ start: number; end: number; text: string }>,
  machine: ReadonlyArray<{ start: number; end: number; text: string; flags: string[] | null }>,
): Array<string[] | "edited"> {
  const byKey = new Map<string, string[]>();
  for (const m of machine) byKey.set(`${ms(m.start)}|${ms(m.end)}|${cueTextKey(m.text)}`, m.flags ?? []);
  return edit.map((e) => byKey.get(`${ms(e.start)}|${ms(e.end)}|${cueTextKey(e.text)}`) ?? "edited");
}

/** "1:12", "1:02:03". */
export function formatTime(sec: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The index of the segment playing at `t` (the last one that has started and not ended), or -1. */
export function segmentAt(segments: ReadonlyArray<{ start: number; end: number }>, t: number): number {
  let found = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.start > t) break;
    if (t < s.end) found = i;
  }
  return found;
}

function vttTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

/**
 * A WebVTT of these cues. Markup characters are escaped (the service reads them back decoded) and
 * blank lines inside a cue's text are dropped (a blank line would end the cue).
 */
export function buildVtt(cues: ReadonlyArray<{ start: number; end: number; text: string }>): string {
  const blocks = cues.map((c) => {
    const text = c.text
      .replace(/\r\n|\r/g, "\n")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `${vttTime(c.start)} --> ${vttTime(c.end)}${text ? `\n${text}` : ""}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
