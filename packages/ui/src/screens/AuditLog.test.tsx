import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { AuditLog } from "./AuditLog";

useMsw();

const PID = "0190f0f0-0000-7000-8000-000000000002";

const ev = (seq: number) => ({
  seq,
  at: `2026-11-0${(seq % 9) + 1}T10:00:00.000Z`,
  actor: "ana",
  device: "dev-A",
  action: seq % 2 ? "store" : "export",
  entity: { type: "source", id: `s${seq}` },
  decision: seq === 3 ? { result: "deny", reason: "Exports of identifiable data are not allowed" } : { result: "allow" },
  details: { op: seq % 2 ? "source.create" : "export.open" },
  prevHash: "x",
  hash: "y",
});

function serveAudit(total: number, pageSize = 2) {
  const queries: Array<Record<string, string>> = [];
  server.use(
    http.get(url(`/projects/${PID}/audit`), ({ request }) => {
      const q = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(q);
      const before = q.before ? Number(q.before) : total + 1;
      const events = [];
      for (let s = before - 1; s >= 1 && events.length < Number(q.limit ?? pageSize); s--) events.push(ev(s));
      return HttpResponse.json({ events, total });
    }),
  );
  return queries;
}

describe("Audit log", () => {
  it("names a new recovery code in plain words (Task 61)", async () => {
    server.use(
      http.get(url(`/projects/${PID}/audit`), () =>
        HttpResponse.json({
          events: [
            { ...ev(2), action: "key.recovery-activated", entity: { type: "project", id: PID }, details: { issueId: "i" } },
            { ...ev(1), action: "store", entity: { type: "project", id: PID }, details: { op: "project.recovery-code", txn: "t", issueId: "i" } },
          ],
          total: 2,
        }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} pageSize={2} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    expect(within(table).getByText("A new recovery code was issued")).toBeTruthy();
    expect(within(table).getByText(/put in place when the library opened/)).toBeTruthy();
  });

  it("shows a paged table of events, newest first, with older pages on request", async () => {
    const queries = serveAudit(5);
    render(<AuditLog api={makeApi()} projectId={PID} pageSize={2} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    const rows = () => within(table).getAllByRole("row").slice(1);
    expect(rows().map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["5", "4"]);
    expect(screen.getByText(/Events 5–4 of 5/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Older events" }));
    expect(await within(table).findByText("source.create", { selector: "td *, td" })).toBeTruthy();
    expect(queries.at(-1)).toEqual({ limit: "2", before: "4" });
    expect(rows().map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["3", "2"]);
    expect(within(rows()[0]!).getByText(/denied/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Newer events" }));
    expect(await within(table).findByText("5")).toBeTruthy();
  });

  it("Verify integrity: \"48,211 events — hash chain intact\"", async () => {
    serveAudit(0);
    server.use(http.get(url(`/projects/${PID}/audit/verify`), () => HttpResponse.json({ ok: true, events: 48211, anchored: true, alteredAt: [] })));
    render(<AuditLog api={makeApi()} projectId={PID} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Verify integrity" }));
    const region = await screen.findByRole("region", { name: "Integrity check" });
    expect(within(region).getByRole("status").textContent).toBe("48,211 events — hash chain intact");
    // No aria-label overriding what the status says (R117).
    expect(within(region).getByRole("status").getAttribute("aria-label")).toBeNull();
  });

  it("Verify integrity shows where the chain breaks", async () => {
    serveAudit(0);
    server.use(
      http.get(url(`/projects/${PID}/audit/verify`), () =>
        HttpResponse.json({ ok: false, events: 120, anchored: true, alteredAt: [], problem: { kind: "chain-broken", detail: "audit chain breaks at event 17 (hash-mismatch); the audit log changed outside the app" } }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Verify integrity" }));
    const out = await screen.findByRole("alert");
    expect(out.textContent).toMatch(/Hash chain broken at event 17 of 120/);
    expect(out.textContent).toMatch(/changed outside the app/);
  });

  it("Verify integrity says UNVERIFIED when this computer holds no anchor to compare with", async () => {
    serveAudit(0);
    server.use(http.get(url(`/projects/${PID}/audit/verify`), () => HttpResponse.json({ ok: true, events: 12, anchored: false, alteredAt: [] })));
    render(<AuditLog api={makeApi()} projectId={PID} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Verify integrity" }));
    const out = within(await screen.findByRole("region", { name: "Integrity check" })).getByRole("status");
    expect(out.textContent).toMatch(/^UNVERIFIED/);
    expect(out.textContent).toMatch(/12 events/);
    expect(out.textContent).toMatch(/no anchor/);
  });

  it("reports earlier alterations even when the chain verifies now", async () => {
    serveAudit(0);
    server.use(http.get(url(`/projects/${PID}/audit/verify`), () => HttpResponse.json({ ok: false, events: 30, anchored: true, alteredAt: ["2026-10-01T08:00:00.000Z"] })));
    render(<AuditLog api={makeApi()} projectId={PID} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Verify integrity" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/found altered on 2026-10-01/);
  });
});
