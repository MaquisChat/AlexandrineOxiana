/**
 * FR-756's remainder (R601 b, R617): the source's detail reads its record with the time limit. A read given up at the
 * limit, or failed with no answer, says the true one of the two sentences in the panel's own alert, with "Try again"
 * there, which reads it again ("Loading…" meanwhile). Inside the library screen the panel is part of the page: while the
 * library screen says its one sentence, the panel says none of its own and the page's one "Try again" reads it again too
 * (R602 M1, R605 I2: one sentence and one "Try again" per page).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { asksInTurn, CURRENT_RW, hang, libraryHandlers, REFUSED_READ, server, SOURCE_FILE, SOURCES, STYLES, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";
import { SourceDetail } from "./SourceDetail";

useMockService();

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const LIMIT = 300;
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);
const tryAgains = () => screen.queryAllByRole("button", { name: "Try again" });
const panel = () => screen.getByRole("region", { name: "Source details" });
/** The panel's side reads (the citation styles, where a watched folder brought the source in), answered. */
const styles = () =>
  server.use(
    http.get(url("/styles"), () => HttpResponse.json(STYLES)),
    http.get(url("/projects/:id/sources/:sid/watch-origin"), () => HttpResponse.json({ origins: [] })),
  );

function showAlone() {
  return render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} firstReadMs={LIMIT} />);
}

describe("the source's detail alone: its read has the limit (FR-756 remainder)", () => {
  it("a read that never settles is given up at the limit: the panel's alert and “Try again”; pressed, “Loading…” and then the record, focus not lost", async () => {
    styles();
    const asks = asksInTurn(url("/projects/:id/sources/:sid"), ["hold", "answer"], () => HttpResponse.json(SOURCE_FILE));
    server.use(asks.handler);
    showAlone();
    expect(within(panel()).getByText("Loading…")).toBeTruthy();
    const again = await within(panel()).findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(within(panel()).queryByText("Loading…")).toBeNull();
    expect(asks.signals[0]!.aborted).toBe(true);
    await userEvent.setup().click(again);
    await within(panel()).findByRole("heading", { level: 2, name: "Ethnography at Work" });
    expect(alerts()).toEqual([]);
    expect(tryAgains()).toHaveLength(0);
    expect(asks.count()).toBe(2);
    expect(document.activeElement === document.body || !document.activeElement?.isConnected).toBe(false);
  });

  it("a read that FAILS with no answer says “could not be reached” as before, now with “Try again”", async () => {
    styles();
    let fail = true;
    server.use(http.get(url("/projects/:id/sources/:sid"), () => (fail ? HttpResponse.error() : HttpResponse.json(SOURCE_FILE))));
    showAlone();
    await within(panel()).findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    fail = false;
    await userEvent.setup().click(tryAgains()[0]!);
    await within(panel()).findByRole("heading", { level: 2, name: "Ethnography at Work" });
    expect(alerts()).toEqual([]);
  });

  it("a read refused with an answer says the service's sentence as before, with no “Try again”", async () => {
    styles();
    server.use(asksInTurn(url("/projects/:id/sources/:sid"), ["refuse"]).handler);
    showAlone();
    await waitFor(() => expect(alerts().join(" ")).toContain(REFUSED_READ));
    expect(tryAgains()).toHaveLength(0);
  });

  it("an answered failure after a give-up takes the give-up's sentence away", async () => {
    styles();
    server.use(asksInTurn(url("/projects/:id/sources/:sid"), ["hold", "refuse"]).handler);
    showAlone();
    await within(panel()).findByRole("button", { name: "Try again" }, { timeout: 5000 });
    await userEvent.setup().click(tryAgains()[0]!);
    await waitFor(() => expect(alerts().join(" ")).toContain(REFUSED_READ));
    expect(alerts().join(" ")).not.toContain(NO_ANSWER);
    expect(tryAgains()).toHaveLength(0);
  });

  for (const reRead of ["given up", "failed with no answer"] as const)
    it(`a refused read, then a re-read (the badges refreshed) ${reRead}: the refusal stands while the re-read is out, then one alert, the re-read's (R623 Minor 1)`, async () => {
      styles();
      const requests: Request[] = [];
      server.use(
        http.get(url("/projects/:id/sources/:sid"), async ({ request }) => {
          requests.push(request);
          if (requests.length === 1) return HttpResponse.json({ error: { code: "INTERNAL", message: REFUSED_READ } }, { status: 500 });
          if (reRead === "failed with no answer") return HttpResponse.error();
          await hang();
          return undefined;
        }),
      );
      const props = { api: testApi(), projectId: "p1", sourceId: "s1", readOnly: false, onClose: vi.fn(), firstReadMs: LIMIT };
      const { rerender } = render(<SourceDetail {...props} refreshKey={0} />);
      await waitFor(() => expect(alerts().join(" ")).toContain(REFUSED_READ));
      rerender(<SourceDetail {...props} refreshKey={1} />);
      await waitFor(() => expect(requests).toHaveLength(2));
      if (reRead === "given up") {
        expect(alerts()).toHaveLength(1);
        expect(alerts().join(" ")).toContain(REFUSED_READ);
      }
      await within(panel()).findByRole("button", { name: "Try again" }, { timeout: 5000 });
      expect(alerts()).toEqual([reRead === "given up" ? NO_ANSWER : UNREACHABLE]);
      expect(tryAgains()).toHaveLength(1);
    });

  it("closing the panel cancels its held read", async () => {
    styles();
    const asks = asksInTurn(url("/projects/:id/sources/:sid"), ["hold"]);
    server.use(asks.handler);
    const { unmount } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await waitFor(() => expect(asks.count()).toBe(1));
    expect(asks.signals[0]!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(asks.signals[0]!.aborted).toBe(true));
  });
});

