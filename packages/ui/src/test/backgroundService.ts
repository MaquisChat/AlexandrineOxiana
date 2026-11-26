/**
 * A mocked library service for the work lines (MSW): the download runs and the transcription list of a project, shaped
 * as the routes Task 5 and Task 7 pin (apps/library-service/src/routes/{downloads,transcription-list}.ts; the shapes in
 * @ao/shared api/background.ts). Records every request by "METHOD path", and lets a test push `background.progress`
 * events on /events.
 *
 * `backgroundDefaults(base)`: the two reads every screen with the work lines makes, answered with nothing to show (no
 * run, an idle list), for the screens' own fakes (service.ts, captureService.ts).
 *
 * Task 9 adds the switches and "Transcribe everything" (routes pinned in Task 7): GET/PUT …/automation, GET/PUT
 * /settings/background, GET …/untranscribed and POST …/transcription-list. `switchDefaults(base)`: the two switch reads,
 * answered with the service's defaults (automatic transcription off, keeping awake on), for the fakes of the screens
 * that show a switch (service.ts, msw-governance.ts, msw-tools.ts).
 */
import { http, HttpResponse, type RequestHandler } from "msw";
import { onTestFinished } from "vitest";
import {
  BACKGROUND_EVENT,
  type BackgroundProgressEvent,
  type BackgroundSettings,
  type DownloadProblemsResponse,
  type DownloadRunSummary,
  type ProjectAutomation,
  type TranscriptionListSummary,
  type UntranscribedResponse,
} from "@ao/shared";

export const BG_BASE = "http://127.0.0.1:4100";

/** A run of "Example Channel" on YouTube, downloading, 120 of 412 (the spec's sketch). */
export function exampleRun(over: Partial<DownloadRunSummary> = {}): DownloadRunSummary {
  const r: DownloadRunSummary = {
    runId: "run-1",
    projectId: "p1",
    url: "https://www.youtube.com/@example",
    title: "Example Channel",
    platform: "youtube",
    quality: "720p",
    transcribe: true,
    state: "downloading",
    total: 412,
    done: 120,
    failed: 0,
    notCompleted: 292,
    startedAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T11:00:00.000Z",
    ...over,
  };
  return over.notCompleted === undefined ? { ...r, notCompleted: r.total - r.done } : r;
}

/** The transcription list with nothing on it. */
export function idleList(projectId: string, over: Partial<TranscriptionListSummary> = {}): TranscriptionListSummary {
  return { projectId, state: "idle", total: 0, done: 0, failed: 0, soundSecondsLeft: 0, unknownLeft: 0, ...over };
}

/** GET …/downloads with no run and GET …/transcription-list idle, for every project. */
export function backgroundDefaults(base: string = BG_BASE): RequestHandler[] {
  return [
    http.get(`${base}/projects/:id/downloads`, () => HttpResponse.json({ runs: [] })),
    http.get(`${base}/projects/:id/transcription-list`, ({ params }) => HttpResponse.json({ list: idleList(String(params.id)) })),
  ];
}

/** GET …/automation answered "off" and GET /settings/background answered "on" (the service's defaults), for every project. */
export function switchDefaults(base: string = BG_BASE): RequestHandler[] {
  return [
    http.get(`${base}/projects/:id/automation`, () => HttpResponse.json({ transcribeNewMedia: false } satisfies ProjectAutomation)),
    http.get(`${base}/settings/background`, () => HttpResponse.json({ keepAwake: true } satisfies BackgroundSettings)),
  ];
}

export interface BackgroundRecorded {
  method: string;
  path: string;
  /** The JSON body of a PUT or POST that has one. */
  body?: unknown;
}

