/**
 * FR-756 B (R584, R586): the library screen's first reads have a time limit. A read given up at the limit says "The
 * library service did not answer in time."; one that failed for want of any answer says "The library service could
 * not be reached." (the two are not merged, R586 M5); both offer "Try again". When the screen's event stream opens anew
 * after it was lost, what has not been read is read again, without a press and without an event on it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { CURRENT_RW, hang, libraryHandlers, PROJECTS, server, serviceError, SOURCES, sseAttempts, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const STATE = { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} };

const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

/** Counts the GETs of each path the screen makes (by the route's pattern). */
function counting() {
  const n = new Map<string, number>();
  return {
    hit: (k: string) => n.set(k, (n.get(k) ?? 0) + 1).get(k)!,
    count: (k: string) => n.get(k) ?? 0,
  };
}

const show = (firstReadMs?: number) => render(<Library api={testApi()} current={CURRENT_RW as never} {...(firstReadMs !== undefined ? { firstReadMs } : {})} />);

describe("Library: first reads that never settle or fail (FR-756 B)", () => {
  it("a projects read that hangs is given up at the limit: “Loading projects…” gives way to the alert and “Try again”; pressing it reads again and the screen fills, focus not lost", async () => {
    const c = counting();
    let answer = false;
    const gate = hang();
    server.use(
      http.get(url("/projects"), async () => {
        c.hit("projects");
        if (!answer) await gate;
        return HttpResponse.json(PROJECTS);
      }),
      ...libraryHandlers(),
    );
    show(300);
    expect(screen.getByText("Loading projects…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Loading projects…")).toBeNull();
    expect(c.count("projects")).toBe(1);
    expect(document.activeElement).toBe(document.body);
    answer = true;
    const user = userEvent.setup();
    await user.click(tryAgain()!);
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    expect(within(nav).getByRole("button", { name: /Dissertation/ })).toBeTruthy();
    await screen.findByText("Ethnography at Work");
    await waitFor(() => expect(tryAgain()).toBeNull());
    expect(c.count("projects")).toBe(2);
    expect(alerts()).toEqual([]);
    // The button pressed has gone: focus is in the library's main pane, never the page.
    expect(document.activeElement).toBe(document.querySelector("main.ao-library__main"));
  });

  it("a projects read that fails for want of an answer says “could not be reached” (not merged with the time limit's words), with “Try again”", async () => {
    let failing = true;
    server.use(
      http.get(url("/projects"), () => (failing ? HttpResponse.error() : HttpResponse.json(PROJECTS))),
      ...libraryHandlers(),
    );
    show(300);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("navigation", { name: "Projects" });
    await waitFor(() => expect(tryAgain()).toBeNull());
    expect(alerts()).toEqual([]);
  });

  it("a projects read refused with an answer the screen handles shows its sentence as before, with no “Try again”", async () => {
    server.use(http.get(url("/projects"), () => serviceError(500, "INTERNAL", "The projects could not be listed.")), ...libraryHandlers());
    show(300);
    await screen.findByText("The projects could not be listed.");
    expect(tryAgain()).toBeNull();
  });

  it("a sources read that hangs is given up at the limit: “Loading sources…” gives way to the alert and “Try again”, which reads them again", async () => {
    const c = counting();
    let answer = false;
    const gate = hang();
    server.use(
      http.get(url("/projects/:id/sources"), async () => {
        c.hit("sources");
        if (!answer) await gate;
        return HttpResponse.json(SOURCES);
      }),
      ...libraryHandlers(),
    );
    show(300);
    await screen.findByText("Loading sources…");
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Loading sources…")).toBeNull();
    // The rest of the screen is there: the projects, the collections.
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeTruthy();
    expect(await screen.findByRole("tree", { name: "Collections" })).toBeTruthy();
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByText("Ethnography at Work");
    await waitFor(() => expect(tryAgain()).toBeNull());
    expect(c.count("sources")).toBe(2);
    expect(alerts()).toEqual([]);
  });

  it("collections and tags that hang are given up at the limit with the alert and “Try again”, which reads them again", async () => {
    const c = counting();
    let answer = false;
    const gate = hang();
    server.use(
      http.get(url("/projects/:id/tags"), async () => {
        c.hit("tags");
        if (!answer) await gate;
        return HttpResponse.json({ tags: [{ id: "t1", scope: "p1", name: "to read" }], workspaceTags: [] });
      }),
      ...libraryHandlers(),
    );
    show(300);
    await screen.findByText("Ethnography at Work");
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    expect(await within(screen.getByRole("region", { name: "Tags" })).findByText("to read")).toBeTruthy();
    await waitFor(() => expect(tryAgain()).toBeNull());
    expect(c.count("tags")).toBe(2);
    expect(alerts()).toEqual([]);
  });

  it("the reads beside the screen (the review queue's count, the recheck's state) do not hold it up when they hang", async () => {
    const gate = hang();
    server.use(
      http.get(url("/projects/:id/review"), async () => {
        await gate;
        return HttpResponse.json({ items: [], total: 1, offset: 0, limit: 0 });
      }),
      http.get(url("/projects/:id/recheck"), async () => {
        await gate;
        return HttpResponse.json({ running: null });
      }),
      ...libraryHandlers(),
    );
    show(300);
    await screen.findByText("Ethnography at Work");
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recheck project" })).toBeTruthy();
    // Nothing is said about them: without the count the link is not offered, as when it fails.
    await new Promise((r) => setTimeout(r, 500));
    expect(alerts()).toEqual([]);
    expect(tryAgain()).toBeNull();
    expect(screen.queryByRole("link", { name: /Review queue/ })).toBeNull();
  });
});

