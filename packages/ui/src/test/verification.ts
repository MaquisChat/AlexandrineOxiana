/**
 * Fixtures for the verification badges, the source screen's pictures and its background work
 * (Task 34d), shaped exactly like the service's source records (apps/library-service/src/routes/
 * sources.ts `sourceRecord`: the stored record plus `fields: FieldReview[]`), the picture route
 * (`GET …/assets/:aid/content`, R135) and the job routes (routes/jobs.ts).
 */
import type { FieldReview } from "@ao/shared";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import { SOURCE_FILE, STYLES, url } from "./service";

export const CROSSREF = { kind: "lookup", label: "an online lookup (crossref)", provider: "crossref" };
export const EMBEDDED = { kind: "embedded", label: "the file's own metadata" };
export const FILENAME = { kind: "filename", label: "the file name" };
export const AI = { kind: "ai", label: "an AI suggestion" };
export const USER = { kind: "user", label: "the researcher" };

export const FIELD_TITLE_VERIFIED: FieldReview = {
  field: "/title",
  status: "verified",
  checks: ["independent-sources-agree"],
  evidence: [
    { value: "Ethnography at Work", from: EMBEDDED, at: "2026-11-01T10:00:00.000Z" },
    { value: "Ethnography at Work", from: CROSSREF, at: "" },
  ],
};

export const FIELD_PUBLISHER_SINGLE: FieldReview = {
  field: "/publisher",
  status: "single-source",
  checks: ["single-trusted-source"],
  evidence: [{ value: "University Press", from: EMBEDDED, at: "2026-11-01T10:00:00.000Z" }],
};

export const FIELD_ISSUED_CONFLICT: FieldReview = {
  field: "/issued",
  status: "conflict",
  checks: ["draft-vs-evidence"],
  reason: 'Publication date recorded here ("2019") does not match what an online lookup (crossref) says ("2018").',
  current: "2019",
  values: [{ value: "2018", from: CROSSREF }],
  evidence: [
    { value: "2019", from: EMBEDDED, at: "2026-11-01T10:00:00.000Z" },
    { value: "2018", from: CROSSREF, at: "2026-11-02T09:30:00.000Z" },
  ],
};

export const FIELD_CREATORS_UNVERIFIED: FieldReview = {
  field: "/creators",
  status: "unverified",
  checks: ["ai-quote"],
  reason: "Creators was suggested by AI, but the passage it quoted does not clearly state it.",
  evidence: [{ value: [{ family: "Smith", given: "Jane" }], from: AI, quote: "by J. Smith and colleagues", at: "2026-11-01T10:00:00.000Z" }],
};

export const FIELD_DOI_CONFIRMED: FieldReview = {
  field: "/identifiers/doi",
  status: "user-confirmed",
  checks: ["user"],
  evidence: [{ value: "10.1000/xyz", from: USER, at: "2026-11-03T08:00:00.000Z" }],
};

export const FIELDS: FieldReview[] = [FIELD_CREATORS_UNVERIFIED, FIELD_DOI_CONFIRMED, FIELD_ISSUED_CONFLICT, FIELD_PUBLISHER_SINGLE, FIELD_TITLE_VERIFIED];

/** The SOURCE_FILE fixture as the service sends it now: with each field's verification and evidence. */
export const VERIFIED_SOURCE = { ...SOURCE_FILE, fields: FIELDS };

export const withFields = (fields: FieldReview[], extra: Record<string, unknown> = {}) => ({ ...SOURCE_FILE, ...extra, fields });

