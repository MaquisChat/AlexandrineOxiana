import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { MoveLibrary } from "./MoveLibrary";

useMsw();

const DEST = "/Volumes/Field SSD/Library";
const allow = { result: "allow", warnings: [] };
const PLAN = {
  destination: { kind: "removable" },
  perProject: [
    { projectId: "p1", name: "Coastal kinship", folder: "Projects/Coastal kinship", decision: allow },
    { projectId: "p2", name: "Clinic interviews", folder: "Projects/Clinic interviews", decision: { result: "deny", reason: "HIPAA: this destination is not an approved place for this project", warnings: [] } },
  ],
  projectsMovedAway: [],
  totalBytes: 5_000_000,
  fileCount: 120,
};
const RESULT = { newRoot: DEST, confirmToken: "tok-123", expiresAt: "2026-11-11T10:15:00.000Z", fileCount: 120, totalBytes: 5_000_000, filesCopied: 120, projectsMovedAway: [], warnings: [] };

/** An NDJSON stream the test feeds line by line. */
function controlledStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    response: () => new HttpResponse(body, { headers: { "content-type": "application/x-ndjson" } }),
    line: (v: unknown) => ctl.enqueue(new TextEncoder().encode(`${JSON.stringify(v)}\n`)),
    end: () => ctl.close(),
  };
}

async function planFor(user: ReturnType<typeof userEvent.setup>, plan = PLAN) {
  server.use(http.post(url("/libraries/move/plan"), () => HttpResponse.json(plan)));
  render(<MoveLibrary api={makeApi()} />);
  await user.type(screen.getByRole("textbox", { name: "Destination folder" }), DEST);
  await user.click(screen.getByRole("button", { name: "Check destination" }));
  return screen.findByRole("region", { name: "Move plan" });
}

