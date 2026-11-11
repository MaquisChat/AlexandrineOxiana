/**
 * A mocked library service for the capture screen tests (MSW, pinned exact in package.json), shaped
 * like apps/library-service/src/routes/{capture,projects,governance}.ts. Records every request by
 * "METHOD path" and lets a test push `capture.progress` events on /events.
 */
import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import { createClient, type ApiClient } from "../api/client";

export const BASE = "http://127.0.0.1:4100";
export const TOKEN = "t".repeat(40);

/** UUIDv7 ids (the service's Id), as the UI validates them before use. */
export const P1 = "019a6f00-0000-7000-8000-000000000001";
export const P2 = "019a6f00-0000-7000-8000-000000000002";

/** Rules that allow the downloader and give a default legal basis for social media. */
export const OPEN_RULES = "captureMethods: [downloader]\nconsent:\n  requireLegalBasis: true\n  defaultLegalBasis:\n    social-media: Public task (GDPR Art. 6(1)(e))\n";
/** Rules that allow the downloader, need a legal basis and give no default (R41). */
export const STRICT_RULES = "captureMethods: [downloader]\n";
/** Rules whose data is not identifiable: no legal basis needed. */
export const ANON_RULES = "captureMethods: [downloader]\nidentifiability:\n  containsIdentifiable: false\n";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface CaptureSetup {
  governance?: Record<string, string>;
  /** Projects that have acknowledged the browser session. */
  acknowledged?: string[];
  /** Answer of POST /projects/:id/capture (default: a new queue id). */
  captureAnswer?: (n: number) => Response | undefined;
  captureDelayMs?: number;
  profileAnswer?: (n: number) => Response | undefined;
  /** Delay before GET /projects/:id/governance answers. */
  governanceDelayMs?: number;
  versions?: Record<string, string | null>;
  versionsAnswer?: () => Response | undefined;
  updateAnswer?: () => Response | undefined;
  updateDelayMs?: number;
  extra?: RequestHandler[];
}

export interface CaptureMock {
  calls: Recorded[];
  bodies(key: string): unknown[];
  emit(type: string, data: unknown): void;
  /** Open /events streams. */
  streams(): number;
  /** Ends every open /events stream (the client reconnects). */
  closeStreams(): void;
  client: ApiClient;
}

export const server = setupServer();

export const errorResponse = (status: number, code: string, message: string, reason?: string) =>
  HttpResponse.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status });

export function mockCapture(o: CaptureSetup = {}): CaptureMock {
  const calls: Recorded[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const acks = new Set(o.acknowledged ?? []);
  const url = (p: string) => `${BASE}${p}`;
  const wait = (ms: number | undefined) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  let captures = 0;
  let profiles = 0;
  const rec = async (request: Request, path: string) => {
    const text = await request.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    calls.push({ method: request.method, path, body });
    return body;
  };

  server.resetHandlers(
    ...(o.extra ?? []),
    http.get(url("/projects"), async ({ request }) => {
      await rec(request, "/projects");
      const p = (id: string, name: string, unlocked = true) => ({ id, name, folder: name, encrypted: false, unlocked, profiles: [], ...(acks.has(id) ? { acknowledgements: ["cookies"] } : {}) });
      return HttpResponse.json({ projects: [p(P1, "Thesis"), p(P2, "Fieldwork")] });
    }),
    http.get(url("/projects/:id/governance"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/governance`);
      await wait(o.governanceDelayMs);
      return HttpResponse.json({ yaml: o.governance?.[params.id as string] ?? OPEN_RULES, sha256: "0".repeat(64), violations: [] });
    }),
    http.post(url("/projects/:id/acknowledge"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/acknowledge`);
      acks.add(params.id as string);
      return HttpResponse.json({ acknowledgements: ["cookies"] });
    }),
    http.post(url("/projects/:id/capture"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/capture`);
      captures++;
      await wait(o.captureDelayMs);
      return o.captureAnswer?.(captures) ?? HttpResponse.json({ queueId: `q${captures}` });
    }),
    http.post(url("/projects/:id/capture-profile"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/capture-profile`);
      profiles++;
      return o.profileAnswer?.(profiles) ?? HttpResponse.json({ queueId: `qp${profiles}` });
    }),
    http.get(url("/tools/versions"), async ({ request }) => {
      await rec(request, "/tools/versions");
      return o.versionsAnswer?.() ?? HttpResponse.json({ versions: o.versions ?? { yt_dlp: "2026.10.01", gallery_dl: "1.32.19", ffmpeg: "7.1", faster_whisper: "1.2.0", python: "3.13.1" } });
    }),
    http.post(url("/tools/update"), async ({ request }) => {
      await rec(request, "/tools/update");
      await wait(o.updateDelayMs);
      return o.updateAnswer?.() ?? HttpResponse.json({ ytDlp: { old: "2026.10.01", new: "2026.11.01", managed: true }, galleryDl: { version: "1.32.19", pinned: true } });
    }),
    http.get(url("/events"), async ({ request }) => {
      await rec(request, "/events");
      let ctl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          open.add(c);
          c.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() {
          open.delete(ctl);
        },
      });
      request.signal.addEventListener("abort", () => open.delete(ctl));
      return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
    }),
  );

  return {
    calls,
    bodies: (key) => calls.filter((c) => `${c.method} ${c.path}` === key).map((c) => c.body),
    emit(type, data) {
      for (const c of open) {
        try {
          c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open.delete(c);
        }
      }
    },
    streams: () => open.size,
    closeStreams() {
      for (const c of [...open]) {
        open.delete(c);
        try {
          c.close();
        } catch {
          // already closed
        }
      }
    },
    client: createClient(BASE, TOKEN),
  };
}