describe("Library: when the event stream opens anew, what has not been read is read again (FR-756 B)", () => {
  it("a projects read still out (it may never settle) is made again when the stream opens anew after it failed — no press, no event needed", async () => {
    const c = counting();
    const ev = sseAttempts((n) => (n === 1 ? "fail" : []));
    const gate = hang();
    server.use(
      ev.handler,
      http.get(url("/projects"), async () => {
        if (c.hit("projects") === 1) await gate;
        return HttpResponse.json(PROJECTS);
      }),
      ...libraryHandlers(),
    );
    show(); // the default limit (twenty seconds): the first read is still out when the stream opens anew
    expect(screen.getByText("Loading projects…")).toBeTruthy();
    await screen.findByRole("navigation", { name: "Projects" }, { timeout: 10_000 });
    await screen.findByText("Ethnography at Work");
    expect(ev.attempts()).toBe(2);
    expect(c.count("projects")).toBe(2);
    expect(tryAgain()).toBeNull();
  });

  it("a projects read that failed is made again once at each new opening of the stream, never in a loop", async () => {
    const c = counting();
    const ev = sseAttempts((n) => (n === 1 ? "fail" : [{ type: "library.state", data: STATE }]));
    server.use(
      ev.handler,
      http.get(url("/projects"), () => {
        c.hit("projects");
        return HttpResponse.error();
      }),
      ...libraryHandlers(),
    );
    show(300);
    await screen.findByRole("button", { name: "Try again" });
    await waitFor(() => expect(c.count("projects")).toBe(2), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    expect(c.count("projects")).toBe(2);
    expect(alerts()).toEqual([UNREACHABLE]);
    // Another drop and opening: one more read, and no more.
    ev.drop();
    await waitFor(() => expect(ev.attempts()).toBe(3), { timeout: 10_000 });
    await waitFor(() => expect(c.count("projects")).toBe(3));
    await new Promise((r) => setTimeout(r, 500));
    expect(c.count("projects")).toBe(3);
  });

  it("an ordinary opening reads the projects and sources once, though the stream opens while they are out", async () => {
    const c = counting();
    server.use(
      http.get(url("/projects"), () => {
        c.hit("projects");
        return HttpResponse.json(PROJECTS);
      }),
      http.get(url("/projects/:id/sources"), () => {
        c.hit("sources");
        return HttpResponse.json(SOURCES);
      }),
      ...libraryHandlers(),
    );
    show();
    await screen.findByText("Ethnography at Work");
    await new Promise((r) => setTimeout(r, 300));
    expect(c.count("projects")).toBe(1);
    expect(c.count("sources")).toBe(1);
  });
});
