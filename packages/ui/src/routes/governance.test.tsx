import { render, screen } from "@testing-library/react";
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
});
