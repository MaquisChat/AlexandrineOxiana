/**
 * The optional tools in the app shell (Task 48b): the route-table line, the settings entry in the
 * library's header, and the first-use question's banner on the open library (Task 48c, R163, R164).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { App, ROUTES } from "../App";
import { PATHS } from "../navigation";
import { FIRST_USE_QUESTION } from "../components/FirstUseTools";
import { ToolsLink } from "../components/MissingToolNotice";
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

  it("never asks over the library chooser: typing a folder path is not interrupted (D9)", async () => {
    const svc = toolsService({ base: BASE });
    // No library open: the chooser (the first matching handler answers).
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: null })), ...appearance(), ...libraryHandlers(), ...svc.handlers);
    const user = userEvent.setup();
    render(<App service={service} />);
    await screen.findByRole("heading", { level: 1, name: "Choose a library" });
    const field = screen.getByRole("textbox", { name: "Library folder" });
    await user.click(field);
    await user.type(field, "/home/ana/Fieldwork library");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);
    expect((field as HTMLInputElement).value).toBe("/home/ana/Fieldwork library");
    expect(screen.queryByText(FIRST_USE_QUESTION)).toBeNull();
    // The chooser does not even read the catalogue: the question belongs to the open library.
    expect(svc.state.requests).not.toContain("GET /tools");
  });

  it("asks on the open library with a banner, never a dialogue by itself; Not now is remembered across a restart of the app", async () => {
    const svc = toolsService({ base: BASE });
    server.use(...appearance(), ...libraryHandlers(), ...svc.handlers);
    const user = userEvent.setup();
    const first = render(<App service={service} />);
    expect(await screen.findByText(FIRST_USE_QUESTION)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(FIRST_USE_QUESTION)).toBeNull();
    first.unmount();
    const asked = svc.state.requests.filter((r) => r === "GET /tools").length;
    render(<App service={service} />);
    await screen.findByRole("navigation", { name: "Projects" });
    expect(screen.queryByText(FIRST_USE_QUESTION)).toBeNull();
    expect(svc.state.requests.filter((r) => r === "GET /tools").length).toBe(asked); // not asked again
  });

  it("is not on a locked project's unlock screen, and is on the unlocked project's library", async () => {
    const svc = toolsService({ base: BASE });
    server.use(...appearance(), ...libraryHandlers(), ...svc.handlers);
    window.history.replaceState(null, "", "/?project=p2");
    const user = userEvent.setup();
    render(<App service={service} />);
    await screen.findByLabelText("Passphrase or recovery code");
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    expect(screen.queryByText(FIRST_USE_QUESTION)).toBeNull();
    await user.click(within(screen.getByRole("navigation", { name: "Projects" })).getByRole("button", { name: /^Dissertation/ }));
    expect(await screen.findByText(FIRST_USE_QUESTION)).toBeTruthy();
  });

  /** The library with the banner, then `go` reaches the Optional tools screen, then back to the library: no banner. */
  async function reachToolsThen(go: (user: ReturnType<typeof userEvent.setup>) => Promise<void>, withNoticeLink = false) {
    const svc = toolsService({ base: BASE });
    server.use(...appearance(), ...libraryHandlers(), ...svc.handlers);
    const user = userEvent.setup();
    render(
      <>
        {withNoticeLink ? <ToolsLink tool="ffmpeg" /> : null}
        <App service={service} />
      </>,
    );
    await screen.findByText(FIRST_USE_QUESTION);
    await go(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Optional tools" })).toBeTruthy();
    expect(window.location.pathname).toBe(PATHS.tools);
    await user.click(screen.getByRole("link", { name: "Back to library" }));
    await screen.findByRole("navigation", { name: "Projects" });
    expect(screen.queryByText(FIRST_USE_QUESTION)).toBeNull();
    expect(window.localStorage.getItem("ao.firstUseTools")).not.toBeNull();
    return svc;
  }

  it("reaching the Optional tools screen by the header's link counts as an answer (R163)", async () => {
    await reachToolsThen(async (user) => user.click(screen.getByRole("link", { name: "Optional tools" })));
    expect(window.localStorage.getItem("ao.firstUseTools")).toBe("seen");
  });

  it("reaching the Optional tools screen by a missing-tool notice's link counts as an answer (R163)", async () => {
    await reachToolsThen(async (user) => user.click(screen.getByRole("link", { name: "Install it from the Optional tools screen" })), true);
    expect(window.localStorage.getItem("ao.firstUseTools")).toBe("seen");
  });

  it("reaching the Optional tools screen from the banner (Choose tools…, then a download) is an answer", async () => {
    const svc = await reachToolsThen(async (user) => {
      await user.click(screen.getByRole("button", { name: "Choose tools…" }));
      await user.click(await screen.findByRole("checkbox", { name: /save picture posts/i }));
      await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    });
    expect(window.localStorage.getItem("ao.firstUseTools")).toBe("chosen");
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual(["POST /tools/image-downloader/install"]);
  });
});
