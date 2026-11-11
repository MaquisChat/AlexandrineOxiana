import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { LIBRARIES, libraryHandlers, server, serviceError, testClient, url, useMockService } from "../test/service";
import { LibraryRoutes, isLibraryPath, navigate } from "./library";

useMockService();
afterEach(() => window.history.replaceState(null, "", "/"));

describe("library routes", () => {
  it("are / and /library", () => {
    expect(isLibraryPath("/")).toBe(true);
    expect(isLibraryPath("/library")).toBe(true);
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

  it("other screens (appearance, review queue) get a Back to library link", async () => {
    window.history.replaceState(null, "", "/settings/appearance");
    const user = userEvent.setup();
    render(<LibraryRoutes client={testClient()} />);
    const link = screen.getByRole("link", { name: "Back to library" });
    expect(link.getAttribute("href")).toBe("/");
    await user.click(link);
    expect(window.location.pathname).toBe("/");
  });

  it("a file dropped anywhere outside a drop zone does not navigate the app away", () => {
    server.use(...libraryHandlers());
    render(<LibraryRoutes client={testClient()} />);
    expect(fireEvent.dragOver(document.body)).toBe(false);
    expect(fireEvent.drop(document.body)).toBe(false);
  });
});
