/**
 * FR-756 (R584, R586, R597): the reader's route reads the source and the library's mode before it shows anything
 * ("Opening the source…"). A read that never settles is given up at the limit and the route shows its own kind of
 * failure — a heading and a sentence, focus on the heading, "Open again" — with the true words: it did not answer in
 * time (a FAILED read keeps "could not be reached"). Its event stream (the library's state, A9), not opened within its
 * own limit, is closed and opened afresh after the route's pause (two seconds); an open, quiet stream is never dropped.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_RW, hang, LIBRARIES, PROJECTS, server, SOURCE_FILE, sseAttempts, testClient, url, useMockService } from "../test/service";
import { ReaderRoute } from "./reader";

// The screen itself is tested in screens/Reader*.test.tsx; here only the route's own reads.
vi.mock("../screens/Reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../screens/Reader")>()),
  ReaderScreen: (p: { assetId?: string }) => <p data-testid="reader-screen">{p.assetId ?? "-"}</p>,
}));

useMockService();

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
});

const NO_ANSWER_HEADING = "Library service did not answer";
const NO_ANSWER = "The library service did not answer in time, so this PDF cannot be shown. Try again in a moment.";
const STATE = { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} };

function serve(o: { events?: ReturnType<typeof sseAttempts>; source?: () => Promise<Response> | Response } = {}) {
  const n = { source: 0, projects: 0 };
  server.use(
    o.events?.handler ?? http.get(url("/events"), () => new HttpResponse(new ReadableStream(), { headers: { "content-type": "text/event-stream" } })),
    http.get(url("/projects"), () => {
      n.projects++;
      return HttpResponse.json(PROJECTS);
    }),
    http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW })),
    http.get(url("/projects/:id/sources/:sid"), () => {
      n.source++;
      return o.source ? o.source() : HttpResponse.json(SOURCE_FILE);
    }),
  );
  return n;
}

const show = (p: { firstReadMs?: number; streamOpenMs?: number } = {}) =>
  render(<ReaderRoute client={testClient()} loc={{ pathname: "/reader", search: "?project=p1&source=s1" }} {...p} />);

describe("ReaderRoute: a first read that never settles (FR-756)", () => {
  it("a source read that hangs is given up at the limit: it did not answer in time, focus on the heading, “Open again” reads again", async () => {
    let release!: () => void;
    const second = new Promise<void>((r) => (release = r));
    const gate = hang();
    let n = 0;
    const count = serve({
      source: async () => {
        await (++n === 1 ? gate : second);
        return HttpResponse.json(SOURCE_FILE);
      },
    });
    show({ firstReadMs: 300 });
    expect(screen.getByText("Opening the source…")).toBeTruthy();
    const h = await screen.findByRole("heading", { level: 2, name: NO_ANSWER_HEADING }, { timeout: 5000 });
    expect(screen.getByText(NO_ANSWER)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(h));
    expect(count.source).toBe(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "Open again" }));
    expect(screen.getByText("Opening the source…")).toBeTruthy();
    release();
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("a1");
    expect(count.source).toBe(2);
  });

  it("a source read that FAILS for want of an answer still says it could not be reached (unchanged)", async () => {
    serve({ source: () => HttpResponse.error() as unknown as Response });
    show({ firstReadMs: 300 });
    await screen.findByRole("heading", { level: 2, name: "Library service not reachable" });
    expect(screen.getByText("The library service could not be reached, so this PDF cannot be shown. Try again in a moment.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open again" })).toBeTruthy();
  });
});

describe("ReaderRoute: an event stream that does not open within the limit is tried afresh (FR-756, R597)", () => {
  it("a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the state it sends asks again whether the project is unlocked", async () => {
    const ev = sseAttempts((n) => (n === 1 ? "hang" : [{ type: "library.state", data: STATE }]));
    const count = serve({ events: ev });
    show({ streamOpenMs: 300 });
    expect((await screen.findByTestId("reader-screen")).textContent).toBe("a1");
    await waitFor(() => expect(count.projects).toBe(1), { timeout: 10_000 });
    expect(ev.attempts()).toBe(2);
    // The route's own first reads were in before it began to listen: nothing of them is read again.
    expect(count.source).toBe(1);
    expect(screen.getByTestId("reader-screen")).toBeTruthy();
  });

  it("a stream that has opened is never dropped by the limit, however long it stays quiet", async () => {
    const signals: AbortSignal[] = [];
    serve();
    server.use(
      http.get(url("/events"), ({ request }) => {
        signals.push(request.signal);
        return new HttpResponse(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      }),
    );
    show({ streamOpenMs: 200 });
    await screen.findByTestId("reader-screen");
    await waitFor(() => expect(signals).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 3_000));
    // Still the first stream, and its request not cancelled (R602).
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
  });
});

describe("ReaderRoute: its two first reads are one read (FR-756, R605 M6)", () => {
  it("a source read that fails cancels the read of the libraries still out, long before the limit", async () => {
    const signals: AbortSignal[] = [];
    const gate = hang();
    serve({ source: () => HttpResponse.error() });
    server.use(
      http.get(url("/libraries"), async ({ request }) => {
        signals.push(request.signal);
        await gate;
        return HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW });
      }),
    );
    show();
    await screen.findByRole("button", { name: "Open again" });
    await waitFor(() => expect(signals).toHaveLength(1));
    await waitFor(() => expect(signals[0]!.aborted).toBe(true), { timeout: 1000 });
  });
});
