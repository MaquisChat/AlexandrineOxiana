/**
 * "Transcribe everything without a transcript" (whole channels, Task 9; R668, R669): a press first says how many sources
 * and how many hours (GET …/untranscribed), then "Transcribe them" puts them on the transcription list once (POST
 * …/transcription-list). The sentences come from @ao/shared (transcribeAllText); the expected strings here are the
 * plan's own.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { transcribeAllText } from "@ao/shared";
import { mockBackground, type BackgroundSetup } from "../test/backgroundService";
import type { ApiClient } from "../api/client";
import { server, testClient, useMockService } from "../test/service";
import { TranscribeAll } from "./TranscribeAll";

useMockService();

const BUTTON = "Transcribe everything without a transcript";
const TWELVE = { count: 12, soundSeconds: 3.5 * 3600, unknownLengths: 0 };

function start(o: BackgroundSetup = {}, projectId = "p1", readOnly = false) {
  const m = mockBackground({ noEvents: true, ...o });
  server.use(...m.handlers);
  const view = render(<TranscribeAll client={testClient()} projectId={projectId} readOnly={readOnly} />);
  return { m, view };
}

/**
 * A client whose requests are watched: `settled("METHOD path")` resolves once that request's answer has been handed to
 * the component. The watcher's `then` is attached before the component's `await`, so the test's own await on
 * `settled` resumes after the component's continuation has run (no timer); awaited inside `act`, its render is flushed.
 */
function watchedClient() {
  const base = testClient();
  const answers = new Map<string, Promise<void>>();
  const client: ApiClient = {
    ...base,
    request: <T,>(method: Parameters<ApiClient["request"]>[0], path: string, opts?: Parameters<ApiClient["request"]>[2]) => {
      const p = base.request<T>(method, path, opts);
      answers.set(`${method} ${path}`, p.then(() => undefined, () => undefined));
      return p;
    },
  };
  return { client, settled: (key: string) => answers.get(key) ?? Promise.reject(new Error(`no request ${key}`)) };
}

