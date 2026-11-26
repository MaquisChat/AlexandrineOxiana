import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { COOKIES_ACKNOWLEDGEMENT } from "../api/capture";
import type { CaptureQueueDetail } from "@ao/shared";
import { http } from "msw";
import { ANON_RULES, BASE, errorResponse, exampleEstimate, mockCapture, P1, P2, server, STRICT_RULES, type CaptureSetup } from "../test/captureService";
import { exampleRun, idleList, mockBackground } from "../test/backgroundService";
import { Capture, CaptureRoute } from "./Capture";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const IG = "https://www.instagram.com/p/Cabc123/";
const TT = "https://www.tiktok.com/@someone/video/7234567890";
const PROFILE = "https://www.instagram.com/someone/";

/** A running links queue of P1 as the service reports it (Task 63). */
const running = (): CaptureQueueDetail => ({
  queueId: "q1",
  projectId: P1,
  kind: "links",
  startedBy: "desktop",
  done: 0,
  total: 3,
  finished: false,
  startedAt: "2026-11-12T10:00:00.000Z",
  urls: [YT, IG, TT],
  items: [],
});

async function setup(o: CaptureSetup = {}, projectId = P1) {
  const m = mockCapture(o);
  const user = userEvent.setup();
  const view = render(<Capture client={m.client} projectId={projectId} />);
  // Ready: the rules are read and the event stream is open, on both sides: the mock counts a stream
  // when it answers, the screen has it once its fetch resolves, and then reads the queues (onOpen).
  // Waiting for only the mock's side let a test unmount while the screen's fetch was still resolving;
  // its abort then never reached the mock's stream (review M6).
  await screen.findByRole("button", { name: "Capture links" });
  await waitFor(() => expect(m.streams()).toBe(1));
  await waitFor(() => expect(m.calls.some((c) => c.path === `/projects/${projectId}/captures`)).toBe(true));
  await waitFor(() => expect(m.calls.some((c) => c.path === `/projects/${projectId}/governance`)).toBe(true));
  await waitFor(() => expect(screen.queryByText(/Reading this project's rules/)).toBeNull());
  return { m, user, view };
}

const links = () => screen.getByRole("textbox", { name: "Links, one per line" });

async function paste(user: ReturnType<typeof userEvent.setup>, lines: string[]) {
  await user.click(links());
  await user.paste(lines.join("\n"));
}

const profileBox = () => screen.getByRole("textbox", { name: "Profile, channel or playlist link" });

/** "Capture profile", then "Start" in the estimate that it shows (whole channels, Task 8). */
async function captureAndStart(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Capture profile" }));
  await user.click(await screen.findByRole("button", { name: "Start" }));
}

describe("Capture screen — links", () => {
  it("pasting 3 links shows 3 previews and posts them in one call", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG, TT]);
    const preview = screen.getByRole("list", { name: "Link preview" });
    const rows = within(preview).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("YouTube — video")).toBeTruthy();
    expect(within(rows[1]!).getByText("Instagram — post")).toBeTruthy();
    expect(within(rows[2]!).getByText("TikTok — video")).toBeTruthy();
    expect(within(rows[0]!).getByText(YT).getAttribute("dir")).toBe("auto");
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture`)[0]).toEqual({ urls: [YT, IG, TT], options: { transcribeModel: "medium" } });
    // Queued: the queue shows them, the box is emptied.
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    expect(within(queue).getAllByRole("listitem")).toHaveLength(3);
    expect((links() as HTMLTextAreaElement).value).toBe("");
  });

  it("a line that is not a web address is pointed out and nothing is sent", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, "www.youtube.com/watch?v=x"]);
    expect(screen.getAllByText(/not a web address/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const err = await screen.findByText(/Line 2 is not a web address/);
    expect(links().getAttribute("aria-invalid")).toBe("true");
    expect(links().getAttribute("aria-describedby")).toContain(err.id);
    expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(0);
  });

  it("a link listed twice is sent once and said so; the count is shown against the limit (review M3, M11)", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG, YT]);
    expect(screen.getByText("3 lines, 2 different links (at most 500 at once)")).toBeTruthy();
    expect(screen.getByText(/Listed twice: captured once/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture`)[0]).toEqual({ urls: [YT, IG], options: { transcribeModel: "medium" } });
  });

  it("a link carrying a user name or password is refused with a sentence (review M3)", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, "https://user:secret@www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    expect(await screen.findByText(/Line 2 contains a user name or password/)).toBeTruthy();
    expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(0);
  });

  it("a double click starts one capture", async () => {
    const { m, user } = await setup({ captureDelayMs: 80 });
    await paste(user, [YT]);
    await user.dblClick(screen.getByRole("button", { name: "Capture links" }));
    await screen.findByRole("region", { name: "Capture queue" });
    await new Promise((r) => setTimeout(r, 120));
    expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1);
  });

  it("sends the options: browser, transcription with a model, refresh existing", async () => {
    const { m, user } = await setup({ acknowledged: [P1] });
    await paste(user, [YT]);
    await user.click(screen.getByRole("checkbox", { name: "Use my browser session" }));
    expect(screen.queryByRole("dialog")).toBeNull(); // already acknowledged in this project
    await user.selectOptions(screen.getByRole("combobox", { name: "Browser" }), "firefox");
    await user.click(screen.getByRole("radio", { name: "Transcribe" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Transcription model" }), "small");
    await user.click(screen.getByRole("checkbox", { name: "Refresh existing" }));
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture`)[0]).toEqual({
      urls: [YT],
      options: { cookiesFromBrowser: "firefox", transcribe: true, transcribeModel: "small", refreshIfExists: true },
    });
  });

  it("“Do not transcribe” is sent as transcribe: false", async () => {
    const { m, user } = await setup();
    await paste(user, [YT]);
    await user.click(screen.getByRole("radio", { name: "Do not transcribe" }));
    expect((screen.getByRole("combobox", { name: "Transcription model" }) as HTMLSelectElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture`)[0]).toEqual({ urls: [YT], options: { transcribe: false } });
  });

  it("a refusal by the project's rules is explained with its reason", async () => {
    const { user } = await setup({ captureAnswer: () => errorResponse(403, "POLICY_DENIED", "This project's rules do not allow that.", "The downloader is not among this project's capture methods.") });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rules don't allow this/);
    expect(alert.textContent).toMatch(/The downloader is not among this project's capture methods\./);
    expect(alert.textContent).not.toMatch(/\{|POLICY_DENIED/);
  });

  it("a media helper that is not running is said in plain words, never with the helper's own start-up text (review M2/N3)", async () => {
    const { user } = await setup({
      captureAnswer: () => errorResponse(503, "WORKER_UNAVAILABLE", "The media helper is not running.", "The media helper is not set up yet. Run `pnpm setup:py` once, then try again."),
    });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/The media helper is not running/);
    expect(alert.textContent).toMatch(/Restart the app/);
    // Said once (Minor O2).
    expect(alert.textContent!.match(/queued/g)).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/setup:py|pnpm|`/);
    // Said once, not three times.
    expect(alert.textContent!.match(/not running|not available/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("a read-only library's internal reason word is not shown", async () => {
    const { user } = await setup({ captureAnswer: () => errorResponse(409, "READ_ONLY", "This library is open read-only, so nothing can be changed.", "locked-by-other-device") });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/read-only/);
    expect(alert.textContent).not.toMatch(/locked-by-other-device/);
  });

  const UNREADABLE = "This project's rules cannot be read, so nothing can be captured here. Correct them on the Governance screen.";

  it("says why nothing can be captured when the service cannot read the rules (R379 FR-A18)", async () => {
    await setup({ unreadable: [P1] });
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
    expect(screen.queryByText(/rules do not allow capture with the downloader/)).toBeNull();
  });

  it("says it too for rules the screen itself cannot read (R379 FR-A18)", async () => {
    await setup({ governance: { [P1]: "encryption: {atRest: optional}\nresidencey: {allowed: [local]}\n" } });
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
  });

  it("does not say it for readable rules (R379 FR-A18)", async () => {
    await setup();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });

  it("does not say it when the rules' request failed: that failure is said instead (R379 FR-A18)", async () => {
    const m = mockCapture({ extra: [http.get(`${BASE}/projects/:id/governance`, () => errorResponse(500, "INTERNAL", "Something went wrong in the library service."))] });
    render(<Capture client={m.client} projectId={P1} />);
    await screen.findByText(/Something went wrong in the library service/);
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });

  it("says when the project's rules do not allow the downloader", async () => {
    await setup({ governance: { [P1]: "consent:\n  requireLegalBasis: false\n" } });
    expect(screen.getByText(/rules do not allow capture with the downloader/)).toBeTruthy();
  });
});

describe("Capture screen — the browser-session acknowledgement", () => {
  it("is asked once per project, with the exact text, and recorded", async () => {
    const { m, user } = await setup();
    const box = screen.getByRole("checkbox", { name: "Use my browser session" });
    await user.click(box);
    const dialog = await screen.findByRole("dialog", { name: "Use your browser session?" });
    expect(within(dialog).getByText(COOKIES_ACKNOWLEDGEMENT)).toBeTruthy();
    expect(screen.getByRole("main").closest("[inert]")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "I understand, use my browser session" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.bodies(`POST /projects/${P1}/acknowledge`)).toEqual([{ kind: "cookies" }]);
    expect((box as HTMLInputElement).checked).toBe(true);
    // Off and on again: not asked again.
    await user.click(box);
    await user.click(box);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.bodies(`POST /projects/${P1}/acknowledge`)).toHaveLength(1);
  });

  it("Cancel and Escape leave the browser session off and return focus to the box", async () => {
    const { m, user } = await setup();
    const box = screen.getByRole("checkbox", { name: "Use my browser session" });
    await user.click(box);
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(document.activeElement).toBe(box);
    await user.click(box);
    dialog = await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(m.bodies(`POST /projects/${P1}/acknowledge`)).toHaveLength(0);
  });

  describe("focus (R145)", () => {
    const CONFIRM = "I understand, use my browser session";

    /** Open from the checkbox; focus is on the dialog's heading, then its first control, and Tab and Shift+Tab stay inside at both ends. */
    async function openAndWalk(user: ReturnType<typeof userEvent.setup>) {
      const box = screen.getByRole("checkbox", { name: "Use my browser session" });
      await user.click(box);
      const dialog = await screen.findByRole("dialog", { name: "Use your browser session?" });
      const confirm = within(dialog).getByRole("button", { name: CONFIRM });
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Use your browser session?" })); // on open: the heading (R376 c)
      await user.tab();
      expect(document.activeElement).toBe(confirm);
      await user.tab();
      expect(document.activeElement).toBe(cancel);
      await user.tab(); // past the last: back to the first
      expect(document.activeElement).toBe(confirm);
      await user.tab({ shift: true }); // before the first: to the last
      expect(document.activeElement).toBe(cancel);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(confirm);
      return { box, dialog, confirm, cancel };
    }

    it("on open, through Tab and Shift+Tab, and after Escape", async () => {
      const { user } = await setup();
      const { box } = await openAndWalk(user);
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(box);
    });

    it("after Cancel", async () => {
      const { user } = await setup();
      const { box, cancel } = await openAndWalk(user);
      await user.click(cancel);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(box);
    });

    it("after the confirming action", async () => {
      const { user } = await setup();
      const { box, confirm } = await openAndWalk(user);
      await user.click(confirm);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(box);
    });

    it("opened by the service's refusal: focus enters, stays inside, and returns to “Capture links”", async () => {
      const { user } = await setup({ acknowledged: [P1], captureAnswer: () => errorResponse(409, "ACKNOWLEDGEMENT_REQUIRED", COOKIES_ACKNOWLEDGEMENT, "cookies") });
      await paste(user, [YT]);
      await user.click(screen.getByRole("checkbox", { name: "Use my browser session" }));
      const start = screen.getByRole("button", { name: "Capture links" });
      await user.click(start);
      const dialog = await screen.findByRole("dialog", { name: "Use your browser session?" });
      const confirm = within(dialog).getByRole("button", { name: CONFIRM });
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Use your browser session?" })); // R376 c
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(cancel);
      await user.tab();
      expect(document.activeElement).toBe(confirm);
      await user.click(confirm);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(start));
    });

    it("returns focus to the opener even when making the page inert moves focus away first, as browsers do (review M9)", async () => {
      const { user } = await setup();
      // A browser moves focus out of an element that becomes inert; jsdom does not. Emulate it.
      const set = Element.prototype.setAttribute;
      vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (this: Element, name: string, value: string) {
        set.call(this, name, value);
        if (name === "inert" && document.activeElement && this.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      });
      const box = screen.getByRole("checkbox", { name: "Use my browser session" });
      await user.click(box);
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(document.activeElement).toBe(box);
    });
  });

  describe("a held or repeated key on the opener never acknowledges (R376 c)", () => {
    const CONFIRM = "I understand, use my browser session";
    async function openWithSpace(user: ReturnType<typeof userEvent.setup>) {
      const box = screen.getByRole("checkbox", { name: "Use my browser session" });
      box.focus();
      await user.keyboard("[Space]");
      const dialog = await screen.findByRole("dialog", { name: "Use your browser session?" });
      return { box, dialog };
    }

    it("held and doubled Enter after it opens: still open, nothing recorded, focus on the heading", async () => {
      const { m, user } = await setup();
      const { dialog } = await openWithSpace(user);
      await user.keyboard("{Enter>4}{/Enter}{Enter}");
      expect(screen.getByRole("dialog", { name: "Use your browser session?" })).toBe(dialog);
      expect(m.bodies(`POST /projects/${P1}/acknowledge`)).toHaveLength(0);
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Use your browser session?" }));
    });

    it("Tab from the heading reaches the confirming button; Enter there records it exactly once", async () => {
      const { m, user } = await setup();
      const { dialog } = await openWithSpace(user);
      await user.tab();
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: CONFIRM }));
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(m.bodies(`POST /projects/${P1}/acknowledge`)).toHaveLength(1);
    });

    it("Shift+Tab from the heading reaches Cancel; Escape closes it and focus returns to the box", async () => {
      const { user } = await setup();
      const { box, dialog } = await openWithSpace(user);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
      await user.tab(); // back to the first control
      await user.tab({ shift: true });
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(box);
    });
  });

  it("another project asks again", async () => {
    const first = await setup({ acknowledged: [P1] });
    await first.user.click(screen.getByRole("checkbox", { name: "Use my browser session" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    first.view.unmount();
    const { user } = await setup({ acknowledged: [P1] }, P2);
    await user.click(screen.getByRole("checkbox", { name: "Use my browser session" }));
    expect(await screen.findByRole("dialog", { name: "Use your browser session?" })).toBeTruthy();
  });

  it("the service asking for it opens the dialog", async () => {
    const { user } = await setup({
      acknowledged: [P1],
      captureAnswer: () => errorResponse(409, "ACKNOWLEDGEMENT_REQUIRED", COOKIES_ACKNOWLEDGEMENT, "cookies"),
    });
    await paste(user, [YT]);
    await user.click(screen.getByRole("checkbox", { name: "Use my browser session" }));
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    expect(await screen.findByRole("dialog", { name: "Use your browser session?" })).toBeTruthy();
  });
});

describe("Capture screen — progress", () => {
  it("a failed item shows the LOGIN_REQUIRED sentence", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => {
      m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 2, finished: false, outcome: { url: YT, status: "created", sourceId: "s1" } });
      m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 2, total: 2, finished: true, outcome: { url: IG, status: "failed", errorCode: "LOGIN_REQUIRED", reason: "x" } });
    });
    expect(await screen.findByText("This post needs a signed-in session. Try again with “Use my browser session”.")).toBeTruthy();
    expect(screen.getByText("Finished. Of 2 links: 1 done, 1 failed.")).toBeTruthy();
  });

  it("no longer says that captures started earlier or from the extension are not shown (Task 63)", async () => {
    await setup();
    expect(document.body.textContent).not.toMatch(/are not shown here|cannot re-read a running capture/);
  });

  it("on opening, reads the running and recent captures: one started earlier from the extension is shown with its outcomes", async () => {
    const { m } = await setup({
      queues: [
        { ...running(), queueId: "from-ext", startedBy: "extension", done: 1, items: [{ url: YT, status: "created", sourceId: "s1" }] },
        { ...running(), queueId: "old", startedAt: "2026-11-12T09:00:00.000Z", urls: [TT], total: 1, done: 1, finished: true, finishedAt: "2026-11-12T09:01:00.000Z", items: [{ url: TT, status: "duplicate" }] },
      ],
    });
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getAllByRole("region")).toHaveLength(2));
    const [newest, older] = within(queue).getAllByRole("region");
    expect(within(newest!).getByText(/Sent from the browser extension/)).toBeTruthy();
    expect(within(newest!).getByText("Saved")).toBeTruthy();
    expect(within(newest!).getByText("Capturing now")).toBeTruthy();
    expect(within(newest!).getByText("Waiting")).toBeTruthy();
    expect(within(older!).getByText("Already in the project")).toBeTruthy();
    expect(queue.textContent).not.toMatch(/Not known/);
    // One list and one read per queue.
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/captures`)).toHaveLength(1);
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/captures/from-ext`)).toHaveLength(1);
    // Its events then fill it.
    await act(async () => m.emit("capture.progress", { queueId: "from-ext", projectId: P1, done: 2, total: 3, finished: false, outcome: { url: IG, status: "created" } }));
    await waitFor(() => expect(within(newest!).getAllByText("Saved")).toHaveLength(2));
  });

  it("a missing tool in a capture read again keeps its notice with the link to the Optional tools screen", async () => {
    await setup({
      queues: [
        {
          ...running(),
          urls: [YT],
          total: 1,
          done: 1,
          finished: true,
          items: [{ url: YT, status: "failed", errorCode: "TOOL_NOT_INSTALLED", reason: "The video downloader is not installed on this computer, so nothing was saved. Install it from the Optional tools screen, then capture the link again.", tool: "video-downloader" }],
        },
      ],
    });
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getByText(/The video downloader is not installed on this computer/)).toBeTruthy());
    const link = within(queue).getByRole("link", { name: /Optional tools/ });
    expect(link.getAttribute("href")).toMatch(/tool=video-downloader/);
  });

  it("after a reconnect, outcomes missed while the connection was down are read again: no “Not known” is left (Minor O1)", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG, TT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 3, finished: false, outcome: { url: YT, status: "created" } }));
    await waitFor(() => expect(within(queue).getByText("Saved")).toBeTruthy());
    // While the stream is down, link 2 fails; the service knows.
    m.setQueues([{ ...running(), queueId: "q1", done: 2, items: [{ url: YT, status: "created" }, { url: IG, status: "failed", errorCode: "LOGIN_REQUIRED" }] }]);
    await act(async () => m.closeStreams());
    await waitFor(() => expect(within(queue).getByText("Failed")).toBeTruthy());
    expect(within(queue).getByText("Capturing now")).toBeTruthy();
    expect(within(queue).queryByText("Not known")).toBeNull();
    expect(within(queue).queryByText(/Progress was missed/)).toBeNull();
    expect(within(queue).getByText("Of 3 links: 1 done, 1 failed, 1 still to come.")).toBeTruthy();
  });

  it("a read answered after the connection was lost again is dropped; the next one is used", async () => {
    const { m, user } = await setup({ queuesDelayMs: 150 });
    await paste(user, [YT, IG]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(m.queueReads()).toBe(1)); // the opening read
    m.setQueues([{ ...running(), queueId: "q1", urls: [YT, IG], total: 2, done: 1, items: [{ url: YT, status: "created" }] }]);
    // A reconnect starts a read; the stream drops again before it is answered.
    await act(async () => m.closeStreams());
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => m.closeStreams());
    await waitFor(() => expect(m.queueReads()).toBe(2));
    // Answered while the connection was down: not applied.
    expect(within(queue).queryByText("Saved")).toBeNull();
    expect(within(queue).getAllByText("Not known").length).toBeGreaterThan(0);
    // The next connection's read is.
    await waitFor(() => expect(within(queue).getByText("Saved")).toBeTruthy());
    await waitFor(() => expect(within(queue).queryByText("Not known")).toBeNull());
  });

  it("a capture with missed progress that the service no longer knows says so, instead of promising an update (review M2)", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 2, finished: false, outcome: { url: YT, status: "created" } }));
    await waitFor(() => expect(within(queue).getByText("Saved")).toBeTruthy());
    const reads = m.calls.filter((c) => c.path === `/projects/${P1}/captures/q1`).length;
    await act(async () => m.closeStreams());
    // After the reconnect the service lists nothing and does not know q1 (restarted, or forgotten).
    await waitFor(() => expect(m.calls.filter((c) => c.path === `/projects/${P1}/captures/q1`).length).toBeGreaterThan(reads));
    await waitFor(() => expect(within(queue).getByText(/can no longer be read from the library service/)).toBeTruthy());
    expect(within(queue).queryByText(/updated as soon as/)).toBeNull();
    expect(within(queue).getByText("Not known")).toBeTruthy();
  });

  it("an event of an unknown capture while the opening read is on its way: that capture is read once (review M8)", async () => {
    const { m } = await setup({ queuesDelayMs: 200, queues: [{ ...running(), queueId: "x", startedBy: "extension", urls: [YT], total: 1 }] });
    await act(async () => m.emit("capture.progress", { queueId: "x", projectId: P1, done: 0, total: 1, finished: false }));
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getByText(/Sent from the browser extension/)).toBeTruthy());
    await waitFor(() => expect(m.queueReads()).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/captures/x`)).toHaveLength(1);
  });

  it("an event of a capture the screen does not know reads that capture once", async () => {
    const { m } = await setup();
    m.setQueues([{ ...running(), queueId: "elsewhere", startedBy: "extension", urls: [YT], total: 1 }]);
    await act(async () => {
      m.emit("capture.progress", { queueId: "elsewhere", projectId: P1, done: 0, total: 1, finished: false });
      m.emit("capture.progress", { queueId: "elsewhere", projectId: P1, done: 0, total: 1, finished: false });
    });
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getByText(/Sent from the browser extension/)).toBeTruthy());
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/captures/elsewhere`)).toHaveLength(1);
  });

  it("while an ended capture still finishes its download, a new capture is refused in the service's words, without pointing to a queue (fix round 2)", async () => {
    const { user } = await setup({
      captureAnswer: () =>
        errorResponse(409, "CONFLICT", "A capture of this project that was stopped when the project was locked is still finishing its current download, so nothing new was queued. Try again in a moment.", "CAPTURE_STOPPING"),
    });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("A capture of this project that was stopped when the project was locked is still finishing its current download, so nothing new was queued. Try again in a moment.");
  });

  it("the same link while its capture runs: the service's refusal is said in plain words and the running capture is shown", async () => {
    const { m, user } = await setup({
      captureAnswer: () =>
        errorResponse(
          409,
          "CONFLICT",
          "At least one of these links is already waiting or being captured in this project, in a capture that is still running, so nothing new was queued. Wait until that capture has finished, or leave the link out.",
          "CAPTURE_RUNNING",
        ),
    });
    await waitFor(() => expect(m.queueReads()).toBe(1));
    m.setQueues([{ ...running(), queueId: "q0", urls: [YT], total: 1 }]);
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already waiting or being captured in this project/);
    expect(alert.textContent).not.toMatch(/CAPTURE_RUNNING|Something changed/);
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getByText("Capturing now")).toBeTruthy());
    expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1);
  });

  it("reconnects after a gap; a link whose outcome was missed is not known, and the gap is explained", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG, TT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 3, finished: false, outcome: { url: YT, status: "created" } }));
    await act(async () => m.closeStreams());
    // done=2 is published while the stream is down: missed.
    await waitFor(() => expect(m.streams()).toBe(1));
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 3, total: 3, finished: true, outcome: { url: TT, status: "created" } }));
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getByText("Finished. Of 3 links: 2 done, 1 not known.")).toBeTruthy());
    expect(within(within(queue).getAllByRole("listitem")[1]!).getByText("Not known")).toBeTruthy();
    expect(within(queue).getByText(/Progress was missed while the connection to the library service was down/)).toBeTruthy();
    expect(queue.textContent).not.toMatch(/not tried|3 of 3/);
    expect(screen.queryByText(/Progress updates are not available right now/)).toBeNull();
  });

  it("a run whose last event is missed does not say “Capturing now” for ever (review N1)", async () => {
    const { m, user } = await setup();
    await paste(user, [YT, IG, TT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 3, finished: false, outcome: { url: YT, status: "created" } }));
    await waitFor(() => expect(within(queue).getByText("Saved")).toBeTruthy());
    await act(async () => m.closeStreams());
    await waitFor(() => expect(within(queue).getByText("Of 3 links: 1 done, 2 not known.")).toBeTruthy());
    expect(within(queue).queryByText(/Capturing now|Waiting/)).toBeNull();
    expect(queue.textContent).not.toMatch(/still to come/);
    expect(within(queue).getAllByText("Not known")).toHaveLength(2);
    expect(within(queue).getByText(/Progress was missed while the connection to the library service was down/)).toBeTruthy();
  });

  it("a legal-basis refusal of a queue this screen did not start does not open the field (review M7)", async () => {
    const { m } = await setup({ governance: { [P1]: ANON_RULES } });
    await act(async () => {
      m.emit("capture.progress", { queueId: "from-the-extension", projectId: P1, done: 1, total: 1, finished: true, outcome: { url: YT, status: "failed", errorCode: "LEGAL_BASIS_REQUIRED" } });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole("textbox", { name: "Legal basis" })).toBeNull();
  });

  it("keeps reconnecting over the screen's life when each reconnection works (review M4)", async () => {
    const { m } = await setup();
    for (let i = 0; i < 4; i++) {
      await act(async () => m.closeStreams());
      await waitFor(() => expect(m.streams()).toBe(1));
    }
    expect(screen.queryByText(/Progress updates are not available right now/)).toBeNull();
  });

  it("an unknown outcome code gets a safe sentence", async () => {
    const { m, user } = await setup();
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 1, finished: true, outcome: { url: YT, status: "failed", errorCode: "QUANTUM_FLUX" } }));
    expect(await screen.findByText(/for a reason this version of the app does not recognise/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/QUANTUM_FLUX/);
  });

  it("events of another project, another queue or malformed ones are dropped", async () => {
    const { m, user } = await setup();
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => {
      m.emit("capture.progress", { queueId: "q1", projectId: P2, done: 1, total: 1, finished: true, outcome: { url: YT, status: "failed", errorCode: "LOGIN_REQUIRED" } });
      m.emit("capture.progress", { queueId: "other", projectId: P1, done: 1, total: 1, finished: true, outcome: { url: YT, status: "failed", errorCode: "LOGIN_REQUIRED" } });
      m.emit("capture.progress", { queueId: "q1", projectId: P1, done: "1", finished: true });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText(/This post needs a signed-in session/)).toBeNull();
    expect(screen.getByText("Capturing now")).toBeTruthy();
  });

  it("an event that arrives before the queue's id is known is kept for it", async () => {
    let emitEarly: () => void = () => {};
    const { m, user } = await setup({
      captureDelayMs: 60,
    });
    emitEarly = () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 1, finished: true, outcome: { url: YT, status: "created" } });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      emitEarly();
    });
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    await waitFor(() => expect(within(queue).getByText("Saved")).toBeTruthy());
  });

  it("after unmount, the event stream is closed and late answers and events are dropped", async () => {
    const errors = vi.spyOn(console, "error");
    const { m, user, view } = await setup({ captureDelayMs: 60 });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    view.unmount();
    await waitFor(() => expect(m.streams()).toBe(0));
    await act(async () => {
      m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 1, finished: true, outcome: { url: YT, status: "created" } });
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("Capture screen — legal basis (R41)", () => {
  it("asks for one where the project requires it and has no default; nothing is sent without it", async () => {
    const { m, user } = await setup({ governance: { [P1]: STRICT_RULES } });
    const field = screen.getByRole("textbox", { name: "Legal basis" });
    expect(field.getAttribute("aria-required")).toBe("true");
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    const err = await screen.findByText(/Enter the legal basis for this capture/);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(err.id);
    expect(document.activeElement).toBe(field);
    expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(0);
    await user.type(field, "Consent (GDPR Art. 6(1)(a))");
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture`)[0]).toEqual({ urls: [YT], options: { transcribeModel: "medium", legalBasis: "Consent (GDPR Art. 6(1)(a))" } });
  });

  it("names the project's default when there is one; typing one overrides it", async () => {
    await setup();
    expect(screen.getByText(/Leave it empty to use the project's default/)).toBeTruthy();
    expect(screen.getByText("Public task (GDPR Art. 6(1)(e))").getAttribute("dir")).toBe("auto");
    expect(screen.getByRole("textbox", { name: "Legal basis" }).getAttribute("aria-required")).toBe("false");
  });

  it("is not asked for when the project's data does not identify people", async () => {
    await setup({ governance: { [P1]: ANON_RULES } });
    expect(screen.queryByRole("textbox", { name: "Legal basis" })).toBeNull();
  });

  it("a LEGAL_BASIS_REQUIRED refusal is explained and the field is offered", async () => {
    const { m, user } = await setup({ governance: { [P1]: ANON_RULES } });
    await paste(user, [YT]);
    await user.click(screen.getByRole("button", { name: "Capture links" }));
    await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => m.emit("capture.progress", { queueId: "q1", projectId: P1, done: 1, total: 1, finished: true, outcome: { url: YT, status: "failed", errorCode: "LEGAL_BASIS_REQUIRED" } }));
    expect((await screen.findAllByText(/need a legal basis for social-media data that can identify people/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Legal basis" })).toBeTruthy();
  });
});

describe("Capture screen — profile", () => {
  it("sends the profile form; comments are off by default and explained; R43 notice", async () => {
    const { m, user } = await setup();
    await user.type(screen.getByRole("textbox", { name: "Profile, channel or playlist link" }), PROFILE);
    expect(screen.getByText("Instagram — whole profile")).toBeTruthy();
    const comments = screen.getByRole("checkbox", { name: "Include comments" });
    expect((comments as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Comments are other people's personal data/)).toBeTruthy();
    // R43: said before a limit is set, and again once it is.
    const max = screen.getByRole("spinbutton", { name: "Maximum number of items" });
    expect(max.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(max.getAttribute("aria-describedby")!.split(" ")[0]!)!.textContent).toMatch(/turns off removed-item detection/);
    await user.type(max, "25");
    expect(screen.getByText(/With a maximum of 25 items, removed-item detection is off for this capture/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Posts from"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Posts until"), { target: { value: "2026-06-30" } });
    await user.click(screen.getByRole("checkbox", { name: "Reels" }));
    await user.click(screen.getByRole("checkbox", { name: "Metadata only" }));
    await captureAndStart(user);
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    // The estimate is asked with the form's options; Start sends them with an explicit transcription choice (the
    // project's switch, off here) and, for metadata only, no quality (whole channels, Task 8).
    expect(m.bodies(`POST /projects/${P1}/capture-estimate`)).toEqual([
      { url: PROFILE, options: { transcribeModel: "medium", since: "2026-01-01", until: "2026-06-30", maxItems: 25, contentTypes: ["reels"], metadataOnly: true } },
    ]);
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)[0]).toEqual({
      url: PROFILE,
      options: { since: "2026-01-01", until: "2026-06-30", maxItems: 25, contentTypes: ["reels"], metadataOnly: true },
    });
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    expect(within(queue).getByText(PROFILE)).toBeTruthy();
  });

  it("never refuses an address on the preview's say-so: it is sent and the service decides (R146)", async () => {
    const { m, user } = await setup();
    const box = screen.getByRole("textbox", { name: "Profile, channel or playlist link" });
    await user.type(box, YT);
    expect(screen.getByText(/looks like a single post.*the app will check it/)).toBeTruthy();
    await captureAndStart(user);
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    await user.type(box, "https://www.youtube.com/something-new/abc");
    expect(screen.getByText(/Not recognised here.*the app will check it/)).toBeTruthy();
    await captureAndStart(user);
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(2));
    // The service's refusal shows in the queue.
    await act(async () =>
      m.emit("capture.progress", {
        queueId: "qp1",
        projectId: P1,
        finished: true,
        report: { status: "failed", listComplete: false, created: 0, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, reappeared: 0, edited: 0, items: [], errorCode: "UNSUPPORTED_URL", reason: "This link is not a YouTube, Instagram or TikTok post, so the downloader cannot capture it." },
      }),
    );
    expect(await screen.findByText("This link is not a YouTube, Instagram or TikTok post, so the downloader cannot capture it.")).toBeTruthy();
  });

  it("refuses dates in the wrong order", async () => {
    const { m, user } = await setup();
    await user.type(screen.getByRole("textbox", { name: "Profile, channel or playlist link" }), PROFILE);
    fireEvent.change(screen.getByLabelText("Posts from"), { target: { value: "2026-06-30" } });
    fireEvent.change(screen.getByLabelText("Posts until"), { target: { value: "2026-01-01" } });
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    expect(await screen.findByText(/“Posts from” must be on or before “Posts until”/)).toBeTruthy();
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
  });

  it("comments need a legal basis even with no rule asking for one", async () => {
    const { m, user } = await setup({ governance: { [P1]: ANON_RULES } });
    await user.type(screen.getByRole("textbox", { name: "Profile, channel or playlist link" }), PROFILE);
    await user.click(screen.getByRole("checkbox", { name: "Include comments" }));
    const field = screen.getByRole("textbox", { name: "Legal basis" });
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    expect(await screen.findByText(/Enter the legal basis for this capture/)).toBeTruthy();
    expect(m.bodies(`POST /projects/${P1}/capture-estimate`)).toHaveLength(0);
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
    await user.type(field, "Legitimate interests");
    await captureAndStart(user);
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)[0]).toEqual({
      url: PROFILE,
      options: { transcribeModel: "medium", quality: "720p", includeComments: true, legalBasis: "Legitimate interests" },
    });
  });

  it("the work lines are shown for the open project", async () => {
    const bg = mockBackground({ runs: [exampleRun({ projectId: P1, state: "interrupted" }), exampleRun({ projectId: P2, runId: "run-9", title: "Other Channel" })], lists: { [P1]: idleList(P1, { state: "paused", total: 412, done: 14 }) }, noEvents: true }, BASE);
    const m = mockCapture({ extra: bg.handlers });
    render(<Capture client={m.client} projectId={P1} />);
    const lines = await screen.findByRole("region", { name: "Downloads and transcriptions" });
    expect(await within(lines).findByText((_c, el) => el?.textContent === "The capture of 'Example Channel' was interrupted: 120 of 412 done." && el.tagName === "P")).toBeTruthy();
    expect(within(lines).getByText("Transcriptions paused: 14 of 412 done.", { ignore: ".ao-visually-hidden" })).toBeTruthy();
    expect(within(lines).getByRole("button", { name: "Resume downloads (292 did not complete) The capture of 'Example Channel' was interrupted: 120 of 412 done." })).toBeTruthy();
    expect(within(lines).queryByText(/Other Channel/)).toBeNull();
    expect(bg.count(`GET /projects/${P2}/downloads`)).toBe(0);
  });

  it("a profile capture started here shows its run in the work lines, from an event on the screen's own stream", async () => {
    const bg = mockBackground({ noEvents: true }, BASE);
    const { m, user } = await setup({ extra: bg.handlers });
    await waitFor(() => expect(bg.count(`GET /projects/${P1}/downloads`)).toBeGreaterThanOrEqual(1));
    expect(screen.queryByRole("region", { name: "Downloads and transcriptions" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Profile, channel or playlist link" }), PROFILE);
    await captureAndStart(user);
    // The service publishes the new run on the one stream the screen has (R679 A2).
    m.emit("background.progress", { projectId: P1, downloads: exampleRun({ projectId: P1, runId: "qp1", title: "someone", url: PROFILE, platform: "instagram", state: "downloading", total: 0, done: 0 }) });
    const lines = await screen.findByRole("region", { name: "Downloads and transcriptions" });
    expect(await within(lines).findByText((_c, el) => el?.textContent === 'Downloading "someone": reading the list of posts…' && el.tagName === "P", { ignore: ".ao-visually-hidden" })).toBeTruthy();
    // Still one stream: the lines follow the screen's.
    expect(m.streams()).toBe(1);
    expect(m.calls.filter((c) => c.path === "/events")).toHaveLength(1);
  });

  it("a profile run's posts and summary appear as its events arrive", async () => {
    const { m, user } = await setup();
    await user.type(screen.getByRole("textbox", { name: "Profile, channel or playlist link" }), PROFILE);
    await captureAndStart(user);
    await screen.findByRole("region", { name: "Capture queue" });
    await act(async () => {
      m.emit("capture.progress", { queueId: "qp1", projectId: P1, done: 1, total: 1, finished: false, outcome: { url: IG, status: "created" } });
      m.emit("capture.progress", {
        queueId: "qp1",
        projectId: P1,
        finished: true,
        report: { status: "completed", listComplete: true, created: 1, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 2, reappeared: 0, edited: 0, items: [] },
      });
    });
    expect(await screen.findByText(/1 new post saved.*2 posts no longer on the platform/)).toBeTruthy();
  });
});

describe("Capture screen — the estimate before a profile is captured (whole channels, Task 8)", () => {
  const HEADING = 'Capture channel: "Example Channel"';
  const YT_CHANNEL = "https://www.youtube.com/@examplechannel";

  /** A promise the test releases (and releases by itself when the test ends). */
  function held() {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    return { p, release };
  }

  it("asks for the list first, then shows the estimate in place of the form's buttons", async () => {
    const gate = held();
    const { m, user } = await setup({ estimateHold: gate.p });
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    expect(await screen.findByText("Asking YouTube for the list of videos…")).toBeTruthy();
    expect(screen.getByText("Asking YouTube for the list of videos…").closest("[role=status]")).not.toBeNull();
    await act(async () => gate.release());
    const region = await screen.findByRole("region", { name: HEADING });
    expect(within(region).getByText("412 videos, about 310 hours.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Capture profile" })).toBeNull();
    expect(screen.queryByText("Asking YouTube for the list of videos…")).toBeNull();
    // Nothing is started before Start.
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
    expect(m.bodies(`POST /projects/${P1}/capture-estimate`)).toEqual([{ url: YT_CHANNEL, options: { transcribeModel: "medium" } }]);
  });

  it("the heading takes focus when the estimate appears", async () => {
    const { user } = await setup();
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    const heading = await screen.findByRole("heading", { level: 3, name: HEADING });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("the Transcribe box starts from the project's switch and names the speech model", async () => {
    const { m, user } = await setup({ automation: { [P1]: true }, estimateAnswer: () => exampleEstimate({ speechModel: "small" }) });
    await user.selectOptions(screen.getByRole("combobox", { name: "Transcription model" }), "small");
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    const box = (await screen.findByRole("checkbox", { name: "Transcribe each video on this Mac (speech model: small)" })) as HTMLInputElement;
    // "Use the project's setting", and the project's switch is on (read beside the estimate, R683 C2).
    await waitFor(() => expect(box.checked).toBe(true));
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/automation`)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // "Do not transcribe" above starts it unticked, without asking the project.
    await user.click(screen.getByRole("radio", { name: "Do not transcribe" }));
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    expect(((await screen.findByRole("checkbox", { name: /Transcribe each video on this Mac/ })) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // "Transcribe" starts it ticked.
    await user.click(screen.getByRole("radio", { name: "Transcribe" }));
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    expect(((await screen.findByRole("checkbox", { name: /Transcribe each video on this Mac/ })) as HTMLInputElement).checked).toBe(true);
    expect(m.calls.filter((c) => c.path === `/projects/${P1}/automation`)).toHaveLength(1);
    // The hint says what "Use the project's setting" follows.
    expect(screen.getByText("“Use the project's setting” follows the project's switch “Transcribe captured audio and video automatically”, on the Governance screen.")).toBeTruthy();
    expect(screen.queryByText(/A profile capture transcribes only when/)).toBeNull();
  });

  it("Start sends the quality and the transcription choice once, however often it is pressed", async () => {
    const { m, user } = await setup({ profileDelayMs: 80 });
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    await user.click(await screen.findByRole("radio", { name: "Audio only" }));
    await user.click(screen.getByRole("checkbox", { name: /Transcribe each video on this Mac/ }));
    // Two presses in the same tick, before any re-render can disable the button: only the synchronous guard holds (R683 E1).
    const startButton = screen.getByRole("button", { name: "Start" });
    act(() => {
      fireEvent.click(startButton);
      fireEvent.click(startButton);
    });
    await screen.findByRole("region", { name: "Capture queue" });
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toEqual([{ url: YT_CHANNEL, options: { transcribe: true, transcribeModel: "medium", quality: "audio" } }]);
    // The queue is added as today, the region closes and focus returns to the profile field, emptied.
    expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
    expect(document.activeElement).toBe(profileBox());
    expect((profileBox() as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Capture profile" })).toBeTruthy();
  });

  it("without Video tools, Start sends the ready-made file", async () => {
    const { m, user } = await setup({ estimateAnswer: () => exampleEstimate({ videoToolsInstalled: false }) });
    await user.type(profileBox(), YT_CHANNEL);
    await captureAndStart(user);
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)[0]).toEqual({ url: YT_CHANNEL, options: { transcribeModel: "medium", quality: "ready" } });
  });

  it("Cancel goes back with focus on the profile field", async () => {
    const { m, user } = await setup();
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
    expect(document.activeElement).toBe(profileBox());
    expect((profileBox() as HTMLInputElement).value).toBe(YT_CHANNEL);
    expect(screen.getByRole("button", { name: "Capture profile" })).toBeTruthy();
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
  });

  it("a refusal shows the service's sentence", async () => {
    const { m, user } = await setup({
      estimateAnswer: () => errorResponse(403, "POLICY_DENIED", "This project's rules do not allow that.", "The downloader is not among this project's capture methods."),
    });
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/The downloader is not among this project's capture methods\./);
    expect(alert.textContent).not.toMatch(/POLICY_DENIED/);
    expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
    expect(screen.getByRole("button", { name: "Capture profile" })).toBeTruthy();
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
  });

  it("a refusal of Start for missing Video tools names them with the link, and keeps the estimate (R685)", async () => {
    const SAID = "Video tools are not installed, so this quality cannot be downloaded. Install them from the Optional tools screen, or choose “Ready-made file (lower quality)”.";
    const { user } = await setup({ profileAnswer: () => errorResponse(409, "TOOL_NOT_INSTALLED", SAID, "ffmpeg") });
    await user.type(profileBox(), YT_CHANNEL);
    await captureAndStart(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The video tools (ffmpeg) are not installed on this computer. Until they are, videos can be downloaded only as ready-made, lower-quality files and get no viewing copies, and media that carries a location stays “proxy pending” and is left out of exports.",
    );
    expect(within(alert).getByRole("link", { name: "Install it from the Optional tools screen" }).getAttribute("href")).toBe("/settings/tools?tool=ffmpeg");
    expect(screen.getByRole("region", { name: HEADING })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Capture queue" })).toBeNull();
  });

  it("a refusal of Start for a missing downloader names that tool (R685)", async () => {
    const { user } = await setup({ profileAnswer: () => errorResponse(409, "TOOL_NOT_INSTALLED", "A tool this needs is not installed on this computer.", "video-downloader") });
    await user.type(profileBox(), YT_CHANNEL);
    await captureAndStart(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The video downloader is not installed on this computer, so videos cannot be saved from the web.");
    expect(within(alert).getByRole("link", { name: "Install it from the Optional tools screen" }).getAttribute("href")).toBe("/settings/tools?tool=video-downloader");
    expect(screen.getByRole("region", { name: HEADING })).toBeTruthy();
  });

  describe("an estimate is only ever started for what the screen shows (R683 B)", () => {
    const CHANGED = "The settings changed, so the estimate was closed. Press “Capture profile” to see it again.";
    const OLD = "https://www.youtube.com/@old";
    const NEW = "https://www.youtube.com/@new";

    it("an address changed while the list is asked for: the old one's estimate is never shown, nothing is sent, the new address stays", async () => {
      const gate = held();
      const { m, user } = await setup({ estimateHold: gate.p });
      await user.type(profileBox(), OLD);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await waitFor(() => expect(m.estimateRequests()).toHaveLength(1));
      await user.clear(profileBox());
      await user.type(profileBox(), NEW);
      // The request still out is cancelled.
      expect(m.estimateRequests()[0]!.signal.aborted).toBe(true);
      await act(async () => gate.release());
      await waitFor(() => expect(m.settled(`POST /projects/${P1}/capture-estimate`)).toBe(1));
      await act(async () => {});
      expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
      expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
      expect((profileBox() as HTMLInputElement).value).toBe(NEW);
      expect(screen.getAllByText(CHANGED)).toHaveLength(1);
      expect(screen.getByText(CHANGED).closest("[role=status]")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Capture profile" })).toBeTruthy();
    });

    it("an option changed under an open estimate closes it, said once; a new estimate then sends what the form shows", async () => {
      const { m, user } = await setup();
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByRole("region", { name: HEADING });
      const status = screen.getByRole("button", { name: "Start" }).closest("form")!.querySelector("[role=status]");
      // The status region is there before its sentence.
      expect(status).not.toBeNull();
      expect(status!.textContent).toBe("");
      await user.click(screen.getByRole("checkbox", { name: "Metadata only" }));
      expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
      expect(screen.getAllByText(CHANGED)).toHaveLength(1);
      expect(status!.textContent).toBe(CHANGED);
      await captureAndStart(user);
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      const sent = m.bodies(`POST /projects/${P1}/capture-profile`)[0] as { url: string; options: Record<string, unknown> };
      expect(sent.url).toBe(YT_CHANNEL);
      expect(sent.options.metadataOnly).toBe(true);
      expect("quality" in sent.options).toBe(false);
    });

    it("the Transcription choice changed under an open estimate closes it", async () => {
      const { m, user } = await setup();
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByRole("region", { name: HEADING });
      await user.click(screen.getByRole("radio", { name: "Do not transcribe" }));
      expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
      expect(screen.getAllByText(CHANGED)).toHaveLength(1);
      expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
    });
  });

  describe("the project's switch is never overridden by a failed read (R683 C)", () => {
    const NOT_READ = "The project's switch for automatic transcription could not be read. This capture follows the switch as it stands, unless you tick the box.";
    const box = () => screen.getByRole("checkbox", { name: /Transcribe each video on this Mac/ }) as HTMLInputElement;
    const sent = (m: ReturnType<typeof mockCapture>) => m.bodies(`POST /projects/${P1}/capture-profile`)[0] as { url: string; options: Record<string, unknown> };

    it("the switch cannot be read: the box starts unticked and says so; untouched, Start leaves transcription to the service", async () => {
      const { m, user } = await setup({ automation: { [P1]: true }, automationAnswer: () => errorResponse(500, "INTERNAL", "Something went wrong.") });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByRole("region", { name: HEADING });
      expect(await screen.findByText(NOT_READ)).toBeTruthy();
      expect(box().checked).toBe(false);
      expect(document.getElementById(box().getAttribute("aria-describedby")!)!.textContent).toBe(NOT_READ);
      await user.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect("transcribe" in sent(m).options).toBe(false);
    });

    it("the switch cannot be read and the box is ticked: transcribe: true", async () => {
      const { m, user } = await setup({ automationAnswer: () => errorResponse(500, "INTERNAL", "Something went wrong.") });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByText(NOT_READ);
      await user.click(box());
      await user.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect(sent(m).options).toEqual({ transcribe: true, transcribeModel: "medium", quality: "720p" });
    });

    it("a switch slower than the estimate never holds it back; the box follows it when it comes", async () => {
      const gate = held();
      const { m, user } = await setup({ automation: { [P1]: true }, automationHold: gate.p });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByRole("region", { name: HEADING });
      expect(m.settled(`GET /projects/${P1}/automation`)).toBe(0);
      expect(box().checked).toBe(false);
      await act(async () => gate.release());
      await waitFor(() => expect(box().checked).toBe(true));
      expect(screen.queryByText(NOT_READ)).toBeNull();
      // Untouched: the service applies the switch as it stands.
      await user.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect("transcribe" in sent(m).options).toBe(false);
    });

    it("“Do not transcribe” above is sent as transcribe: false", async () => {
      const { m, user } = await setup({ automation: { [P1]: true } });
      await user.click(screen.getByRole("radio", { name: "Do not transcribe" }));
      await user.type(profileBox(), YT_CHANNEL);
      await captureAndStart(user);
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect(sent(m).options).toEqual({ transcribe: false, quality: "720p" });
    });

    it("the box changed from the switch is sent explicitly", async () => {
      const { m, user } = await setup({ automation: { [P1]: true } });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByRole("region", { name: HEADING });
      await waitFor(() => expect(box().checked).toBe(true));
      await user.click(box());
      await user.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect(sent(m).options.transcribe).toBe(false);
      expect("transcribeModel" in sent(m).options).toBe(false);
    });

    it("the model sent is the one the estimate names", async () => {
      const { m, user } = await setup();
      await user.selectOptions(screen.getByRole("combobox", { name: "Transcription model" }), "small");
      await user.click(screen.getByRole("radio", { name: "Do not transcribe" }));
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      // Asked without a model, the estimate names the service's (medium).
      await user.click(await screen.findByRole("checkbox", { name: "Transcribe each video on this Mac (speech model: medium)" }));
      await user.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect(sent(m).options).toEqual({ transcribe: true, transcribeModel: "medium", quality: "720p" });
    });

    it("metadata only: no box, and transcription is never sent as true", async () => {
      const { m, user } = await setup();
      await user.click(screen.getByRole("radio", { name: "Transcribe" }));
      await user.click(screen.getByRole("checkbox", { name: "Metadata only" }));
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByRole("region", { name: HEADING });
      expect(screen.queryByRole("checkbox", { name: /Transcribe each video on this Mac/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Start" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
      expect(sent(m).options.transcribe).not.toBe(true);
      expect("transcribeModel" in sent(m).options).toBe(false);
    });
  });

  describe("the listing can be given up, and locks nothing else (R683 D)", () => {
    const LISTING = "Asking YouTube for the list of videos…";

    it("Cancel during the listing cancels the request, drops its answer and puts focus on the profile field", async () => {
      const gate = held();
      const { m, user } = await setup({ estimateHold: gate.p });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      const status = (await screen.findByText(LISTING)).closest("[role=status]")!;
      await waitFor(() => expect(m.estimateRequests()).toHaveLength(1));
      const request = m.estimateRequests()[0]!;
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(request.signal.aborted).toBe(true);
      expect(document.activeElement).toBe(profileBox());
      expect(status.isConnected).toBe(true);
      expect(status.textContent).toBe("");
      await act(async () => gate.release());
      await waitFor(() => expect(m.settled(`POST /projects/${P1}/capture-estimate`)).toBe(1));
      await act(async () => {});
      expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Capture profile" })).toBeTruthy();
      expect((profileBox() as HTMLInputElement).value).toBe(YT_CHANNEL);
    });

    it("once the first-read limit has passed with no list, the status says it is still asking", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const gate = held();
      const m = mockCapture({ estimateHold: gate.p });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Capture client={m.client} projectId={P1} firstReadMs={10_000} />);
      await screen.findByRole("button", { name: "Capture links" });
      await waitFor(() => expect(screen.queryByText(/Reading this project's rules/)).toBeNull());
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      const status = (await screen.findByText(LISTING)).closest("[role=status]")!;
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(status.textContent).toBe("Still asking YouTube for the list. A long list can take a few minutes.");
      // No hard limit: the request is still out, and Cancel still gives it up.
      expect(m.estimateRequests()[0]!.signal.aborted).toBe(false);
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    });

    it("an address the preview cannot place still gets words and Cancel, and the slow words after the limit (R685)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const gate = held();
      const m = mockCapture({ estimateHold: gate.p });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Capture client={m.client} projectId={P1} firstReadMs={10_000} />);
      await screen.findByRole("button", { name: "Capture links" });
      await waitFor(() => expect(screen.queryByText(/Reading this project's rules/)).toBeNull());
      await user.type(profileBox(), "https://example.org/someone");
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      const status = (await screen.findByText("Asking the platform for the list…")).closest("[role=status]")!;
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(status.textContent).toBe("Still asking the platform for the list. A long list can take a few minutes.");
    });

    it("“Capture links” works while an estimate is asked for and while one is open", async () => {
      const gate = held();
      const { m, user } = await setup({ estimateHold: gate.p });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      await screen.findByText(LISTING);
      await paste(user, [YT]);
      await user.click(screen.getByRole("button", { name: "Capture links" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(1));
      expect(screen.getByText(LISTING)).toBeTruthy();
      await act(async () => gate.release());
      await screen.findByRole("region", { name: HEADING });
      await waitFor(() => expect((links() as HTMLTextAreaElement).value).toBe(""));
      await paste(user, [IG]);
      await user.click(screen.getByRole("button", { name: "Capture links" }));
      await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture`)).toHaveLength(2));
      expect((m.bodies(`POST /projects/${P1}/capture`)[1] as { urls: string[] }).urls).toEqual([IG]);
      expect(screen.getByRole("region", { name: HEADING })).toBeTruthy();
    });

    it("an estimate refused for a missing tool names the tool, with its link to the Optional tools screen", async () => {
      const { user } = await setup({
        estimateAnswer: () =>
          errorResponse(409, "TOOL_NOT_INSTALLED", "A tool this needs is not installed on this computer, so nothing was saved. Install it from the Optional tools screen, then try again.", "video-downloader"),
      });
      await user.type(profileBox(), YT_CHANNEL);
      await user.click(screen.getByRole("button", { name: "Capture profile" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("The video downloader is not installed on this computer, so videos cannot be saved from the web.");
      expect(within(alert).getByRole("link", { name: "Install it from the Optional tools screen" }).getAttribute("href")).toBe("/settings/tools?tool=video-downloader");
    });
  });

  it("an answer after the project changed is dropped", async () => {
    const gate = held();
    const { m, user, view } = await setup({ estimateHold: gate.p });
    await user.type(profileBox(), YT_CHANNEL);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-estimate`)).toHaveLength(1));
    view.rerender(<Capture client={m.client} projectId={P2} />);
    await act(async () => gate.release());
    // The held answer has reached the screen (R683 E2).
    await waitFor(() => expect(m.settled(`POST /projects/${P1}/capture-estimate`)).toBe(1));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: HEADING })).toBeNull();
    expect(screen.queryByText("Asking YouTube for the list of videos…")).toBeNull();
    expect(m.bodies(`POST /projects/${P2}/capture-profile`)).toHaveLength(0);
  });
});

describe("Capture route", () => {
  it("opens the project named in the address; an unknown one opens none", async () => {
    const m = mockCapture();
    const first = render(<CaptureRoute client={m.client} loc={{ pathname: "/capture", search: `?project=${P2}` }} />);
    await waitFor(() => expect(m.calls.some((c) => c.path === `/projects/${P2}/governance`)).toBe(true));
    expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe(P2);
    first.unmount();
    render(<CaptureRoute client={m.client} loc={{ pathname: "/capture", search: "?project=019a6f00-0000-7000-8000-0000000000ff" }} />);
    expect(await screen.findByText(/not one of this library's projects/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Capture links" })).toBeNull();
  });
});

describe("Capture screen — capture tools", () => {
  it("shows the tools' versions and updates them, old → new", async () => {
    const { m, user } = await setup({ updateDelayMs: 80 });
    const tools = screen.getByRole("region", { name: "Capture tools" });
    await within(tools).findByText("2026.10.01");
    expect(within(tools).getByText("1.32.19")).toBeTruthy();
    await user.dblClick(within(tools).getByRole("button", { name: "Update capture tools" }));
    expect(await within(tools).findByText("yt-dlp: 2026.10.01 → 2026.11.01")).toBeTruthy();
    expect(within(tools).getByText(/gallery-dl 1\.32\.19 is the image downloader; it is installed and updated from the Optional tools screen/)).toBeTruthy();
    expect(m.bodies("POST /tools/update")).toHaveLength(1);
  });

  it("a missing tool is explained in plain words", async () => {
    await setup({ versions: { yt_dlp: null, gallery_dl: "1.32.19", ffmpeg: null } });
    const tools = screen.getByRole("region", { name: "Capture tools" });
    // Nothing downloads by itself (R156): the video downloader is installed from the tools screen.
    expect(await within(tools).findByText("Not installed. Install it from the Optional tools screen.")).toBeTruthy();
    expect(within(tools).getByText(/Not installed on this computer/)).toBeTruthy();
  });

  it("an unexpected failure (500) and a helper that is not running are said plainly", async () => {
    const { user } = await setup({
      versionsAnswer: () => errorResponse(503, "WORKER_UNAVAILABLE", "The media helper is not running.", "The media helper is not set up yet. Run `pnpm setup:py` once, then try again."),
      // An error the service does not know: 500 INTERNAL with its generic message.
      updateAnswer: () => errorResponse(500, "INTERNAL", "Something went wrong. Nothing was changed by this request unless it says otherwise."),
    });
    const tools = screen.getByRole("region", { name: "Capture tools" });
    expect(await within(tools).findByText(/media helper is not running/)).toBeTruthy();
    expect(tools.textContent).not.toMatch(/setup:py/);
    await user.click(within(tools).getByRole("button", { name: "Update capture tools" }));
    const alert = await within(tools).findByRole("alert");
    expect(alert.textContent).toMatch(/^The capture tools could not be updated\./);
    expect(alert.textContent).toMatch(/Something went wrong\. Nothing was changed/);
  });

  it("a failed update with a tool code is explained, the code never shown", async () => {
    const { user } = await setup({ updateAnswer: () => errorResponse(502, "TOOLS_UPDATE_FAILED", "The capture tools could not be updated.", "TOOL_CHECKSUM_MISMATCH") });
    const tools = screen.getByRole("region", { name: "Capture tools" });
    await user.click(within(tools).getByRole("button", { name: "Update capture tools" }));
    expect(await within(tools).findByText(/did not match its published checksum/)).toBeTruthy();
    expect(tools.textContent).not.toMatch(/TOOL_CHECKSUM_MISMATCH/);
  });

  it("a failed update as the service sends it (502 TOOL_FAILED with the helper's code) is explained (Task 63)", async () => {
    const { user } = await setup({
      updateAnswer: () => errorResponse(502, "TOOL_FAILED", "The tool could not be installed or updated. Nothing was left half-installed; try again later.", "TOOL_UPDATE_FAILED"),
    });
    const tools = screen.getByRole("region", { name: "Capture tools" });
    await user.click(within(tools).getByRole("button", { name: "Update capture tools" }));
    const alert = await within(tools).findByRole("alert");
    expect(alert.textContent).toBe("The downloader tool could not be updated. Try again later.");
  });
});

describe("Capture screen — what a lock cut (FR-370, FR-371; R464 b)", () => {
  const MANY =
    "A lock stopped 3 links in this project from being captured. The links were not kept while the project was locked: add them again to capture them.";
  const ONE = "A lock stopped 1 link in this project from being captured. The link was not kept while the project was locked: add it again to capture it.";
  const ACK = `/projects/${P1}/captures/cut-by-lock/acknowledge`;

  it("says how many links a lock cut, as a status, and 'Got it' acknowledges it once and moves focus to the links field", async () => {
    const { m, user } = await setup({ cutByLock: { [P1]: 3 } });
    const note = await screen.findByText(MANY);
    expect(note.closest("[role=status]")).not.toBeNull();
    const got = screen.getByRole("button", { name: "Got it" });
    await user.dblClick(got);
    await waitFor(() => expect(screen.queryByText(MANY)).toBeNull());
    expect(m.calls.filter((c) => c.method === "POST" && c.path === ACK)).toHaveLength(1);
    expect(document.activeElement).toBe(links());
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
  });

  it("one link: the sentence is in the singular", async () => {
    await setup({ cutByLock: { [P1]: 1 } });
    expect(await screen.findByText(ONE)).toBeTruthy();
  });

  it("nothing is shown when no lock cut anything, or for another project", async () => {
    await setup({ cutByLock: { [P2]: 4 } });
    expect(screen.queryByText(/A lock stopped the capture/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
  });

  it("an acknowledgement that fails keeps the reminder and says so plainly", async () => {
    const { user } = await setup({ cutByLock: { [P1]: 3 }, cutAckAnswer: () => errorResponse(503, "UNAVAILABLE", "The library service is busy. Try again in a moment.") });
    await user.click(await screen.findByRole("button", { name: "Got it" }));
    expect(await screen.findByText(/The library service is busy/)).toBeTruthy();
    expect(screen.getByText(MANY)).toBeTruthy();
  });
});
