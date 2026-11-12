import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARIES, libraryHandlers, server, serviceError, testClient, url, useMockService } from "../test/service";
import { navigate } from "../navigation";
import { LibraryRoutes, isLibraryPath } from "./library";

useMockService();
// The open library asks for the tools catalogue (the first-use question, Task 48c); outside the desktop app it is refused.
beforeEach(() => server.use(http.get(url("/tools"), () => serviceError(403, "FORBIDDEN", "The tools are managed from the desktop app."))));
afterEach(() => window.history.replaceState(null, "", "/"));

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
