import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../api/client";
import { useLocation } from "../navigation";
import { mockBackground } from "../test/backgroundService";
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

  it("the Governance screen of the app shows the project's automatic transcription switch, read for that project (whole channels, Task 9)", async () => {
    const m = mockBackground({ noEvents: true, automation: { p2: { transcribeNewMedia: true } } }, BASE);
    server.use(
      ...m.handlers,
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship" }, { id: "p2", name: "Clinic" }] })),
      http.get(url("/projects/p2/governance"), () => HttpResponse.json({ yaml: "", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p2/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p2/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
    );
    window.history.replaceState(null, "", "/governance?project=p2");
    render(<Host />);
    const section = await screen.findByRole("region", { name: "Automatic transcription" });
    const box = within(section).getByRole("checkbox", { name: "Transcribe captured audio and video automatically" }) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(m.count("GET /projects/p2/automation")).toBe(1);
  });

  it("an unknown project in the address selects none and says so, instead of showing another project's screen (41b2 M1)", async () => {
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Coastal kinship" }] })));
    window.history.replaceState(null, "", "/fieldwork?project=nope");
    render(<Host />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not in this library/);
    expect(screen.getByText("Choose a project first.")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("");
  });

  it.each(["/governance", "/audit", "/fieldwork"])("FR-163: on %s a locked project is marked in the picker, and the screen offers to unlock it in the library", async (path) => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted: true, unlocked: false }, { id: "p2", name: "Coastal kinship", encrypted: true, unlocked: true }] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
      // What the screen itself reads of a locked project is refused as the service refuses it.
      http.get(url("/projects/p1/*"), () => HttpResponse.json({ error: { code: "PROJECT_LOCKED", message: "This project is locked." } }, { status: 423 })),
    );
    window.history.replaceState(null, "", `${path}?project=p1`);
    render(<Host />);
    const picker = await screen.findByRole("combobox", { name: "Project" });
    await waitFor(() => expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["\u2068Clinic\u2069 (locked)", "\u2068Coastal kinship\u2069"]));
    const link = await screen.findByRole("link", { name: "Unlock it in the library" });
    expect(link.getAttribute("href")).toBe("/?project=p1");
    expect(link.closest("p")?.textContent).toBe("This project is locked. Unlock it in the library to see and change everything in it here.");
  });

  it("FR-158 (R463 M7): a right-to-left project name in the picker is isolated with the Unicode isolate marks, “(locked)” outside them", async () => {
    const name = "مقابلات هرات 2";
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name, encrypted: true, unlocked: false }] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
      http.get(url("/projects/p1/*"), () => HttpResponse.json({ error: { code: "PROJECT_LOCKED", message: "This project is locked." } }, { status: 423 })),
    );
    window.history.replaceState(null, "", "/audit?project=p1");
    render(<Host />);
    const picker = await screen.findByRole("combobox", { name: "Project" });
    await waitFor(() => expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual([`\u2068${name}\u2069 (locked)`]));
  });

  it("FR-163: an unlocked project is not marked and nothing offers to unlock it", async () => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p2", name: "Coastal kinship", encrypted: true, unlocked: true }] })),
      http.get(url("/projects/p2/audit"), () => HttpResponse.json({ events: [], total: 0 })),
    );
    window.history.replaceState(null, "", "/audit?project=p2");
    render(<Host />);
    expect(await screen.findByRole("heading", { name: "Audit log", level: 1 })).toBeTruthy();
    expect([...screen.getByRole("combobox", { name: "Project" }).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["\u2068Coastal kinship\u2069"]);
    expect(screen.queryByRole("link", { name: "Unlock it in the library" })).toBeNull();
  });

  it.each([
    ["a locked project", { projects: [{ id: "p1", name: "Clinic", encrypted: true, unlocked: false }] }, { mode: "read-write" }, "This project is locked, so its rules cannot be changed until it is unlocked."],
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

  it("a project locked in another window while the Governance form is open: the form turns off and says why (FR-389)", async () => {
    let locked = false;
    let push!: (type: string) => void;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        push = (type) => c.enqueue(new TextEncoder().encode(`event: ${type}\ndata: {}\n\n`));
        // The real service opens every stream with the state as it is (routes/libraries.ts).
        push("library.state");
      },
    });
    let connected = false;
    server.use(
      http.get(url("/events"), () => {
        connected = true;
        return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
      }),
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted: true, unlocked: !locked }] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
      http.get(url("/projects/p1/governance"), () => HttpResponse.json({ yaml: "captureMethods: [manual_upload, browser_capture]\n", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<Host />);
    const capture = await screen.findByRole("region", { name: "Capture methods" });
    const browser = () => within(capture).getByRole("checkbox", { name: /Browser capture/ }) as HTMLInputElement;
    await waitFor(() => expect(browser().disabled).toBe(false));
    await waitFor(() => expect(connected).toBe(true));
    locked = true;
    push("library.state");
    // The reason's sentence is the one the Governance form shows for a locked project (FR-163), and the route offers the way to unlock it.
    expect(await screen.findByText("This project is locked, so its rules cannot be changed until it is unlocked.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Unlock it in the library" })).toBeTruthy();
    expect(browser().disabled).toBe(true);
    // Unlocked again elsewhere: the form can be changed again.
    locked = false;
    push("library.state");
    await waitFor(() => expect(browser().disabled).toBe(false));
    expect(screen.queryByText("This project is locked, so its rules cannot be changed until it is unlocked.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Unlock it in the library" })).toBeNull();
  });

  // R468 (M1): the form reads the projects and the library's mode once on opening; the stream's
  // opening snapshot reads nothing more; each later library.state reads the projects once and takes
  // the mode from the event itself.
  it("the Governance form reads the projects and the library's mode once on opening, and once per later change (FR-389, R468)", async () => {
    let projectReads = 0;
    let libraryReads = 0;
    let push!: (data: Record<string, unknown>) => void;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        push = (data) => c.enqueue(new TextEncoder().encode(`event: library.state\ndata: ${JSON.stringify(data)}\n\n`));
        push({ open: true, mode: "read-write" });
      },
    });
    let connected = false;
    server.use(
      http.get(url("/events"), () => {
        connected = true;
        return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
      }),
      http.get(url("/projects"), () => {
        projectReads++;
        return HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted: false, unlocked: true }] });
      }),
      http.get(url("/libraries"), () => {
        libraryReads++;
        return HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } });
      }),
      http.get(url("/projects/p1/governance"), () => HttpResponse.json({ yaml: "captureMethods: [manual_upload, browser_capture]\n", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<Host />);
    const capture = await screen.findByRole("region", { name: "Capture methods" });
    const browser = () => within(capture).getByRole("checkbox", { name: /Browser capture/ }) as HTMLInputElement;
    await waitFor(() => expect(browser().disabled).toBe(false));
    await waitFor(() => expect(connected).toBe(true));
    // A later change that turns the library read-only: shown from the event, with one read of the projects.
    push({ open: true, mode: "read-only" });
    expect(await screen.findByText("This library is open read-only here, so its rules cannot be changed.")).toBeTruthy();
    await waitFor(() => expect(projectReads).toBe(2));
    expect(libraryReads).toBe(1);
    expect(browser().disabled).toBe(true);
    // One more later change: one more read of the projects, none of the libraries.
    push({ open: true, mode: "read-write" });
    await waitFor(() => expect(browser().disabled).toBe(false));
    await waitFor(() => expect(projectReads).toBe(3));
    expect(libraryReads).toBe(1);
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

  it.each([
    ["an encrypted project", true],
    ["a project that is not encrypted", false],
  ])("the Governance form of %s is told so from the project list: an exception's reason dialog says what the rules file keeps only when encrypted (R369 a)", async (_what, encrypted) => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted, unlocked: true }] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
      http.get(url("/projects/p1/governance"), () => HttpResponse.json({ yaml: "profiles: [hipaa]\nencryption:\n  atRest: required\n", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<Host />);
    const enc = await screen.findByRole("region", { name: "Encryption" });
    const select = within(enc).getByRole("combobox", { name: "Encryption at rest" }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.setup().selectOptions(select, "optional");
    const dialog = screen.getByRole("dialog", { name: "Record a reason" });
    expect(/can be read without the passphrase/.test(dialog.textContent ?? "")).toBe(encrypted);
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

describe("R463 M4: Fieldwork in a read-only library does not offer to detach a signed form", () => {
  it.each([
    ["read-only", false],
    ["read-write", true],
  ])("a %s library", async (mode, offered) => {
    server.use(
      http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted: false, unlocked: true }] })),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode } })),
      http.get(url("/projects/p1/participants"), () => HttpResponse.json({ participants: [{ id: "f1", code: "P-001", consentIds: ["c1"] }], complete: true })),
      http.get(url("/projects/p1/sessions"), () => HttpResponse.json({ sessions: [], complete: true })),
      http.get(url("/projects/p1/consents"), () =>
        HttpResponse.json({ consents: [{ id: "c1", participantId: "f1", scope: "Audio", date: "2026-03-14", documentAssetId: "0190f0f0-0000-7000-8000-0000000000aa" }], complete: true }),
      ),
    );
    window.history.replaceState(null, "", "/fieldwork?project=p1");
    render(<Host />);
    const records = await screen.findByRole("region", { name: "Consent records" });
    await within(records).findByText(/Signed form attached\./);
    const why = "This library is open read-only here, so a signed form cannot be detached.";
    if (offered) {
      expect(await within(records).findByRole("button", { name: "Detach the signed form of P-001…" })).toBeTruthy();
      expect(screen.queryByText(why)).toBeNull();
    } else {
      expect(await within(records).findByText(why)).toBeTruthy();
      expect(within(records).queryByRole("button", { name: /Detach/ })).toBeNull();
    }
  });
});

