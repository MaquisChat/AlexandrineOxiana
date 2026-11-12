import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { App, ROUTES } from "./App";
import { navigate, PATHS } from "./navigation";
import { DEFAULT_APPEARANCE } from "./theme/appearance";
import { BASE, libraryHandlers, server, TOKEN, url, useMockService } from "./test/service";

useMockService();
afterEach(() => window.history.replaceState(null, "", "/"));

const service = { baseUrl: BASE, token: TOKEN };
const appearance = () => [
  http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
  http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
  http.get(url("/tools"), () => HttpResponse.json({ error: { code: "FORBIDDEN", message: "The tools are managed from the desktop app." } }, { status: 403 })),
];

function at(path: string) {
  window.history.replaceState(null, "", path);
}

describe("the app's one router (R118)", () => {
  it("has one route table covering the library, import, review queue and appearance paths", () => {
    const owners = (p: string) => ROUTES.filter((r) => r.matches(p)).length;
    for (const p of ["/", "/library", "/import", "/import/review", "/settings/appearance", "/governance", "/audit", "/fieldwork", "/move-library", "/missing-files"]) expect(owners(p)).toBe(1);
    expect(owners("/nowhere")).toBe(0);
  });

  it("shows the library at / with no Back to library link", async () => {
    server.use(...appearance(), ...libraryHandlers());
    render(<App service={service} />);
    expect(await screen.findByRole("navigation", { name: "Projects" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Back to library" })).toBeNull();
  });

  it("Appearance link opens the settings in place; Back to library returns without a reload", async () => {
    server.use(...appearance(), ...libraryHandlers());
    const user = userEvent.setup();
    render(<App service={service} />);
    await user.click(await screen.findByRole("link", { name: "Appearance" }));
    expect(window.location.pathname).toBe(PATHS.appearance);
    expect(window.location.hash).toBe("");
    expect(await screen.findByRole("heading", { name: /Appearance/ })).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "Your name as researcher" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Projects" })).toBeNull();
    const back = screen.getByRole("link", { name: "Back to library" });
    expect(back.getAttribute("href")).toBe("/");
    await user.click(back);
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByRole("navigation", { name: "Projects" })).toBeTruthy();
  });

  it("/import/review shows the review queue with a working Back to library link", async () => {
    server.use(...appearance(), ...libraryHandlers(), http.get(url("/projects/:id/imports"), () => HttpResponse.json({ batches: [] })));
    at(PATHS.reviewQueue);
    const user = userEvent.setup();
    render(<App service={service} />);
    expect(await screen.findByRole("combobox", { name: "Import" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Back to library" }));
    expect(await screen.findByRole("navigation", { name: "Projects" })).toBeTruthy();
  });

  it("the library's needs-review link reaches the review queue", async () => {
    server.use(...appearance(), ...libraryHandlers(), http.get(url("/projects/:id/imports"), () => HttpResponse.json({ batches: [] })));
    render(<App service={service} />);
    await screen.findByRole("navigation", { name: "Projects" });
    act(() => navigate(PATHS.reviewQueue));
    expect(await screen.findByRole("combobox", { name: "Import" })).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(await screen.findByRole("navigation", { name: "Projects" })).toBeTruthy();
  });

  it("the Import link in the library opens the wizard for the selected project", async () => {
    server.use(...appearance(), ...libraryHandlers());
    const user = userEvent.setup();
    render(<App service={service} />);
    const header = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
    await user.click(await within(header).findByRole("link", { name: "Import" }));
    expect(window.location.pathname).toBe(PATHS.importWizard);
    expect(new URLSearchParams(window.location.search).get("project")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeTruthy();
  });

  it("Governance and records opens the Task 36 screens for the library's project, with Back to library", async () => {
    server.use(...appearance(), ...libraryHandlers(), http.get(url("/projects/:id/governance"), () => HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] })));
    const user = userEvent.setup();
    render(<App service={service} />);
    const header = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
    await user.click(await within(header).findByRole("link", { name: "Governance and records" }));
    expect(window.location.pathname).toBe(PATHS.governance);
    expect(new URLSearchParams(window.location.search).get("project")).toBe("p1");
    expect(await screen.findByRole("navigation", { name: "Governance and library" })).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Back to library" }));
    expect(await screen.findByRole("navigation", { name: "Projects" })).toBeTruthy();
  });

  describe("the library honours the project in the address (41b2 I1)", () => {
    const TWO = {
      projects: [
        { id: "p1", name: "Dissertation", folder: "Dissertation", encrypted: false, unlocked: true, profiles: [] },
        { id: "p3", name: "Second", folder: "Second", encrypted: false, unlocked: true, profiles: [] },
        { id: "p2", name: "Clinic interviews", folder: "Clinic interviews", encrypted: true, unlocked: false, profiles: [] },
      ],
    };
    const handlers = () => [
      ...appearance(),
      http.get(url("/projects"), () => HttpResponse.json(TWO)),
      http.get(url("/projects/:id/governance"), () => HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/:id/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
      http.get(url("/projects/:id/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      ...libraryHandlers(),
    ];
    const selected = async () => {
      const nav = await screen.findByRole("navigation", { name: "Projects" });
      await waitFor(() => expect(nav.querySelector("[aria-current]")).not.toBeNull());
      return nav.querySelector("[aria-current]")!.textContent;
    };

    it("Governance → Back to library, and the browser's Back, return to the project that was selected", async () => {
      server.use(...handlers());
      const user = userEvent.setup();
      render(<App service={service} />);
      await user.click(await screen.findByRole("button", { name: /Second/ }));
      expect(new URLSearchParams(window.location.search).get("project")).toBe("p3");
      const header = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
      await user.click(await within(header).findByRole("link", { name: "Governance and records" }));
      expect(window.location.search).toBe("?project=p3");
      await screen.findByRole("navigation", { name: "Governance and library" });
      await user.click(screen.getByRole("link", { name: "Back to library" }));
      expect(await selected()).toMatch(/Second/);
      expect(window.location.pathname + window.location.search).toBe("/?project=p3");
      expect(screen.getByRole("region", { name: "Attach files to Second" })).toBeTruthy();
      // The browser's Back: to governance, then to the library entry.
      await act(async () => {
        window.history.back();
        await new Promise((r) => setTimeout(r, 50));
      });
      await screen.findByRole("navigation", { name: "Governance and library" });
      await act(async () => {
        window.history.back();
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(await selected()).toMatch(/Second/);
    });

    it("with no project in the address, selects the first and writes it into the address", async () => {
      server.use(...handlers());
      render(<App service={service} />);
      expect(await selected()).toMatch(/Dissertation/);
      await waitFor(() => expect(window.location.search).toBe("?project=p1"));
    });

    it("an unknown project id selects nothing and says so; no files can be dropped until a project is chosen", async () => {
      server.use(...handlers());
      at("/?project=nope");
      const user = userEvent.setup();
      render(<App service={service} />);
      expect((await screen.findByRole("alert")).textContent).toMatch(/project named in the address is not in this library/);
      expect(screen.getByRole("navigation", { name: "Projects" }).querySelector("[aria-current]")).toBeNull();
      expect(screen.queryByRole("region", { name: /Attach files/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: /Second/ }));
      expect(await screen.findByRole("region", { name: "Attach files to Second" })).toBeTruthy();
      expect(screen.queryByText(/not in this library/)).toBeNull();
      expect(window.location.search).toBe("?project=p3");
    });

    it("a locked project named in the address is selected and asks to be unlocked", async () => {
      server.use(...handlers());
      at("/library?project=p2");
      render(<App service={service} />);
      expect(await selected()).toMatch(/Clinic interviews/);
      expect(await screen.findByLabelText("Passphrase or recovery code")).toBeTruthy();
      expect(screen.queryByRole("region", { name: /Attach files/ })).toBeNull();
    });
  });

  it("an unknown path says so and offers Back to library", async () => {
    server.use(...appearance(), ...libraryHandlers());
    at("/nowhere");
    render(<App service={service} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" })).toBeTruthy();
  });

  it("a file dropped anywhere outside a drop zone does not navigate the app away", () => {
    server.use(...appearance(), ...libraryHandlers());
    render(<App service={service} />);
    expect(fireEvent.dragOver(document.body)).toBe(false);
    expect(fireEvent.drop(document.body)).toBe(false);
  });

  it("text dragged into a field still drops there; files dropped on a field are still stopped (41b1 M9)", () => {
    server.use(...appearance(), ...libraryHandlers());
    render(<App service={service} />);
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const text = { dataTransfer: { types: ["text/plain"], getData: () => "words" } };
    expect(fireEvent.dragOver(field, text)).toBe(true);
    expect(fireEvent.drop(field, text)).toBe(true);
    expect(fireEvent.drop(field, { dataTransfer: { types: ["Files"], files: [] } })).toBe(false);
    expect(fireEvent.drop(document.body, text)).toBe(false);
    field.remove();
  });
});
