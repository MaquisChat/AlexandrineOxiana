/**
 * "Recheck project" on the library screen (Task 34d, R99): the job's progress from the service's
 * job.progress events, one job at a time, and the badges read again when it finishes. R137: the
 * library row's review badge and the source screen's verification badges are separate things.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { CURRENT_RW, libraryHandlers, server, SOURCES, serviceError, testApi, url, useMockService } from "../test/service";
import { FIELD_ISSUED_CONFLICT, FIELD_TITLE_VERIFIED, VERIFIED_SOURCE, withFields } from "../test/verification";
import { Library } from "./Library";

useMockService();

const enc = new TextEncoder();

/** An event stream the test writes to: `send()` delivers one event while the screen listens. */
function liveEvents() {
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const queued: string[] = [];
  const write = (s: string) => (ctl ? ctl.enqueue(enc.encode(s)) : queued.push(s));
  return {
    handler: http.get(url("/events"), () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          for (const s of queued.splice(0)) c.enqueue(enc.encode(s));
        },
      });
      return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
    }),
    send: (type: string, data: unknown) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
  };
}

const progress = (done: number, total: number, more: Record<string, unknown> = {}) => ({ kind: "recheck", jobId: "job-1", projectId: "p1", done, total, finished: false, ...more });

/** Every distinct text each live region (status, alert, aria-live) of the page shows, in order, while watched. */
function watchAnnouncements() {
  const seen = new Map<Element, string[]>();
  const regions = () => [...document.querySelectorAll("[role=status], [role=alert], [aria-live]")].filter((el) => el.getAttribute("aria-live") !== "off");
  const snap = () => {
    for (const r of regions()) {
      const list = seen.get(r) ?? [];
      const text = (r.textContent ?? "").trim();
      if (list.at(-1) !== text) list.push(text);
      seen.set(r, list);
    }
  };
  snap();
  const mo = new MutationObserver(snap);
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  return {
    stop: () => {
      snap();
      mo.disconnect();
    },
    /** The non-empty texts each region showed that mention the recheck. */
    about: (re: RegExp) => [...seen.values()].flatMap((list) => list.filter((t) => t !== "" && re.test(t))),
  };
}

describe("Recheck project: announcements (R113, review F1)", () => {
  it("many rapid progress events announce only the start and the end; the visible counter and bar still move", async () => {
    const ev = liveEvents();
    server.use(ev.handler, http.post(url("/projects/:id/recheck"), () => HttpResponse.json({ jobId: "job-1", total: 60 })), ...libraryHandlers());
    ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    await within(nav).findByRole("button", { name: /Dissertation/ });
    await screen.findByRole("table", { name: "Sources" });
    const watch = watchAnnouncements();
    await user.click(screen.getByRole("button", { name: "Recheck project" }));
    await screen.findByText("Rechecking the project's sources.");
    for (let i = 1; i <= 59; i++) ev.send("job.progress", progress(i, 60));
    await waitFor(() => expect(screen.getByText("59 of 60")).toBeTruthy());
    const bar = screen.getByRole("progressbar", { name: "Project recheck progress" });
    expect(bar.getAttribute("value")).toBe("59");
    expect(bar.closest("[role=status], [aria-live]")).toBeNull();
    ev.send("job.progress", progress(60, 60, { finished: true, changed: 3, failed: 0 }));
    await screen.findByText(/Recheck finished: 3 sources changed/);
    watch.stop();
    const said = watch.about(/recheck/i);
    expect(said).toEqual(["Rechecking the project's sources.", "Recheck finished: 3 sources changed."]);
    // The background-jobs indicator does not repeat the recheck's progress.
    expect(screen.getByRole("status", { name: "Background jobs" }).textContent).toBe("");
  });
});

