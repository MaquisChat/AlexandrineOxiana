import { describe, expect, it } from "vitest";
import {
  Annotation,
  Asset,
  ImportBatch,
  ImportOptions,
  LibraryRelativePath,
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
      { kind: "text-range", assetId: newId(), start: 0, end: 5, quote: "hello", prefix: "", suffix: "" },
      { kind: "pdf", assetId: newId(), page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] },
      { kind: "epub-cfi", assetId: newId(), cfi: "epubcfi(/6/4)" },
      { kind: "time-range", assetId: newId(), startMs: 0, endMs: 1000 },
      { kind: "image-region", assetId: newId(), shape: "rect", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { kind: "transcript-segment", assetId: newId(), segmentIds: ["s1"] },
    ];
    for (const a of anchors) {
      expect(Annotation.safeParse({ ...base, anchors: [a] }).success, a.kind).toBe(true);
    }
    expect(Annotation.safeParse({ ...base, anchors: [{ kind: "bogus" }] }).success).toBe(false);
  });
});

describe("ImportOptions / ImportBatch", () => {
  it("defaults", () => {
    expect(ImportOptions.parse({})).toEqual({
      fileHandling: "copy",
      structure: "collections",
      duplicates: "merge",
      ocr: true,
      transcribe: false,
      autoAcceptThreshold: 0.8,
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
