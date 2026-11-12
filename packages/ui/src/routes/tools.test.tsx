/**
 * The optional tools in the app shell (Task 48b): the route-table line, the settings entry in the
 * library's header, and the first-use dialogue mounted by the app.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { App, ROUTES } from "../App";
import { PATHS } from "../navigation";
import { catalogue, toolsService } from "../test/msw-tools";
import { BASE, libraryHandlers, server, TOKEN, url, useMockService } from "../test/service";
import { DEFAULT_APPEARANCE } from "../theme/appearance";

useMockService();
afterEach(() => {
  window.history.replaceState(null, "", "/");
  try {
    window.localStorage.clear();
  } catch {
    // no storage
  }
});

const service = { baseUrl: BASE, token: TOKEN };
const appearance = () => [
  http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
  http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
];

/** Every tool installed: the first-use dialogue stays closed. */
const allInstalled = () => catalogue().map((t) => ({ ...t, installed: true, usable: true }));

describe("the optional tools in the app", () => {
  it("has one route for the tools screen", () => {
    expect(ROUTES.filter((r) => r.matches(PATHS.tools)).length).toBe(1);
  });

  it("shows the tools screen at its address, with Back to library", async () => {
    server.use(...appearance(), ...toolsService({ base: BASE, tools: allInstalled() }).handlers);
    window.history.replaceState(null, "", `${PATHS.tools}?tool=ffmpeg`);
    render(<App service={service} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Optional tools" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Video tools (ffmpeg)"));
  });

  it("is reachable from the settings links in the library's header", async () => {
    server.use(...appearance(), ...libraryHandlers(), ...toolsService({ base: BASE, tools: allInstalled() }).handlers);
    const user = userEvent.setup();
    render(<App service={service} />);
    await user.click(await screen.findByRole("link", { name: "Optional tools" }));
    expect(window.location.pathname).toBe(PATHS.tools);
    expect(await screen.findByRole("heading", { level: 1, name: "Optional tools" })).toBeTruthy();
  });

  it("asks on first use, over the library, and Not now is remembered across a restart of the app", async () => {
    const svc = toolsService({ base: BASE });
    server.use(...appearance(), ...libraryHandlers(), ...svc.handlers);
    const user = userEvent.setup();
    const first = render(<App service={service} />);
    expect(await screen.findByRole("dialog", { name: "Optional tools" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    first.unmount();
    const asked = svc.state.requests.filter((r) => r === "GET /tools").length;
    render(<App service={service} />);
    await screen.findByRole("navigation", { name: "Projects" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(svc.state.requests.filter((r) => r === "GET /tools").length).toBe(asked);
  });
});