export interface BackgroundSetup {
  runs?: DownloadRunSummary[];
  /** Per project; left out: idle. */
  lists?: Record<string, TranscriptionListSummary>;
  /** Per run id. */
  problems?: Record<string, DownloadProblemsResponse>;
  /** Hold every POST until `release()` (or the test's end). */
  holdActions?: boolean;
  /** Answer of a POST on a run (default: the run in its new state). */
  runAnswer?: (what: string, runId: string) => Response | undefined;
  /** Answer of a POST on the transcription list (default: the list in its new state). */
  listAnswer?: (what: string) => Response | undefined;
  /** The project's switch, per project; left out: off. */
  automation?: Record<string, ProjectAutomation>;
  /** Answer of a PUT of the project's switch (default: the switch saved and sent back). */
  automationAnswer?: (body: unknown) => Response | undefined;
  /** The keep-awake setting; left out: on. */
  settings?: BackgroundSettings;
  /** Answer of a PUT of the keep-awake setting (default: saved and sent back). */
  settingsAnswer?: (body: unknown) => Response | undefined;
  /** What GET …/untranscribed says, per project; left out: nothing to transcribe. */
  untranscribed?: Record<string, UntranscribedResponse>;
  /** Answer of POST …/transcription-list (default: the untranscribed sources put on the list, and an event sent). */
  transcribeAllAnswer?: (body: unknown) => Response | undefined;
  /** Hold the PUTs of the switches and POST …/transcription-list too until `release()` (or the test's end). */
  holdSwitches?: boolean;
  /** Leave out the /events handler (the test gives its own). */
  noEvents?: boolean;
  /** Handlers tried first. */
  extra?: RequestHandler[];
}

export interface BackgroundMock {
  handlers: RequestHandler[];
  calls: BackgroundRecorded[];
  /** How many times "METHOD path" was asked. */
  count(key: string): number;
  /** The bodies sent with "METHOD path", in order. */
  bodies(key: string): unknown[];
  /** Sends a `background.progress` event (or any event) on every open /events stream. */
  emit(data: BackgroundProgressEvent, type?: string): void;
  /** The /events requests, kept (their signals are read when asserting a cancel). */
  eventRequests: Request[];
  streams(): number;
  closeStreams(): void;
  setRuns(runs: DownloadRunSummary[]): void;
  setList(projectId: string, list: TranscriptionListSummary): void;
  release(): void;
}

const STATE_AFTER: Record<string, DownloadRunSummary["state"]> = { pause: "paused", stop: "stopped", resume: "downloading" };