/** A source with a phone photo (HEIC original), its JPEG viewing copy, a page screenshot and a video. */
export const PICTURE_SOURCE = {
  ...SOURCE_FILE,
  fields: [],
  assets: [
    { id: "a-heic", sourceId: "s1", role: "original", kind: "image", path: "P/Sources/s1/IMG_0001.heic", encrypted: true, sha256: "1".repeat(64), bytes: 2_000_000, mime: "image/heic" },
    { id: "a-mov", sourceId: "s1", role: "original", kind: "video", path: "P/Sources/s1/IMG_0001.mov", encrypted: true, sha256: "2".repeat(64), bytes: 9_000_000, mime: "video/quicktime" },
    {
      id: "a-proxy",
      sourceId: "s1",
      role: "derived",
      kind: "proxy",
      path: "P/Sources/s1/IMG_0001.proxy.jpg",
      encrypted: true,
      sha256: "3".repeat(64),
      bytes: 300_000,
      mime: "image/jpeg",
      derivation: { parents: ["a-heic"], operation: "image.proxy", provider: "ao-worker", ranAt: "local", params: { location: "coarsen" }, at: "2026-11-01T10:00:00Z", triggeredBy: "import" },
    },
    {
      id: "a-vproxy",
      sourceId: "s1",
      role: "derived",
      kind: "proxy",
      path: "P/Sources/s1/IMG_0001.proxy.mp4",
      encrypted: true,
      sha256: "4".repeat(64),
      bytes: 3_000_000,
      mime: "video/mp4",
      derivation: { parents: ["a-mov"], operation: "video.proxy", provider: "ao-worker", ranAt: "local", params: { location: "coarsen" }, at: "2026-11-01T10:00:00Z", triggeredBy: "import" },
    },
    { id: "a-shot", sourceId: "s1", role: "original", kind: "screenshot", path: "P/Sources/s1/page.png", encrypted: false, sha256: "5".repeat(64), bytes: 80_000, mime: "image/png" },
    { id: "a-svg", sourceId: "s1", role: "original", kind: "image", path: "P/Sources/s1/logo.svg", encrypted: false, sha256: "6".repeat(64), bytes: 900, mime: "image/svg+xml" },
  ],
};

/** A source whose photo's viewing copy failed (R84) and whose video's copy is still waiting. */
export const PROXY_FAILED_SOURCE = {
  ...SOURCE_FILE,
  fields: [],
  assets: PICTURE_SOURCE.assets.filter((a) => a.role === "original" && a.id !== "a-shot" && a.id !== "a-svg"),
  pendingProxies: [
    { id: "j1", type: "image.proxy", assetId: "a-heic", location: "coarsen", queuedAt: "2026-11-01T10:00:00Z", failed: { code: "LOCATION_MISMATCH", at: "2026-11-01T10:01:00Z", attempts: 3 } },
    { id: "j2", type: "video.proxy", assetId: "a-mov", location: "coarsen", queuedAt: "2026-11-01T10:00:00Z" },
  ],
};

/** A source with a transcript. */
export const TRANSCRIPT_SOURCE = {
  ...SOURCE_FILE,
  fields: [],
  assets: [
    { id: "a-audio", sourceId: "s1", role: "original", kind: "audio", path: "P/Sources/s1/interview.m4a", encrypted: false, sha256: "7".repeat(64), bytes: 9_000, mime: "audio/mp4" },
    {
      id: "a-tr",
      sourceId: "s1",
      role: "derived",
      kind: "transcript",
      path: "P/Sources/s1/interview.vtt",
      encrypted: false,
      sha256: "8".repeat(64),
      bytes: 900,
      mime: "text/vtt",
      derivation: { parents: ["a-audio"], operation: "transcribe", provider: "whisper", ranAt: "local", params: {}, at: "2026-11-01T10:00:00Z", triggeredBy: "user" },
    },
  ],
};

/** Bytes of a tiny PNG (the content is irrelevant to jsdom; the type is what matters). */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const pictureResponse = (mime = "image/jpeg") => new HttpResponse(PNG_BYTES, { headers: { "content-type": mime, "x-content-type-options": "nosniff", "cache-control": "no-store" } });

/** Handlers for the source screen: the record (`source`), the styles list and pictures. */
export function sourceHandlers(source: unknown = VERIFIED_SOURCE) {
  return [
    http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(source as Record<string, unknown>)),
    http.get(url("/styles"), () => HttpResponse.json(STYLES)),
    http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), ({ params }) => pictureResponse(params.aid === "a-shot" ? "image/png" : "image/jpeg")),
  ];
}

/**
 * jsdom has no URL.createObjectURL: a recording stand-in. `live()` lists the blob URLs created and
 * not yet revoked.
 */
export function installBlobUrls() {
  const created: Array<{ url: string; blob: Blob }> = [];
  const revoked = new Set<string>();
  let n = 0;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((b: Blob) => {
    const u = `blob:http://127.0.0.1/${++n}`;
    created.push({ url: u, blob: b });
    return u;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.add(u);
  }) as typeof URL.revokeObjectURL;
  return {
    created,
    revoked,
    live: () => created.filter((c) => !revoked.has(c.url)).map((c) => c.url),
    restore: () => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    },
  };
}
