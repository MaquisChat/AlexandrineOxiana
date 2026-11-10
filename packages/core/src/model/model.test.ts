import { describe, expect, it } from "vitest";
import {
  Anchor,
  Annotation,
  Asset,
  ImportBatch,
  ImportOptions,
  LibraryRelativePath,
  LinkedRelativePath,
  Source,
  SourceFile,
  inLang,
  newId,
  primary,
} from "../index.js";

const now = "2026-11-09T10:00:00.000Z";

function fixture() {
  const sourceId = newId();
  const assetId = newId();
  return {
    formatVersion: 1,
    source: {
      id: sourceId,
      projectIds: [newId()],
      type: "social-post",
      title: {
        variants: [
          { lang: "es", kind: "original", value: "Mi barrio de noche" },
          {
            lang: "en",
            kind: "translated",
            value: "My neighborhood at night",
            producedBy: { by: "machine", tool: "nllb", at: now },
          },
        ],
      },
      creators: [{ literal: "@barrio", role: "uploader", handle: "@barrio" }],
      issued: "2026-02-28",
      identifiers: { platform: "instagram", platformPostId: "C123", url: "https://example.org/p/C123" },
      caseAttributes: {},
      provenance: {
        captureMethod: "downloader",
        capturedAt: now,
        tool: { name: "yt-dlp", version: "1.0" },
        fileHashes: { [assetId]: "a".repeat(64) },
        legal: { status: "public" },
        identifiable: false,
      },
      collectionIds: [],
      tagIds: [],
      participantIds: [],
      createdAt: now,
      createdBy: "me",
      modifiedAt: now,
      modifiedBy: "me",
      folder: "sources/2026/reel",
      citationKey: "barrio2026",
    },
    assets: [
      {
        id: assetId,
        sourceId,
        role: "original",
        kind: "video",
        path: "sources/2026/reel/reel.mp4",
        encrypted: false,
        sha256: "a".repeat(64),
        bytes: 10,
        mime: "video/mp4",
      },
    ],
    annotations: [],
  };
}

describe("SourceFile", () => {
  it("parses a Spanish reel and applies defaults", () => {
    const sf = SourceFile.parse(fixture());
    expect(primary(sf.source.title)).toBe("Mi barrio de noche");
    expect(inLang(sf.source.title, "en")).toBe("My neighborhood at night");
    expect(inLang(sf.source.title, "fr")).toBeUndefined();
    expect(sf.source.availability).toEqual({ status: "available" });
    expect(sf.fieldEvidence).toEqual([]);
    expect(sf.verification).toEqual({});
  });

  it("primary falls back to first variant", () => {
    expect(primary({ variants: [{ lang: "en", kind: "translated", value: "x" }] })).toBe("x");
  });

  it("rejects bad issued dates", () => {
    for (const issued of ["2026-13-01", "2026-02-30", "26", "2026-1-1"]) {
      const f = fixture();
      (f.source as Record<string, unknown>).issued = issued;
      expect(Source.safeParse(f.source).success, issued).toBe(false);
    }
    for (const issued of ["2026", "2026-02", "2024-02-29"]) {
      const f = fixture();
      (f.source as Record<string, unknown>).issued = issued;
      expect(Source.safeParse(f.source).success, issued).toBe(true);
    }
  });

  it("accepts platform identifier and rejects bad ids/timestamps", () => {
    const f = fixture();
    expect(Source.parse(f.source).identifiers.platform).toBe("instagram");
    expect(Source.safeParse({ ...f.source, id: "nope" }).success).toBe(false);
    expect(Source.safeParse({ ...f.source, createdAt: "yesterday" }).success).toBe(false);
  });

  it("accepts browser_capture and downloader capture methods", () => {
    const f = fixture();
    const p = { ...f.source.provenance, captureMethod: "browser_capture" };
    expect(Source.safeParse({ ...f.source, provenance: p }).success).toBe(true);
  });
});

describe("LinkedRelativePath (R24)", () => {
  it("allows leading .. segments only", () => {
    for (const p of ["../Papers/x.pdf", "../../a/b.pdf", "a/b.pdf"]) expect(LinkedRelativePath.safeParse(p).success, p).toBe(true);
    for (const p of ["..", "../..", "a/../b", "../a/../b", "/abs", "C:/x", "a\\b", "", "./a", "../a//b"]) expect(LinkedRelativePath.safeParse(p).success, p).toBe(false);
  });
  it("a linked asset's path may point outside the library; an unlinked one may not", () => {
    const base = fixture().assets[0]!;
    const linked = { ...base, path: "../P/x.pdf", encrypted: false, linked: { absolutePath: "/home/u/P/x.pdf", libraryRelativePath: "../P/x.pdf" } };
    expect(Asset.safeParse(linked).success).toBe(true);
    expect(Asset.safeParse({ ...linked, path: "other.pdf" }).success).toBe(false);
    expect(Asset.safeParse({ ...base, path: "../P/x.pdf" }).success).toBe(false);
  });
});