describe("Transcribe everything without a transcript", () => {
  it("Transcribe everything first says how many sources and how many hours", async () => {
    const { m } = start({ untranscribed: { p1: TWELVE } });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    const said = await screen.findByText(transcribeAllText.confirm(TWELVE));
    expect(said.textContent).toBe("12 sources have audio or video and no transcript: about 3.5 hours of sound. They are transcribed one at a time on this Mac, after anything already on the list.");
    // The confirmation takes focus (waited for itself, R689).
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(screen.getByRole("button", { name: "Transcribe them" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(m.count("GET /projects/p1/untranscribed")).toBe(1);
    expect(m.count("POST /projects/p1/transcription-list")).toBe(0);
  });

  it("with nothing to do it says so and offers nothing", async () => {
    const { m } = start({ untranscribed: { p1: { count: 0, soundSeconds: 0, unknownLengths: 0 } } });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    const said = await screen.findByText("Every source with audio or video already has a transcript, or is already on the transcription list.");
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(screen.queryByRole("button", { name: "Transcribe them" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(m.count("POST /projects/p1/transcription-list")).toBe(0);
  });

  it("Transcribe them sends one request and says how many were put on the list", async () => {
    const { m } = start({ untranscribed: { p1: TWELVE }, holdSwitches: true });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    const confirm = await screen.findByRole("button", { name: "Transcribe them" });
    // A double click, then another press while the request is out: one request.
    await userEvent.dblClick(confirm);
    await userEvent.click(confirm);
    await waitFor(() => expect(m.count("POST /projects/p1/transcription-list")).toBe(1));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    m.release();
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toBe("12 sources were put on the transcription list."));
    expect(m.count("POST /projects/p1/transcription-list")).toBe(1);
    expect(screen.queryByRole("button", { name: "Transcribe them" })).toBeNull();
    // Focus returns to the button (waited for itself, R689).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: BUTTON })));
  });

  it("Cancel sends nothing and focus returns to the button", async () => {
    const { m } = start({ untranscribed: { p1: TWELVE } });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(transcribeAllText.confirm(TWELVE))).toBeNull();
    expect(screen.queryByRole("button", { name: "Transcribe them" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: BUTTON }));
    expect(m.count("POST /projects/p1/transcription-list")).toBe(0);
  });

  it("a refusal for a missing speech model names it", async () => {
    const { m } = start({
      untranscribed: { p1: TWELVE },
      transcribeAllAnswer: () =>
        HttpResponse.json({ error: { code: "TOOL_NOT_INSTALLED", message: "A tool this needs is not installed on this computer. The Optional tools screen shows how to get it.", reason: "speech-medium" } }, { status: 409 }),
    });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await userEvent.click(await screen.findByRole("button", { name: "Transcribe them" }));
    const alert = await screen.findByRole("alert");
    // Said once: the speech model's own sentence and its link, not the service's general sentence as well.
    expect(alert.textContent).not.toContain("A tool this needs is not installed on this computer.");
    expect(alert.textContent).not.toContain("The Optional tools screen shows how to get it.");
    expect(alert.textContent).toBe("The speech model “medium” is not installed on this computer. Install it from the Optional tools screen.");
    expect(alert.textContent).not.toContain("speech-medium");
    const link = screen.getByRole("link", { name: "Install it from the Optional tools screen" });
    expect(link.getAttribute("href")).toBe("/settings/tools?tool=speech-medium");
    expect(m.count("POST /projects/p1/transcription-list")).toBe(1);
    expect(screen.queryByRole("status")?.textContent ?? "").toBe("");
  });

  it("a refusal for another missing tool says it once, as the app says a missing tool elsewhere", async () => {
    start({
      untranscribed: { p1: TWELVE },
      transcribeAllAnswer: () =>
        HttpResponse.json({ error: { code: "TOOL_NOT_INSTALLED", message: "A tool this needs is not installed on this computer. The Optional tools screen shows how to get it.", reason: "ffmpeg" } }, { status: 409 }),
    });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await userEvent.click(await screen.findByRole("button", { name: "Transcribe them" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("A tool this needs is not installed on this computer.");
    expect(alert.textContent).toContain("The video tools (ffmpeg) are not installed on this computer.");
    expect(screen.getByRole("link", { name: "Install it from the Optional tools screen" }).getAttribute("href")).toBe("/settings/tools?tool=ffmpeg");
  });

  it("a refusal by the project's rules shows the service's sentence", async () => {
    start({
      untranscribed: { p1: TWELVE },
      transcribeAllAnswer: () => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "Transcription on this computer is not allowed in this project." } }, { status: 403 }),
    });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await userEvent.click(await screen.findByRole("button", { name: "Transcribe them" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Transcription on this computer is not allowed in this project.");
  });

  it("an answer after the project changed is dropped", async () => {
    const m = mockBackground({ noEvents: true, untranscribed: { p1: TWELVE }, holdSwitches: true });
    server.use(...m.handlers);
    const w = watchedClient();
    const view = render(<TranscribeAll client={w.client} projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await userEvent.click(await screen.findByRole("button", { name: "Transcribe them" }));
    await waitFor(() => expect(m.count("POST /projects/p1/transcription-list")).toBe(1));
    view.rerender(<TranscribeAll client={w.client} projectId="p2" />);
    // The screen now shows p2: its confirmation is gone and its button can be pressed.
    expect(screen.queryByRole("button", { name: "Transcribe them" })).toBeNull();
    expect((screen.getByRole("button", { name: BUTTON }) as HTMLButtonElement).disabled).toBe(false);
    // p1's answer arrives and is handed to the component; nothing of it is said, and nothing is pressed meanwhile.
    m.release();
    await act(async () => {
      await w.settled("POST /projects/p1/transcription-list");
    });
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: BUTTON }));
  });

  it("an answer of the count after the project changed is dropped", async () => {
    const m = mockBackground({ noEvents: true, untranscribed: { p1: TWELVE }, holdReads: true });
    server.use(...m.handlers);
    const w = watchedClient();
    const view = render(<TranscribeAll client={w.client} projectId="p1" />);
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await waitFor(() => expect(m.count("GET /projects/p1/untranscribed")).toBe(1));
    view.rerender(<TranscribeAll client={w.client} projectId="p2" />);
    m.release();
    await act(async () => {
      await w.settled("GET /projects/p1/untranscribed");
    });
    // p1's count is not offered on p2's screen.
    expect(screen.queryByText(transcribeAllText.confirm(TWELVE))).toBeNull();
    expect(screen.queryByRole("button", { name: "Transcribe them" })).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("two presses of Transcribe them in the same moment send one request", async () => {
    const { m } = start({ untranscribed: { p1: TWELVE } });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    const confirm = await screen.findByRole("button", { name: "Transcribe them" });
    // Both presses land before the screen re-renders (the button is not yet disabled): the synchronous guard holds.
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    const status = screen.getByRole("status");
    await waitFor(() => expect(status.textContent).not.toBe(""));
    expect(m.count("POST /projects/p1/transcription-list")).toBe(1);
    expect(status.textContent).toBe("12 sources were put on the transcription list.");
  });

  it("on a read-only library the button is off, as the screen's other edit buttons are, and asks nothing", async () => {
    const { m } = start({ untranscribed: { p1: TWELVE } }, "p1", true);
    const button = screen.getByRole("button", { name: BUTTON }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.click(button);
    expect(m.count("GET /projects/p1/untranscribed")).toBe(0);
    expect(screen.queryByRole("group")).toBeNull();
  });
});
