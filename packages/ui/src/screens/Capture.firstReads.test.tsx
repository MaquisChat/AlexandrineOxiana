/**
 * FR-756 (R584, R586, R597): capture's first reads — the project (its name, whether the browser session was
 * acknowledged, whether it is locked) and its rules ("Reading this project's rules…"), and on the route the list of
 * projects — have a time limit. A read given up at the limit says "The library service did not answer in time."; one
 * that failed for want of any answer keeps "The library service could not be reached."; both offer "Try again". Its
 * event stream, not opened within its own limit, is closed and opened afresh after the screen's pause (300 ms); at that
 * opening the first reads still out are made again. An open, quiet stream is never dropped.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BASE, mockCapture, P1, server } from "../test/captureService";
import { hang } from "../test/service";
import { Capture, CaptureRoute } from "./Capture";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const LOADING = /Reading this project's rules/;
const url = (p: string) => `${BASE}${p}`;

const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);
const heading = () => screen.getByRole("heading", { level: 1, name: "Capture" });

/**
 * A GET whose asks are counted; `hold(n)` true: the n-th ask is held until `release()` (or the test's end) — else it
 * falls through to the mocked service's own answer.
 */
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
    /** Each ask's request signal (an open stream's must not be aborted). */
    get signals(): AbortSignal[] {
      return requests.map((r) => r.signal);
    },
    release: () => release(),
  };
}

const show = (m: ReturnType<typeof mockCapture>, p: { firstReadMs?: number; streamOpenMs?: number; streamQuietMs?: number } = {}) => render(<Capture client={m.client} projectId={P1} {...p} />);

describe("Capture: first reads that never settle or fail (FR-756)", () => {
  it("a rules read that hangs is given up at the limit: the loading words give way to the alert and “Try again”; pressing it reads again and the screen is ready, focus not lost", async () => {
    const rules = holding(`/projects/${P1}/governance`, (n) => n <= 2);
    const m = mockCapture({ extra: [rules.handler] });
    show(m, { firstReadMs: 300 });
    expect(screen.getByText(LOADING)).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText(LOADING)).toBeNull();
    // As for a rules read that failed: the rules are taken strictly meanwhile, and the note on unreadable rules is not shown.
    expect(screen.queryByText(/rules cannot be read/i)).toBeNull();
    await userEvent.setup().click(tryAgain()!);
    expect(screen.getByText(LOADING)).toBeTruthy();
    expect(alerts()).toEqual([]);
    rules.release();
    await waitFor(() => expect(screen.queryByText(LOADING)).toBeNull());
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture links" }) as HTMLButtonElement).disabled).toBe(false));
    expect(rules.count()).toBe(2);
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(document.activeElement).toBe(heading());
  });

  it("a project read that hangs is given up at the limit, with the alert and “Try again”; pressing it reads the project again", async () => {
    const projects = holding("/projects", (n) => n === 1);
    const m = mockCapture({ extra: [projects.handler] });
    show(m, { firstReadMs: 300 });
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    await userEvent.setup().click(tryAgain()!);
    await screen.findByText("Thesis");
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture links" }) as HTMLButtonElement).disabled).toBe(false));
    expect(projects.count()).toBe(2);
    expect(alerts()).toEqual([]);
  });

  it("a rules read that fails for want of an answer keeps its words, “could not be reached” (not merged with the limit's), and now offers “Try again”", async () => {
    let failing = true;
    const m = mockCapture({ extra: [http.get(url(`/projects/${P1}/governance`), () => (failing ? HttpResponse.error() : undefined))] });
    show(m, { firstReadMs: 300 });
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture links" }) as HTMLButtonElement).disabled).toBe(false));
    expect(alerts()).toEqual([]);
  });

  it("one sentence at a time (R602 M1): a project read that failed with no answer and a rules read given up at the limit show “could not be reached” alone, with one “Try again”", async () => {
    let failing = true;
    const rules = holding(`/projects/${P1}/governance`, (n) => n === 1);
    const m = mockCapture({ extra: [http.get(url("/projects"), () => (failing ? HttpResponse.error() : undefined)), rules.handler] });
    show(m, { firstReadMs: 300 });
    await waitFor(() => expect(rules.count()).toBe(1));
    await screen.findByRole("button", { name: "Try again" });
    // The rules read is given up after the project failed: still the one sentence.
    await new Promise((r) => setTimeout(r, 500));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByText("Thesis");
    await waitFor(() => expect(alerts()).toEqual([]));
  });

  it("a rules read the service refused with its own words shows them as before, with no “Try again” (unchanged)", async () => {
    const m = mockCapture({ extra: [http.get(url(`/projects/${P1}/governance`), () => HttpResponse.json({ error: { code: "INTERNAL", message: "The rules file is damaged." } }, { status: 500 }))] });
    show(m, { firstReadMs: 300 });
    await waitFor(() => expect(alerts().some((a) => a?.includes("The rules file is damaged."))).toBe(true));
    expect(tryAgain()).toBeNull();
  });

  it("the route's list of projects, never answered, is given up at the limit with “Try again”; pressing it fills the project choice", async () => {
    const projects = holding("/projects", (n) => n === 1);
    const m = mockCapture({ extra: [projects.handler] });
    render(<CaptureRoute client={m.client} loc={{ pathname: "/capture", search: "" }} firstReadMs={300} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("option", { name: "Thesis" });
    await screen.findByRole("button", { name: "Capture links" });
    expect(alerts()).toEqual([]);
  });
});

