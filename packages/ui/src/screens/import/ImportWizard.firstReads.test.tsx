/**
 * FR-756 (R584, R586, R597): the import wizard's first reads have a time limit — the import named in the address
 * ("Opening the import…"), the list of projects, the project's rules, and on the run step the batch's state on arrival.
 * A read given up at the limit says the service "did not answer in time"; one that failed for want of any answer keeps
 * "could not be reached" (never both run together); the opening and the projects offer "Try again". The run step's
 * event stream, not opened within its own limit, is closed and opened afresh after its pause (300 ms); at that opening
 * the batch's state is read again. An open, quiet stream is never dropped.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { B1, BASE, mockService, P1, server, type ServiceSetup } from "../../test/importService";
import { hang } from "../../test/service";
import { ImportWizard } from "./ImportWizard";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const url = (p: string) => `${BASE}${p}`;
const running = { batchId: B1, number: 4, kind: "folder", state: "running", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 0, merged: 0, skipped: 0, failed: 0, needsReview: 0 } };

const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

/** A GET whose asks are counted; the asks `hold(n)` picks are held until `release()` (or the test's end), else answered by the mocked service. */
function holding(path: string, hold: (n: number) => boolean) {
  let n = 0;
  const requests: Request[] = [];
  const gate = hang();
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let freed = false;
  return {
    handler: http.get(url(path), async ({ request }) => {
      requests.push(request);
      if (hold(++n) && !freed) await Promise.race([gate, released]);
      return undefined;
    }),
    count: () => n,
    /** Each ask's request signal (an open stream's must not be aborted). */
    get signals(): AbortSignal[] {
      return requests.map((r) => r.signal);
    },
    /** Lets every held ask, and every later one, be answered. */
    release: () => {
      freed = true;
      release();
    },
  };
}

function open(o: ServiceSetup, p: { firstReadMs?: number; streamOpenMs?: number; streamQuietMs?: number; batch?: boolean } = {}) {
  const m = mockService(o);
  render(<ImportWizard client={m.client} projectId={P1} {...(p.batch === false ? {} : { batchId: B1 })} {...(p.firstReadMs !== undefined ? { firstReadMs: p.firstReadMs } : {})} {...(p.streamOpenMs !== undefined ? { streamOpenMs: p.streamOpenMs } : {})} {...(p.streamQuietMs !== undefined ? { streamQuietMs: p.streamQuietMs } : {})} />);
  return m;
}