describe("Move library", () => {
  it("a plan with one denied project lists the reason and offers \"Move the other projects only\"", async () => {
    const user = userEvent.setup();
    let body: any;
    const s = controlledStream();
    server.use(
      http.post(url("/libraries/move"), async ({ request }) => {
        body = await request.json();
        return s.response();
      }),
    );
    const plan = await planFor(user);
    const denied = within(plan).getByRole("row", { name: /Clinic interviews/ });
    expect(denied.textContent).toMatch(/Not allowed: HIPAA: this destination is not an approved place/);
    expect(within(plan).getByRole("row", { name: /Coastal kinship/ }).textContent).toMatch(/Allowed/);
    expect(within(plan).queryByRole("button", { name: "Move library" })).toBeNull();
    expect(within(plan).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await user.click(within(plan).getByRole("button", { name: "Move the other projects only" }));
    await waitFor(() => expect(body).toEqual({ dest: DEST, excludeProjectIds: ["p2"], attempt: expect.any(String) }));
    s.end();
  });

  it("shows progress, and \"Delete old copy\" stays disabled until verification succeeded", async () => {
    const user = userEvent.setup();
    const s = controlledStream();
    let deleted: any;
    server.use(
      http.post(url("/libraries/move"), () => s.response()),
      http.post(url("/libraries/move/delete-old"), async ({ request }) => {
        deleted = await request.json();
        return HttpResponse.json({ deleted: true, warnings: [] });
      }),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    const del = () => screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement;
    expect(del().disabled).toBe(true);
    s.line({ progress: { phase: "copy", filesDone: 30, fileCount: 120, bytesDone: 1, totalBytes: 5 } });
    expect(await screen.findByText(/Copying: 30 of 120 files/)).toBeTruthy();
    expect(del().disabled).toBe(true);
    s.line({ progress: { phase: "verify", filesDone: 60, fileCount: 120, bytesDone: 1, totalBytes: 5 } });
    expect(await screen.findByText(/Verifying: 60 of 120 files/)).toBeTruthy();
    expect(del().disabled).toBe(true);
    s.line({ done: true, result: RESULT });
    s.end();
    expect((await screen.findByRole("status", { name: "Verification" })).textContent).toMatch(/All 120 files were copied and verified/);
    await waitFor(() => expect(del().disabled).toBe(false));
    await user.click(del());
    const dialog = screen.getByRole("dialog", { name: "Delete old copy" });
    await user.type(within(dialog).getByRole("textbox", { name: /Type delete to confirm/ }), "delete");
    await user.click(within(dialog).getByRole("button", { name: "Delete the old copy" }));
    await waitFor(() => expect(deleted).toEqual({ token: "tok-123" }));
    expect(await screen.findByText(/The old copy was deleted/)).toBeTruthy();
  });

  it("a failed verification keeps \"Delete old copy\" disabled and says nothing was deleted", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(url("/libraries/move"), () =>
        new HttpResponse(`${JSON.stringify({ progress: { phase: "verify", filesDone: 3, fileCount: 120, bytesDone: 1, totalBytes: 5 } })}\n${JSON.stringify({ error: { code: "CONFLICT", message: "A copied file did not match its original (Projects/A/x.pdf)." } })}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        }),
      ),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not match its original.*nothing was deleted/s);
    expect((screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("FR-755: a move that did not finish once the old copy was closed says so in one sentence naming the new place, never that the library stays where it was", async () => {
    const user = userEvent.setup();
    const body = { code: "UNAVAILABLE", message: "The move did not finish, so the library has been closed. Open it at its new place, and the move will be finished then; nothing is lost.", reason: "move-not-finished" };
    server.use(
      http.post(url("/libraries/move"), () =>
        new HttpResponse(`${JSON.stringify({ progress: { phase: "switch", filesDone: 120, fileCount: 120, bytesDone: 5, totalBytes: 5 } })}\n${JSON.stringify({ error: body })}\n`, { headers: { "content-type": "application/x-ndjson" } }),
      ),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`The move did not finish, so the library has been closed. Open it at its new place, ${DEST}, and the move will be finished then; nothing is lost.`);
    expect(alert.querySelector("bdi, [dir='auto']")?.textContent).toBe(DEST);
    expect(screen.queryByText(/stays where it was/u)).toBeNull();
    expect((screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("R583 I1: a split move that did not finish says so for the projects, and that the library they came from opens again", async () => {
    const user = userEvent.setup();
    const body = { code: "UNAVAILABLE", message: "x", reason: "move-not-finished-split" };
    server.use(
      http.post(url("/libraries/move"), () => new HttpResponse(`${JSON.stringify({ error: body })}\n`, { headers: { "content-type": "application/x-ndjson" } })),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      `The move of the projects did not finish, so the library has been closed. Open the new library at its new place, ${DEST}, and the move will be finished then. The library they came from can be opened again for the projects that stayed; nothing is lost.`,
    );
    expect(alert.querySelector("[dir='auto']")?.textContent).toBe(DEST);
  });

  it("FR-755: the same sentence when the move's answer is read again from move/status after the stream was cut off", async () => {
    const user = userEvent.setup();
    let attempt = "";
    server.use(
      http.post(url("/libraries/move"), async ({ request }) => {
        attempt = ((await request.json()) as { attempt: string }).attempt;
        return new HttpResponse(`${JSON.stringify({ progress: { phase: "switch", filesDone: 1, fileCount: 1, bytesDone: 1, totalBytes: 1 } })}\n`, { headers: { "content-type": "application/x-ndjson" } });
      }),
      http.get(url("/libraries/move/status"), () =>
        HttpResponse.json({ pending: null, running: false, failed: { newRoot: DEST, attempt, error: { code: "UNAVAILABLE", message: "The move did not finish, so the library has been closed. Open it at its new place, and the move will be finished then; nothing is lost.", reason: "move-not-finished" } } }),
      ),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(`The move did not finish, so the library has been closed. Open it at its new place, ${DEST}, and the move will be finished then; nothing is lost.`));
  });

  it("after the stream is cut off, re-fetches the move's token from move/status", async () => {
    const user = userEvent.setup();
    let deleted: any;
    server.use(
      http.post(url("/libraries/move"), () => new HttpResponse(`${JSON.stringify({ progress: { phase: "copy", filesDone: 1, fileCount: 120, bytesDone: 1, totalBytes: 5 } })}\n`, { headers: { "content-type": "application/x-ndjson" } })),
      http.get(url("/libraries/move/status"), () => HttpResponse.json({ pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-after-reconnect", expiresAt: "2026-11-11T10:15:00.000Z" } })),
      http.post(url("/libraries/move/delete-old"), async ({ request }) => {
        deleted = await request.json();
        return HttpResponse.json({ deleted: true, warnings: [] });
      }),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    expect((await screen.findByRole("status", { name: "Verification" })).textContent).toMatch(/finished and was verified/);
    const del = screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    await user.click(del);
    const dialog = screen.getByRole("dialog", { name: "Delete old copy" });
    await user.type(within(dialog).getByRole("textbox", { name: /Type delete to confirm/ }), "delete");
    await user.click(within(dialog).getByRole("button", { name: "Delete the old copy" }));
    await waitFor(() => expect(deleted).toEqual({ token: "tok-after-reconnect" }));
  });

  it("a stream cut off in the middle of a line (the client's cut-off error) also asks move/status", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(url("/libraries/move"), () => new HttpResponse(`${JSON.stringify({ progress: { phase: "copy", filesDone: 1, fileCount: 120, bytesDone: 1, totalBytes: 5 } })}\n{"progress":{"pha`, { headers: { "content-type": "application/x-ndjson" } })),
      http.get(url("/libraries/move/status"), () => HttpResponse.json({ pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-cut", expiresAt: "2026-11-11T10:15:00.000Z" } })),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    expect(await screen.findByRole("status", { name: "Verification" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("picks up only the move it started: a finished move to another place is not offered for deletion", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(url("/libraries/move"), () => new HttpResponse("", { headers: { "content-type": "application/x-ndjson" } })),
      http.get(url("/libraries/move/status"), () => HttpResponse.json({ pending: { oldRoot: "/x", newRoot: "/Volumes/Other/Library", confirmToken: "not-mine", expiresAt: "2026-11-11T10:15:00.000Z" } })),
    );
    server.use(http.post(url("/libraries/move/plan"), () => HttpResponse.json({ ...PLAN, perProject: [PLAN.perProject[0]!] })));
    render(<MoveLibrary api={makeApi()} pollMs={5} maxPolls={3} />);
    await user.type(screen.getByRole("textbox", { name: "Destination folder" }), DEST);
    await user.click(screen.getByRole("button", { name: "Check destination" }));
    await user.click(within(await screen.findByRole("region", { name: "Move plan" })).getByRole("button", { name: "Move library" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/No finished move/);
    expect(screen.queryByRole("status", { name: "Verification" })).toBeNull();
    expect((screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a move the service answered (headers received) whose stream broke before any line asks move/status, never \"nothing was copied\"", async () => {
    const user = userEvent.setup();
    let polled = 0;
    server.use(
      http.post(url("/libraries/move"), () => {
        const body = new ReadableStream<Uint8Array>({ start: (c) => setTimeout(() => c.error(new TypeError("network connection lost")), 5) });
        return new HttpResponse(body, { headers: { "content-type": "application/x-ndjson" } });
      }),
      http.get(url("/libraries/move/status"), () => {
        polled++;
        return HttpResponse.json({ pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-headers", expiresAt: "2026-11-11T10:15:00.000Z" } });
      }),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    expect(await screen.findByRole("status", { name: "Verification" })).toBeTruthy();
    expect(polled).toBeGreaterThan(0);
    expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
  });

  describe("a move request that failed before the service answered asks move/status before saying anything (R379, I5)", () => {
    const LOST = "The connection to the app's service was lost. The move may still be running. This screen will show what happened as soon as the service answers.";
    /** The move request fails as the network does (status 0, UNAVAILABLE); its body is kept. */
    const lostMove = (seen: { body?: any }) =>
      http.post(url("/libraries/move"), async ({ request }) => {
        seen.body = await request.json();
        return HttpResponse.error();
      });
    async function start(user: ReturnType<typeof userEvent.setup>) {
      server.use(http.post(url("/libraries/move/plan"), () => HttpResponse.json({ ...PLAN, perProject: [PLAN.perProject[0]!] })));
      render(<MoveLibrary api={makeApi()} pollMs={5} maxPolls={200} />);
      await user.type(screen.getByRole("textbox", { name: "Destination folder" }), DEST);
      await user.click(screen.getByRole("button", { name: "Check destination" }));
      await user.click(within(await screen.findByRole("region", { name: "Move plan" })).getByRole("button", { name: "Move library" }));
    }

    it("the reviewer's probe: move/status IS asked, and while it says a move is running the false sentence is never shown; then the result", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          return HttpResponse.json(polls < 4 ? { pending: null, running: true, failed: null } : { pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-lost", expiresAt: "2026-11-11T10:15:00.000Z" }, running: false, failed: null });
        }),
      );
      await start(user);
      expect(await screen.findByText("Waiting for the move to finish…")).toBeTruthy();
      expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
      expect(screen.queryByRole("region", { name: "Move plan" })).toBeNull();
      expect((await screen.findByRole("status", { name: "Verification" })).textContent).toMatch(/finished and was verified/);
      expect(polls).toBeGreaterThanOrEqual(4);
      expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
      expect((screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(false);
      expect(typeof seen.body.attempt).toBe("string");
    });

    it("no move running and none made: only then \"could not be started … Nothing was copied or changed\", back to the plan", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          // An earlier move's failure (another attempt) is not this one's.
          return HttpResponse.json({ pending: null, running: false, failed: { newRoot: DEST, attempt: "an-earlier-attempt", error: { code: "CONFLICT", message: "Old failure." } } });
        }),
      );
      await start(user);
      expect((await screen.findByRole("alert")).textContent).toMatch(/^The move could not be started: .*Nothing was copied or changed\.$/);
      expect(screen.queryByText(/Old failure/)).toBeNull();
      expect(polls).toBeGreaterThan(0);
      expect(screen.getByRole("region", { name: "Move plan" })).toBeTruthy();
    });

    it("a move that finished with an error (this attempt's): its error, never \"nothing was copied\"", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () =>
          HttpResponse.json({ pending: null, running: false, failed: { newRoot: DEST, attempt: seen.body?.attempt, error: { code: "CONFLICT", message: "A copied file did not match its original." } } }),
        ),
      );
      await start(user);
      expect((await screen.findByRole("alert")).textContent).toMatch(/did not match its original\. The move stopped; nothing was deleted, and the library stays where it was\./);
      expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
      expect((screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("the service cannot be reached: a sentence that claims nothing about the files, and it keeps asking", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          return HttpResponse.error();
        }),
      );
      await start(user);
      expect((await screen.findByRole("alert")).textContent).toBe(LOST);
      const seenPolls = polls;
      await waitFor(() => expect(polls).toBeGreaterThan(seenPolls + 2));
      expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
      expect(screen.queryByRole("region", { name: "Move plan" })).toBeNull();
    });

    it("the status request failing twice and then answering: the lost-connection sentence, then what the service says", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      let sawLost = false;
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          if (polls <= 2) return HttpResponse.error();
          sawLost ||= screen.queryByText(LOST) !== null;
          return HttpResponse.json({ pending: null, running: false, failed: null });
        }),
      );
      await start(user);
      expect((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent).toBeTruthy();
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/The move could not be started/));
      expect(sawLost).toBe(true);
      // "Not started" needs two successive answers that agree (R399 b): the third and the fourth.
      expect(polls).toBe(4);
    });

    it("a move seen running, then the service restarted (empty answers): never \"not started\"; it ends as the cut-off path does (R399 a)", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      const alerts: string[] = [];
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          const a = screen.queryByRole("alert")?.textContent;
          if (a) alerts.push(a);
          if (polls <= 2) return HttpResponse.json({ pending: null, running: true, failed: null });
          if (polls <= 4) return HttpResponse.error();
          return HttpResponse.json({ pending: null, running: false, failed: null });
        }),
      );
      server.use(http.post(url("/libraries/move/plan"), () => HttpResponse.json({ ...PLAN, perProject: [PLAN.perProject[0]!] })));
      render(<MoveLibrary api={makeApi()} pollMs={5} maxPolls={12} />);
      await user.type(screen.getByRole("textbox", { name: "Destination folder" }), DEST);
      await user.click(screen.getByRole("button", { name: "Check destination" }));
      await user.click(within(await screen.findByRole("region", { name: "Move plan" })).getByRole("button", { name: "Move library" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("No finished move was found. Open the library to check where it is before trying again."), { timeout: 5000 });
      expect(polls).toBe(12);
      expect(alerts.some((a) => /Nothing was copied or changed/.test(a))).toBe(false);
      expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
      expect(screen.queryByRole("region", { name: "Move plan" })).toBeNull();
    });

    it("the lost-connection sentence goes as soon as any status answer arrives, and comes back only when the service is lost again (second review, M-a)", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      const shown: Array<{ alert: string | null; waiting: boolean }> = [];
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          shown.push({ alert: screen.queryByRole("alert")?.textContent ?? null, waiting: screen.queryByText("Waiting for the move to finish…") !== null });
          if (polls === 1 || polls === 3) return HttpResponse.error();
          if (polls === 2) return HttpResponse.json({ pending: null, running: true, failed: null });
          if (polls <= 6) return HttpResponse.json({ pending: null, running: false, failed: null });
          return HttpResponse.json({ pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-back", expiresAt: "2026-11-11T10:15:00.000Z" }, running: false, failed: null });
        }),
      );
      await start(user);
      expect((await screen.findByRole("status", { name: "Verification" }, { timeout: 3000 })).textContent).toMatch(/finished and was verified/);
      // shown[k] is what the screen showed after answer k (polls are 1-based, shown is 0-based).
      expect(shown[1]).toEqual({ alert: LOST, waiting: false }); // lost
      expect(shown[2]).toEqual({ alert: null, waiting: true }); // a move is running: the sentence is gone
      expect(shown[3]).toEqual({ alert: LOST, waiting: true }); // lost again: it is back
      expect(shown[4]).toEqual({ alert: null, waiting: true }); // an empty answer after "running": gone, still waiting
      expect(shown[5]).toEqual({ alert: null, waiting: true });
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("the first status question waits one polling interval (R399 b)", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let failedAt = 0;
      let askedAt = 0;
      server.use(
        http.post(url("/libraries/move"), async ({ request }) => {
          seen.body = await request.json();
          failedAt = Date.now();
          return HttpResponse.error();
        }),
        http.get(url("/libraries/move/status"), () => {
          askedAt ||= Date.now();
          return HttpResponse.json({ pending: null, running: false, failed: null });
        }),
      );
      server.use(http.post(url("/libraries/move/plan"), () => HttpResponse.json({ ...PLAN, perProject: [PLAN.perProject[0]!] })));
      render(<MoveLibrary api={makeApi()} pollMs={150} maxPolls={20} />);
      await user.type(screen.getByRole("textbox", { name: "Destination folder" }), DEST);
      await user.click(screen.getByRole("button", { name: "Check destination" }));
      await user.click(within(await screen.findByRole("region", { name: "Move plan" })).getByRole("button", { name: "Move library" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/The move could not be started/), { timeout: 5000 });
      expect(askedAt - failedAt).toBeGreaterThanOrEqual(140);
    });

    it("one empty answer followed by \"running\" does not conclude \"not started\" (R399 b)", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let polls = 0;
      const alerts: string[] = [];
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () => {
          polls++;
          const a = screen.queryByRole("alert")?.textContent;
          if (a) alerts.push(a);
          if (polls === 1) return HttpResponse.json({ pending: null, running: false, failed: null });
          if (polls <= 3) return HttpResponse.json({ pending: null, running: true, failed: null });
          return HttpResponse.json({ pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-late", expiresAt: "2026-11-11T10:15:00.000Z" }, running: false, failed: null });
        }),
      );
      await start(user);
      expect((await screen.findByRole("status", { name: "Verification" }, { timeout: 3000 })).textContent).toMatch(/finished and was verified/);
      expect(alerts.some((a) => /could not be started/.test(a))).toBe(false);
      expect(screen.queryByText(/Nothing was copied or changed/)).toBeNull();
    });

    it("a move refused after it was marked (background work that could not be paused): that reason, not \"could not be reached\" (R399 c)", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), () =>
          HttpResponse.json({
            pending: null,
            running: false,
            failed: { newRoot: DEST, attempt: seen.body?.attempt, error: { code: "CONFLICT", message: "Some background work could not be paused in time, so the library was not moved; try again in a moment." } },
          }),
        ),
      );
      await start(user);
      const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
      await waitFor(() => expect(alert.textContent).toMatch(/^Some background work could not be paused in time/));
      expect(alert.textContent).not.toMatch(/could not be reached/);
    });

    it("until the first status answer the screen says \"Checking what became of the move…\" in a status region, not an alert (R399 d)", async () => {
      const user = userEvent.setup();
      const seen: { body?: any } = {};
      let answer!: () => void;
      const held = new Promise<void>((r) => (answer = r));
      server.use(
        lostMove(seen),
        http.get(url("/libraries/move/status"), async () => {
          await held;
          return HttpResponse.json({ pending: null, running: true, failed: null });
        }),
      );
      await start(user);
      const checking = await screen.findByText("Checking what became of the move…");
      expect(checking.getAttribute("role")).toBe("status");
      expect(within(screen.getByRole("region", { name: "Progress" })).getByText("Checking what became of the move…")).toBe(checking);
      expect(screen.queryByRole("alert")).toBeNull();
      answer();
      expect(await screen.findByText("Waiting for the move to finish…")).toBeTruthy();
      expect(screen.queryByText("Checking what became of the move…")).toBeNull();
    });

    it("a plain refusal from the service (4xx with a reason) is shown as it is; move/status is not asked", async () => {
      const user = userEvent.setup();
      let polled = false;
      server.use(
        http.post(url("/libraries/move"), () => HttpResponse.json({ error: { code: "CONFLICT", message: "Some changes are still being made. Try the move again in a moment." } }, { status: 409 })),
        http.get(url("/libraries/move/status"), () => {
          polled = true;
          return HttpResponse.json({ pending: null, running: false, failed: null });
        }),
      );
      await start(user);
      expect((await screen.findByRole("alert")).textContent).toMatch(/The move could not be started: Some changes are still being made.*Nothing was copied or changed/);
      expect(polled).toBe(false);
    });
  });

  describe("the move's own warnings are shown (R379, I2)", () => {
    const W1 = "The library.move audit event could not be recorded for project p1; it could not be kept for later either (disk full)";
    const W2 = "The library.move audit event could not be recorded for project p3; the project is marked as needing attention and the event is recorded when the library is next opened";
    const HEAD = "The move finished, with these warnings:";

    it("a done line with two warnings shows both under the heading, after the summary", async () => {
      const user = userEvent.setup();
      const s = controlledStream();
      server.use(http.post(url("/libraries/move"), () => s.response()));
      const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
      await user.click(within(plan).getByRole("button", { name: "Move library" }));
      s.line({ done: true, result: { ...RESULT, warnings: [W1, W2] } });
      s.end();
      const ok = await screen.findByRole("status", { name: "Verification" });
      expect(ok.textContent).toMatch(/^All 120 files were copied and verified\./);
      const head = await screen.findByText(HEAD);
      const list = screen.getByRole("list", { name: HEAD });
      expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([W1, W2]);
      expect(head.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(ok.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("no warnings: no heading", async () => {
      const user = userEvent.setup();
      const s = controlledStream();
      server.use(http.post(url("/libraries/move"), () => s.response()));
      const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
      await user.click(within(plan).getByRole("button", { name: "Move library" }));
      s.line({ done: true, result: RESULT });
      s.end();
      await screen.findByRole("status", { name: "Verification" });
      expect(screen.queryByText(HEAD)).toBeNull();
    });

    it("the cut-off path gets them from move/status", async () => {
      const user = userEvent.setup();
      server.use(
        http.post(url("/libraries/move"), () => new HttpResponse("", { headers: { "content-type": "application/x-ndjson" } })),
        http.get(url("/libraries/move/status"), () => HttpResponse.json({ pending: { oldRoot: "/Users/ana/Library", newRoot: DEST, confirmToken: "tok-w", expiresAt: "2026-11-11T10:15:00.000Z", warnings: [W2] }, running: false, failed: null })),
      );
      const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
      await user.click(within(plan).getByRole("button", { name: "Move library" }));
      await screen.findByRole("status", { name: "Verification" });
      expect(within(screen.getByRole("list", { name: HEAD })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([W2]);
    });

    it("a plan shows each project's decision warnings beside that project", async () => {
      const user = userEvent.setup();
      const warned = { ...PLAN.perProject[0]!, decision: { result: "allow_with_conditions", warnings: ["This destination is removable: keep the drive encrypted."] } };
      const plan = await planFor(user, { ...PLAN, perProject: [warned, PLAN.perProject[1]!] } as unknown as typeof PLAN);
      const row = within(plan).getByRole("row", { name: /Coastal kinship/ });
      expect(row.textContent).toMatch(/This destination is removable: keep the drive encrypted\./);
      expect(within(plan).getByRole("row", { name: /Clinic interviews/ }).textContent).not.toMatch(/removable/);
    });
  });

  it("matches the finished move by its destination the way the service compares paths (Windows separators and case)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(url("/libraries/move/plan"), () => HttpResponse.json({ ...PLAN, perProject: [PLAN.perProject[0]!] })),
      http.post(url("/libraries/move"), () => new HttpResponse("", { headers: { "content-type": "application/x-ndjson" } })),
      http.get(url("/libraries/move/status"), () => HttpResponse.json({ pending: { oldRoot: "C:/old", newRoot: "d:/field ssd/library", confirmToken: "tok-win", expiresAt: "2026-11-11T10:15:00.000Z" } })),
    );
    render(<MoveLibrary api={makeApi()} pollMs={5} maxPolls={3} />);
    await user.type(screen.getByRole("textbox", { name: "Destination folder" }), "D:\\Field SSD\\Archive\\..\\Library\\");
    await user.click(screen.getByRole("button", { name: "Check destination" }));
    await user.click(within(await screen.findByRole("region", { name: "Move plan" })).getByRole("button", { name: "Move library" }));
    expect(await screen.findByRole("status", { name: "Verification" })).toBeTruthy();
  });

  it("stops reading the move's stream when the screen closes", async () => {
    const user = userEvent.setup();
    const s = controlledStream();
    let req: Request | undefined;
    server.use(
      http.post(url("/libraries/move"), ({ request }) => {
        req = request;
        return s.response();
      }),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    await waitFor(() => expect(req).toBeDefined());
    cleanup();
    await waitFor(() => expect(req!.signal.aborted).toBe(true));
  });

  it("MOVE_IN_PROGRESS: says a move is already running, and does not offer another move's old copy", async () => {
    const user = userEvent.setup();
    let polls = 0;
    server.use(
      http.post(url("/libraries/move/plan"), () => HttpResponse.json({ error: { code: "MOVE_IN_PROGRESS", message: "The library is being moved; changes wait until it is done." } }, { status: 503 })),
      http.get(url("/libraries/move/status"), () => {
        polls++;
        return HttpResponse.json({ pending: polls > 1 ? { oldRoot: "/old", newRoot: DEST, confirmToken: "tok-9", expiresAt: "2026-11-11T10:15:00.000Z" } : null });
      }),
    );
    render(<MoveLibrary api={makeApi()} pollMs={10} />);
    await user.type(screen.getByRole("textbox", { name: "Destination folder" }), DEST);
    await user.click(screen.getByRole("button", { name: "Check destination" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already being moved/);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("status", { name: "Verification" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete old copy", hidden: false }) === null || (screen.getByRole("button", { name: "Delete old copy" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
