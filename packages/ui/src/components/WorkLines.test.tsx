/**
 * The work lines (whole channels, Task 6; R668, R669, R672): one line per download run and one for the transcription
 * list, with their buttons, "Show them" and its copied list, and the event stream that keeps them current (R597, R641
 * D2, R658, R659). The sentences come from @ao/shared; the expected strings here are the plan's own.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_EVENT, LIST_STOPPED_TEXT, problemLine, WORK_LINES_TEXT, type BackgroundProgressEvent, type DownloadProblem } from "@ao/shared";
import type { ServiceEvent } from "../api/client";
import { exampleRun, idleList, mockBackground, type BackgroundSetup } from "../test/backgroundService";
import { hang, server, testClient, url, useMockService } from "../test/service";
import { WorkLines, type WorkLinesEvents } from "./WorkLines";

useMockService();

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

/** What is shown (the visually hidden telling for a screen reader left out, as in MissingFiles.test.tsx). */
const SHOWN = { ignore: "script, style, .ao-visually-hidden" };
/** A sentence as shown, also when a title in it is its own element (UserText): the innermost element holding all of it. */
const whole = (text: string) => (_content: string, el: Element | null) => !!el && el.textContent === text && ![...el.children].some((c) => c.textContent === text);
const shown = (text: string) => screen.findByText(whole(text), SHOWN);
const notShown = (text: string) => expect(screen.queryByText(whole(text), SHOWN)).toBeNull();
const getShown = (text: string) => screen.getByText(whole(text), SHOWN);
const heading = () => screen.getByRole("heading", { level: 2, name: WORK_LINES_TEXT.heading });
const buttonNames = () => within(screen.getByRole("region", { name: WORK_LINES_TEXT.heading })).queryAllByRole("button").map((b) => b.textContent);
const LOST = WORK_LINES_TEXT.lost;
/** The block of the line whose title is `title` (a run, or the transcription list). */
const lineOf = (title: string) => getShown(title).closest("li.ao-worklines__run, .ao-worklines__list") as HTMLElement;
/** A button found within its line, named by itself and its line's title (R679 B1). */
const buttonOf = (title: string, name: string) => within(lineOf(title)).getByRole("button", { name: `${name} ${title}` });

function start(o: BackgroundSetup = {}, props: { streamOpenMs?: number; streamQuietMs?: number; projectId?: string; events?: WorkLinesEvents } = {}) {
  const m = mockBackground(o);
  server.use(...m.handlers);
  const client = testClient();
  const view = render(
    <WorkLines
      client={client}
      projectId={props.projectId ?? "p1"}
      {...(props.streamOpenMs !== undefined ? { streamOpenMs: props.streamOpenMs } : {})}
      {...(props.streamQuietMs !== undefined ? { streamQuietMs: props.streamQuietMs } : {})}
      {...(props.events ? { events: props.events } : {})}
    />,
  );
  return { m, client, view };
}

/** A screen's own event stream, as handed to the lines (A1): `emit` delivers an event, `open` a (re)opening. */
function screenStream() {
  const subs = new Set<{ onEvent: (e: ServiceEvent) => void; onOpen: () => void }>();
  const events: WorkLinesEvents = {
    subscribe(onEvent, onOpen) {
      const s = { onEvent, onOpen };
      subs.add(s);
      return () => void subs.delete(s);
    },
  };
  return {
    events,
    subscribers: () => subs.size,
    emit: (data: BackgroundProgressEvent, type: string = BACKGROUND_EVENT) => act(async () => [...subs].forEach((s) => s.onEvent({ type, data }))),
    open: () => act(async () => [...subs].forEach((s) => s.onOpen())),
  };
}

const later = (n: number) => new Date(Date.parse("2026-11-26T11:00:00.000Z") + n * 1000).toISOString();

const PROBLEMS: DownloadProblem[] = [
  { title: "Interview with the mayor", url: "https://www.youtube.com/watch?v=aaa", reason: "This video is private.", platformReason: "Private video" },
  { url: "https://www.youtube.com/watch?v=bbb", reason: "The connection was lost three times." },
  { title: "مقابلة", url: "https://www.youtube.com/watch?v=ccc", reason: "This video has been removed, or its address is wrong." },
];

