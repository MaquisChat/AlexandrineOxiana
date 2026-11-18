/** Reading sources (and their extracted text) from the library's files for indexing. */
import { join } from "node:path";
import { Annotation, SourceFile } from "@ao/core";
import { decryptBytes, readMaybe } from "../repo/io.js";

export type ProjectKey = { key: Uint8Array; keyId: string };

/**
 * The SourceFile in `dir` (source.json, or source.json.enc with `k`) with its annotations (from
 * annotations.json(.enc), R74 I4, so their text can be indexed); null when there is none.
 */
export async function readSource(dir: string, k: ProjectKey | null | undefined, opts: { annotations?: boolean } = {}): Promise<SourceFile | null> {
  let sf: SourceFile;
  if (k) {
    const raw = await readMaybe(join(dir, "source.json.enc"));
    if (!raw) return null;
    const text = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
    sf = SourceFile.parse(JSON.parse(text.toString("utf8")));
  } else {
    const raw = await readMaybe(join(dir, "source.json"));
    if (!raw) return null;
    sf = SourceFile.parse(JSON.parse(raw.toString("utf8")));
  }
  return opts.annotations === false ? sf : withAnnotations(dir, sf, k);
}

/**
 * `sf` with the annotations kept in its folder's annotations.json(.enc) when source.json lists
 * only their count. Read as the repository reads them (R77): a missing, damaged or undecryptable
 * file gives no annotations (the repository raises the warning when the source is opened).
 */
export async function withAnnotations(dir: string, sf: SourceFile, k: ProjectKey | null | undefined): Promise<SourceFile> {
  if (sf.annotations.length || !sf.annotationCount) return sf;
  try {
    let raw = await readMaybe(join(dir, k ? "annotations.json.enc" : "annotations.json"));
    if (!raw) return sf;
    if (k) raw = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
    return { ...sf, annotations: Annotation.array().parse(JSON.parse(raw.toString("utf8"))) };
  } catch {
    return sf;
  }
}

/** Plain text of a WebVTT transcript: no header, cue ids, timings, notes or markup. */
export function stripVtt(vtt: string): string {
  const out: string[] = [];
  let skipBlock = false;
  for (const raw of vtt.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      skipBlock = false;
      continue;
    }
    if (skipBlock || /^WEBVTT/.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      skipBlock = true;
      continue;
    }
    if (line.includes("-->") || /^\d+$/.test(line)) continue;
    out.push(line.replace(/<[^>]*>/g, ""));
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Text of the newest derived asset of kind `ocr-text` (plain text) and of kind `transcript` (.vtt is
 * stripped to its words), decrypted when needed. Unreadable assets are skipped. Undefined if none.
 */
export async function readExtractedText(root: string, sf: SourceFile, k: ProjectKey | null | undefined): Promise<string | undefined> {
  const parts: string[] = [];
  for (const kind of ["ocr-text", "transcript"]) {
    // A transcript's segments.json sits next to its .vtt with the same kind; only the text forms count.
    const cands = sf.assets.filter((a) => a.role === "derived" && a.kind === kind && a.mime !== "application/json");
    if (cands.length === 0) continue;
    const newest = cands.reduce((best, a) => ((a.derivation?.at ?? "") >= (best.derivation?.at ?? "") ? a : best));
    try {
      let raw = await readMaybe(join(root, ...newest.path.split("/")));
      if (!raw) continue;
      if (newest.encrypted) {
        if (!k) continue;
        raw = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
      }
      const text = raw.toString("utf8");
      parts.push(/\.vtt(\.enc)?$/i.test(newest.path) ? stripVtt(text) : text);
    } catch {
      // unreadable derived file: index the rest
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}