describe("LibraryRelativePath", () => {
  it("rejects unsafe paths", () => {
    for (const p of ["/etc/x", "a\\b", "a/../b", "..", "C:/x", "c:x", ""]) {
      expect(LibraryRelativePath.safeParse(p).success, p).toBe(false);
    }
    for (const p of ["a/b.txt", "a..b/c", "sources/2026/x"]) {
      expect(LibraryRelativePath.safeParse(p).success, p).toBe(true);
    }
  });

  it("is enforced on Asset.path and Source.folder", () => {
    const f = fixture();
    for (const bad of ["/abs.mp4", "a\\b.mp4", "../x.mp4"]) {
      expect(Asset.safeParse({ ...f.assets[0], path: bad }).success, bad).toBe(false);
    }
    expect(Source.safeParse({ ...f.source, folder: "/abs" }).success).toBe(false);
  });
});

describe("Anchor / Annotation", () => {
  it("parses each anchor kind", () => {
    const base = { id: newId(), sourceId: newId(), kind: "highlight", author: "me", createdAt: now };
    const anchors = [
      { id: newId(), kind: "text-range", assetId: newId(), start: 0, end: 5, quote: "hello", prefix: "", suffix: "" },
      { id: newId(), kind: "pdf", assetId: newId(), page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
      { id: newId(), kind: "epub-cfi", assetId: newId(), cfi: "epubcfi(/6/4)" },
      { id: newId(), kind: "time-range", assetId: newId(), startMs: 0, endMs: 1000 },
      { id: newId(), kind: "image-region", assetId: newId(), shape: "rect", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { id: newId(), kind: "transcript-segment", assetId: newId(), segmentIds: ["s1"] },
    ];
    for (const a of anchors) {
      expect(Annotation.safeParse({ ...base, anchors: [a] }).success, a.kind).toBe(true);
    }
    expect(Annotation.safeParse({ ...base, anchors: [{ kind: "bogus" }] }).success).toBe(false);
  });

  it("requires anchor id and lets a translation anchor reference the original", () => {
    const orig = { id: newId(), kind: "text-range", assetId: newId(), start: 0, end: 5, quote: "hola" };
    const tr = { id: newId(), kind: "text-range", assetId: newId(), start: 0, end: 4, quote: "hi", originalAnchorId: orig.id };
    expect(Anchor.parse(tr).originalAnchorId).toBe(orig.id);
    const { id: _omit, ...noId } = orig;
    expect(Anchor.safeParse(noId).success).toBe(false);
  });

  it("rejects inverted ranges and bad shapes", () => {
    const a = newId();
    const mk = (o: object) => Anchor.safeParse({ id: newId(), assetId: a, ...o }).success;
    expect(mk({ kind: "text-range", start: 5, end: 1, quote: "x" })).toBe(false);
    expect(mk({ kind: "text-range", start: 3, end: 3, quote: "" })).toBe(true);
    expect(mk({ kind: "time-range", startMs: 10, endMs: 5 })).toBe(false);
    expect(mk({ kind: "time-range", startMs: 5, endMs: 5 })).toBe(true);
    expect(mk({ kind: "pdf", page: 1, rects: [] })).toBe(false);
    const p = (x: number) => ({ x, y: x });
    expect(mk({ kind: "image-region", shape: "rect", points: [p(0)] })).toBe(false);
    expect(mk({ kind: "image-region", shape: "rect", points: [p(0), p(1), p(2)] })).toBe(false);
    expect(mk({ kind: "image-region", shape: "rect", points: [p(0), p(1)] })).toBe(true);
    expect(mk({ kind: "image-region", shape: "polygon", points: [p(0), p(1)] })).toBe(false);
    expect(mk({ kind: "image-region", shape: "polygon", points: [p(0), p(1), p(2)] })).toBe(true);
  });
});

describe("ImportOptions / ImportBatch", () => {
  it("defaults", () => {
    expect(ImportOptions.parse({})).toEqual({
      fileHandling: "copy",
      linkedFiles: "link",
      includeDeleted: false,
      structure: "collections",
      duplicates: "merge",
      ocr: true,
      transcribe: false,
      autoAcceptThreshold: 0.9,
      fileNamePatterns: [],
    });
  });

  it("accepts profile-capture source kind", () => {
    const b = {
      id: newId(),
      projectId: newId(),
      number: 1,
      source: { kind: "profile-capture", location: "https://instagram.com/x" },
      options: {},
      startedAt: now,
      counts: { created: 0, merged: 0, skipped: 0, failed: 0, needsReview: 0 },
    };
    expect(ImportBatch.parse(b).options.ocr).toBe(true);
  });
});
