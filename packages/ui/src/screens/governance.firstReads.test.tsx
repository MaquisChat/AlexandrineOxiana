/**
 * FR-756 (R584, R586, R597): the governance screens' first reads, given up after the time limit when they never settle
 * (neither answered nor failed): the screen's own alert says "The library service did not answer in time." with
 * "Try again", which reads again (the loading words meanwhile) and focus is not lost; a read that FAILS shows what it
 * showed before. The limit is passed small (`firstReadMs`), as FR-750's screens' tests do.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../api/client";
import { GovernanceRoutes } from "../routes/governance";
import { useLocation } from "../navigation";
import { BASE, TOKEN, makeApi, server, url, useMsw } from "../test/msw-governance";
import { hang } from "../test/service";
import { AuditLog } from "./AuditLog";
import { Fieldwork } from "./Fieldwork";
import { GovernanceSettings } from "./GovernanceSettings";

useMsw();
afterEach(() => window.history.replaceState(null, "", "/"));

const PID = "0190f0f0-0000-7000-8000-000000000001";
const P = (path: string) => url(`/projects/${PID}${path}`);
const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const LIMIT = 300;
const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

/** A GET that hangs (never settles) until `answer` is set; then answers with `body`. Counts its requests. */
function held(path: string, body: unknown) {
  const h = { answer: false, count: 0 };
  const gate = hang();
  server.use(
    http.get(path, async () => {
      h.count++;
      if (!h.answer) await gate;
      return HttpResponse.json(body as never);
    }),
  );
  return h;
}