describe("WorkLines: the download runs", () => {
  it('a downloading run shows "Downloading "Example Channel": 120 of 412" with Pause and Stop; a wait shows "waiting 2 minutes — YouTube asked to slow down"', async () => {
    const { m } = start({ runs: [exampleRun()] });
    await shown('Downloading "Example Channel": 120 of 412');
    expect(heading()).toBeTruthy();
    expect(buttonNames()).toEqual(["Pause", "Stop"]);
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => m.emit({ projectId: "p1", downloads: exampleRun({ state: "waiting", wait: { ms: 120_000, why: "rate-limited" }, updatedAt: later(1) }) }));
    await shown("waiting 2 minutes — YouTube asked to slow down");
    expect(getShown('Downloading "Example Channel": 120 of 412')).toBeTruthy();
    expect(buttonNames()).toEqual(["Pause", "Stop"]);
  });

  it('a run with failures shows "3 could not be downloaded" and Show them lists title, address and reason through UserText', async () => {
    const { m } = start({ runs: [exampleRun({ failed: 3 })], problems: { "run-1": { platform: "youtube", problems: PROBLEMS } } });
    await shown("3 could not be downloaded");
    expect(buttonNames()).toEqual(["Pause", "Stop", "Show them"]);
    await userEvent.setup().click(buttonOf('Downloading "Example Channel": 120 of 412', "Show them"));
    const h = await screen.findByRole("heading", { name: "Could not be downloaded" });
    await waitFor(() => expect(document.activeElement).toBe(h));
    const title = await shown("Interview with the mayor");
    expect(title.getAttribute("dir")).toBe("auto");
    expect(getShown("https://www.youtube.com/watch?v=aaa").getAttribute("dir")).toBe("auto");
    expect(getShown("This video is private.").getAttribute("dir")).toBe("auto");
    expect(getShown("YouTube says: “Private video”").getAttribute("dir")).toBe("auto");
    expect(getShown("(no title)")).toBeTruthy();
    expect(getShown("The connection was lost three times.")).toBeTruthy();
    expect(getShown("مقابلة").getAttribute("dir")).toBe("auto");
    expect(m.count("GET /projects/p1/downloads/run-1/problems")).toBe(1);
  });

  it('a finished run with failures shows the fixed line and "Resume downloads (14 did not complete)"', async () => {
    start({ runs: [exampleRun({ state: "finished", done: 398, failed: 14 })] });
    await shown('"Example Channel": 398 of 412 downloaded. 14 could not be downloaded.');
    notShown("14 could not be downloaded");
    expect(buttonNames()).toEqual(["Show them", "Resume downloads (14 did not complete)", "Discard"]);
  });

  it("an interrupted run shows \"The capture of 'Example Channel' was interrupted: 120 of 412 done.\" with Resume downloads and Discard", async () => {
    start({ runs: [exampleRun({ state: "interrupted" })] });
    await shown("The capture of 'Example Channel' was interrupted: 120 of 412 done.");
    expect(buttonNames()).toEqual(["Resume downloads (292 did not complete)", "Discard"]);
  });

  it('a run that completed everything says so and offers only "Remove from this list", which discards it (R679 C2)', async () => {
    const DONE = '"Example Channel": all 412 downloaded.';
    const { m } = start({ runs: [exampleRun({ state: "finished", done: 412 }), exampleRun({ runId: "run-2", title: "Second Channel", state: "paused", startedAt: later(5) })] });
    await shown(DONE);
    expect(within(lineOf(DONE)).getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove from this list"]);
    await userEvent.setup().click(buttonOf(DONE, "Remove from this list"));
    await waitFor(() => notShown(DONE));
    expect(m.count("POST /projects/p1/downloads/run-1/discard")).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(getShown('"Second Channel" is paused: 120 of 412 downloaded.')).toBeTruthy();
  });

  it('a run with nothing new to download offers only "Remove from this list" (R679 C2)', async () => {
    const NONE = '"Example Channel": nothing new to download.';
    const { m } = start({ runs: [exampleRun({ state: "finished", total: 0, done: 0 })] });
    await shown(NONE);
    expect(buttonNames()).toEqual(["Remove from this list"]);
    await userEvent.setup().click(buttonOf(NONE, "Remove from this list"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    notShown(NONE);
    expect(m.count("POST /projects/p1/downloads/run-1/discard")).toBe(1);
  });

  it("a run waiting its turn says so and offers Stop only", async () => {
    start({ runs: [exampleRun({ state: "queued", total: 0, done: 0 })] });
    await shown('"Example Channel" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.');
    expect(buttonNames()).toEqual(["Stop"]);
  });

  it('a run interrupted before it began offers "Resume downloads" without a count', async () => {
    start({ runs: [exampleRun({ state: "interrupted", total: 0, done: 0 })] });
    await shown("The capture of 'Example Channel' was interrupted before it began.");
    expect(buttonNames()).toEqual(["Resume downloads", "Discard"]);
  });

  it('a run stopped before it began says so, with "Resume downloads" and Discard', async () => {
    start({ runs: [exampleRun({ state: "stopped", total: 0, done: 0 })] });
    await shown('"Example Channel" was stopped before it began.');
    expect(buttonNames()).toEqual(["Resume downloads", "Discard"]);
  });

  it("Resume downloads pressed twice sends one request", async () => {
    const { m } = start({ runs: [exampleRun({ state: "interrupted" })], holdActions: true });
    const user = userEvent.setup();
    await shown("The capture of 'Example Channel' was interrupted: 120 of 412 done.");
    const resume = buttonOf("The capture of 'Example Channel' was interrupted: 120 of 412 done.", "Resume downloads (292 did not complete)");
    await user.dblClick(resume);
    await waitFor(() => expect(m.count("POST /projects/p1/downloads/run-1/resume")).toBe(1));
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    await user.click(resume);
    m.release();
    await shown('Downloading "Example Channel": 120 of 412');
    expect(m.count("POST /projects/p1/downloads/run-1/resume")).toBe(1);
  });

  it("Copy the list copies one line per video and says so", async () => {
    start({ runs: [exampleRun({ state: "finished", done: 409, failed: 3 })], problems: { "run-1": { platform: "youtube", problems: PROBLEMS } } });
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const FINISHED = '"Example Channel": 409 of 412 downloaded. 3 could not be downloaded.';
    await shown(FINISHED);
    await user.click(buttonOf(FINISHED, "Show them"));
    await shown("Interview with the mayor");
    await user.click(buttonOf(FINISHED, "Copy the list"));
    await shown("The list was copied.");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]![0]).toBe(PROBLEMS.map((p) => problemLine(p, "youtube")).join("\n"));
    expect(writeText.mock.calls[0]![0].split("\n")).toEqual([
      "Interview with the mayor — https://www.youtube.com/watch?v=aaa — This video is private. YouTube says: “Private video”",
      "(no title) — https://www.youtube.com/watch?v=bbb — The connection was lost three times.",
      "مقابلة — https://www.youtube.com/watch?v=ccc — This video has been removed, or its address is wrong.",
    ]);
    // A refusal says so, in plain words.
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(buttonOf(FINISHED, "Copy the list"));
    await shown("The list could not be copied. Select it and copy it by hand.");
    notShown("The list was copied.");
  });

  it("Discard removes the run and focus goes to the heading", async () => {
    const { m } = start({ runs: [exampleRun({ state: "interrupted" })] });
    await shown("The capture of 'Example Channel' was interrupted: 120 of 412 done.");
    await userEvent.setup().click(buttonOf("The capture of 'Example Channel' was interrupted: 120 of 412 done.", "Discard"));
    await waitFor(() => notShown("The capture of 'Example Channel' was interrupted: 120 of 412 done."));
    expect(m.count("POST /projects/p1/downloads/run-1/discard")).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it("a discarded event removes its run", async () => {
    const { m } = start({ runs: [exampleRun({ state: "paused" }), exampleRun({ runId: "run-2", title: "Second Channel", state: "stopped", startedAt: "2026-11-26T12:00:00.000Z" })] });
    await shown('"Example Channel" is paused: 120 of 412 downloaded.');
    // Newest first.
    const titles = screen.getAllByText(/Channel/, SHOWN).map((e) => e.closest("p")?.textContent);
    expect(titles[0]).toBe('"Second Channel" was stopped: 120 of 412 downloaded.');
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => m.emit({ projectId: "p1", discarded: "run-1" }));
    await waitFor(() => notShown('"Example Channel" is paused: 120 of 412 downloaded.'));
    expect(getShown('"Second Channel" was stopped: 120 of 412 downloaded.')).toBeTruthy();
  });

  it("events of another project are ignored", async () => {
    const { m } = start({ runs: [exampleRun()] });
    await shown('Downloading "Example Channel": 120 of 412');
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => {
      m.emit({ projectId: "p2", downloads: exampleRun({ projectId: "p2", done: 200, updatedAt: later(1) }) });
      m.emit({ projectId: "p2", discarded: "run-1" });
      m.emit({ projectId: "p2", transcriptions: idleList("p2", { state: "running", total: 5, done: 1 }) });
      m.emit({ projectId: "p1", downloads: exampleRun({ done: 130, updatedAt: later(2) }) });
    });
    await shown('Downloading "Example Channel": 130 of 412');
    notShown('Downloading "Example Channel": 200 of 412');
    notShown("Transcribing: 1 of 5");
  });

  it("a title line is told to a screen reader at most every five seconds (R658 M3)", async () => {
    const said = () => screen.queryAllByRole("status").map((s) => s.textContent);
    const { m } = start({ runs: [exampleRun()] });
    await shown('Downloading "Example Channel": 120 of 412');
    await waitFor(() => expect(m.streams()).toBe(1));
    // The line as read at the opening is shown, not told.
    expect(said().some((t) => t?.includes("120 of 412"))).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => m.emit({ projectId: "p1", downloads: exampleRun({ done: 121, updatedAt: later(1) }) }));
      await vi.waitFor(() => expect(said()).toContain('Downloading "Example Channel": 121 of 412'));
      await act(async () => {
        m.emit({ projectId: "p1", downloads: exampleRun({ done: 122, updatedAt: later(2) }) });
        m.emit({ projectId: "p1", downloads: exampleRun({ done: 123, updatedAt: later(3) }) });
      });
      await vi.waitFor(() => expect(getShown('Downloading "Example Channel": 123 of 412')).toBeTruthy());
      await act(async () => vi.advanceTimersByTimeAsync(4_000));
      expect(said()).toContain('Downloading "Example Channel": 121 of 412');
      expect(said().some((t) => t?.includes("123 of"))).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      await vi.waitFor(() => expect(said()).toContain('Downloading "Example Channel": 123 of 412'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkLines: the transcription line", () => {
  const running = idleList("p1", { state: "running", total: 412, done: 14, current: { sourceId: "s1", title: "Title of the video" }, soundSecondsLeft: 6 * 86_400 * 4, unknownLeft: 0 });

  it('the transcription line shows "measuring…" until a speed is known, then the time left', async () => {
    const { m } = start({ lists: { p1: running } });
    await shown('Transcribing: 14 of 412 — "Title of the video"');
    expect(getShown("measuring…")).toBeTruthy();
    expect(buttonNames()).toEqual(["Pause", "Stop"]);
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => m.emit({ projectId: "p1", transcriptions: { ...running, soundPerSecond: 4 } }));
    await shown("about 6 days left at this Mac's speed (4 minutes of sound per minute)");
    notShown("measuring…");
  });

  it("paused transcriptions show Continue and Stop", async () => {
    const { m } = start({ lists: { p1: { ...running, state: "paused" } } });
    await shown("Transcriptions paused: 14 of 412 done.");
    expect(buttonNames()).toEqual(["Continue", "Stop"]);
    await userEvent.setup().click(buttonOf("Transcriptions paused: 14 of 412 done.", "Continue"));
    await shown('Transcribing: 14 of 412 — "Title of the video"');
    expect(m.count("POST /projects/p1/transcription-list/continue")).toBe(1);
  });

  it("Stop of the transcriptions removes the line, says the stopped sentence once and moves focus to the heading", async () => {
    const { m } = start({ lists: { p1: running } });
    await shown('Transcribing: 14 of 412 — "Title of the video"');
    await userEvent.setup().click(buttonOf('Transcribing: 14 of 412 — "Title of the video"', "Stop"));
    await shown(LIST_STOPPED_TEXT);
    expect(screen.getAllByText(LIST_STOPPED_TEXT)).toHaveLength(1);
    expect(screen.getByText(LIST_STOPPED_TEXT).getAttribute("role")).toBe("status");
    notShown('Transcribing: 14 of 412 — "Title of the video"');
    expect(buttonNames()).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(m.count("POST /projects/p1/transcription-list/stop")).toBe(1);
  });

  it("paused transcriptions stopped say the stopped sentence too", async () => {
    const PAUSED = "Transcriptions paused: 14 of 412 done.";
    const { m } = start({ lists: { p1: { ...running, state: "paused" } } });
    await shown(PAUSED);
    await userEvent.setup().click(buttonOf(PAUSED, "Stop"));
    await shown(LIST_STOPPED_TEXT);
    notShown(PAUSED);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(m.count("POST /projects/p1/transcription-list/stop")).toBe(1);
  });

  it('finished transcriptions offer only "Remove from this list": the line goes, nothing says they were stopped, focus goes to the heading (R679 C3)', async () => {
    const FINISHED = "Transcriptions finished: all 3 done.";
    const { m } = start({ runs: [exampleRun({ state: "paused" })], lists: { p1: idleList("p1", { total: 3, done: 3 }) } });
    await shown(FINISHED);
    expect(within(lineOf(FINISHED)).getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove from this list"]);
    await userEvent.setup().click(buttonOf(FINISHED, "Remove from this list"));
    await waitFor(() => notShown(FINISHED));
    expect(m.count("POST /projects/p1/transcription-list/stop")).toBe(1);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    notShown(LIST_STOPPED_TEXT);
    expect(screen.queryByText(LIST_STOPPED_TEXT)).toBeNull();
  });

  it("nothing to show renders nothing: no run and an idle list with nothing on it (the stream is followed all the same)", async () => {
    const { m } = start();
    // Without a screen's stream, the lines' own stream runs from the mount (R679 A1): read at the mount and at its opening.
    await waitFor(() => expect(m.streams()).toBe(1));
    await waitFor(() => expect(m.count("GET /projects/p1/transcription-list")).toBe(2));
    await waitFor(() => expect(m.count("GET /projects/p1/downloads")).toBe(2));
    expect(m.count("GET /events")).toBe(1);
    expect(screen.queryByRole("heading", { name: WORK_LINES_TEXT.heading })).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    // A run that starts later shows its line.
    await act(async () => m.emit({ projectId: "p1", downloads: exampleRun({ state: "queued", total: 0, done: 0 }) }));
    await shown('"Example Channel" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.');
  });

  it("a service that does not know the two routes (404) shows nothing and says no error", async () => {
    // Fastify's own answer for a route it does not have.
    let asks = 0;
    const unknown = (path: string) => () => (asks++, HttpResponse.json({ message: `Route GET:${path} not found`, error: "Not Found", statusCode: 404 }, { status: 404 }));
    const { m } = start({
      runs: [exampleRun()],
      extra: [http.get(url("/projects/p1/downloads"), unknown("/projects/p1/downloads")), http.get(url("/projects/p1/transcription-list"), unknown("/projects/p1/transcription-list"))],
    });
    await waitFor(() => expect(m.streams()).toBe(1));
    // At the mount and at the stream's opening.
    await waitFor(() => expect(asks).toBe(4));
    // Nothing to show: no error said.
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });
});

/** A GET whose asks are counted; the asks `hold(n)` picks are held until `release()` (or the test's end), else answered by the next handler. */
function holding(path: string, hold: (n: number) => boolean) {
  let n = 0;
  const requests: Request[] = [];
  const gate = hang();
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  return {
    handler: http.get(url(path), async ({ request }) => {
      requests.push(request);
      if (hold(++n)) await Promise.race([gate, released]);
      return undefined;
    }),
    count: () => n,
    requests,
    release: () => release(),
  };
}

/** R659: `/events` answered as the real service does: the opening `library.state` event, then `then`, then the stream ends. Connections after `upTo` are held, never opening. */
function dropping(then: string, upTo = Infinity) {
  let n = 0;
  const requests: Request[] = [];
  const gate = hang();
  const opening = `event: library.state\ndata: ${JSON.stringify({ open: true, libraryId: "lib-1", mode: "read-write" })}\n\n`;
  return {
    handler: http.get(url("/events"), async ({ request }) => {
      requests.push(request);
      if (++n <= upTo) return new HttpResponse(`${opening}${then}`, { headers: { "Content-Type": "text/event-stream" } });
      await gate;
      return undefined;
    }),
    n: () => n,
    requests,
  };
}
const progress = (projectId: string) => `event: background.progress\ndata: ${JSON.stringify({ projectId, downloads: exampleRun({ projectId, done: 121, updatedAt: later(1) }) })}\n\n`;

describe("WorkLines: the event stream (R597, R641 D2, R658, R659)", () => {
  it("a stream that does not open within the limit is opened again", async () => {
    const events = holding("/events", (n) => n === 1);
    const { m } = start({ runs: [exampleRun()], extra: [events.handler] }, { streamOpenMs: 300 });
    await shown('Downloading "Example Channel": 120 of 412');
    await waitFor(() => expect(events.count()).toBe(2), { timeout: 5000 });
    expect(events.requests[0]!.signal.aborted).toBe(true);
    // At the opening, and at the new stream's opening.
    await waitFor(() => expect(m.count("GET /projects/p1/downloads")).toBe(2));
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => m.emit({ projectId: "p1", downloads: exampleRun({ done: 125, updatedAt: later(1) }) }));
    await shown('Downloading "Example Channel": 125 of 412');
    notShown(LOST);
  });

  it("a stream silent past the limit is opened again", async () => {
    // The second try is held, never opening: the lines rest there (its opening limit is the default 20 s).
    const events = holding("/events", (n) => n === 2);
    start({ runs: [exampleRun()], extra: [events.handler] }, { streamQuietMs: 300 });
    await shown('Downloading "Example Channel": 120 of 412');
    await waitFor(() => expect(events.count()).toBe(2), { timeout: 10_000 });
    expect(events.requests[0]!.signal.aborted).toBe(true);
    expect(events.requests[1]!.signal.aborted).toBe(false);
    notShown(LOST);
  });

  it("the opening state then an end, repeated, ends in the notice", async () => {
    const events = dropping("", 3);
    start({ runs: [exampleRun()], extra: [events.handler] });
    await shown(LOST);
    expect(events.n()).toBe(3);
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    await userEvent.setup().click(reconnect);
    // A fresh try (held, never opening): the notice goes while it is made.
    await waitFor(() => expect(events.n()).toBe(4));
    notShown(LOST);
  });

  it("this project's background.progress then a drop keeps following", async () => {
    const events = dropping(progress("p1"), 5);
    start({ runs: [exampleRun()], extra: [events.handler] });
    await waitFor(() => expect(events.n()).toBe(6), { timeout: 20_000 });
    expect(events.requests[5]!.signal.aborted).toBe(false);
    notShown(LOST);
    expect(getShown('Downloading "Example Channel": 121 of 412')).toBeTruthy();
  });

  it("another project's background.progress then a drop ends in the notice", async () => {
    const events = dropping(progress("p2"));
    start({ runs: [exampleRun()], extra: [events.handler] });
    await shown(LOST);
    expect(events.n()).toBe(3);
    expect(getShown('Downloading "Example Channel": 120 of 412')).toBeTruthy();
  });

  it("answers after the project changed or after unmount are dropped", async () => {
    // The read of p1's runs is held.
    const reads = holding("/projects/p1/downloads", () => true);
    const { m, client, view } = start({ runs: [exampleRun()], extra: [reads.handler] });
    // At the mount and at the opening of the stream (R679 A1).
    await waitFor(() => expect(reads.count()).toBe(2));
    view.rerender(<WorkLines client={client} projectId="p2" />);
    // At the mount and at the opening of the stream, which runs from the mount (R679 A1).
    await waitFor(() => expect(m.count("GET /projects/p2/downloads")).toBe(2));
    expect(reads.requests[0]!.signal.aborted).toBe(true);
    expect(reads.requests[1]!.signal.aborted).toBe(true);
    reads.release();
    await waitFor(() => expect(m.count("GET /projects/p2/transcription-list")).toBeGreaterThanOrEqual(1));
    notShown('Downloading "Example Channel": 120 of 412');
    expect(screen.queryByRole("region")).toBeNull();
    // After unmount: a held read is cancelled, and its answer changes nothing.
    const later2 = holding("/projects/p2/transcription-list", () => true);
    server.use(later2.handler);
    view.rerender(<WorkLines client={client} projectId="p2" key="again" />);
    await waitFor(() => expect(later2.count()).toBe(2));
    view.unmount();
    await waitFor(() => expect(later2.requests[0]!.signal.aborted).toBe(true));
    await waitFor(() => expect(later2.requests[1]!.signal.aborted).toBe(true));
    later2.release();
  });
});

describe("WorkLines: the screen's own stream (R679 A)", () => {
  const RUNNING_LIST = idleList("p1", { state: "running", total: 5, done: 1 });

  it("a screen that showed nothing gets a run and a running list by event: both lines appear, and the lines open no stream of their own", async () => {
    const feed = screenStream();
    const { m } = start({}, { events: feed.events });
    await waitFor(() => expect(m.count("GET /projects/p1/downloads")).toBe(1));
    await waitFor(() => expect(m.count("GET /projects/p1/transcription-list")).toBe(1));
    expect(feed.subscribers()).toBe(1);
    expect(screen.queryByRole("region")).toBeNull();
    await feed.emit({ projectId: "p1", downloads: exampleRun() });
    await feed.emit({ projectId: "p1", transcriptions: RUNNING_LIST });
    await shown('Downloading "Example Channel": 120 of 412');
    await shown("Transcribing: 1 of 5");
    expect(m.count("GET /events")).toBe(0);
  });

  it("a run discarded by event, then a new run's event: the new line appears", async () => {
    const feed = screenStream();
    const { m } = start({ runs: [exampleRun({ state: "interrupted" })] }, { events: feed.events });
    await shown("The capture of 'Example Channel' was interrupted: 120 of 412 done.");
    await feed.emit({ projectId: "p1", discarded: "run-1" });
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    await feed.emit({ projectId: "p1", downloads: exampleRun({ runId: "run-2", title: "Second Channel", startedAt: later(5), updatedAt: later(5) }) });
    await shown('Downloading "Second Channel": 120 of 412');
    expect(feed.subscribers()).toBe(1);
    expect(m.count("GET /events")).toBe(0);
  });

  it("both lists are read again at every opening of the screen's stream", async () => {
    const feed = screenStream();
    const { m } = start({}, { events: feed.events });
    await waitFor(() => expect(m.count("GET /projects/p1/downloads")).toBe(1));
    m.setRuns([exampleRun({ state: "paused" })]);
    await feed.open();
    await shown('"Example Channel" is paused: 120 of 412 downloaded.');
    await waitFor(() => expect(m.count("GET /projects/p1/transcription-list")).toBe(2));
    expect(m.count("GET /projects/p1/downloads")).toBe(2);
    expect(m.count("GET /events")).toBe(0);
  });

  it("a read that fails (500) shows the notice; Reconnect reads again, and a read that succeeds takes the notice away", async () => {
    const feed = screenStream();
    let failing = true;
    let asks = 0;
    const fail = () => (asks++, failing ? HttpResponse.json({ error: { code: "INTERNAL", message: "Something went wrong." } }, { status: 500 }) : undefined);
    const { m } = start({ runs: [exampleRun()], extra: [http.get(url("/projects/p1/downloads"), fail), http.get(url("/projects/p1/transcription-list"), fail)] }, { events: feed.events });
    await shown(LOST);
    notShown('Downloading "Example Channel": 120 of 412');
    // Reconnect reads again: still failing, the notice stays.
    await userEvent.setup().click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(asks).toBe(4));
    await shown(LOST);
    failing = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Reconnect" }));
    await shown('Downloading "Example Channel": 120 of 412');
    await waitFor(() => notShown(LOST));
    // Failing again; the next opening of the screen's stream reads, and its success takes the notice away.
    failing = true;
    await feed.open();
    await shown(LOST);
    failing = false;
    await feed.open();
    await waitFor(() => notShown(LOST));
    expect(m.count("GET /events")).toBe(0);
  });

  it("a 404 says nothing and keeps the runs learned from events", async () => {
    const feed = screenStream();
    let asks = 0;
    const unknown = () => (asks++, HttpResponse.json({ message: "Route not found", error: "Not Found", statusCode: 404 }, { status: 404 }));
    start({ extra: [http.get(url("/projects/p1/downloads"), unknown), http.get(url("/projects/p1/transcription-list"), unknown)] }, { events: feed.events });
    await feed.emit({ projectId: "p1", downloads: exampleRun() });
    await shown('Downloading "Example Channel": 120 of 412');
    await feed.open();
    await waitFor(() => expect(asks).toBe(4));
    await act(async () => {});
    expect(getShown('Downloading "Example Channel": 120 of 412')).toBeTruthy();
    notShown(LOST);
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  it("a read that answers after a newer event does not overwrite it (the runs and the list)", async () => {
    const feed = screenStream();
    const runsRead = holding("/projects/p1/downloads", () => true);
    const listRead = holding("/projects/p1/transcription-list", () => true);
    const { m } = start({ runs: [exampleRun({ done: 100 })], lists: { p1: idleList("p1", { state: "running", total: 5, done: 1 }) }, extra: [runsRead.handler, listRead.handler] }, { events: feed.events });
    await waitFor(() => expect(runsRead.count()).toBe(1));
    await waitFor(() => expect(listRead.count()).toBe(1));
    // While the reads are out: the run moved on, a second run started, and the list moved on. The same updatedAt as the
    // read's own, so only the order of arrival tells which is newer.
    await feed.emit({ projectId: "p1", downloads: exampleRun({ done: 130 }) });
    await feed.emit({ projectId: "p1", downloads: exampleRun({ runId: "run-2", title: "Second Channel", startedAt: later(5), updatedAt: later(5) }) });
    await feed.emit({ projectId: "p1", transcriptions: idleList("p1", { state: "running", total: 5, done: 3 }) });
    await shown('Downloading "Example Channel": 130 of 412');
    await shown("Transcribing: 3 of 5");
    runsRead.release();
    listRead.release();
    await waitFor(() => expect(m.count("GET /projects/p1/transcription-list")).toBe(1));
    await waitFor(() => expect(m.count("GET /projects/p1/downloads")).toBe(1));
    // The read's answers came (as they stood when it was sent) and changed nothing.
    await act(async () => {});
    expect(getShown('Downloading "Example Channel": 130 of 412')).toBeTruthy();
    expect(getShown('Downloading "Second Channel": 120 of 412')).toBeTruthy();
    expect(getShown("Transcribing: 3 of 5")).toBeTruthy();
    notShown('Downloading "Example Channel": 100 of 412');
    notShown("Transcribing: 1 of 5");
  });

  it("after a Discard here, once focus leaves the heading, nothing is left on screen (M6)", async () => {
    const feed = screenStream();
    const { m } = start({ runs: [exampleRun({ state: "interrupted" })] }, { events: feed.events });
    await shown("The capture of 'Example Channel' was interrupted: 120 of 412 done.");
    await userEvent.setup().click(buttonOf("The capture of 'Example Channel' was interrupted: 120 of 412 done.", "Discard"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(m.count("POST /projects/p1/downloads/run-1/discard")).toBe(1);
    act(() => heading().blur());
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    // Still subscribed: a new run shows its line.
    await feed.emit({ projectId: "p1", downloads: exampleRun({ runId: "run-2", title: "Second Channel" }) });
    await shown('Downloading "Second Channel": 120 of 412');
  });

  it("the lines unsubscribe at unmount", async () => {
    const feed = screenStream();
    const { view } = start({}, { events: feed.events });
    expect(feed.subscribers()).toBe(1);
    view.unmount();
    expect(feed.subscribers()).toBe(0);
  });
});

describe("WorkLines: names and what a screen reader is told (R679 B)", () => {
  it("each button is named by itself and its line: three Stop buttons have three names", async () => {
    start({
      runs: [exampleRun(), exampleRun({ runId: "run-2", title: "Second Channel", state: "queued", total: 0, done: 0, startedAt: later(5) })],
      lists: { p1: idleList("p1", { state: "running", total: 5, done: 1 }) },
    });
    await shown('Downloading "Example Channel": 120 of 412');
    const region = screen.getByRole("region", { name: WORK_LINES_TEXT.heading });
    expect(within(region).getByRole("button", { name: 'Stop Downloading "Example Channel": 120 of 412' })).toBeTruthy();
    expect(within(region).getByRole("button", { name: 'Pause Downloading "Example Channel": 120 of 412' })).toBeTruthy();
    expect(within(region).getByRole("button", { name: 'Stop "Second Channel" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.' })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Stop Transcribing: 1 of 5" })).toBeTruthy();
    expect(within(region).queryAllByRole("button", { name: "Stop" })).toEqual([]);
  });

  it("the status that says the list was stopped is there, empty, before its sentence arrives (M2)", async () => {
    const TITLE = "Transcribing: 1 of 5";
    start({ lists: { p1: idleList("p1", { state: "running", total: 5, done: 1 }) } });
    await shown(TITLE);
    const region = screen.getByRole("region", { name: WORK_LINES_TEXT.heading });
    const statuses = () => within(region).getAllByRole("status").filter((e) => !e.classList.contains("ao-visually-hidden"));
    expect(statuses()).toHaveLength(1);
    const status = statuses()[0]!;
    expect(status.textContent).toBe("");
    await userEvent.setup().click(buttonOf(TITLE, "Stop"));
    await waitFor(() => expect(status.textContent).toBe(LIST_STOPPED_TEXT));
    expect(statuses()).toEqual([status]);
  });

  it("a run that first appears through an event is told to a screen reader once (M5)", async () => {
    const feed = screenStream();
    const told = () => screen.queryAllByRole("status").filter((e) => e.classList.contains("ao-visually-hidden")).map((e) => e.textContent);
    const { m } = start({ runs: [exampleRun()] }, { events: feed.events });
    await shown('Downloading "Example Channel": 120 of 412');
    await waitFor(() => expect(m.count("GET /projects/p1/transcription-list")).toBe(1));
    const QUEUED = '"Second Channel" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.';
    const second = exampleRun({ runId: "run-2", title: "Second Channel", state: "queued", total: 0, done: 0, startedAt: later(5) });
    await feed.emit({ projectId: "p1", downloads: second });
    await shown(QUEUED);
    await waitFor(() => expect(told()).toContain(QUEUED));
    m.setRuns([exampleRun(), second]);
    // A read again changes nothing told: the new line is told once, the line read at the mount not at all.
    await feed.open();
    await waitFor(() => expect(m.count("GET /projects/p1/transcription-list")).toBe(2));
    await act(async () => {});
    expect(told().filter((t) => t === QUEUED)).toHaveLength(1);
    expect(told().some((t) => t?.includes("120 of 412"))).toBe(false);
  });

  it("an action's refusal is shown inside the block of its run, and of the list (M9)", async () => {
    const FIRST = 'Downloading "Example Channel": 120 of 412';
    const SECOND = 'Downloading "Second Channel": 120 of 412';
    const LIST = "Transcriptions paused: 1 of 5 done.";
    const conflict = (message: string) => HttpResponse.json({ error: { code: "CONFLICT", message } }, { status: 409 });
    start({
      runs: [exampleRun(), exampleRun({ runId: "run-2", title: "Second Channel", startedAt: later(5) })],
      lists: { p1: idleList("p1", { state: "paused", total: 5, done: 1 }) },
      runAnswer: (_what, runId) => (runId === "run-2" ? conflict("These downloads are already running.") : undefined),
      listAnswer: () => conflict("The list changed."),
    });
    await shown(SECOND);
    const user = userEvent.setup();
    await user.click(buttonOf(SECOND, "Pause"));
    const alert = await within(lineOf(SECOND)).findByRole("alert");
    expect(alert.textContent).toContain("These downloads are already running.");
    expect(within(lineOf(FIRST)).queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("alert")).toEqual([alert]);
    await user.click(buttonOf(LIST, "Continue"));
    const listAlert = await within(lineOf(LIST)).findByRole("alert");
    expect(listAlert.textContent).toContain("The list changed.");
    expect(within(lineOf(SECOND)).getByRole("alert")).toBe(alert);
  });
});

describe("WorkLines: smaller points (R679 D)", () => {
  /** Two presses in the same tick, before anything is drawn again (M1). */
  const twice = (b: HTMLElement) =>
    act(() => {
      fireEvent.click(b);
      fireEvent.click(b);
    });

  it("two presses in one tick of a run's action send one request", async () => {
    const TITLE = 'Downloading "Example Channel": 120 of 412';
    const { m } = start({ runs: [exampleRun()] });
    await shown(TITLE);
    await twice(buttonOf(TITLE, "Pause"));
    await shown('"Example Channel" is paused: 120 of 412 downloaded.');
    expect(m.count("POST /projects/p1/downloads/run-1/pause")).toBe(1);
  });

  it("two presses in one tick of Discard send one request", async () => {
    const TITLE = "The capture of 'Example Channel' was interrupted: 120 of 412 done.";
    const { m } = start({ runs: [exampleRun({ state: "interrupted" })] });
    await shown(TITLE);
    await twice(buttonOf(TITLE, "Discard"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(m.count("POST /projects/p1/downloads/run-1/discard")).toBe(1);
  });

  it('two presses in one tick of a run\'s "Remove from this list" send one request', async () => {
    const TITLE = '"Example Channel": all 412 downloaded.';
    const { m } = start({ runs: [exampleRun({ state: "finished", done: 412 })] });
    await shown(TITLE);
    await twice(buttonOf(TITLE, "Remove from this list"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(m.count("POST /projects/p1/downloads/run-1/discard")).toBe(1);
  });

  it("two presses in one tick of the list's action send one request", async () => {
    const TITLE = "Transcribing: 1 of 5";
    const { m } = start({ lists: { p1: idleList("p1", { state: "running", total: 5, done: 1 }) } });
    await shown(TITLE);
    await twice(buttonOf(TITLE, "Pause"));
    await shown("Transcriptions paused: 1 of 5 done.");
    expect(m.count("POST /projects/p1/transcription-list/pause")).toBe(1);
  });

  it('two presses in one tick of the list\'s "Remove from this list" send one request', async () => {
    const TITLE = "Transcriptions finished: all 3 done.";
    const { m } = start({ lists: { p1: idleList("p1", { total: 3, done: 3 }) } });
    await shown(TITLE);
    await twice(buttonOf(TITLE, "Remove from this list"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(m.count("POST /projects/p1/transcription-list/stop")).toBe(1);
  });

  it('a title is found with its quotation marks: the titles "of" and "Downloading" (M4)', async () => {
    const OF = "The capture of 'of' was interrupted: 120 of 412 done.";
    const DL = 'Downloading "Downloading": 120 of 412';
    start({ runs: [exampleRun({ title: "of", state: "interrupted" }), exampleRun({ runId: "run-2", title: "Downloading", startedAt: later(5) })] });
    for (const [text, title, before] of [
      [OF, "of", "The capture of '"],
      [DL, "Downloading", 'Downloading "'],
    ] as const) {
      const p = await shown(text);
      const outside = p.querySelectorAll("[dir=auto]");
      expect(outside).toHaveLength(1);
      expect(outside[0]!.textContent).toBe(title);
      expect(p.firstChild!.textContent).toBe(before);
    }
  });

  it('"Show them" says nothing under its heading until the list arrives; a failure says so with "Try again" inside that run\'s block (M8)', async () => {
    const TITLE = '"Example Channel": 409 of 412 downloaded. 3 could not be downloaded.';
    let failing = true;
    const problems = holding("/projects/p1/downloads/run-1/problems", (n) => n === 1);
    const fail = http.get(url("/projects/p1/downloads/run-1/problems"), () => (failing ? HttpResponse.error() : undefined));
    start({ runs: [exampleRun({ state: "finished", done: 409, failed: 3 })], problems: { "run-1": { platform: "youtube", problems: PROBLEMS } }, extra: [problems.handler, fail] });
    await shown(TITLE);
    const user = userEvent.setup();
    await user.click(buttonOf(TITLE, "Show them"));
    await waitFor(() => expect(problems.count()).toBe(1));
    // While the read is out: no empty heading.
    expect(screen.queryByRole("heading", { name: "Could not be downloaded" })).toBeNull();
    problems.release();
    const alert = await within(lineOf(TITLE)).findByRole("alert");
    expect(alert.textContent).toBe("The library service could not be reached.");
    const h = within(lineOf(TITLE)).getByRole("heading", { name: "Could not be downloaded" });
    await waitFor(() => expect(document.activeElement).toBe(h));
    failing = false;
    await user.click(buttonOf(TITLE, "Try again"));
    await shown("Interview with the mayor");
    expect(within(lineOf(TITLE)).queryByRole("alert")).toBeNull();
    expect(problems.count()).toBe(2);
  });

  it('the "Show them" read is cancelled when the block closes, and when the lines go (M8)', async () => {
    const TITLE = '"Example Channel": 409 of 412 downloaded. 3 could not be downloaded.';
    const problems = holding("/projects/p1/downloads/run-1/problems", () => true);
    const { view } = start({ runs: [exampleRun({ state: "finished", done: 409, failed: 3 })], extra: [problems.handler] });
    await shown(TITLE);
    const user = userEvent.setup();
    await user.click(buttonOf(TITLE, "Show them"));
    await waitFor(() => expect(problems.count()).toBe(1));
    await user.click(buttonOf(TITLE, "Show them"));
    await waitFor(() => expect(problems.requests[0]!.signal.aborted).toBe(true));
    await user.click(buttonOf(TITLE, "Show them"));
    await waitFor(() => expect(problems.count()).toBe(2));
    view.unmount();
    await waitFor(() => expect(problems.requests[1]!.signal.aborted).toBe(true));
    problems.release();
  });

  it('the "Show them" read has the first-read time limit (M8)', async () => {
    const TITLE = '"Example Channel": 409 of 412 downloaded. 3 could not be downloaded.';
    const problems = holding("/projects/p1/downloads/run-1/problems", () => true);
    start({ runs: [exampleRun({ state: "finished", done: 409, failed: 3 })], extra: [problems.handler] });
    await shown(TITLE);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(buttonOf(TITLE, "Show them"));
      await vi.waitFor(() => expect(problems.count()).toBe(1));
      // (vi.waitFor moved the fake clock a little on its own.)
      await act(async () => vi.advanceTimersByTimeAsync(19_000));
      expect(within(lineOf(TITLE)).queryByRole("alert")).toBeNull();
      expect(problems.requests[0]!.signal.aborted).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      await vi.waitFor(() => expect(within(lineOf(TITLE)).getByRole("alert").textContent).toBe("The library service did not answer in time."));
      expect(problems.requests[0]!.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
