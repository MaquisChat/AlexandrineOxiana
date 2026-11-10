/** Reading sources (and their extracted text) from the library's files for indexing. */
import { join } from "node:path";
import { SourceFile } from "@ao/core";
import { decryptBytes, readMaybe } from "../repo/io.js";

export type ProjectKey = { key: Uint8Array; keyId: string };

/** The SourceFile in `dir` (source.json, or source.json.enc with `k`); null when there is none. */
export async function readSource(dir: string, k: ProjectKey | null | undefined): Promise<SourceFile | null> {
  if (k) {
    const raw = await readMaybe(join(dir, "source.json.enc"));
    if (!raw) return null;
    const text = await decryptBytes((id) => (id === k.keyId ? k.key : undefined), raw);
    return SourceFile.parse(JSON.parse(text.toString("utf8")));
  }
  const raw = await readMaybe(join(dir, "source.json"));
  if (!raw) return null;
  return SourceFile.parse(JSON.parse(raw.toString("utf8")));
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
    const cands = sf.assets.filter((a) => a.role === "derived" && a.kind === kind);
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