describe("Import wizard: first reads that never settle or fail (FR-756)", () => {
  it("the import named in the address, never answered, is given up at the limit: “Opening the import…” gives way to the alert and “Try again”, which opens it", async () => {
    const batches = holding(`/projects/${P1}/imports`, () => true);
    open({ batches: [running], extra: [batches.handler] }, { firstReadMs: 300 });
    expect(screen.getByText("Opening the import…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([`The import could not be read. ${NO_ANSWER}`]);
    expect(screen.queryByText("Opening the import…")).toBeNull();
    await userEvent.setup().click(tryAgain()!);
    expect(screen.getByText("Opening the import…")).toBeTruthy();
    expect(alerts()).toEqual([]);
    batches.release();
    const run = await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(document.activeElement).toBe(run));
    expect(tryAgain()).toBeNull();
  });

  it("an opening that fails for want of an answer keeps its words, “could not be reached”, and now offers “Try again”", async () => {
    let failing = true;
    open({ batches: [running], extra: [http.get(url(`/projects/${P1}/imports`), () => (failing ? Response.error() : undefined))] }, { firstReadMs: 300 });
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([`The import could not be read. ${UNREACHABLE}`]);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("heading", { name: "Run" });
    expect(alerts()).toEqual([]);
  });

  it("one sentence at a time (R602 M1): an opening given up at the limit and a list of projects that failed with no answer show “could not be reached” alone, with one “Try again”", async () => {
    let failing = true;
    const batches = holding(`/projects/${P1}/imports`, (n) => n === 1);
    open({ batches: [running], extra: [batches.handler, http.get(url("/projects"), () => (failing ? Response.error() : undefined))] }, { firstReadMs: 300 });
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText("Opening the import…")).toBeNull());
    expect(alerts()).toEqual([`The import could not be read. ${UNREACHABLE}`]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(alerts()).toEqual([]));
  });

  it("an opening the service refused with its own words shows them as before, with no “Try again” (unchanged)", async () => {
    open({ batches: [running], batchesRefused: true }, { firstReadMs: 300 });
    await waitFor(() => expect(alerts().some((a) => a?.startsWith("The import could not be read."))).toBe(true));
    expect(tryAgain()).toBeNull();
  });

  it("the list of projects, never answered, is given up at the limit with the alert and “Try again”, which fills the project choice", async () => {
    const projects = holding("/projects", (n) => n === 1);
    open({ extra: [projects.handler] }, { firstReadMs: 300, batch: false });
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("option", { name: "Thesis" });
    expect(alerts()).toEqual([]);
    expect(projects.count()).toBe(2);
  });

  it("the project's rules, never answered, are given up at the limit and taken strictly, as when they fail: Start import is not held off for ever", async () => {
    const rules = holding(`/projects/${P1}/governance`, () => true);
    open({ extra: [rules.handler] }, { firstReadMs: 300, batch: false });
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "/data/papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: "Options" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Start import" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    // Taken strictly: no link in place (encryption required).
    expect((screen.getByRole("radio", { name: "Copy into the library" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("Import wizard: rules that could not be read are said where the options are forced (FR-756, R605 M2)", () => {
  const STRICT_NOTE = "This project's rules could not be read, so the strictest options are used. Try again to read them.";
  async function toOptions() {
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "/data/papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: "Options" });
    return user;
  }
  const linkInPlace = () => screen.getByRole("radio", { name: /Link in place/ }) as HTMLInputElement;

  it.each([
    ["given up at the limit", (n: number) => n === 1, false],
    ["failed with no answer", () => false, true],
  ])("rules %s: the Options step says the strictest options are used, with “Try again”, which reads them and shows the options they allow", async (_what, hold, fail) => {
    let asks = 0;
    const rules = holding(`/projects/${P1}/governance`, hold);
    const failing = http.get(url(`/projects/${P1}/governance`), () => (++asks === 1 ? Response.error() : undefined));
    open({ extra: [fail ? failing : rules.handler] }, { firstReadMs: 300, batch: false });
    const user = await toOptions();
    await screen.findByText(STRICT_NOTE, {}, { timeout: 5000 });
    expect(linkInPlace().disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    await user.click(tryAgain()!);
    await waitFor(() => expect(linkInPlace().disabled).toBe(false));
    expect(screen.queryByText(STRICT_NOTE)).toBeNull();
    expect(tryAgain()).toBeNull();
  });
});

describe("Import wizard, run step: its first read and its event stream (FR-756, R597)", () => {
  it("the batch's state on arrival, never answered, is given up at the limit and the run is followed (it no longer waits before listening)", async () => {
    // The first ask is the opening's; the second, the run step's on arrival.
    const batches = holding(`/projects/${P1}/imports`, (n) => n === 2);
    const m = open({ batches: [running], extra: [batches.handler] }, { firstReadMs: 300 });
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(m.calls.some((c) => c.path === "/events")).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(batches.count()).toBe(3)); // read again at the stream's opening
    await act(async () => m.emit("import.progress", { batchId: B1, projectId: P1, state: "running", done: 1, total: 3 }));
    await screen.findByText("1 of 3 items");
    expect(alerts()).toEqual([]);
  });

  it("a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the batch's state is read again", async () => {
    const events = holding("/events", (n) => n === 1);
    const batches = holding(`/projects/${P1}/imports`, () => false);
    const m = open({ batches: [running], extra: [events.handler, batches.handler] }, { streamOpenMs: 300 });
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(events.count()).toBe(2), { timeout: 5000 });
    // Opening, arrival, after the lost try, and at the new opening.
    await waitFor(() => expect(batches.count()).toBe(4));
    await act(async () => m.emit("import.progress", { batchId: B1, projectId: P1, state: "running", done: 2, total: 3 }));
    await screen.findByText("2 of 3 items");
    expect(alerts()).toEqual([]);
  });

  it("a stream that never opens at all ends, after the step's own tries, in its existing notice, saying it did not answer in time (not merged with “could not be reached”)", async () => {
    const events = holding("/events", () => true);
    open({ batches: [running], extra: [events.handler] }, { streamOpenMs: 200 });
    await screen.findByText(/Progress updates are not available right now/, {}, { timeout: 5000 });
    expect(events.count()).toBe(3);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(alerts()).toContain(NO_ANSWER);
    expect(alerts().some((a) => a?.includes(UNREACHABLE))).toBe(false);
  });

  it("a stream that has opened is never dropped by the limit, however long it stays quiet", async () => {
    const events = holding("/events", () => false);
    const m = open({ batches: [running], extra: [events.handler] }, { streamOpenMs: 100 });
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(m.calls.filter((c) => c.path === "/events")).toHaveLength(1));
    // Ten times the limit, and more than the step's pause before a new try: still the first stream.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(events.count()).toBe(1);
    expect(events.signals[0]!.aborted).toBe(false);
    expect(screen.queryByText(/Progress updates are not available right now/)).toBeNull();
  });

  it("R641 D2: a stream that opens and then delivers nothing for `streamQuietMs` (not even a keep-alive) is cancelled, the batch's state checked, and the stream opened afresh", async () => {
    // The second try is held, never opening: the step rests there (its opening limit is the default 20 s).
    const events = holding("/events", (n) => n === 2);
    const batches = holding(`/projects/${P1}/imports`, () => false);
    open({ batches: [running], extra: [events.handler, batches.handler] }, { streamQuietMs: 300 });
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(events.count()).toBe(2), { timeout: 10_000 });
    expect(events.signals[0]!.aborted).toBe(true);
    expect(screen.queryByText(/Progress updates are not available right now/)).toBeNull();
  });
});

describe("Import wizard, run step: leaving it cancels its held read (FR-756, R605 M3)", () => {
  it("the batch's state on arrival, held: its request's signal is aborted when the screen is left", async () => {
    // The first ask is the opening's; the second, the run step's on arrival.
    const batches = holding(`/projects/${P1}/imports`, (n) => n === 2);
    const m = mockService({ batches: [running], extra: [batches.handler] });
    const { unmount } = render(<ImportWizard client={m.client} projectId={P1} batchId={B1} />);
    await screen.findByRole("heading", { name: "Run" });
    await waitFor(() => expect(batches.count()).toBe(2));
    expect(batches.signals[1]!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(batches.signals[1]!.aborted).toBe(true));
  });
});
