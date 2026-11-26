import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
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

// Every test: a project with no marks unless it says otherwise (Task 50).
beforeEach(() => {
  server.use(http.get(url(`/projects/${PID}/attention`), () => HttpResponse.json({ marks: [] })));
});

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

  it("a refused new recovery code is not called issued (M-d)", async () => {
    server.use(
      http.get(url(`/projects/${PID}/audit`), () =>
        HttpResponse.json({
          events: [{ ...ev(1), action: "store", entity: { type: "project", id: PID }, decision: { result: "deny", reason: "Policy could not be evaluated" }, details: { op: "project.recovery-code" } }],
          total: 1,
        }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} pageSize={2} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    expect(within(table).queryByText("A new recovery code was issued")).toBeNull();
    expect(within(table).getByText("A new recovery code was asked for")).toBeTruthy();
    expect(within(table).getByText(/denied/i)).toBeTruthy();
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

describe("Task 50 (R154 b, d): late entries, attention marks, the library's audit log", () => {
  const RTL = "\u202Eevil\u202C دراسة";

  it("a late entry says when it happened, that it was recorded late, by which computer, and if interrupted", async () => {
    server.use(
      http.get(url(`/projects/${PID}/audit`), () =>
        HttpResponse.json({
          events: [{ ...ev(1), at: "2026-11-09T10:00:00.000Z", action: "library.relink", details: { files: 1, recordedLate: { occurredAt: "2026-11-02T08:00:00.000Z", interrupted: true, by: "dev-B", reason: "EIO" } } }],
          total: 1,
        }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    const cell = within(table).getAllByRole("row")[1]!;
    expect(cell.textContent).toMatch(/Happened 2026-11-02T08:00:00.000Z/);
    expect(cell.textContent).toMatch(/recorded late on 2026-11-09T10:00:00.000Z/);
    expect(cell.textContent).toMatch(/by dev-B/);
    expect(cell.textContent).toMatch(/may not have finished/);
  });

  it("text from the log goes through UserText (dir=auto)", async () => {
    server.use(
      http.get(url(`/projects/${PID}/audit`), () =>
        HttpResponse.json({ events: [{ ...ev(1), actor: RTL, action: RTL, decision: { result: "deny", reason: RTL }, details: { op: RTL } }], total: 1 }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    const spans = within(table).getAllByText((_t, el) => el?.getAttribute("dir") === "auto" && (el.textContent ?? "").includes("evil"));
    // actor, action, operation and the refusal's reason
    expect(spans.length).toBeGreaterThanOrEqual(4);
  });

  const marks = [
    { id: "m1", kind: "audit-unrecorded", action: "library.relink", occurredAt: "2026-11-02T08:00:00.000Z", actor: "ana", reason: "EIO", interrupted: true, canSetAside: true },
    { id: "m2", kind: "permissions-not-set", action: "library.relink", occurredAt: "2026-11-03T08:00:00.000Z", actor: "ana", canSetAside: true },
    { id: "u-0123456789abcdef0123456789abcdef", kind: "unrecognised", name: "abc 2.json", canSetAside: true },
    { id: "m4", kind: "waiting", action: "library.reconnect", occurredAt: "2026-11-04T08:00:00.000Z", actor: "ana", canSetAside: false },
  ];

  it("lists the project's attention marks in plain words; a mark waiting for this computer cannot be set aside here", async () => {
    serveAudit(0);
    server.use(http.get(url(`/projects/${PID}/attention`), () => HttpResponse.json({ marks })));
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const region = await screen.findByRole("region", { name: "Needs attention" });
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toMatch(/not recorded in the audit log/);
    expect(items[0]!.textContent).toMatch(/library\.relink/);
    expect(items[1]!.textContent).toMatch(/could not be made private/);
    expect(items[2]!.textContent).toMatch(/An unrecognised item in the attention folder: abc 2\.json/);
    expect(within(items[2]!).getByText("abc 2.json").getAttribute("dir")).toBe("auto");
    expect(items[3]!.textContent).toMatch(/kept on this computer/);
    expect(within(items[3]!).queryByRole("button")).toBeNull();
    expect(within(region).getAllByRole("button", { name: /Set aside/ })).toHaveLength(3);
  });

  it("Set aside: focus moves into the dialog and is trapped; Escape restores it; a reason is required; after it, focus is on the list's heading", async () => {
    serveAudit(0);
    let list = marks.slice(0, 1);
    const posted: unknown[] = [];
    server.use(
      http.get(url(`/projects/${PID}/attention`), () => HttpResponse.json({ marks: list })),
      http.post(url(`/projects/${PID}/attention/m1/set-aside`), async ({ request }) => {
        posted.push(await request.json());
        list = [];
        return HttpResponse.json({ recordedIn: "project" });
      }),
    );
    const user = userEvent.setup();
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const button = await screen.findByRole("button", { name: /Set aside/ });
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Set this aside" });
    const reason = within(dialog).getByRole("textbox", { name: /Reason/ });
    expect(document.activeElement).toBe(reason);
    const confirm = within(dialog).getByRole("button", { name: "Set aside" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.tab();
    expect(document.activeElement).toBe(reason);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);

    await user.click(button);
    const d2 = await screen.findByRole("dialog", { name: "Set this aside" });
    await user.type(within(d2).getByRole("textbox", { name: /Reason/ }), "Recorded on paper");
    await user.click(within(d2).getByRole("button", { name: "Set aside" }));
    await screen.findByText(/Nothing needs attention/);
    expect(posted).toEqual([{ reason: "Recorded on paper" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Needs attention" }));
  });

  it("a refused set-aside is shown in plain words and keeps the mark", async () => {
    serveAudit(0);
    server.use(
      http.get(url(`/projects/${PID}/attention`), () => HttpResponse.json({ marks: marks.slice(0, 1) })),
      http.post(url(`/projects/${PID}/attention/m1/set-aside`), () => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "Policy could not be evaluated" } }, { status: 403 })),
    );
    const user = userEvent.setup();
    render(<AuditLog api={makeApi()} projectId={PID} />);
    await user.click(await screen.findByRole("button", { name: /Set aside/ }));
    const d = await screen.findByRole("dialog", { name: "Set this aside" });
    await user.type(within(d).getByRole("textbox", { name: /Reason/ }), "x");
    await user.click(within(d).getByRole("button", { name: "Set aside" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Policy could not be evaluated/);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows the library's audit log: refused creations by name, set-asides with their mark and reason, and its integrity check", async () => {
    serveAudit(0);
    server.use(
      http.get(url("/libraries/audit"), () =>
        HttpResponse.json({
          events: [
            { seq: 2, at: "2026-11-09T10:00:00.000Z", actor: "ana", device: "dev-A", action: "store", decision: { result: "deny", reason: "Governance requires encryption at rest" }, details: { op: "project.create", name: RTL, encrypted: false } },
            { seq: 1, at: "2026-11-08T10:00:00.000Z", actor: "ana", device: "dev-A", action: "set-aside", projectId: PID, decision: { result: "allow" }, details: { op: "attention.set-aside", reason: "Recorded on paper", mark: { kind: "audit-unrecorded", record: { action: "library.relink", occurredAt: "2026-11-02T08:00:00.000Z" } } } },
            { seq: 0, at: "2026-11-07T10:00:00.000Z", actor: "ana", device: "dev-A", action: "set-aside", projectId: PID, decision: { result: "deny", reason: "A reason is required to set this aside" }, details: { op: "attention.set-aside", reason: "", mark: { kind: "unrecognised", name: "abc 2.json", entry: "file" } } },
          ],
          total: 3,
        }),
      ),
      http.get(url("/libraries/audit/verify"), () => HttpResponse.json({ ok: true, events: 2, anchored: true, alteredAt: [] })),
    );
    const user = userEvent.setup();
    render(<AuditLog api={makeApi()} projectId={PID} />);
    await user.click(await screen.findByRole("button", { name: "Show the library's audit log" }));
    const table = await screen.findByRole("table", { name: "Library audit events" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toMatch(/A project named .*evil.* was asked for/);
    expect(rows[0]!.textContent).toMatch(/Denied: Governance requires encryption at rest/);
    expect(rows[0]!.textContent).toMatch(/Further identical refusals that day are not listed/);
    expect(within(rows[0]!).getAllByText((_t, el) => el?.getAttribute("dir") === "auto" && (el.textContent ?? "").includes("evil")).length).toBeGreaterThanOrEqual(1);
    expect(rows[1]!.textContent).toMatch(/A mark was set aside/);
    expect(rows[1]!.textContent).toMatch(/not recorded in the audit log \(library\.relink, 2026-11-02T08:00:00\.000Z\)/);
    expect(rows[1]!.textContent).toMatch(/Reason: Recorded on paper/);
    expect(rows[2]!.textContent).toMatch(/Setting a mark aside was asked for/);
    expect(rows[2]!.textContent).not.toMatch(/A mark was set aside/);
    expect(rows[2]!.textContent).toMatch(/unrecognised item in the attention folder: abc 2\.json/);
    await user.click(screen.getByRole("button", { name: "Verify the library's audit log" }));
    expect((await screen.findByText(/2 events — hash chain intact/)).textContent).toBeTruthy();
  });
});

describe("N3, N8: set-asides in the project's log; stale answers and double clicks", () => {
  it("N3: a set-aside recorded in the project's log shows which mark, the reason, who and when", async () => {
    server.use(
      http.get(url(`/projects/${PID}/audit`), () =>
        HttpResponse.json({
          events: [
            {
              ...ev(5),
              at: "2026-11-09T10:00:00.000Z",
              actor: "ana",
              action: "set-aside",
              entity: { type: "project", id: PID },
              decision: { result: "allow" },
              details: { op: "attention.set-aside", reason: "Recorded on paper", mark: { kind: "permissions-not-set", record: { action: "library.relink", occurredAt: "2026-11-03T08:00:00.000Z" } } },
            },
          ],
          total: 1,
        }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    const row = within(table).getAllByRole("row")[1]!;
    expect(row.textContent).toMatch(/2026-11-09T10:00:00.000Z/);
    expect(row.textContent).toMatch(/ana/);
    expect(row.textContent).toMatch(/A mark was set aside/);
    expect(row.textContent).toMatch(/could not be made private \(library\.relink, 2026-11-03T08:00:00\.000Z\)/);
    expect(row.textContent).toMatch(/Reason: Recorded on paper/);
  });

  it("R362 b: a sealed reason is shown as the service reads it: the text while unlocked, a sentence while locked or when it cannot be shown; never the SHA-256", async () => {
    const sha = "a".repeat(64);
    const sealed = { reasonGiven: true, reasonSha256: sha };
    server.use(
      http.get(url(`/projects/${PID}/audit`), () =>
        HttpResponse.json({
          events: [
            { ...ev(4), action: "store", entity: { type: "project", id: PID }, details: { op: "project.governance", ...sealed }, reasonShown: { state: "text", text: "IRB amendment 7" } },
            { ...ev(3), action: "set-aside", entity: { type: "project", id: PID }, decision: { result: "allow" }, details: { op: "attention.set-aside", ...sealed, mark: { kind: "unrecognised", name: "x.json", entry: "file" } }, reasonShown: { state: "locked", message: "A reason was given. It can be read when the project is unlocked." } },
            { ...ev(2), action: "store", entity: { type: "consent", id: "c" }, details: { op: "consent.document-detach", ...sealed }, reasonShown: { state: "mismatch", message: "A reason was given, but the text kept for it does not match what the audit log recorded, so it is not shown." } },
            { ...ev(1), action: "store", entity: { type: "consent", id: "c" }, details: { op: "consent.document-detach", reason: "wrong form" } },
          ],
          total: 4,
        }),
      ),
    );
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const table = await screen.findByRole("table", { name: "Audit events" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toMatch(/Reason: IRB amendment 7/);
    expect(rows[1]!.textContent).toMatch(/A mark was set aside/);
    expect(rows[1]!.textContent).toMatch(/Reason: A reason was given\. It can be read when the project is unlocked\./);
    expect(rows[2]!.textContent).toMatch(/does not match what the audit log recorded/);
    // A reason audited as typed (a project that is not encrypted) is shown as before.
    expect(rows[3]!.textContent).toMatch(/Reason: wrong form/);
    expect(table.textContent).not.toContain(sha);
  });

  it("N8: the library's verify button sends one request on a double click", async () => {
    serveAudit(0);
    let calls = 0;
    server.use(
      http.get(url("/libraries/audit/verify"), async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return HttpResponse.json({ ok: true, events: 1, anchored: true, alteredAt: [] });
      }),
    );
    const user = userEvent.setup();
    render(<AuditLog api={makeApi()} projectId={PID} />);
    const b = await screen.findByRole("button", { name: "Verify the library's audit log" });
    await user.dblClick(b);
    await screen.findByText(/1 event — hash chain intact/);
    expect(calls).toBe(1);
  });

  it("N8: a later successful load clears an earlier error in Needs attention", async () => {
    serveAudit(0);
    let fail = true;
    server.use(
      http.get(url(`/projects/${PID}/attention`), () =>
        fail ? HttpResponse.json({ error: { code: "INTERNAL", message: "Could not read" } }, { status: 500 }) : HttpResponse.json({ marks: [] }),
      ),
    );
    const { rerender } = render(<AuditLog api={makeApi()} projectId={PID} />);
    const region = await screen.findByRole("region", { name: "Needs attention" });
    await within(region).findByRole("alert");
    fail = false;
    rerender(<AuditLog api={makeApi()} projectId={PID} />);
    await within(region).findByText(/Nothing needs attention/);
    expect(within(region).queryByRole("alert")).toBeNull();
  });

  it("N8: an answer for an earlier project is dropped", async () => {
    const P2 = "0190f0f0-0000-7000-8000-000000000003";
    serveAudit(0);
    server.use(
      http.get(url(`/projects/${P2}/audit`), () => HttpResponse.json({ events: [], total: 0 })),
      http.get(url(`/projects/${PID}/attention`), async () => {
        await new Promise((r) => setTimeout(r, 80));
        return HttpResponse.json({ marks: [{ id: "m1", kind: "audit-unrecorded", action: "library.relink", occurredAt: "2026-11-02T08:00:00.000Z", canSetAside: true }] });
      }),
      http.get(url(`/projects/${P2}/attention`), () => HttpResponse.json({ marks: [] })),
    );
    const api = makeApi();
    const { rerender } = render(<AuditLog api={api} projectId={PID} />);
    rerender(<AuditLog api={api} projectId={P2} />);
    await screen.findByText(/Nothing needs attention/);
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryByText(/library\.relink/)).toBeNull();
    expect(screen.getByText(/Nothing needs attention/)).toBeTruthy();
  });
});

describe("FR-762: under strict mode (mounted, cleaned up, mounted again) the screen still shows what it reads", () => {
  it("Needs attention shows its list", async () => {
    serveAudit(0);
    render(
      <StrictMode>
        <AuditLog api={makeApi()} projectId={PID} />
      </StrictMode>,
    );
    const region = await screen.findByRole("region", { name: "Needs attention" });
    expect(await within(region).findByText(/Nothing needs attention/)).toBeTruthy();
  });

  it("the library's audit log and its check are shown", async () => {
    serveAudit(0);
    server.use(
      http.get(url("/libraries/audit"), () =>
        HttpResponse.json({ events: [{ seq: 1, at: "2026-11-09T10:00:00.000Z", actor: "ana", device: "dev-A", action: "store", decision: { result: "deny", reason: "Governance requires encryption at rest" }, details: { op: "project.create", name: "Field diary", encrypted: false } }], total: 1 }),
      ),
      http.get(url("/libraries/audit/verify"), () => HttpResponse.json({ ok: true, events: 1, anchored: true, alteredAt: [] })),
    );
    const user = userEvent.setup();
    render(
      <StrictMode>
        <AuditLog api={makeApi()} projectId={PID} />
      </StrictMode>,
    );
    await user.click(await screen.findByRole("button", { name: "Show the library's audit log" }));
    expect(await screen.findByRole("table", { name: "Library audit events" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Verify the library's audit log" }));
    expect(await screen.findByText(/1 events? — hash chain intact/)).toBeTruthy();
  });
});
