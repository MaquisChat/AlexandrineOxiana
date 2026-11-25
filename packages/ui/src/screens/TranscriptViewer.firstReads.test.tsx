/**
 * FR-756 (R584, R586, R597): the transcript viewer's first reads — the source, its versions, the chosen version's
 * segments — have a time limit. A read given up at the limit says "The library service did not answer in time."; one
 * that failed for want of any answer says "The library service could not be reached." (never both run together); both
 * offer "Try again". Its event stream, not opened within its own limit, is closed and opened afresh after the screen's
 * pause (two seconds); at that opening the first reads still out are made again. An open, quiet stream is never dropped.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptApi } from "../api/transcripts";
import { hang, server, sse, sseAttempts, testClient, url, useMockService } from "../test/service";
import { serviceErrorBody, sourceFile, transcriptService } from "../test/msw-transcripts";
import { TranscriptViewer } from "./TranscriptViewer";

useMockService();

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const TITLE = "Interview with a baker";

const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);
const heading = () => screen.getByRole("heading", { level: 1 });
/** The Version box's options, as shown. */
const versionBox = () => [...(screen.getByLabelText("Version") as HTMLSelectElement).options].map((o) => o.textContent);

beforeEach(() => {
  window.history.replaceState(null, "", "/transcript?project=p1&source=s1");
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
  vi.restoreAllMocks();
});

/** The mocked service, then `over` in front of it (MSW takes the newest handler first). */
function serve(...over: Parameters<typeof server.use>) {
  const svc = transcriptService({ media: "none" });
  server.use(...svc.handlers);
  if (over.length) server.use(...over);
  return svc;
}

/** A GET that hangs on its first `held` asks (never settles until the test ends), then answers as the service does. */
function holding(path: string, held: number, answer: () => Response | Promise<Response>) {
  let n = 0;
  const gate = hang();
  return {
    handler: http.get(url(path), async () => {
      if (++n <= held) await gate;
      return answer();
    }),
    count: () => n,
  };
}

const show = (p: { firstReadMs?: number; streamOpenMs?: number; streamQuietMs?: number } = {}) => render(<TranscriptViewer api={transcriptApi(testClient())} projectId="p1" sourceId="s1" {...p} />);