export function mockBackground(o: BackgroundSetup = {}, base: string = BG_BASE): BackgroundMock {
  const calls: BackgroundRecorded[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const eventRequests: Request[] = [];
  const enc = new TextEncoder();
  let runs = [...(o.runs ?? [])];
  const lists: Record<string, TranscriptionListSummary> = { ...(o.lists ?? {}) };
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  const rec = (request: Request, path: string) => calls.push({ method: request.method, path });
  const hold = () => (o.holdActions ? released : Promise.resolve());
  const listOf = (pid: string) => lists[pid] ?? idleList(pid);
  const automation: Record<string, ProjectAutomation> = { ...(o.automation ?? {}) };
  let settings: BackgroundSettings = o.settings ?? { keepAwake: true };
  const untranscribed: Record<string, UntranscribedResponse> = { ...(o.untranscribed ?? {}) };
  const holdSwitch = () => (o.holdSwitches ? released : Promise.resolve());
  const nothing: UntranscribedResponse = { count: 0, soundSeconds: 0, unknownLengths: 0 };
  const readBody = async (request: Request): Promise<unknown> => {
    const text = await request.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  const emitOn = (data: BackgroundProgressEvent, type: string = BACKGROUND_EVENT) => {
    for (const c of open) {
      try {
        c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        open.delete(c);
      }
    }
  };

  const handlers: RequestHandler[] = [
    ...(o.extra ?? []),
    http.get(`${base}/projects/:id/downloads`, ({ request, params }) => {
      rec(request, `/projects/${String(params.id)}/downloads`);
      return HttpResponse.json({ runs: runs.filter((r) => r.projectId === params.id) });
    }),
    http.get(`${base}/projects/:id/downloads/:runId/problems`, ({ request, params }) => {
      rec(request, `/projects/${String(params.id)}/downloads/${String(params.runId)}/problems`);
      return HttpResponse.json(o.problems?.[String(params.runId)] ?? { platform: "youtube", problems: [] });
    }),
    http.post(`${base}/projects/:id/downloads/:runId/:what`, async ({ request, params }) => {
      const what = String(params.what);
      const runId = String(params.runId);
      rec(request, `/projects/${String(params.id)}/downloads/${runId}/${what}`);
      await hold();
      const answer = o.runAnswer?.(what, runId);
      if (answer) return answer;
      if (what === "discard") {
        runs = runs.filter((r) => r.runId !== runId);
        return HttpResponse.json({ discarded: true });
      }
      const r = runs.find((x) => x.runId === runId);
      if (!r) return HttpResponse.json({ error: { code: "NOT_FOUND", message: "These downloads were not found." } }, { status: 404 });
      const next = { ...r, state: STATE_AFTER[what] ?? r.state, updatedAt: new Date(Date.parse(r.updatedAt) + 1000).toISOString() };
      runs = runs.map((x) => (x.runId === runId ? next : x));
      return HttpResponse.json({ run: next });
    }),
    http.get(`${base}/projects/:id/automation`, ({ request, params }) => {
      rec(request, `/projects/${String(params.id)}/automation`);
      return HttpResponse.json(automation[String(params.id)] ?? { transcribeNewMedia: false });
    }),
    http.put(`${base}/projects/:id/automation`, async ({ request, params }) => {
      const pid = String(params.id);
      const body = await readBody(request);
      calls.push({ method: "PUT", path: `/projects/${pid}/automation`, body });
      await holdSwitch();
      const answer = o.automationAnswer?.(body);
      if (answer) return answer;
      automation[pid] = body as ProjectAutomation;
      return HttpResponse.json(automation[pid]);
    }),
    http.get(`${base}/settings/background`, ({ request }) => {
      rec(request, "/settings/background");
      return HttpResponse.json(settings);
    }),
    http.put(`${base}/settings/background`, async ({ request }) => {
      const body = await readBody(request);
      calls.push({ method: "PUT", path: "/settings/background", body });
      await holdSwitch();
      const answer = o.settingsAnswer?.(body);
      if (answer) return answer;
      settings = body as BackgroundSettings;
      return HttpResponse.json(settings);
    }),
    http.get(`${base}/projects/:id/untranscribed`, ({ request, params }) => {
      rec(request, `/projects/${String(params.id)}/untranscribed`);
      return HttpResponse.json(untranscribed[String(params.id)] ?? nothing);
    }),
    http.post(`${base}/projects/:id/transcription-list`, async ({ request, params }) => {
      const pid = String(params.id);
      const body = await readBody(request);
      calls.push({ method: "POST", path: `/projects/${pid}/transcription-list`, body });
      await holdSwitch();
      const answer = o.transcribeAllAnswer?.(body);
      if (answer) return answer;
      const added = (untranscribed[pid] ?? nothing).count;
      untranscribed[pid] = nothing;
      const l = listOf(pid);
      lists[pid] = added > 0 ? { ...l, state: l.state === "paused" ? "paused" : "running", total: l.total + added } : l;
      // As the service does (Task 7, R679): the change is published before the answer.
      emitOn({ projectId: pid, transcriptions: lists[pid] });
      return HttpResponse.json({ added, list: lists[pid] });
    }),
    http.get(`${base}/projects/:id/transcription-list`, ({ request, params }) => {
      rec(request, `/projects/${String(params.id)}/transcription-list`);
      return HttpResponse.json({ list: listOf(String(params.id)) });
    }),
    http.post(`${base}/projects/:id/transcription-list/:what`, async ({ request, params }) => {
      const pid = String(params.id);
      const what = String(params.what);
      rec(request, `/projects/${pid}/transcription-list/${what}`);
      await hold();
      const answer = o.listAnswer?.(what);
      if (answer) return answer;
      const l = listOf(pid);
      lists[pid] = what === "stop" ? idleList(pid) : { ...l, state: what === "pause" ? "paused" : "running" };
      return HttpResponse.json({ list: lists[pid] });
    }),
    ...(o.noEvents
      ? []
      : [
          http.get(`${base}/events`, ({ request }) => {
            rec(request, "/events");
            eventRequests.push(request);
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
        ]),
  ];

  return {
    handlers,
    calls,
    count: (key) => calls.filter((c) => `${c.method} ${c.path}` === key).length,
    bodies: (key) => calls.filter((c) => `${c.method} ${c.path}` === key).map((c) => c.body),
    emit(data, type = BACKGROUND_EVENT) {
      for (const c of open) {
        try {
          c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open.delete(c);
        }
      }
    },
    eventRequests,
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
    setRuns(r) {
      runs = [...r];
    },
    setList(pid, l) {
      lists[pid] = l;
    },
    release: () => release(),
  };
}
