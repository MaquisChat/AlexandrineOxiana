import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "../navigation";
import type { ApiClient } from "../api/client";
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

  it("/import naming a project and an import opens that import's report (D1)", async () => {
    const m = mockService({ batches: [{ batchId: B1, number: 4, kind: "folder", state: "finished", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 3, merged: 0, skipped: 0, failed: 0, needsReview: 1 } }] });
    render(<>{importRoute({ pathname: "/import", search: `?project=${P1}&batch=${B1}` }, m.client)}</>);
    expect(await screen.findByRole("heading", { name: "Report and undo" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Undo import" })).toBeTruthy();
  });

  it("/import ignores an import id that is not valid, without calling the service with it", async () => {
    const m = mockService();
    render(<>{importRoute({ pathname: "/import", search: `?project=${P1}&batch=..` }, m.client)}</>);
    expect(await screen.findByRole("option", { name: "Thesis" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("heading", { name: "Report and undo" })).toBeNull();
    expect(m.calls.filter((c) => c.path.includes(".."))).toHaveLength(0);
  });

  it("/import/review links back to the report of the import being reviewed (D1)", async () => {
    const m = mockService();
    render(<>{importRoute({ pathname: "/import/review", search: `?project=${P1}&batch=${B1}` }, m.client)}</>);
    const link = await screen.findByRole("link", { name: "Back to the import's report and undo" });
    expect(link.getAttribute("href")).toBe(`/import?project=${P1}&batch=${B1}`);
  });

  it("/import/review's picker links to the chosen import's report (D1)", async () => {
    const m = mockService({ batches: [{ batchId: B7, number: 7, kind: "folder", state: "finished", startedAt: "2026-11-10T09:00:00.000Z", counts: { created: 3, merged: 0, skipped: 0, failed: 0, needsReview: 0 } }] });
    render(<>{importRoute({ pathname: "/import/review", search: "" }, m.client)}</>);
    await screen.findByRole("option", { name: /Import 7/ });
    // Nothing waits in import 7, so it is not chosen for review; once chosen, its report is linked.
    const pick = screen.getByRole("combobox", { name: "Import" }) as HTMLSelectElement;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(pick, { target: { value: B7 } });
    const link = await screen.findByRole("link", { name: "Back to the import's report and undo" });
    expect(link.getAttribute("href")).toBe(`/import?project=${P1}&batch=${B7}`);
  });

  it("Start import, through the route as App renders it: the address names the import, and the wizard opened on it shows the run (D1; a deliberate remount, M1)", async () => {
    window.history.replaceState(null, "", `/import?project=${P1}`);
    const m = mockService({ batches: [{ batchId: B1, number: 4, kind: "folder", state: "running", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 0, merged: 0, skipped: 0, failed: 0, needsReview: 0 } }] });
    function Routed({ client }: { client: ApiClient }) {
      return <>{importRoute(useLocation(), client)}</>;
    }
    const user = userEvent.setup();
    render(<Routed client={m.client} />);
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    await user.type(screen.getByRole("textbox", { name: "Folder path" }), "/data/papers");
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { name: "Options" });
    await user.click(screen.getByRole("button", { name: "Start import" }));
    const run = await screen.findByRole("heading", { name: "Run" });
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(document.activeElement).toBe(run)); // focus is placed on arrival (R145, M2)
    expect(new URLSearchParams(window.location.search).get("batch")).toBe(B1);
    expect(m.bodies(`POST /projects/${P1}/import`)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("other paths are not import routes", () => {
    const m = mockService();
    expect(importRoute({ pathname: "/library", search: "" }, m.client)).toBeNull();
  });
});
