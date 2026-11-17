/**
 * MOBI / AZW3 (metadata only, spec 5.4): the PalmDB header, record 0's MOBI header and its EXTH
 * records 100 (author), 503 (updated title), 104 (ISBN), 106 (publishing date), 524 (language).
 * Every offset and length is checked against the bytes actually read, and record counts are
 * bounded, so malformed input can neither crash the parser nor make it loop.
 */
import * as fsp from "node:fs/promises";
import { basename } from "node:path";
import type { Creator } from "@ao/core";
import { clean, normalizeDate, parseName } from "./names.js";
import { embeddedTitle, keepCreators } from "./title-like.js";
import type { RawExtract } from "./types.js";

const PALMDB_HEADER = 78;
/** Record 0 (headers + EXTH + full name) is small; never read more than this of it. */
const MAX_RECORD0 = 1024 * 1024;
const MAX_EXTH_RECORDS = 1024;

const EXTH_AUTHOR = 100;
const EXTH_ISBN = 104;
const EXTH_DATE = 106;
const EXTH_TITLE = 503;
const EXTH_LANGUAGE = 524;

function decoder(encoding: number): { decode(b: Uint8Array): string } {
  try {
    return new TextDecoder(encoding === 1252 ? "windows-1252" : "utf-8", { fatal: false });
  } catch {
    return new TextDecoder("utf-8", { fatal: false });
  }
}

/** Reads `len` bytes at `pos` (fewer at end of file). */
async function readAt(fh: fsp.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

export function parseRecord0(rec0: Buffer): { title?: string; authors: string[]; isbns: string[]; date?: string; language?: string } {
  const out: { title?: string; authors: string[]; isbns: string[]; date?: string; language?: string } = { authors: [], isbns: [] };
  if (rec0.length < 16 + 8 || rec0.toString("latin1", 16, 20) !== "MOBI") return out;
  const headerLen = rec0.readUInt32BE(20);
  const dec = decoder(rec0.length >= 32 ? rec0.readUInt32BE(28) : 65001);

  if (rec0.length >= 0x5c) {
    const off = rec0.readUInt32BE(0x54);
    const len = rec0.readUInt32BE(0x58);
    if (len > 0 && off < rec0.length && len <= rec0.length - off) out.title = clean(dec.decode(rec0.subarray(off, off + len))) || undefined;
  }

  const hasExth = rec0.length >= 0x84 && (rec0.readUInt32BE(0x80) & 0x40) !== 0;
  const exthStart = 16 + headerLen;
  if (!hasExth || headerLen < 4 || exthStart + 12 > rec0.length || rec0.toString("latin1", exthStart, exthStart + 4) !== "EXTH") return out;
  const exthLen = rec0.readUInt32BE(exthStart + 4);
  const end = Math.min(rec0.length, exthStart + Math.max(12, exthLen));
  const count = Math.min(rec0.readUInt32BE(exthStart + 8), MAX_EXTH_RECORDS);
  let p = exthStart + 12;
  let titleFromExth: string | undefined;
  for (let i = 0; i < count && p + 8 <= end; i++) {
    const type = rec0.readUInt32BE(p);
    const len = rec0.readUInt32BE(p + 4);
    if (len < 8 || len > end - p) break; // a length that runs past the block (or cannot advance) ends parsing
    const value = clean(dec.decode(rec0.subarray(p + 8, p + len)));
    if (value) {
      if (type === EXTH_AUTHOR) out.authors.push(value);
      else if (type === EXTH_ISBN) out.isbns.push(value);
      else if (type === EXTH_DATE) out.date ??= value;
      else if (type === EXTH_TITLE) titleFromExth ??= value;
      else if (type === EXTH_LANGUAGE) out.language ??= value;
    }
    p += len;
  }
  if (titleFromExth) out.title = titleFromExth;
  return out;
}

export async function extractMobi(path: string): Promise<RawExtract> {
  const fh = await fsp.open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const head = await readAt(fh, 0, PALMDB_HEADER);
    if (head.length < PALMDB_HEADER) return {};
    const nameEnd = head.indexOf(0);
    // R394 a: the PalmDB name and the EXTH title count only when they look like a title.
    const palmName = embeddedTitle(clean(head.toString("latin1", 0, nameEnd >= 0 && nameEnd < 32 ? nameEnd : 32)) || undefined, basename(path));
    const fallback: RawExtract = palmName ? { title: palmName } : {};

    const numRecords = head.readUInt16BE(76);
    if (numRecords < 1) return fallback;
    const list = await readAt(fh, PALMDB_HEADER, Math.min(numRecords, 2) * 8);
    if (list.length < 8) return fallback;
    const start = list.readUInt32BE(0);
    const next = list.length >= 16 ? list.readUInt32BE(8) : size;
    const stop = Math.min(size, next > start ? next : size, start + MAX_RECORD0);
    if (start < PALMDB_HEADER || start >= size || stop <= start) return fallback;
    const rec0 = await readAt(fh, start, stop - start);

    const m = parseRecord0(rec0);
    const out: RawExtract = {};
    const title = embeddedTitle(m.title, basename(path)) ?? palmName;
    if (title) out.title = title;
    const creators = keepCreators(m.authors.map((a) => parseName(a)).filter((c): c is Creator => !!c));
    if (creators.length) out.creators = creators;
    const issued = normalizeDate(m.date);
    if (issued) out.issued = issued;
    if (m.language) out.language = m.language;
    if (m.isbns.length) out.ids = { isbns: m.isbns };
    return out;
  } finally {
    await fh.close();
  }
}
