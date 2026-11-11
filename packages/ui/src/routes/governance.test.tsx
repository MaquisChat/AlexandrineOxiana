import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../api/client";
import { BASE, TOKEN, server, url, useMsw } from "../test/msw-governance";
import { GovernanceRoutes, governanceRoutes } from "./governance";

useMsw();
afterEach(() => {
  window.location.hash = "";
});

describe("governance routes (R113)", () => {
  it("registers the five Task 36 screens", () => {
    expect(governanceRoutes.map((r) => r.path)).toEqual(["#/governance", "#/audit", "#/fieldwork", "#/move-library", "#/missing-files"]);
  });

  it("navigates between the screens for the chosen project", async () => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship" }, { id: "p2", name: "Clinic" }] })),
      http.get(url("/projects/p2/audit"), () => HttpResponse.json({ events: [], total: 0 })),
    );
    render(<GovernanceRoutes client={createClient(BASE, TOKEN)} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Project" }), "p2");
    await user.click(screen.getByRole("link", { name: "Audit log" }));
    expect(await screen.findByRole("heading", { name: "Audit log", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Audit log" }).getAttribute("aria-current")).toBe("page");
  });
});
