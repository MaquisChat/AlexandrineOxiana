/**
 * A mocked library service for the Bulk Import tests (MSW, pinned exact in package.json). Records
 * every request body by "METHOD path" and lets a test push `import.progress` events on /events.
 */
import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { createClient, type ApiClient } from "../api/client";
import type { ImportReport, ReviewItem, ScanSummary } from "../api/import";

export const BASE = "http://127.0.0.1:4100";
export const TOKEN = "t".repeat(40);

/** UUIDv7 ids (the service's Id), as the UI validates them before use (R115 I3). */
export const P1 = "019a6f00-0000-7000-8000-000000000001";
export const P2 = "019a6f00-0000-7000-8000-000000000002";
export const B1 = "019a7000-0000-7000-8000-0000000000b1";
export const B7 = "019a7000-0000-7000-8000-0000000000b7";

export const PROJECT = { id: P1, name: "Thesis", encrypted: false, unlocked: true };

/** Governance that neither pseudonymises names nor requires encryption. */
export const OPEN_GOVERNANCE = "identifiability:\n  containsIdentifiable: false\n  pseudonymizeFileNames: false\nencryption:\n  atRest: optional\n";
/** Governance of an identifiable project (IRB profile: names pseudonymised, R64). */
export const PSEUDONYMISING_GOVERNANCE = "profiles: [irb]\n";

export const SUMMARY: ScanSummary = {
  items: 1290,
  byType: { pdf: 1200, epub: 90 },
  totalBytes: 3_221_225_472,
  likelyDuplicates: 14,
  alreadyImported: 7,
  unreadable: [{ path: "broken/locked.pdf", reason: "The PDF is encrypted." }],
  notes: ["2 empty records were skipped."],
  outsideFiles: [],
};

export const REPORT: ImportReport = {
  batchId: B1,
  number: 4,
  kind: "folder",
  state: "finished",
  startedAt: "2026-11-11T10:00:00.000Z",
  finishedAt: "2026-11-11T10:20:00.000Z",
  counts: { items: 1290, created: 1280, needsReview: 4, duplicates: 2, merged: 3, updated: 0, unchanged: 0, deletedHere: 0, failed: 1 },
  failures: [{ item: "notes/scan-12.pdf", reason: "The file could not be read." }],
  fileNotes: [],
  pendingReview: [{ reviewId: "r1", sourceId: "s1", reasons: ["Low confidence"] }],
  keptFields: [],
  governance: [],
  notes: [],
};

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface ServiceMock {
  calls: Recorded[];
  bodies(key: string): unknown[];
  /** Pushes one SSE event to every open /events stream. */
  emit(type: string, data: unknown): void;
  client: ApiClient;
  /** Replaces what GET /projects/:id/imports answers. */
  setBatches(b: unknown[]): void;
  /** Most source requests in flight at once. */
  peakSourceRequests(): number;
}

export interface ServiceSetup {
  governance?: string;
  summary?: ScanSummary;
  report?: ImportReport;
  review?: ReviewItem[];
  sources?: Record<string, unknown>;
  collections?: Array<{ id: string; name: string }>;
  tags?: Array<{ id: string; name: string; color?: string }>;
  batches?: unknown[];
  participants?: unknown[];
  sessions?: unknown[];
  workspaceTags?: Array<{ id: string; name: string; color?: string }>;
  extra?: RequestHandler[];
  /** "close": every /events stream ends right after its ": connected" comment. */
  events?: "open" | "close";
  /** Delay (ms) before each source answer. */
  sourceDelayMs?: number;
  /** Delay (ms) before the dry run answers. */
  dryRunDelayMs?: number;
  /** Delay (ms) before the governance answers. */
  governanceDelayMs?: number;
  /** Source ids whose first request fails (HTTP 500). */
  failSourcesOnce?: string[];
  /** The Zotero key in the password store (Task 57): stored at the start, or no store at all. */
  zoteroKey?: { stored?: boolean; noStore?: boolean };
  /** What GET /import/zotero-data-folders answers (default none). */
  zoteroFolders?: Array<{ path: string; from: "usual-place" | "zotero-setting" }>;
  /** Picture bytes by asset id, for GET …/assets/:aid/content; anything else is 400. */
  pictures?: Record<string, { type: string; bytes: Uint8Array }>;
  /** Delay (ms) before each picture answer. */
  pictureDelayMs?: number;
}

export const server = setupServer();