describe("Capture route: the list of projects with a project in the address (FR-756, R605 I1)", () => {
  const route = (m: ReturnType<typeof mockCapture>) => render(<CaptureRoute client={m.client} loc={{ pathname: "/capture", search: `?project=${P1}` }} firstReadMs={300} />);
  const linksField = () => screen.getByRole("textbox", { name: "Links, one per line" }) as HTMLTextAreaElement;

  it("a list given up at the limit leaves the working Capture screen as it was: links being typed are not lost, and nothing says the project is not one of the library's", async () => {
    // The screen's own read of the projects asks first (a child's effect runs first): the route's is the second ask.
    const projects = holding("/projects", (n) => n === 2);
    const m = mockCapture({ extra: [projects.handler] });
    route(m);
    await screen.findByText("Thesis");
    await waitFor(() => expect(projects.count()).toBe(2));
    const user = userEvent.setup();
    await user.click(linksField());
    await user.keyboard("https://example.org/a");
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText(/not one of this library's projects/)).toBeNull();
    expect(linksField().value).toBe("https://example.org/a");
    expect(screen.getByRole("heading", { level: 1, name: "Capture" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("a list that failed with no answer leaves the Capture screen too, and never says the project is not one of the library's", async () => {
    let n = 0;
    const m = mockCapture({ extra: [http.get(url("/projects"), () => (++n === 2 ? HttpResponse.error() : undefined))] });
    route(m);
    await screen.findByText("Thesis");
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.queryByText(/not one of this library's projects/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Links, one per line" })).toBeTruthy();
  });
});

describe("Capture route and screen: one sentence and one “Try again” for the page (FR-756, R605 I2)", () => {
  const route = (m: ReturnType<typeof mockCapture>) => render(<CaptureRoute client={m.client} loc={{ pathname: "/capture", search: `?project=${P1}` }} firstReadMs={300} />);

  it("the route's list given up and the screen's rules failed with no answer say “could not be reached” alone, with one “Try again”, which reads both again", async () => {
    let answer = false;
    const projects = holding("/projects", (n) => n === 2);
    let rulesAsks = 0;
    const m = mockCapture({
      extra: [
        projects.handler,
        http.get(url(`/projects/${P1}/governance`), () => {
          rulesAsks++;
          return answer ? undefined : HttpResponse.error();
        }),
      ],
    });
    route(m);
    await waitFor(() => expect(projects.count()).toBe(2));
    await new Promise((r) => setTimeout(r, 600));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("option", { name: "Thesis" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture links" }) as HTMLButtonElement).disabled).toBe(false));
    expect(projects.count()).toBe(3);
    expect(rulesAsks).toBe(2);
    await waitFor(() => expect(alerts()).toEqual([]));
  });

  it("the mirror: the route's list failed with no answer and the screen's rules given up say “could not be reached” alone, with one “Try again”", async () => {
    let n = 0;
    const rules = holding(`/projects/${P1}/governance`, (k) => k === 1);
    const m = mockCapture({ extra: [http.get(url("/projects"), () => (++n === 2 ? HttpResponse.error() : undefined)), rules.handler] });
    route(m);
    await waitFor(() => expect(rules.count()).toBe(1));
    await new Promise((r) => setTimeout(r, 600));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("option", { name: "Thesis" });
    await waitFor(() => expect(rules.count()).toBe(2));
    await waitFor(() => expect(alerts()).toEqual([]));
  });
});

describe("Capture: an event stream that does not open within the limit is tried afresh (FR-756, R597)", () => {
  it("a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the first reads still out are made again", async () => {
    const events = holding("/events", (n) => n === 1);
    const rules = holding(`/projects/${P1}/governance`, (n) => n === 1);
    const m = mockCapture({ extra: [events.handler, rules.handler] });
    show(m, { streamOpenMs: 300 }); // the reads keep the default limit (twenty seconds): the first rules read is still out
    expect(screen.getByText(LOADING)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(LOADING)).toBeNull(), { timeout: 5000 });
    await waitFor(() => expect((screen.getByRole("button", { name: "Capture links" }) as HTMLButtonElement).disabled).toBe(false));
    expect(events.count()).toBe(2);
    expect(rules.count()).toBe(2);
    // The queues are read at that opening too, as at every opening.
    await waitFor(() => expect(m.calls.some((c) => c.path === `/projects/${P1}/captures`)).toBe(true));
    expect(alerts()).toEqual([]);
  });

  it("a stream that never opens at all ends, after the screen's own tries, in its existing notice with “Reconnect”", async () => {
    const events = holding("/events", () => true);
    const m = mockCapture({ extra: [events.handler] });
    show(m, { streamOpenMs: 200 });
    await screen.findByText(/Progress updates are not available right now/, {}, { timeout: 5000 });
    expect(events.count()).toBe(3);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("“Reconnect” also makes again the first reads still out (R605 M7)", async () => {
    const events = holding("/events", () => true);
    const rules = holding(`/projects/${P1}/governance`, (n) => n === 1);
    const m = mockCapture({ extra: [events.handler, rules.handler] });
    show(m, { streamOpenMs: 200 }); // the reads keep the default limit (twenty seconds): the first rules read is still out
    await screen.findByText(/Progress updates are not available right now/, {}, { timeout: 5000 });
    expect(rules.count()).toBe(1);
    expect(screen.getByText(LOADING)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(rules.count()).toBe(2));
    await waitFor(() => expect(screen.queryByText(LOADING)).toBeNull());
    expect(rules.signals[0]!.aborted).toBe(true);
  });

  it("a stream that has opened is never dropped by the limit, however long it stays quiet", async () => {
    const events = holding("/events", () => false);
    const m = mockCapture({ extra: [events.handler] });
    show(m, { streamOpenMs: 100 });
    await waitFor(() => expect(m.streams()).toBe(1));
    // Ten times the limit, and more than the screen's pause before a new try: still the first stream.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(events.count()).toBe(1);
    expect(m.streams()).toBe(1);
    expect(events.signals[0]!.aborted).toBe(false);
  });

  it("R641 D2: a stream that opens and then delivers nothing for `streamQuietMs` (not even a keep-alive) is cancelled and opened afresh; the notice does not come (an opening starts the count again)", async () => {
    const events = holding("/events", () => false);
    const m = mockCapture({ extra: [events.handler] });
    show(m, { streamQuietMs: 300 });
    await waitFor(() => expect(events.count()).toBeGreaterThanOrEqual(5), { timeout: 30_000 });
    expect(events.signals[0]!.aborted).toBe(true);
    expect(screen.queryByText(/Progress updates are not available right now/)).toBeNull();
  });
});
