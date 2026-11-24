import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_RW, LIBRARIES, libraryHandlers, server, serviceError, testClient, url, useMockService } from "../test/service";
import { navigate } from "../navigation";
import { LibraryRoutes, isLibraryPath } from "./library";

useMockService();
// The open library asks for the tools catalogue (the first-use question, Task 48c); outside the desktop app it is refused.
beforeEach(() => server.use(http.get(url("/tools"), () => serviceError(403, "FORBIDDEN", "The tools are managed from the desktop app."))));
afterEach(() => window.history.replaceState(null, "", "/"));

/** Matches the "still opening" line as a whole (the library's name is inside UserText). */
const stillOpening = (re: RegExp) => (_: string, el: Element | null) => el?.tagName === "P" && re.test(el.textContent ?? "");

describe("library routes", () => {
  it("are / and /library", () => {
    expect(isLibraryPath("/")).toBe(true);
    expect(isLibraryPath("/library")).toBe(true);
    expect(isLibraryPath("/library/")).toBe(true);
    expect(isLibraryPath("/import/review")).toBe(false);
  });

  it("with a library open, shows it", async () => {
    server.use(...libraryHandlers());
    render(<LibraryRoutes client={testClient()} />);
    expect(await screen.findByRole("navigation", { name: "Projects" })).toBeTruthy();
  });

  it("with none open, the chooser; a missing library leads to not found, and back", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
      http.post(url("/libraries/open"), () => serviceError(404, "NOT_FOUND", "That folder is not a library.")),
    );
    const user = userEvent.setup();
    render(<LibraryRoutes client={testClient()} />);
    await user.click(await screen.findByRole("button", { name: "Open Thesis library" }));
    expect(await screen.findByRole("heading", { name: /Library not found/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open a different library" }));
    expect(await screen.findByRole("heading", { name: "Choose a library" })).toBeTruthy();
  });

  it("D5: on launch, a remembered library the service could not reopen shows “Library not found”, not the chooser", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, notFound: { libraryId: "lib-1", name: "Thesis library" } })));
    render(<LibraryRoutes client={testClient()} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Library not found: Thesis library" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose a library" })).toBeNull();
  });

  it("D5: a not-found library the registry no longer knows falls back to the chooser", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, notFound: { libraryId: "lib-9", name: "Gone" } })));
    render(<LibraryRoutes client={testClient()} />);
    expect(await screen.findByRole("heading", { name: "Choose a library" })).toBeTruthy();
  });

  it("I1: while the last library is still being opened, the chooser says so, stays usable, and keeps checking until it is open", async () => {
    let phase: "reopening" | "open" = "reopening";
    let checks = 0;
    server.use(
      http.get(url("/libraries"), () => {
        checks++;
        return HttpResponse.json(phase === "reopening" ? { ...LIBRARIES, reopening: { libraryId: "lib-1", name: "Thesis library" } } : { ...LIBRARIES, current: CURRENT_RW });
      }),
      ...libraryHandlers(),
    );
    render(<LibraryRoutes client={testClient()} />);
    const status = await screen.findByText(stillOpening(/Still opening Thesis library, the library that was open last time/));
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.getByRole("heading", { name: "Choose a library" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Open Grant 2025" })).toBeTruthy();
    // It keeps checking while the answer is the same...
    const before = checks;
    await waitFor(() => expect(checks).toBeGreaterThan(before), { timeout: 5000 });
    expect(screen.getByText(stillOpening(/Still opening Thesis library/))).toBeTruthy();
    // ...and once it is open, the library is shown.
    phase = "open";
    expect(await screen.findByRole("navigation", { name: "Projects" }, { timeout: 5000 })).toBeTruthy();
  });

  it("FR-368: while the last library is still being opened, it asks again after 2, 4 and 8 seconds, then every 15, and stops when the screen goes", async () => {
    let checks = 0;
    server.use(
      http.get(url("/libraries"), () => {
        checks++;
        return HttpResponse.json({ ...LIBRARIES, reopening: { libraryId: "lib-1", name: "Thesis library" } });
      }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      // Lets the answers in flight arrive without moving the clock (vi.waitFor would move it).
      const settle = async () => {
        for (let i = 0; i < 20; i++) await wait(0);
      };
      const { unmount } = render(<LibraryRoutes client={testClient()} />);
      await settle();
      expect(screen.getByText(stillOpening(/Still opening Thesis library/))).toBeTruthy();
      const base = checks; // the first look, and the chooser's own list of libraries
      // The checks after it come at 2, 6, 14, 29 and 44 seconds (2, 4, 8, then every 15).
      const at = [2_000, 6_000, 14_000, 29_000, 44_000];
      let now = 0;
      for (const [i, t] of at.entries()) {
        await wait(t - now - 1);
        expect(checks).toBe(base + i);
        await wait(1);
        await settle();
        expect(checks).toBe(base + 1 + i);
        now = t;
      }
      // The wording does not change.
      expect(screen.getByText(stillOpening(/Still opening Thesis library, the library that was open last time/))).toBeTruthy();
      // Once the screen goes, nothing more is asked.
      unmount();
      await wait(60_000);
      expect(checks).toBe(base + at.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("I1: a library chosen while the last one is still being opened stays; a late answer of the check is dropped", async () => {
    let phase: "reopening" | "late" = "reopening";
    let lateAsked = 0;
    let releaseLate!: () => void;
    const late = new Promise<void>((r) => (releaseLate = r));
    server.use(
      http.get(url("/libraries"), async () => {
        if (phase === "reopening") return HttpResponse.json({ ...LIBRARIES, reopening: { libraryId: "lib-1", name: "Thesis library" } });
        lateAsked++;
        await late; // the check in flight when the researcher chooses: it answers late (here: the old one not found)
        return HttpResponse.json({ ...LIBRARIES, notFound: { libraryId: "lib-1", name: "Thesis library" } });
      }),
      http.post(url("/libraries/open"), () => HttpResponse.json({ libraryId: "lib-2", name: "Grant 2025", mode: "read-write" })),
      ...libraryHandlers({ current: { libraryId: "lib-2", name: "Grant 2025", mode: "read-write" } }),
    );
    const user = userEvent.setup();
    render(<LibraryRoutes client={testClient()} />);
    await screen.findByText(stillOpening(/Still opening Thesis library/));
    const openB = await screen.findByRole("button", { name: "Open Grant 2025" });
    phase = "late";
    await waitFor(() => expect(lateAsked).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await user.click(openB);
    expect(await screen.findByRole("heading", { level: 1, name: "Grant 2025" })).toBeTruthy();
    releaseLate();
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.getByRole("heading", { level: 1, name: "Grant 2025" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: /Library not found/ })).toBeNull();
  });

  it("navigate() changes the path and notifies listeners", async () => {
    let seen = "";
    const on = () => (seen = window.location.pathname);
    window.addEventListener("popstate", on);
    navigate("/import/review");
    window.removeEventListener("popstate", on);
    await waitFor(() => expect(seen).toBe("/import/review"));
  });

  it("when the service reports the library closed, goes back to the chooser", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, current: { libraryId: "lib-1", name: "Thesis library", mode: "read-write" } })),
      ...libraryHandlers({ events: [{ type: "library.state", data: { open: false } }] }),
    );
    render(<LibraryRoutes client={testClient()} />);
    expect(await screen.findByRole("heading", { name: "Choose a library" })).toBeTruthy();
  });
});
