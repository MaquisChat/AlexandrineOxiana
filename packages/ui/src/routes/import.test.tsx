import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockService, server, B1, B7, P1 } from "../test/importService";
import { importRoute, IMPORT_PATHS } from "./import";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

describe("import routes", () => {
  it("declares the wizard and the review queue", () => {
    expect(IMPORT_PATHS).toEqual({ wizard: "/import", review: "/import/review" });
  });

  it("/import shows the wizard", async () => {
    const m = mockService();
    render(<>{importRoute({ pathname: "/import", search: "" }, m.client)}</>);
    expect(await screen.findByRole("heading", { name: "Bulk import" })).toBeTruthy();
  });

  it("/import/review shows the review queue of the batch named in the query", async () => {
    const m = mockService();
    render(<>{importRoute({ pathname: "/import/review", search: `?project=${P1}&batch=${B1}` }, m.client)}</>);
    expect(await screen.findByRole("heading", { name: "Review queue" })).toBeTruthy();
    expect(await screen.findByText(/Nothing is waiting for review/)).toBeTruthy();
    expect(m.bodies(`GET /imports/${B1}/review`)).toHaveLength(1);
  });

  it("/import/review without a batch lets the researcher pick one", async () => {
    const m = mockService({ batches: [{ batchId: B7, number: 7, kind: "folder", state: "finished", startedAt: "2026-11-10T09:00:00.000Z", counts: { created: 3, merged: 0, skipped: 0, failed: 0, needsReview: 2 } }] });
    render(<>{importRoute({ pathname: "/import/review", search: "" }, m.client)}</>);
    expect(await screen.findByRole("combobox", { name: "Project" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: /Import 7/ })).toBeTruthy();
  });

  it.each([
    ["?project=..&batch=" + "B1"],
    ["?project=" + "P1" + "&batch=.."],
    ["?project=p1&batch=b1"],
  ])("refuses ids that are not UUIDv7 (%s) without calling the service", async (search) => {
    const m = mockService();
    render(<>{importRoute({ pathname: "/import/review", search: search.replace("B1", B1).replace("P1", P1) }, m.client)}</>);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/not a valid/i));
    expect(m.calls.filter((c) => c.path.includes(".."))).toHaveLength(0);
    expect(m.calls.filter((c) => c.path.startsWith("/imports/"))).toHaveLength(0);
  });

  it("/import ignores a project id that is not valid", async () => {
    const m = mockService();
    render(<>{importRoute({ pathname: "/import", search: "?project=.." }, m.client)}</>);
    expect(await screen.findByRole("option", { name: "Thesis" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(m.calls.filter((c) => c.path.includes(".."))).toHaveLength(0);
  });

  it("other paths are not import routes", () => {
    const m = mockService();
    expect(importRoute({ pathname: "/library", search: "" }, m.client)).toBeNull();
  });
});

describe("useImportRoute", () => {
  it("follows in-app navigation without reloading", async () => {
    const { act } = await import("@testing-library/react");
    const { useImportRoute, navigate } = await import("./import");
    const m = mockService();
    window.history.replaceState(null, "", "/");
    function Host() {
      return useImportRoute(m.client) ?? <p>Not an import page</p>;
    }
    render(<Host />);
    expect(screen.getByText("Not an import page")).toBeTruthy();
    act(() => navigate(`/import/review?project=${P1}&batch=${B1}`));
    expect(await screen.findByRole("heading", { name: "Review queue" })).toBeTruthy();
    act(() => navigate("/"));
    expect(screen.getByText("Not an import page")).toBeTruthy();
  });
});
