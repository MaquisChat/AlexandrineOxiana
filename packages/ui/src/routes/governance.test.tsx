import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../api/client";
import { useLocation } from "../navigation";
import { BASE, TOKEN, server, url, useMsw } from "../test/msw-governance";
import { GovernanceRoutes, governanceRoutes, isGovernancePath } from "./governance";

useMsw();
afterEach(() => window.history.replaceState(null, "", "/"));

function Host() {
  return <GovernanceRoutes client={createClient(BASE, TOKEN)} loc={useLocation()} />;
}

describe("governance routes (R113, R118)", () => {
  it("registers the five Task 36 screens on plain paths (no hash routing)", () => {
    expect(governanceRoutes.map((r) => r.path)).toEqual(["/governance", "/audit", "/fieldwork", "/move-library", "/missing-files"]);
    expect(isGovernancePath("/audit/")).toBe(true);
    expect(isGovernancePath("/import")).toBe(false);
  });

  it("navigates between the screens for the chosen project, with pushState and the project in the address", async () => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship" }, { id: "p2", name: "Clinic" }] })),
      http.get(url("/projects/p2/audit"), () => HttpResponse.json({ events: [], total: 0 })),
      http.get(url("/projects/p2/governance"), () => HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
    );
    window.history.replaceState(null, "", "/governance");
    render(<Host />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Project" }), "p2");
    expect(window.location.search).toBe("?project=p2");
    await user.click(screen.getByRole("link", { name: "Audit log" }));
    expect(window.location.pathname).toBe("/audit");
    expect(window.location.hash).toBe("");
    expect(await screen.findByRole("heading", { name: "Audit log", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("href")).toBe("/audit?project=p2");
  });

  it("an unknown project in the address selects none and says so, instead of showing another project's screen (41b2 M1)", async () => {
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship" }] })));
    window.history.replaceState(null, "", "/fieldwork?project=nope");
    render(<Host />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not in this library/);
    expect(screen.getByText("Choose a project first.")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("");
  });

  it.each([
    ["a locked project", { projects: [{ id: "p1", name: "Clinic", encrypted: true, unlocked: false }] }, { mode: "read-write" }, "This project is locked. Unlock it in the library to change its rules."],
    ["a read-only library", { projects: [{ id: "p1", name: "Clinic", encrypted: false, unlocked: true }] }, { mode: "read-only", readOnlyReason: "locked-by-other-device" }, "This library is open read-only here, so its rules cannot be changed."],
  ])("the Governance form of %s shows the rules, capture methods included, but cannot change them, and says why (D11)", async (_what, projects, current, why) => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json(projects)),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", ...current } })),
      http.get(url("/projects/p1/governance"), () => HttpResponse.json({ yaml: "captureMethods: [manual_upload, browser_capture]\n", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<Host />);
    expect(await screen.findByText(why)).toBeTruthy();
    const capture = await screen.findByRole("region", { name: "Capture methods" });
    const browser = within(capture).getByRole("checkbox", { name: /Browser capture/ }) as HTMLInputElement;
    expect(browser.checked).toBe(true);
    expect(browser.disabled).toBe(true);
  });

  it("a writable library and an unlocked project leave the form editable", async () => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted: true, unlocked: true }] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
      http.get(url("/projects/p1/governance"), () => HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<Host />);
    const capture = await screen.findByRole("region", { name: "Capture methods" });
    await waitFor(() => expect((within(capture).getByRole("checkbox", { name: /Browser capture/ }) as HTMLInputElement).disabled).toBe(false));
    expect(screen.queryByText(/cannot be changed|Unlock it in the library/)).toBeNull();
  });

  it("a failed project list is shown (41b2 M2)", async () => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The service is not answering." } }, { status: 503 })),
      http.get(url("/libraries"), () => HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The service is not answering." } }, { status: 503 })),
    );
    window.history.replaceState(null, "", "/governance");
    render(<Host />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/projects could not be read|could not be reached/);
  });
});

describe("R362 h: the Fieldwork screen is told whether its project is encrypted", () => {
  const SCOPE_NOTE = "In an encrypted project this text can be read without the passphrase. Do not put a person's name in it.";
  for (const encrypted of [true, false]) {
    it(`${encrypted ? "encrypted: the scope field carries the note" : "not encrypted: nothing"}`, async () => {
      server.use(
        http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship", encrypted, unlocked: true }] })),
        http.get(url("/projects/p1/participants"), () => HttpResponse.json({ participants: [], complete: true })),
        http.get(url("/projects/p1/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
        http.get(url("/projects/p1/consents"), () => HttpResponse.json({ consents: [], complete: true })),
      );
      window.history.replaceState(null, "", "/fieldwork?project=p1");
      render(<Host />);
      const scope = await screen.findByRole("textbox", { name: "Scope" });
      if (encrypted) await waitFor(() => expect(scope.getAttribute("aria-describedby")).toBeTruthy());
      await waitFor(() => expect(screen.queryAllByText(SCOPE_NOTE)).toHaveLength(encrypted ? 1 : 0));
    });
  }
});