describe("FR-756: Governance (the project's rules)", () => {
  const side = () =>
    server.use(
      http.get(P("/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(P("/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );

  it("a read of the rules that never settles is given up at the limit: the alert and “Try again”; pressed, it reads again, the loading words meanwhile, and focus is not lost", async () => {
    side();
    const h = held(P("/governance"), { yaml: "profiles: []\n", sha256: "a".repeat(64), violations: [] });
    render(<GovernanceSettings api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    expect(screen.getByText("Loading the project's rules…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Loading the project's rules…")).toBeNull();
    // A second hang: the loading words while it is out, then the alert again.
    await userEvent.setup().click(tryAgain()!);
    expect(screen.getByText("Loading the project's rules…")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Governance" }));
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    h.answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("button", { name: "Save changes" });
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(h.count).toBe(3);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Governance" }));
  });

  it("a read of the rules that FAILS says what it said before, now with “Try again”", async () => {
    side();
    let fail = true;
    server.use(http.get(P("/governance"), () => (fail ? HttpResponse.error() : HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] }))));
    render(<GovernanceSettings api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    fail = false;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("button", { name: "Save changes" });
  });

  it("a read of the rules refused with an answer says its sentence as before, with no “Try again”", async () => {
    server.use(http.get(P("/governance"), () => HttpResponse.json({ error: { code: "INTERNAL", message: "The rules could not be read." } }, { status: 500 })));
    render(<GovernanceSettings api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    await screen.findByText("The rules could not be read.");
    expect(tryAgain()).toBeNull();
  });
});

describe("FR-756: the audit log", () => {
  const PAGE = { events: [{ seq: 1, at: "2026-10-01T08:00:00.000Z", actor: "Ana", action: "source.add", decision: { result: "allow" } }], total: 1 };

  it("a read of the log that never settles is given up at the limit: the alert and “Try again”; pressed, the log is shown and focus is not lost", async () => {
    server.use(http.get(P("/attention"), () => HttpResponse.json({ marks: [] })));
    const h = held(P("/audit"), PAGE);
    render(<AuditLog api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByRole("table", { name: "Audit events" })).toBeNull();
    h.answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("table", { name: "Audit events" });
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(h.count).toBe(2);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Audit log" }));
  });

  it("a read of the log that FAILS says what it said before, now with “Try again”", async () => {
    server.use(
      http.get(P("/attention"), () => HttpResponse.json({ marks: [] })),
      http.get(P("/audit"), () => HttpResponse.error()),
    );
    render(<AuditLog api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
  });
});

describe("FR-756: fieldwork", () => {
  it("a read of the records that never settles is given up at the limit: the alert and “Try again”; pressed, it reads again, the loading words meanwhile, and the records are shown", async () => {
    const h = held(P("/participants"), { participants: [], complete: true });
    server.use(
      http.get(P("/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
      http.get(P("/consents"), () => HttpResponse.json({ consents: [], complete: true })),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    h.answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("heading", { level: 2, name: "Participants" });
    expect(tryAgain()).toBeNull();
    expect(h.count).toBe(2);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Fieldwork" }));
  });

  it("a read of the records that FAILS says what it said before, now with “Try again”", async () => {
    server.use(
      http.get(P("/participants"), () => HttpResponse.error()),
      http.get(P("/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
      http.get(P("/consents"), () => HttpResponse.json({ consents: [], complete: true })),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
  });
});

describe("FR-756: the governance screens' list of projects", () => {
  function Host() {
    return <GovernanceRoutes client={createClient(BASE, TOKEN)} loc={useLocation()} firstReadMs={LIMIT} />;
  }

  it("a list that never settles is given up at the limit: the alert and “Try again” (not “not in this library”); pressed, the project's screen is shown", async () => {
    const h = held(url("/projects"), { projects: [{ id: "p1", name: "Coastal kinship" }] });
    server.use(
      http.get(url("/projects/p1/audit"), () => HttpResponse.json({ events: [], total: 0 })),
      http.get(url("/projects/p1/attention"), () => HttpResponse.json({ marks: [] })),
    );
    window.history.replaceState(null, "", "/audit");
    render(<Host />);
    expect(screen.getByText("Choose a project first.")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    h.answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("heading", { level: 1, name: "Audit log" });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("p1"));
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(h.count).toBe(2);
    expect(document.activeElement?.isConnected && document.activeElement !== document.body).toBe(true);
  });

  it("a list given up at the limit leaves the project named in the address shown, never “not in this library”", async () => {
    held(url("/projects"), { projects: [] });
    server.use(
      http.get(url("/projects/p1/audit"), () => HttpResponse.json({ events: [], total: 0 })),
      http.get(url("/projects/p1/attention"), () => HttpResponse.json({ marks: [] })),
    );
    window.history.replaceState(null, "", "/audit?project=p1");
    render(<Host />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
    expect(screen.queryByText("Choose a project first.")).toBeNull();
  });

  it("a list that FAILS says what it said before, now with “Try again”", async () => {
    server.use(http.get(url("/projects"), () => HttpResponse.error()));
    window.history.replaceState(null, "", "/audit");
    render(<Host />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getByText("Choose a project first.")).toBeTruthy();
  });
});

describe("FR-756, R605 M1: the governance route never says the project is not in the library of a list it did not read", () => {
  function Host() {
    return <GovernanceRoutes client={createClient(BASE, TOKEN)} loc={useLocation()} firstReadMs={LIMIT} />;
  }
  const NOT_IN = /not in this library/;
  const screenReads = () =>
    server.use(
      http.get(url("/projects/p1/audit"), () => HttpResponse.json({ events: [], total: 0 })),
      http.get(url("/projects/p1/attention"), () => HttpResponse.json({ marks: [] })),
    );
  /** The list's asks in turn: "fail" (no answer), "hold" (never settles), or the list. */
  function list(asks: Array<"fail" | "hold" | "answer">) {
    let n = 0;
    const gate = hang();
    server.use(
      http.get(url("/projects"), async () => {
        const what = asks[Math.min(n++, asks.length - 1)];
        if (what === "fail") return HttpResponse.error();
        if (what === "hold") await gate;
        return HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship" }] });
      }),
    );
    return () => n;
  }

  it("a list that failed, then was given up on “Try again”: never “not in this library”, and the project's screen stays", async () => {
    screenReads();
    const asks = list(["fail", "hold"]);
    window.history.replaceState(null, "", "/audit?project=p1");
    render(<Host />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.queryByText(NOT_IN)).toBeNull();
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(asks()).toBe(2);
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText(NOT_IN)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
  });

  it("a list given up, then failed on “Try again”: never “not in this library”, and the project's screen stays", async () => {
    screenReads();
    const asks = list(["hold", "fail"]);
    window.history.replaceState(null, "", "/audit?project=p1");
    render(<Host />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(alerts()).toEqual([UNREACHABLE]));
    expect(asks()).toBe(2);
    expect(screen.queryByText(NOT_IN)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy();
    expect(screen.queryByText("Choose a project first.")).toBeNull();
  });
});