describe("the source's detail inside the library screen: one sentence and one “Try again” for the page (FR-756 remainder)", () => {
  it("the panel's read given up while the library's own search failed with no answer: “could not be reached” alone, one “Try again”, which reads both again", async () => {
    styles();
    let searchFails = false;
    let answer = false;
    const gate = hang();
    let detailAsks = 0;
    let searchAsks = 0;
    server.use(
      http.get(url("/projects/:id/sources/:sid"), async () => {
        detailAsks++;
        if (!answer) await gate;
        return HttpResponse.json(SOURCE_FILE);
      }),
      http.get(url("/projects/:id/sources"), () => {
        searchAsks++;
        return searchFails && !answer ? HttpResponse.error() : HttpResponse.json(SOURCES);
      }),
      ...libraryHandlers(),
    );
    render(<Library api={testApi()} current={CURRENT_RW as never} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ethnography at Work" }));
    await waitFor(() => expect(detailAsks).toBe(1));
    // The library's own read of the sources fails with no answer (a search) while the panel's read is out.
    searchFails = true;
    await user.type(screen.getByRole("searchbox", { name: "Search sources" }), "x");
    await waitFor(() => expect(alerts()).toEqual([UNREACHABLE]), { timeout: 3000 });
    // Past the panel's limit: still one sentence, one button.
    await new Promise((r) => setTimeout(r, LIMIT + 200));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(tryAgains()).toHaveLength(1);
    expect(within(panel()).queryByRole("button", { name: "Try again" })).toBeNull();
    const searchBefore = searchAsks;
    answer = true;
    await user.click(tryAgains()[0]!);
    await within(panel()).findByRole("heading", { level: 2, name: "Ethnography at Work" });
    await waitFor(() => expect(alerts()).toEqual([]));
    expect(tryAgains()).toHaveLength(0);
    expect(detailAsks).toBe(2);
    expect(searchAsks).toBeGreaterThan(searchBefore);
  });

  it("the panel's read given up while the library says nothing: the panel's own alert and “Try again”, alone on the page", async () => {
    styles();
    let answer = false;
    const gate = hang();
    server.use(
      http.get(url("/projects/:id/sources/:sid"), async () => {
        if (!answer) await gate;
        return HttpResponse.json(SOURCE_FILE);
      }),
      ...libraryHandlers(),
    );
    render(<Library api={testApi()} current={CURRENT_RW as never} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Ethnography at Work" }));
    const again = await within(panel()).findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(tryAgains()).toHaveLength(1);
    answer = true;
    await user.click(again);
    await within(panel()).findByRole("heading", { level: 2, name: "Ethnography at Work" });
    expect(alerts()).toEqual([]);
  });
});
