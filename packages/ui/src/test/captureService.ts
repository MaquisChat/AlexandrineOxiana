/**
 * A mocked library service for the capture screen tests (MSW, pinned exact in package.json), shaped
 * like apps/library-service/src/routes/{capture,projects,governance}.ts. Records every request by
 * "METHOD path" and lets a test push `capture.progress` events on /events.
 */
import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import type { CaptureEstimate, CaptureQueueDetail } from "@ao/shared";
import { createClient, type ApiClient } from "../api/client";
import { backgroundDefaults } from "./backgroundService";

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

/**
 * The estimate of POST /projects/:id/capture-estimate (whole channels, Task 5's route): the spec's channel of 412
 * videos and 310 hours, 380 GB free on "Macintosh HD", Video tools installed.
 */
export function exampleEstimate(over: Partial<CaptureEstimate> = {}): CaptureEstimate {
  return {
    kind: "channel",
    platform: "youtube",
    title: "Example Channel",
    count: 412,
    alreadyInProject: 0,
    soundSeconds: 310 * 3600,
    unknownLengths: 0,
    listComplete: true,
    freeBytes: 380_000_000_000,
    diskName: "Macintosh HD",
    videoToolsInstalled: true,
    speechModel: "medium",
    metadataOnly: false,
    ...over,
  };
}

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
  /** Delay before POST /projects/:id/capture-profile answers. */
  profileDelayMs?: number;
  /**
   * Answer of POST /projects/:id/capture-estimate (default: `exampleEstimate`, with `metadataOnly` as asked); a
   * CaptureEstimate is sent as JSON.
   */
  estimateAnswer?: (n: number, body: unknown) => Response | CaptureEstimate | undefined;
  /** Held until this settles before the estimate is answered. */
  estimateHold?: Promise<unknown>;
  /** Per project: `automation.transcribeNewMedia` (GET /projects/:id/automation, Task 7's route); default false. */
  automation?: Record<string, boolean>;
  /** Delay before GET /projects/:id/governance answers. */
  governanceDelayMs?: number;
  /** Projects whose rules the service says it cannot read (`readable: false`, R379 FR-A18). */
  unreadable?: string[];
  versions?: Record<string, string | null>;
  versionsAnswer?: () => Response | undefined;
  updateAnswer?: () => Response | undefined;
  updateDelayMs?: number;
  extra?: RequestHandler[];
  /** The optional tools' catalogue (GET /tools, Task 48b); left out: refused as in a plain browser (403). */
  tools?: unknown[];
  /** The capture queues the service knows of (GET /projects/:id/captures[/:queueId], Task 63); changed later with setQueues. */
  queues?: CaptureQueueDetail[];
  /** Delay before GET /projects/:id/captures answers. */
  queuesDelayMs?: number;
  /** Answer of GET /projects/:id/captures (default: the queues). */
  queuesAnswer?: () => Response | undefined;
  /** Per project: the links a lock cut, told with its queues until acknowledged (R464 b). */
  cutByLock?: Record<string, number>;
  /** Answer of POST /projects/:id/captures/cut-by-lock/acknowledge (default: forgets the count). */
  cutAckAnswer?: () => Response | undefined;
}

export interface CaptureMock {
  calls: Recorded[];
  bodies(key: string): unknown[];
  emit(type: string, data: unknown): void;
  /** Open /events streams. */
  streams(): number;
  /** Ends every open /events stream (the client reconnects). */
  closeStreams(): void;
  /** What the service reports from now on. */
  setQueues(queues: CaptureQueueDetail[]): void;
  /** GET /projects/:id/captures answers sent so far. */
  queueReads(): number;
  client: ApiClient;
}

export const server = setupServer();

export const errorResponse = (status: number, code: string, message: string, reason?: string) =>
  HttpResponse.json({ error: { code, message, ...(reason ? { reason } : {}) } }, { status });

export function mockCapture(o: CaptureSetup = {}): CaptureMock {
  const calls: Recorded[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const held: Request[] = [];
  const enc = new TextEncoder();
  const acks = new Set(o.acknowledged ?? []);
  const url = (p: string) => `${BASE}${p}`;
  const wait = (ms: number | undefined) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  let captures = 0;
  let profiles = 0;
  let estimates = 0;
  let queues = o.queues ?? [];
  let queueReads = 0;
  const cut = { ...(o.cutByLock ?? {}) };
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
      const unreadable = o.unreadable?.includes(params.id as string) ?? false;
      return HttpResponse.json({
        yaml: o.governance?.[params.id as string] ?? OPEN_RULES,
        sha256: "0".repeat(64),
        violations: [],
        readable: !unreadable,
        issues: unreadable ? ["residencey: unknown key (check spelling) in governance.yaml"] : [],
        warnings: [],
      });
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
      const n = profiles;
      await wait(o.profileDelayMs);
      return o.profileAnswer?.(n) ?? HttpResponse.json({ queueId: `qp${n}` });
    }),
    http.post(url("/projects/:id/capture-estimate"), async ({ request, params }) => {
      const body = await rec(request, `/projects/${params.id as string}/capture-estimate`);
      estimates++;
      const n = estimates;
      await o.estimateHold;
      const answer = o.estimateAnswer?.(n, body);
      if (answer instanceof Response) return answer;
      const asked = (body as { options?: { metadataOnly?: boolean } } | undefined)?.options;
      return HttpResponse.json(answer ?? exampleEstimate({ metadataOnly: asked?.metadataOnly === true }));
    }),
    http.get(url("/projects/:id/automation"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/automation`);
      return HttpResponse.json({ transcribeNewMedia: o.automation?.[params.id as string] ?? false });
    }),
    http.get(url("/projects/:id/captures"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/captures`);
      await wait(o.queuesDelayMs);
      const answer = o.queuesAnswer?.();
      queueReads++;
      if (answer) return answer;
      const summaries = queues.filter((q) => q.projectId === params.id).map(({ urls: _u, items: _i, itemsOmitted: _o, ...summary }) => summary);
      const n = cut[params.id as string];
      return HttpResponse.json({ queues: summaries, ...(n ? { cutByLock: n } : {}) });
    }),
    http.post(url("/projects/:id/captures/cut-by-lock/acknowledge"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/captures/cut-by-lock/acknowledge`);
      const answer = o.cutAckAnswer?.();
      if (answer) return answer;
      delete cut[params.id as string];
      return HttpResponse.json({ acknowledged: true });
    }),
    http.get(url("/projects/:id/captures/:qid"), async ({ request, params }) => {
      await rec(request, `/projects/${params.id as string}/captures/${params.qid as string}`);
      const q = queues.find((x) => x.queueId === params.qid && x.projectId === params.id);
      return q ? HttpResponse.json(q) : errorResponse(404, "NOT_FOUND", "That capture was not found.");
    }),
    http.get(url("/tools"), () =>
      o.tools ? HttpResponse.json({ platform: "linux-x64", tools: o.tools, jobs: [] }) : errorResponse(403, "FORBIDDEN", "The tools are managed from the desktop app."),
    ),
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
      // The request is kept: Node's Request passes the caller's abort on through a weak reference, so a listener on the
      // signal of a request no longer held can miss it.
      held.push(request);
      request.signal.addEventListener("abort", () => open.delete(ctl));
      return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
    }),
    // The work lines (whole channels): no download run, and an idle transcription list (not recorded in `calls`).
    ...backgroundDefaults(BASE),
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
    setQueues(q) {
      queues = q;
    },
    queueReads: () => queueReads,
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