describe("Recheck project (R99)", () => {
  /** The library on screen with its projects and sources loaded, each part awaited in turn. */
  async function libraryShown() {
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    await within(nav).findByRole("button", { name: /Dissertation/ });
    await screen.findByRole("button", { name: "Recheck project" });
    return screen.findByRole("table", { name: "Sources" });
  }

  it("starts the job, shows its progress from the job events, ignores other jobs, and refuses a second start while it runs", async () => {
    const ev = liveEvents();
    let starts = 0;
    server.use(
      ev.handler,
      http.post(url("/projects/:id/recheck"), ({ params }) => {
        starts++;
        expect(params.id).toBe("p1");
        return HttpResponse.json({ jobId: "job-1", total: 2 });
      }),
      ...libraryHandlers(),
    );
    ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
    const user = userEvent.setup();
    await libraryShown();
    const button = screen.getByRole("button", { name: "Recheck project" });
    await user.click(button);
    await waitFor(() => expect(starts).toBe(1));
    const status = screen.getByRole("status", { name: "Project recheck" });
    await waitFor(() => expect(status.textContent).toBe("Rechecking the project's sources."));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await user.click(button);
    expect(starts).toBe(1);

    ev.send("job.progress", progress(1, 2));
    await screen.findByText("1 of 2");
    const bar = screen.getByRole("progressbar", { name: "Project recheck progress" });
    expect(bar.getAttribute("value")).toBe("1");
    expect(bar.getAttribute("max")).toBe("2");
    // Another job's events (another project, or another recheck) do not move it.
    ev.send("job.progress", { ...progress(2, 2), jobId: "job-other", finished: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(status.textContent).toBe("Rechecking the project's sources.");

    ev.send("job.progress", progress(2, 2, { finished: true, changed: 1, failed: 0 }));
    await waitFor(() => expect(status.textContent).toBe("Recheck finished: 1 source changed."));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("when the job finishes, the open source's badges are read again", async () => {
    const ev = liveEvents();
    let sourceReads = 0;
    server.use(
      ev.handler,
      http.post(url("/projects/:id/recheck"), () => HttpResponse.json({ jobId: "job-1", total: 2 })),
      http.get(url("/projects/:id/sources/:sid"), () => {
        sourceReads++;
        return HttpResponse.json(sourceReads === 1 ? VERIFIED_SOURCE : withFields([{ ...FIELD_TITLE_VERIFIED, status: "conflict" }]));
      }),
      ...libraryHandlers(),
    );
    ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
    const user = userEvent.setup();
    const table = await libraryShown();
    await user.click(await within(table).findByRole("button", { name: "Ethnography at Work" }));
    await screen.findByRole("button", { name: "Title: Verified" });
    await user.click(screen.getByRole("button", { name: "Recheck project" }));
    await screen.findByText("Rechecking the project's sources.");
    ev.send("job.progress", progress(2, 2, { finished: true, changed: 1, failed: 0 }));
    await screen.findByText("Recheck finished: 1 source changed.");
    expect(await screen.findByRole("button", { name: "Title: Conflict" })).toBeTruthy();
  });

  it("FR-348: a recheck started before the screen was left and running on is shown again on return, from its next event; no second one is started", async () => {
    const ev = liveEvents();
    let starts = 0;
    server.use(
      ev.handler,
      http.post(url("/projects/:id/recheck"), () => {
        starts++;
        return HttpResponse.json({ jobId: "job-2", total: 10 });
      }),
      ...libraryHandlers(),
    );
    ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
    await libraryShown();
    const button = screen.getByRole("button", { name: "Recheck project" }) as HTMLButtonElement;
    const status = screen.getByRole("status", { name: "Project recheck" });
    // The job started on the earlier visit goes on reporting.
    ev.send("job.progress", { ...progress(3, 10), jobId: "job-old" });
    await screen.findByText("3 of 10");
    expect(status.textContent).toBe("Rechecking the project's sources.");
    expect(button.disabled).toBe(true);
    await userEvent.setup().click(button);
    expect(starts).toBe(0);
    ev.send("job.progress", { ...progress(10, 10, { finished: true, changed: 2, failed: 0 }), jobId: "job-old" });
    await waitFor(() => expect(status.textContent).toBe("Recheck finished: 2 sources changed."));
    expect(button.disabled).toBe(false);
  });

  it("a job whose events arrive before its start is answered still finishes (no stuck progress)", async () => {
    const ev = liveEvents();
    server.use(
      ev.handler,
      http.post(url("/projects/:id/recheck"), async () => {
        ev.send("job.progress", progress(0, 0, { finished: true, changed: 0, failed: 0 }));
        await new Promise((r) => setTimeout(r, 40));
        return HttpResponse.json({ jobId: "job-1", total: 0 });
      }),
      ...libraryHandlers(),
    );
    ev.send("library.state", { open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {} });
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const button = await screen.findByRole("button", { name: "Recheck project" });
    await screen.findByRole("table", { name: "Sources" });
    await user.click(button);
    const status = screen.getByRole("status", { name: "Project recheck" });
    await waitFor(() => expect(status.textContent).toContain("Recheck finished"));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("a recheck the service refuses is explained in plain words, and can be started again", async () => {
    const ev = liveEvents();
    server.use(ev.handler, http.post(url("/projects/:id/recheck"), () => serviceError(409, "READ_ONLY", "read only")), ...libraryHandlers());
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await screen.findByRole("table", { name: "Sources" });
    const button = await screen.findByRole("button", { name: "Recheck project" });
    await user.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The project recheck did not start. This library is read-only");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("is not offered for a locked project, and is off in a read-only library", async () => {
    server.use(...libraryHandlers({ current: { ...CURRENT_RW, mode: "read-only", readOnlyReason: "not-writable" } }));
    render(<Library api={testApi()} current={{ ...CURRENT_RW, mode: "read-only", readOnlyReason: "not-writable" } as never} />);
    await screen.findByRole("table", { name: "Sources" });
    expect((screen.getByRole("button", { name: "Recheck project" }) as HTMLButtonElement).disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Clinic interviews/ }));
    await screen.findByRole("heading", { name: "Clinic interviews is locked" });
    expect(screen.queryByRole("button", { name: "Recheck project" })).toBeNull();
  });

  it("R137: a row with no review waiting (the review item was accepted) still opens to its conflict, not 'confirmed by you'", async () => {
    server.use(
      http.get(url("/projects/:id/sources"), () => HttpResponse.json({ ...SOURCES, items: SOURCES.items.map((s) => ({ ...s, needsReview: false })) })),
      http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(withFields([FIELD_ISSUED_CONFLICT]))),
      ...libraryHandlers(),
    );
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const table = await screen.findByRole("table", { name: "Sources" });
    expect(within(table).queryByText(/Needs review/i)).toBeNull();
    await user.click(within(table).getByRole("button", { name: "Ethnography at Work" }));
    expect(await screen.findByRole("button", { name: "Publication date: Conflict" })).toBeTruthy();
    expect(screen.queryByText("Confirmed by you")).toBeNull();
  });
});