export function mockService(o: ServiceSetup = {}): ServiceMock {
  const calls: Recorded[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  const rec = async (request: Request, path: string) => {
    let body: unknown;
    const text = await request.text();
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    calls.push({ method: request.method, path, body });
    return body;
  };
  const url = (p: string) => `${BASE}${p}`;
  const wait = (ms: number | undefined) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  let batches = o.batches ?? [];
  let inFlight = 0;
  let peak = 0;
  const failOnce = new Set(o.failSourcesOnce ?? []);
  let keyStored = !!o.zoteroKey?.stored;
  const noStore = () => HttpResponse.json({ error: { code: "UNAVAILABLE", message: "No secure key store is available on this computer, so the key was not saved." } }, { status: 503 });

  // Replaces the previous test's handlers (rather than resetting after each test), so a request a
  // component sends while a test is being torn down still finds a handler.
  server.resetHandlers(
    ...(o.extra ?? []),
    http.get(url("/projects"), async ({ request }) => {
      await rec(request, "/projects");
      return HttpResponse.json({ projects: [PROJECT, { id: P2, name: "Fieldwork", encrypted: true, unlocked: true }] });
    }),
    http.get(url("/projects/:id/governance"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/governance`);
      await wait(o.governanceDelayMs);
      return HttpResponse.json({ yaml: o.governance ?? OPEN_GOVERNANCE, sha256: "0".repeat(64), violations: [] });
    }),
    http.post(url("/projects/:id/import/dry-run"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/import/dry-run`);
      await wait(o.dryRunDelayMs);
      return HttpResponse.json(o.summary ?? SUMMARY);
    }),
    http.post(url("/projects/:id/import"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/import`);
      return HttpResponse.json({ batchId: B1 });
    }),
    http.post(url("/projects/:id/device-import"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/device-import`);
      return HttpResponse.json({ batchId: B1 });
    }),
    http.get(url("/projects/:id/imports"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/imports`);
      return HttpResponse.json({ batches });
    }),
    http.get(url("/projects/:id/participants"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/participants`);
      return HttpResponse.json({ participants: o.participants ?? [], complete: true });
    }),
    http.get(url("/projects/:id/sessions"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/sessions`);
      return HttpResponse.json({ sessions: o.sessions ?? [], complete: true });
    }),
    http.get(url("/projects/:id/collections"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/collections`);
      return HttpResponse.json({ collections: o.collections ?? [] });
    }),
    http.get(url("/projects/:id/tags"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/tags`);
      return HttpResponse.json({ tags: o.tags ?? [], workspaceTags: o.workspaceTags ?? [] });
    }),
    http.get(url("/secrets/zotero-api-key"), async ({ request }) => {
      await rec(request, "/secrets/zotero-api-key");
      return o.zoteroKey?.noStore ? noStore() : HttpResponse.json({ stored: keyStored });
    }),
    http.put(url("/secrets/zotero-api-key"), async ({ request }) => {
      await rec(request, "/secrets/zotero-api-key");
      await wait(20);
      if (o.zoteroKey?.noStore) return noStore();
      keyStored = true;
      return HttpResponse.json({ stored: true });
    }),
    http.delete(url("/secrets/zotero-api-key"), async ({ request }) => {
      await rec(request, "/secrets/zotero-api-key");
      if (o.zoteroKey?.noStore) return noStore();
      const removed = keyStored;
      keyStored = false;
      return HttpResponse.json({ removed });
    }),
    http.get(url("/import/zotero-data-folders"), async ({ request }) => {
      await rec(request, "/import/zotero-data-folders");
      return HttpResponse.json({ folders: o.zoteroFolders ?? [] });
    }),
    http.get(url("/projects/:id/sources/:sid/assets/:aid/content"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/sources/${params.sid as string}/assets/${params.aid as string}/content`);
      await wait(o.pictureDelayMs);
      const p = o.pictures?.[params.aid as string];
      if (!p) return HttpResponse.json({ error: { code: "VALIDATION", message: "This file is not a picture." } }, { status: 400 });
      return new HttpResponse(p.bytes, { headers: { "Content-Type": p.type } });
    }),
    http.get(url("/projects/:id/sources/:sid"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/sources/${params.sid as string}`);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await wait(o.sourceDelayMs);
      } finally {
        inFlight--;
      }
      if (failOnce.delete(params.sid as string)) return HttpResponse.json({ error: { code: "INTERNAL", message: "The source could not be read." } }, { status: 500 });
      const s = o.sources?.[params.sid as string];
      return s ? HttpResponse.json(s) : HttpResponse.json({ error: { code: "NOT_FOUND", message: "That source was not found." } }, { status: 404 });
    }),
    http.get(url("/projects/:id/sources"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/sources`);
      return HttpResponse.json({ total: 1, items: [{ id: "s-old", title: "An older edition", type: "book" }] });
    }),
    http.post(url("/imports/:batchId/:action"), async ({ request, params }) => {
      const action = params.action as string;
      await rec(request, `/imports/${params.batchId as string}/${action}`);
      if (action === "undo") return HttpResponse.json({ removedSources: 1284, revertedMerges: 3, kept: [] });
      return HttpResponse.json({ batchId: params.batchId, action });
    }),
    http.get(url("/imports/:batchId/report"), async ({ request, params }) => {
      await rec(request, `/imports/${params.batchId as string}/report`);
      return HttpResponse.json(o.report ?? REPORT);
    }),
    http.get(url("/imports/:batchId/review"), async ({ request, params }) => {
      await rec(request, `/imports/${params.batchId as string}/review`);
      return HttpResponse.json({ items: o.review ?? [] });
    }),
    http.post(url("/review/bulk-edit"), async ({ request }) => {
      const b = (await rec(request, "/review/bulk-edit")) as { itemIds: string[] };
      return HttpResponse.json({ edited: b.itemIds.length });
    }),
    http.post(url("/review/:itemId/decide"), async ({ request, params }) => {
      await rec(request, `/review/${params.itemId as string}/decide`);
      return HttpResponse.json({ decided: true });
    }),
    http.get(url("/events"), async ({ request }) => {
      await rec(request, "/events");
      let ctl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          streams.add(c);
          c.enqueue(enc.encode(": connected\n\n"));
          if (o.events === "close") {
            streams.delete(c);
            c.close();
          }
        },
        cancel() {
          streams.delete(ctl);
        },
      });
      request.signal.addEventListener("abort", () => streams.delete(ctl));
      return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
    }),
  );

  return {
    calls,
    bodies: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).map((c) => c.body),
    emit(type, data) {
      for (const c of streams) {
        try {
          c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          streams.delete(c);
        }
      }
    },
    client: createClient(BASE, TOKEN),
    setBatches(b) {
      batches = b;
    },
    peakSourceRequests: () => peak,
  };
}
