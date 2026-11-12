import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COOKIES_ACKNOWLEDGEMENT } from "../api/capture";
import { ANON_RULES, errorResponse, mockCapture, P1, P2, server, STRICT_RULES, type CaptureSetup } from "../test/captureService";
import { Capture, CaptureRoute } from "./Capture";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const IG = "https://www.instagram.com/p/Cabc123/";
const TT = "https://www.tiktok.com/@someone/video/7234567890";
const PROFILE = "https://www.instagram.com/someone/";

async function setup(o: CaptureSetup = {}, projectId = P1) {
  const m = mockCapture(o);
  const user = userEvent.setup();
  const view = render(<Capture client={m.client} projectId={projectId} />);
  // Ready: the rules are read and the event stream is open.
  await screen.findByRole("button", { name: "Capture links" });
  await waitFor(() => expect(m.streams()).toBe(1));
  await waitFor(() => expect(m.calls.some((c) => c.path === `/projects/${projectId}/governance`)).toBe(true));
  await waitFor(() => expect(screen.queryByText(/Reading this project's rules/)).toBeNull());
  return { m, user, view };
}

const links = () => screen.getByRole("textbox", { name: "Links, one per line" });

async function paste(user: ReturnType<typeof userEvent.setup>, lines: string[]) {
  await user.click(links());
  await user.paste(lines.join("\n"));
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
    expect(alert.textContent).toMatch(/capture tools are not available on this computer right now/);
    expect(alert.textContent).toMatch(/Restart the app/);
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

    /** Open from the checkbox; focus is on the first control of the dialog, and Tab and Shift+Tab stay inside at both ends. */
    async function openAndWalk(user: ReturnType<typeof userEvent.setup>) {
      const box = screen.getByRole("checkbox", { name: "Use my browser session" });
      await user.click(box);
      const dialog = await screen.findByRole("dialog", { name: "Use your browser session?" });
      const confirm = within(dialog).getByRole("button", { name: CONFIRM });
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      expect(document.activeElement).toBe(confirm); // on open
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
      expect(document.activeElement).toBe(confirm);
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

  it("says that captures started earlier or elsewhere are not shown here", async () => {
    await setup();
    expect(screen.getByText(/Captures started earlier, or from the browser extension, keep running in the library service but are not shown here/)).toBeTruthy();
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
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)[0]).toEqual({
      url: PROFILE,
      options: { transcribeModel: "medium", since: "2026-01-01", until: "2026-06-30", maxItems: 25, contentTypes: ["reels"], metadataOnly: true },
    });
    const queue = await screen.findByRole("region", { name: "Capture queue" });
    expect(within(queue).getByText(PROFILE)).toBeTruthy();
  });

  it("never refuses an address on the preview's say-so: it is sent and the service decides (R146)", async () => {
    const { m, user } = await setup();
    const box = screen.getByRole("textbox", { name: "Profile, channel or playlist link" });
    await user.type(box, YT);
    expect(screen.getByText(/looks like a single post.*the app will check it/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    await user.clear(box);
    await user.type(box, "https://www.youtube.com/something-new/abc");
    expect(screen.getByText(/Not recognised here.*the app will check it/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
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
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(0);
    await user.type(field, "Legitimate interests");
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
    await waitFor(() => expect(m.bodies(`POST /projects/${P1}/capture-profile`)).toHaveLength(1));
    expect(m.bodies(`POST /projects/${P1}/capture-profile`)[0]).toEqual({ url: PROFILE, options: { transcribeModel: "medium", includeComments: true, legalBasis: "Legitimate interests" } });
  });

  it("a profile run's posts and summary appear as its events arrive", async () => {
    const { m, user } = await setup();
    await user.type(screen.getByRole("textbox", { name: "Profile, channel or playlist link" }), PROFILE);
    await user.click(screen.getByRole("button", { name: "Capture profile" }));
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

  it("a failed update as the service sends it today (500) and a helper that is not running are said plainly", async () => {
    const { user } = await setup({
      versionsAnswer: () => errorResponse(503, "WORKER_UNAVAILABLE", "The media helper is not running.", "The media helper is not set up yet. Run `pnpm setup:py` once, then try again."),
      // apps/library-service: media-worker.ts call() throws a plain Error → toApiError → 500 INTERNAL.
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

  it("a failed update with a tool code (once Task 63 sends one) is explained, the code never shown", async () => {
    const { user } = await setup({ updateAnswer: () => errorResponse(502, "TOOLS_UPDATE_FAILED", "The capture tools could not be updated.", "TOOL_CHECKSUM_MISMATCH") });
    const tools = screen.getByRole("region", { name: "Capture tools" });
    await user.click(within(tools).getByRole("button", { name: "Update capture tools" }));
    expect(await within(tools).findByText(/did not match its published checksum/)).toBeTruthy();
    expect(tools.textContent).not.toMatch(/TOOL_CHECKSUM_MISMATCH/);
  });
});
