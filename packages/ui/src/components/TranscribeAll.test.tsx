/**
 * "Transcribe everything without a transcript" (whole channels, Task 9; R668, R669): a press first says how many sources
 * and how many hours (GET …/untranscribed), then "Transcribe them" puts them on the transcription list once (POST
 * …/transcription-list). The sentences come from @ao/shared (transcribeAllText); the expected strings here are the
 * plan's own.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { transcribeAllText } from "@ao/shared";
import { mockBackground, type BackgroundSetup } from "../test/backgroundService";
import { server, testClient, useMockService } from "../test/service";
import { TranscribeAll } from "./TranscribeAll";

useMockService();

const BUTTON = "Transcribe everything without a transcript";
const TWELVE = { count: 12, soundSeconds: 3.5 * 3600, unknownLengths: 0 };

function start(o: BackgroundSetup = {}, projectId = "p1") {
  const m = mockBackground({ noEvents: true, ...o });
  server.use(...m.handlers);
  const view = render(<TranscribeAll client={testClient()} projectId={projectId} />);
  return { m, view };
}

describe("Transcribe everything without a transcript", () => {
  it("Transcribe everything first says how many sources and how many hours", async () => {
    const { m } = start({ untranscribed: { p1: TWELVE } });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    const said = await screen.findByText(transcribeAllText.confirm(TWELVE));
    expect(said.textContent).toBe("12 sources have audio or video and no transcript: about 3.5 hours of sound. They are transcribed one at a time on this Mac, after anything already on the list.");
    // The confirmation takes focus.
    expect(document.activeElement).toBe(said);
    expect(screen.getByRole("button", { name: "Transcribe them" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(m.count("GET /projects/p1/untranscribed")).toBe(1);
    expect(m.count("POST /projects/p1/transcription-list")).toBe(0);
  });

  it("with nothing to do it says so and offers nothing", async () => {
    const { m } = start({ untranscribed: { p1: { count: 0, soundSeconds: 0, unknownLengths: 0 } } });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    const said = await screen.findByText("Every source with audio or video already has a transcript, or is already on the transcription list.");
    expect(document.activeElement).toBe(said);
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
    // Focus returns to the button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: BUTTON }));
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
    expect(alert.textContent).toContain("A tool this needs is not installed on this computer. The Optional tools screen shows how to get it.");
    expect(alert.textContent).toContain("The speech model “medium” is not installed on this computer.");
    expect(alert.textContent).not.toContain("speech-medium");
    const link = screen.getByRole("link", { name: "Install it from the Optional tools screen" });
    expect(link.getAttribute("href")).toBe("/settings/tools?tool=speech-medium");
    expect(m.count("POST /projects/p1/transcription-list")).toBe(1);
    expect(screen.queryByRole("status")?.textContent ?? "").toBe("");
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
    const { m, view } = start({ untranscribed: { p1: TWELVE, p2: { count: 1, soundSeconds: 60, unknownLengths: 0 } }, holdSwitches: true });
    await userEvent.click(screen.getByRole("button", { name: BUTTON }));
    await userEvent.click(await screen.findByRole("button", { name: "Transcribe them" }));
    await waitFor(() => expect(m.count("POST /projects/p1/transcription-list")).toBe(1));
    view.rerender(<TranscribeAll client={testClient()} projectId="p2" />);
    // The screen now shows p2: its confirmation is gone and its button can be pressed.
    expect(screen.queryByRole("button", { name: "Transcribe them" })).toBeNull();
    const button = screen.getByRole("button", { name: BUTTON }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    m.release();
    // p1's answer was released before p2 is asked; once p2's own confirmation is shown, nothing of p1's answer is said.
    await userEvent.click(button);
    expect(await screen.findByText(transcribeAllText.confirm({ count: 1, soundSeconds: 60, unknownLengths: 0 }))).toBeTruthy();
    expect(m.count("GET /projects/p2/untranscribed")).toBe(1);
    expect(screen.queryByText(/were put on the transcription list/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