describe("TranscriptViewer: first reads that never settle or fail (FR-756)", () => {
  it("a source read that hangs is given up at the limit: the alert and “Try again”; pressing it reads again, the title shows, focus is not lost", async () => {
    const src = holding("/projects/:id/sources/:sid", 1, () => HttpResponse.json(sourceFile("s1", TITLE, "none")));
    serve(src.handler);
    show({ firstReadMs: 300 });
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(src.count()).toBe(1);
    // The rest of the screen shows meanwhile: the versions and the transcript were read.
    await screen.findByText("Hello and welcome.");
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(heading().textContent).toBe(`Transcript: ${TITLE}`));
    expect(src.count()).toBe(2);
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(document.activeElement).toBe(heading());
  });

  it("a versions read that hangs is given up at the limit: the alert and “Try again” in place of a waiting list; pressing it shows “Loading…” then the transcript", async () => {
    const svc = transcriptService({ media: "none" });
    const gate = hang();
    let reads = 0;
    let release!: () => void;
    const second = new Promise<void>((r) => (release = r));
    server.use(...svc.handlers);
    server.use(
      http.get(url("/projects/:id/sources/:sid/transcripts"), async () => {
        await (++reads === 1 ? gate : second);
        return HttpResponse.json({ versions: svc.state.versions });
      }),
    );
    show({ firstReadMs: 300 });
    expect((screen.getByLabelText("Version") as HTMLSelectElement).options[0]!.textContent).toBe("Loading…");
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    // R605 I3: the versions were never read: the box says nothing that claims they were ("No transcript yet").
    expect(versionBox()).toEqual([""]);
    await userEvent.setup().click(tryAgain()!);
    expect((screen.getByLabelText("Version") as HTMLSelectElement).options[0]!.textContent).toBe("Loading…");
    expect(alerts()).toEqual([]);
    release();
    await screen.findByText("Hello and welcome.");
    expect(reads).toBe(2);
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    ["failed with no answer", () => HttpResponse.error()],
    ["refused with the service's own words", () => HttpResponse.json({ error: { code: "INTERNAL", message: "The versions could not be listed." } }, { status: 500 })],
  ])("a versions read that %s never shows “No transcript yet” in the Version box (R605 I3)", async (_what, answer) => {
    const svc = transcriptService({ media: "none" });
    server.use(...svc.handlers);
    server.use(http.get(url("/projects/:id/sources/:sid/transcripts"), answer));
    show({ firstReadMs: 300 });
    await waitFor(() => expect(alerts().length).toBeGreaterThan(0));
    expect(versionBox()).toEqual([""]);
    expect(screen.queryByText("No transcript yet")).toBeNull();
  });

  it("a transcript read that hangs is given up at the limit: “Loading the transcript…” gives way to the alert and “Try again”; pressing it shows the loading words, then the segments", async () => {
    const svc = transcriptService({ media: "none" });
    const gate = hang();
    let reads = 0;
    let release!: () => void;
    const second = new Promise<void>((r) => (release = r));
    server.use(...svc.handlers);
    server.use(
      http.get(url("/projects/:id/sources/:sid/transcripts/:aid"), async ({ params }) => {
        await (++reads === 1 ? gate : second);
        return HttpResponse.json(svc.state.transcripts[String(params.aid)]);
      }),
    );
    show({ firstReadMs: 300 });
    await screen.findByText("Loading the transcript…");
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Loading the transcript…")).toBeNull();
    await userEvent.setup().click(tryAgain()!);
    expect(screen.getByText("Loading the transcript…")).toBeTruthy();
    expect(alerts()).toEqual([]);
    release();
    await screen.findByText("Hello and welcome.");
    expect(reads).toBe(2);
    expect(alerts()).toEqual([]);
    expect(document.activeElement).toBe(heading());
  });

  it("a read that fails for want of an answer keeps its words, “could not be reached” (not merged with the limit's), and now offers “Try again”", async () => {
    let failing = true;
    const svc = serve();
    server.use(http.get(url("/projects/:id/sources/:sid/transcripts"), () => (failing ? HttpResponse.error() : HttpResponse.json({ versions: svc.state.versions }))));
    show({ firstReadMs: 300 });
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByText("Hello and welcome.");
    expect(alerts()).toEqual([]);
  });

  it("one sentence at a time (R602 M1): a read that failed with no answer and another given up at the limit show “could not be reached” alone, with one “Try again”", async () => {
    let failing = true;
    serve(
      http.get(url("/projects/:id/sources/:sid"), () => (failing ? HttpResponse.error() : HttpResponse.json(sourceFile("s1", TITLE, "none")))),
      holding("/projects/:id/sources/:sid/transcripts", 1, () => HttpResponse.json({ versions: [] })).handler,
    );
    show({ firstReadMs: 300 });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1), { timeout: 5000 });
    // The versions read is given up after the source failed: still the one sentence.
    await new Promise((r) => setTimeout(r, 500));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(heading().textContent).toBe(`Transcript: ${TITLE}`));
    await waitFor(() => expect(alerts()).toEqual([]));
  });

  it("a read the service refused with its own words shows them as before, with no “Try again” (unchanged)", async () => {
    serve(http.get(url("/projects/:id/sources/:sid/transcripts"), () => serviceErrorBody(500, "INTERNAL", "The transcript list is damaged.")));
    show({ firstReadMs: 300 });
    await waitFor(() => expect(alerts().some((a) => a?.includes("The transcript list is damaged."))).toBe(true));
    expect(tryAgain()).toBeNull();
  });

  it("the job's state is a side read: one that hangs blocks nothing", async () => {
    serve(http.get(url("/projects/:id/sources/:sid/transcription"), async () => {
      await hang();
      return HttpResponse.json({ job: null });
    }));
    show({ firstReadMs: 300 });
    await screen.findByText("Hello and welcome.");
    await waitFor(() => expect(heading().textContent).toBe(`Transcript: ${TITLE}`));
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
  });
});

describe("TranscriptViewer: an event stream that does not open within the limit is tried afresh (FR-756, R597)", () => {
  it("a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the first reads still out are made again", async () => {
    const ev = sseAttempts((n) => (n === 1 ? "hang" : []));
    const src = holding("/projects/:id/sources/:sid", 1, () => HttpResponse.json(sourceFile("s1", TITLE, "none")));
    const svc = serve(ev.handler, src.handler);
    show({ streamOpenMs: 300 }); // the reads keep the default limit (twenty seconds): the first source read is still out
    await screen.findByText("Hello and welcome.");
    await waitFor(() => expect(heading().textContent).toBe(`Transcript: ${TITLE}`), { timeout: 10_000 });
    expect(ev.attempts()).toBe(2);
    expect(src.count()).toBe(2);
    // The job's state is read at the opening too, as at every opening.
    expect(svc.log.jobReads).toBeGreaterThanOrEqual(2);
    expect(alerts()).toEqual([]);
  });

  it("a stream that has opened is never dropped by the limit, however long it stays quiet", async () => {
    const signals: AbortSignal[] = [];
    serve(
      http.get(url("/events"), ({ request }) => {
        signals.push(request.signal);
        return sse([]);
      }),
    );
    show({ streamOpenMs: 200 });
    await screen.findByText("Hello and welcome.");
    await waitFor(() => expect(signals).toHaveLength(1));
    // Fifteen times the limit, and more than the screen's pause before a new try (two seconds): still the first stream,
    // and its request not cancelled (R602: the body of a mocked stream goes on after an abort, so the signal is what tells).
    await new Promise((r) => setTimeout(r, 3_000));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
  });

  it("R641 D2: a stream that opens and then delivers nothing for `streamQuietMs` (not even a keep-alive) is cancelled and opened afresh", async () => {
    const signals: AbortSignal[] = [];
    serve(
      http.get(url("/events"), ({ request }) => {
        signals.push(request.signal);
        return sse([]);
      }),
    );
    show({ streamQuietMs: 300 });
    await screen.findByText("Hello and welcome.");
    await waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(signals[0]!.aborted).toBe(true);
  });
});
