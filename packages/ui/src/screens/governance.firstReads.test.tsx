/**
 * FR-756 (R584, R586, R597): the governance screens' first reads, given up after the time limit when they never settle
 * (neither answered nor failed): the screen's own alert says "The library service did not answer in time." with
 * "Try again", which reads again (the loading words meanwhile) and focus is not lost; a read that FAILS shows what it
 * showed before. The limit is passed small (`firstReadMs`), as FR-750's screens' tests do.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
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
const PAGE_ONE = { events: [{ seq: 1, at: "2026-10-01T08:00:00.000Z", actor: "Ana", action: "source.add", decision: { result: "allow" } }], total: 1 };

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

describe("FR-756, R605 I2: one sentence and one “Try again” for the page — the route's list and the screen's own reads together", () => {
  function Host() {
    return <GovernanceRoutes client={createClient(BASE, TOKEN)} loc={useLocation()} firstReadMs={LIMIT} />;
  }
  const RULES = { yaml: "profiles: []\n", sha256: "a".repeat(64), violations: [] };
  const LOG = { events: [{ seq: 1, at: "2026-10-01T08:00:00.000Z", actor: "Ana", action: "source.add", decision: { result: "allow" } }], total: 1 };
  /** The route's side reads (the stream never opens; the library's mode is read-write). */
  const routeSide = () =>
    server.use(
      http.get(url("/events"), async () => {
        await hang();
        return new HttpResponse(null);
      }),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
    );
  /** A GET whose asks are counted: "fail" (no answer), "hold" (never settles) or the body, as `now()` says at each ask. */
  function asked(path: string, body: unknown, now: () => "fail" | "hold" | "answer") {
    const h = { count: 0 };
    const gate = hang();
    server.use(
      http.get(path, async () => {
        h.count++;
        const what = now();
        if (what === "fail") return HttpResponse.error();
        if (what === "hold") await gate;
        return HttpResponse.json(body as never);
      }),
    );
    return h;
  }
  const LIST = { projects: [{ id: "p1", name: "Coastal kinship" }] };
  const SCREENS = [
    {
      path: "/governance",
      read: "/projects/p1/governance",
      body: RULES,
      side: () =>
        server.use(
          http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
          http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
        ),
      shown: () => screen.findByRole("button", { name: "Save changes" }),
    },
    {
      path: "/audit",
      read: "/projects/p1/audit",
      body: LOG,
      side: () => server.use(http.get(url("/projects/p1/attention"), () => HttpResponse.json({ marks: [] }))),
      shown: () => screen.findByRole("table", { name: "Audit events" }),
    },
    {
      path: "/fieldwork",
      read: "/projects/p1/participants",
      body: { participants: [], complete: true },
      side: () =>
        server.use(
          http.get(url("/projects/p1/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
          http.get(url("/projects/p1/consents"), () => HttpResponse.json({ consents: [], complete: true })),
        ),
      shown: () => screen.findByRole("heading", { level: 2, name: "Participants" }),
    },
  ];

  it.each(SCREENS)("on $path: the list given up at the limit and the screen's read failed with no answer say “could not be reached” alone, with one “Try again”, which reads both again", async (s) => {
    routeSide();
    s.side();
    let mode: "fail" | "hold" | "answer" = "hold";
    const list = asked(url("/projects"), LIST, () => (mode === "answer" ? "answer" : "hold"));
    const own = asked(url(s.read), s.body, () => (mode === "answer" ? "answer" : "fail"));
    window.history.replaceState(null, "", `${s.path}?project=p1`);
    render(<Host />);
    await waitFor(() => expect(own.count).toBe(1));
    // Past the list's limit: it is given up after the screen's read failed.
    await new Promise((r) => setTimeout(r, LIMIT + 300));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    mode = "answer";
    await userEvent.setup().click(tryAgain()!);
    await s.shown();
    await waitFor(() => expect(alerts()).toEqual([]));
    expect(tryAgain()).toBeNull();
    expect(list.count).toBe(2);
    expect(own.count).toBe(2);
    expect(document.activeElement?.isConnected && document.activeElement !== document.body).toBe(true);
  });

  it("the mirror: the list failed with no answer and the screen's read given up at the limit say “could not be reached” alone, with one “Try again”, which reads both again", async () => {
    routeSide();
    SCREENS[1]!.side();
    let answer = false;
    const list = asked(url("/projects"), LIST, () => (answer ? "answer" : "fail"));
    const own = asked(url("/projects/p1/audit"), LOG, () => (answer ? "answer" : "hold"));
    window.history.replaceState(null, "", "/audit?project=p1");
    render(<Host />);
    await waitFor(() => expect(own.count).toBe(1));
    await new Promise((r) => setTimeout(r, LIMIT + 300));
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("table", { name: "Audit events" });
    await waitFor(() => expect(alerts()).toEqual([]));
    expect(list.count).toBe(2);
    expect(own.count).toBe(2);
  });

  it("both given up at the limit say “did not answer in time” alone, with one “Try again”", async () => {
    routeSide();
    SCREENS[2]!.side();
    asked(url("/projects"), LIST, () => "hold");
    asked(url("/projects/p1/participants"), { participants: [], complete: true }, () => "hold");
    window.history.replaceState(null, "", "/fieldwork?project=p1");
    render(<Host />);
    await new Promise((r) => setTimeout(r, LIMIT + 400));
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("the screen's read failed while the list is still out: the screen's alert alone; its “Try again” reads the list still out again too", async () => {
    routeSide();
    SCREENS[1]!.side();
    let answer = false;
    const list = asked(url("/projects"), LIST, () => (answer ? "answer" : "hold"));
    const own = asked(url("/projects/p1/audit"), LOG, () => (answer ? "answer" : "fail"));
    window.history.replaceState(null, "", "/audit?project=p1");
    // A long limit for the list: it is still out when "Try again" is pressed.
    render(<GovernanceRoutes client={createClient(BASE, TOKEN)} loc={{ pathname: "/audit", search: "?project=p1" }} firstReadMs={10_000} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("table", { name: "Audit events" });
    await waitFor(() => expect(list.count).toBe(2));
    expect(own.count).toBe(2);
    await waitFor(() => expect(alerts()).toEqual([]));
  });
});

describe("FR-756, R605 M3: leaving a governance screen cancels its held read", () => {
  /** A GET that never settles; each ask's request signal is kept. */
  function heldSignals(path: string) {
    const signals: AbortSignal[] = [];
    const gate = hang();
    server.use(
      http.get(path, async ({ request }) => {
        signals.push(request.signal);
        await gate;
        return HttpResponse.json({});
      }),
    );
    return signals;
  }
  it.each([
    ["the project's rules", "/governance", () => <GovernanceSettings api={makeApi()} projectId={PID} />],
    ["the audit log", "/audit", () => <AuditLog api={makeApi()} projectId={PID} />],
    ["fieldwork", "/participants", () => <Fieldwork api={makeApi()} projectId={PID} />],
  ])("%s: the request's signal is aborted when the screen is left", async (_name, path, el) => {
    server.use(
      http.get(P("/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(P("/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
      http.get(P("/attention"), () => HttpResponse.json({ marks: [] })),
      http.get(P("/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
      http.get(P("/consents"), () => HttpResponse.json({ consents: [], complete: true })),
    );
    const signals = heldSignals(P(path));
    const { unmount } = render(el());
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });
});

describe("FR-756, R605 M5: a re-read after an act, given up, never replaces the act's own message", () => {
  /** A GET answered with `body` on its first ask, then held (never settles) until `h.answer` is set. */
  function thenHeld(path: string, body: unknown) {
    const h = { answer: false, count: 0 };
    const gate = hang();
    server.use(
      http.get(path, async () => {
        if (++h.count > 1 && !h.answer) await gate;
        return HttpResponse.json(body as never);
      }),
    );
    return h;
  }

  it("fieldwork: a refused act keeps its message when the re-read after it is given up; the give-up is the screen's alert with “Try again”, which reads again", async () => {
    const h = thenHeld(P("/participants"), { participants: [], complete: true });
    server.use(
      http.get(P("/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
      http.get(P("/consents"), () => HttpResponse.json({ consents: [], complete: true })),
      http.post(P("/participants"), () => HttpResponse.json({ error: { code: "REFUSED", message: "The participant could not be added." } }, { status: 409 })),
    );
    render(<Fieldwork api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add participant" }));
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual(["The participant could not be added.", NO_ANSWER]);
    h.answer = true;
    await user.click(tryAgain()!);
    await waitFor(() => expect(alerts()).toEqual(["The participant could not be added."]));
    expect(tryAgain()).toBeNull();
    expect(h.count).toBe(3);
  });

  it("the audit log: after a set-aside, a re-read of the log given up keeps the screen's earlier message and says the give-up with “Try again”", async () => {
    const h = thenHeld(P("/audit"), PAGE_ONE);
    let list = [{ id: "m1", kind: "permissions-not-set", action: "library.relink", occurredAt: "2026-11-03T08:00:00.000Z", actor: "ana", canSetAside: true }];
    server.use(
      http.get(P("/attention"), () => HttpResponse.json({ marks: list })),
      http.get(P("/audit/verify"), () => HttpResponse.json({ error: { code: "INTERNAL", message: "The audit log could not be checked." } }, { status: 500 })),
      http.post(P("/attention/m1/set-aside"), () => {
        list = [];
        return HttpResponse.json({ recordedIn: "project" });
      }),
    );
    render(<AuditLog api={makeApi()} projectId={PID} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Audit events" });
    await user.click(screen.getByRole("button", { name: "Verify integrity" }));
    await screen.findByText("The audit log could not be checked.");
    await user.click(screen.getByRole("button", { name: /Set aside/ }));
    const dialog = await screen.findByRole("dialog", { name: "Set this aside" });
    await user.type(within(dialog).getByRole("textbox", { name: /Reason/ }), "Recorded on paper");
    await user.click(within(dialog).getByRole("button", { name: "Set aside" }));
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual(["The audit log could not be checked.", NO_ANSWER]);
    h.answer = true;
    await user.click(tryAgain()!);
    // A log read that is answered clears the screen's alerts, as it did before.
    await waitFor(() => expect(alerts()).toEqual([]));
    expect(tryAgain()).toBeNull();
    expect(h.count).toBe(3);
  });
});

describe("FR-756, R605 M6: fieldwork's three requests are one read: the failure of one cancels the others at once", () => {
  it("a records request that fails cancels the two still out, long before the limit", async () => {
    const signals: AbortSignal[] = [];
    const gate = hang();
    const held = async ({ request }: { request: Request }) => {
      signals.push(request.signal);
      await gate;
      return HttpResponse.json({});
    };
    server.use(http.get(P("/participants"), () => HttpResponse.error()), http.get(P("/sessions"), held), http.get(P("/consents"), held));
    render(<Fieldwork api={makeApi()} projectId={PID} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(signals).toHaveLength(2);
    await waitFor(() => expect(signals.every((s) => s.aborted)).toBe(true), { timeout: 1000 });
  });
});
