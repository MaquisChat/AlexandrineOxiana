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
    await waitFor(() => expect(body).toEqual({ dest: DEST, excludeProjectIds: ["p2"] }));
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

  it("a move the service could not be reached for is \"could not be started\", not a cut-off stream", async () => {
    const user = userEvent.setup();
    let polled = false;
    server.use(
      http.post(url("/libraries/move"), () => HttpResponse.error()),
      http.get(url("/libraries/move/status"), () => {
        polled = true;
        return HttpResponse.json({ pending: null });
      }),
    );
    const plan = await planFor(user, { ...PLAN, perProject: [PLAN.perProject[0]!] });
    await user.click(within(plan).getByRole("button", { name: "Move library" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/The move could not be started/);
    expect(polled).toBe(false);
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