describe("R641 D1: the Governance form's event stream reconnects by itself, with an opening limit", () => {
  const readOnly = "This library is open read-only here, so its rules cannot be changed.";
  /** GET /events whose attempts answer in turn: "hang" (never opens until the request is cancelled) or a stream that sends one state and stays open (`drop()` ends it). */
  function attempts(answer: (n: number) => "hang" | Record<string, unknown>) {
    let n = 0;
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const requests: Request[] = [];
    return {
      handler: http.get(url("/events"), async ({ request }) => {
        requests.push(request);
        const a = answer(++n);
        if (a === "hang") {
          await new Promise<void>((r) => request.signal.addEventListener("abort", () => r(), { once: true }));
          return HttpResponse.error();
        }
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            ctl = c;
            c.enqueue(new TextEncoder().encode(`event: library.state\ndata: ${JSON.stringify(a)}\n\n`));
          },
        });
        return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
      }),
      attempts: () => n,
      signals: () => requests.map((r) => r.signal),
      drop: () => {
        ctl?.close();
        ctl = undefined;
      },
    };
  }
  function serve(events: { handler: Parameters<typeof server.use>[0] }) {
    const count = { projects: 0 };
    server.use(
      events.handler,
      http.get(url("/projects"), () => {
        count.projects++;
        return HttpResponse.json({ projects: [{ id: "p1", name: "Clinic", encrypted: false, unlocked: true }] });
      }),
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "l1", name: "Lib", mode: "read-write" } })),
      http.get(url("/projects/p1/governance"), () => HttpResponse.json({ yaml: "captureMethods: [manual_upload, browser_capture]\n", sha256: "a".repeat(64), violations: [] })),
      http.get(url("/projects/p1/protocol/documents"), () => HttpResponse.json({ documents: [] })),
      http.get(url("/projects/p1/retention"), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    );
    return count;
  }
  const browserBox = async () => {
    const capture = await screen.findByRole("region", { name: "Capture methods" });
    return () => within(capture).getByRole("checkbox", { name: /Browser capture/ }) as HTMLInputElement;
  };

  it("a stream that drops is opened again after a pause; the state it opens with counts as a change (what was missed is read again)", async () => {
    const ev = attempts((n) => (n === 1 ? { open: true, mode: "read-write" } : { open: true, mode: "read-only" }));
    const count = serve(ev);
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<GovernanceRoutes client={createClient(BASE, TOKEN)} loc={window.location} streamOpenMs={5_000} />);
    const browser = await browserBox();
    await waitFor(() => expect(browser().disabled).toBe(false));
    await waitFor(() => expect(ev.attempts()).toBe(1));
    expect(count.projects).toBe(1);
    // The library turned read-only while the stream was down: the reopened stream's first state says so.
    ev.drop();
    expect(await screen.findByText(readOnly, undefined, { timeout: 10_000 })).toBeTruthy();
    expect(ev.attempts()).toBe(2);
    expect(browser().disabled).toBe(true);
    await waitFor(() => expect(count.projects).toBe(2));
  });

  it("a stream that never opens is given up at the limit (its request cancelled) and opened afresh", async () => {
    const ev = attempts((n) => (n === 1 ? "hang" : { open: true, mode: "read-only" }));
    serve(ev);
    window.history.replaceState(null, "", "/governance?project=p1");
    render(<GovernanceRoutes client={createClient(BASE, TOKEN)} loc={window.location} streamOpenMs={300} />);
    expect(await screen.findByText(readOnly, undefined, { timeout: 10_000 })).toBeTruthy();
    expect(ev.attempts()).toBe(2);
    expect(ev.signals()[0]!.aborted).toBe(true);
    expect(ev.signals()[1]!.aborted).toBe(false);
  });
  it("a stream that opens and then delivers nothing for `streamQuietMs` is given up (its request cancelled) and opened afresh (R641 D2)", async () => {
    let n = 0;
    const requests: Request[] = [];
    serve({
      handler: http.get(url("/events"), ({ request }) => {
        requests.push(request);
        // The first opens and sends nothing at all, not even a keep-alive; the second sends the state as it now is.
        const first = ++n === 1;
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            if (!first) c.enqueue(new TextEncoder().encode(`event: library.state\ndata: ${JSON.stringify({ open: true, mode: "read-only" })}\n\n`));
          },
        });
        return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
      }),
    });
    // On a fake clock: the silence limit, the pause and the second stream's own silence act only as the test moves time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      window.history.replaceState(null, "", "/governance?project=p1");
      render(<GovernanceRoutes client={createClient(BASE, TOKEN)} loc={window.location} streamQuietMs={300} />);
      await vi.waitFor(() => expect(n).toBe(1));
      // The clock moves on in steps of 100 ms until the silence limit has given the first stream up …
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect(requests[0]!.signal.aborted).toBe(true);
      });
      // … then by the pause (2 s), after which it is opened afresh and its first state is shown.
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(screen.getByText(readOnly)).toBeTruthy());
      expect(n).toBe(2);
      expect(requests[1]!.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("each pause before the stream is opened again leaves no abort listener behind once it is over (review M4)", async () => {
    serve({ handler: http.get(url("/events"), () => HttpResponse.error()) });
    // The screen's own signal, as it is handed to the stream; its live "abort" listeners are counted.
    const client = createClient(BASE, TOKEN);
    let live = 0;
    let watched: AbortSignal | undefined;
    const opened = vi.fn((o: Parameters<typeof client.events>[0]) => {
      const signal = o?.signal;
      if (signal && !watched) {
        watched = signal;
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean) => {
          if (type === "abort") live++;
          add(type, fn, opts);
        }) as AbortSignal["addEventListener"];
        signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions | boolean) => {
          if (type === "abort") live--;
          remove(type, fn, opts);
        }) as AbortSignal["removeEventListener"];
      }
      return client.events(o);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      window.history.replaceState(null, "", "/governance?project=p1");
      render(<GovernanceRoutes client={{ ...client, events: opened }} loc={window.location} />);
      // Each try fails at once; after it the screen pauses (2 s), then tries again. Five pauses go by.
      for (let n = 1; n <= 6; n++) {
        await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(n));
        if (n < 6) await vi.advanceTimersByTimeAsync(2_000);
      }
      // At rest in the sixth pause: its own listener, and none left from the five pauses before.
      await vi.waitFor(() => expect(live).toBe(1));
    } finally {
      vi.useRealTimers();
    }
  });
});
