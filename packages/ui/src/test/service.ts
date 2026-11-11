/**
 * A mocked library service for screen tests (MSW, R113): fixtures shaped exactly like the Task 30
 * routes (apps/library-service/src/routes/*.ts) and helpers for their NDJSON and SSE streams.
 */
import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createClient } from "../api/client";
import { libraryApi, type LibraryApi } from "../api/library";

export const BASE = "http://127.0.0.1:4100";
export const TOKEN = "t".repeat(40);
export const url = (path: string) => `${BASE}${path}`;

export const server = setupServer();

/** Starts the mocked service for the file; every request must have a handler. */
export function useMockService(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

export function testClient() {
  return createClient(BASE, TOKEN);
}

export function testApi(): LibraryApi {
  return libraryApi(testClient());
}

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An NDJSON response whose lines arrive one by one, `gapMs` apart. */
export function ndjson(lines: unknown[], gapMs = 30): HttpResponse<BodyInit> {
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const [i, l] of lines.entries()) {
        if (i > 0) await sleep(gapMs);
        c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
      }
      c.close();
    },
  });
  return new HttpResponse(stream, { headers: { "content-type": "application/x-ndjson" } });
}

/** A text/event-stream that sends `events` then stays open until the client goes away. */
export function sse(events: Array<{ type: string; data: unknown }>): HttpResponse<BodyInit> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
    },
  });
  return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
}

export const serviceError = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });

// ---- fixtures -------------------------------------------------------------------------------

export const LIBRARIES = {
  libraries: [
    { libraryId: "lib-1", name: "Thesis library", lastKnownPaths: ["/Volumes/Fieldwork SSD/Thesis library"] },
    { libraryId: "lib-2", name: "Grant 2025", lastKnownPaths: ["/home/r/Grant 2025"] },
  ],
};

export const CURRENT_RW = { libraryId: "lib-1", name: "Thesis library", mode: "read-write" };

export const PROJECTS = {
  projects: [
    { id: "p1", name: "Dissertation", folder: "Dissertation", encrypted: false, unlocked: true },
    { id: "p2", name: "Clinic interviews", folder: "Clinic interviews", encrypted: true, unlocked: false },
  ],
};

export const GOVERNANCE: Record<string, string> = {
  p1: "profiles: [irb, gdpr]\nencryption: optional\n",
  p2: "# rules\nprofiles:\n  - hipaa\n",
};

export const COLLECTIONS = {
  collections: [
    { id: "c1", projectId: "p1", name: "Chapter 1" },
    { id: "c2", projectId: "p1", name: "Interviews", parentId: "c1" },
    { id: "c3", projectId: "p1", name: "Field notes", parentId: "c2" },
    { id: "c4", projectId: "p1", name: "Chapter 2" },
  ],
};

export const TAGS = {
  tags: [{ id: "t1", scope: "p1", name: "to read" }],
  workspaceTags: [{ id: "w1", scope: "workspace", name: "methods" }],
};

export const SOURCES = {
  total: 2,
  items: [
    { id: "s1", projectId: "p1", type: "book", title: "Ethnography at Work", creatorsText: "Smith, Jane", issuedYear: "2019", folder: "Dissertation/Sources/s1", needsReview: false, locked: false },
    { id: "s2", projectId: "p1", type: "article-journal", title: "دراسة ميدانية", creatorsText: "Haddad, R.", folder: "Dissertation/Sources/s2", needsReview: true, locked: false },
  ],
};

export const SOURCE_FILE = {
  formatVersion: 1,
  source: {
    id: "s1",
    projectIds: ["p1"],
    type: "book",
    title: { variants: [{ lang: "en", kind: "original", value: "Ethnography at Work" }] },
    creators: [{ family: "Smith", given: "Jane", role: "author" }],
    publisher: "University Press",
    issued: "2019",
    identifiers: { doi: "10.1000/xyz" },
    citationKey: "smith2019",
    caseAttributes: {},
    provenance: { method: "manual_upload" },
    availability: { status: "available" },
    collectionIds: ["c1"],
    tagIds: ["t1"],
    participantIds: [],
    createdAt: "2026-11-01T10:00:00Z",
    createdBy: "r",
    modifiedAt: "2026-11-01T10:00:00Z",
    modifiedBy: "r",
    folder: "Dissertation/Sources/s1",
  },
  assets: [{ id: "a1", sourceId: "s1", role: "original", kind: "pdf", path: "Dissertation/Sources/s1/smith-2019.pdf", encrypted: false, sha256: "0".repeat(64), bytes: 1024, mime: "application/pdf" }],
  annotations: [],
  fieldEvidence: [],
  verification: {},
};

export const STYLES = {
  styles: [
    { id: "apa", title: "American Psychological Association 7th edition" },
    { id: "chicago-author-date", title: "Chicago Manual of Style 17th edition (author-date)" },
    { id: "modern-language-association", title: "Modern Language Association 9th edition" },
  ],
};

/** Everything the library screen asks for, answered from the fixtures (override per test with server.use). */
export function libraryHandlers(opts: { current?: Record<string, unknown>; state?: Record<string, unknown>; events?: Array<{ type: string; data: unknown }> } = {}) {
  const current = opts.current ?? CURRENT_RW;
  const state = opts.state ?? { open: true, ...current, integrityWarnings: [], projectWarnings: {} };
  const j = (b: JsonBodyType) => () => HttpResponse.json(b);
  return [
    http.get(url("/libraries"), j({ ...LIBRARIES, current })),
    http.get(url("/projects"), j(PROJECTS)),
    http.get(url("/projects/:id/governance"), ({ params }) => HttpResponse.json({ yaml: GOVERNANCE[String(params.id)] ?? "", sha256: "a".repeat(64), violations: [] })),
    http.get(url("/projects/:id/collections"), j(COLLECTIONS)),
    http.get(url("/projects/:id/tags"), j(TAGS)),
    http.get(url("/projects/:id/sources"), j(SOURCES)),
    http.get(url("/projects/:id/sources/:sid"), j(SOURCE_FILE)),
    http.get(url("/styles"), j(STYLES)),
    http.get(url("/events"), () => sse([{ type: "library.state", data: state }, ...(opts.events ?? [])])),
  ];
}
