import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptApi } from "../api/transcripts";
import { navigate } from "../navigation";
import { BASE, server, testClient, url, useMockService } from "../test/service";
import { humanTranscript, humanVersion, machineTranscript, machineVersion, MACHINE_VERSIONS, serviceErrorBody, transcriptService } from "../test/msw-transcripts";
import { TranscriptViewer } from "./TranscriptViewer";

useMockService();

const api = () => transcriptApi(testClient());
const media = () => document.querySelector("video, audio") as HTMLMediaElement | null;
const segmentList = () => screen.getByRole("list", { name: "Transcript segments" });
const segmentItems = () => within(segmentList()).getAllByRole("listitem");

let scrolled: Element[] = [];
let played = 0;

beforeEach(() => {
  scrolled = [];
  played = 0;
  window.history.replaceState(null, "", "/transcript?project=p1&source=s1");
  // jsdom has no media playback and no scrolling: the tests drive the element's events and properties.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function () {
    played++;
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(async () => {
  // Close the viewer while the mocked service still answers: closing revokes the ticket.
  cleanup();
  await new Promise((r) => setTimeout(r, 20));
  vi.restoreAllMocks();
});

/** Moves the player to `t` seconds as a browser would report it. */
function playTo(el: HTMLMediaElement, t: number) {
  el.currentTime = t;
  fireEvent(el, new Event("timeupdate"));
}

async function open(opts: Parameters<typeof transcriptService>[0] = {}, props: { sourceId?: string; onLocked?: () => void } = {}) {
  const svc = transcriptService(opts);
  server.use(...svc.handlers);
  const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId={props.sourceId ?? "s1"} {...(props.onLocked ? { onLocked: props.onLocked } : {})} />);
  await screen.findByText("Hello and welcome.");
  return { svc, view };
}

describe("TranscriptViewer — segments and flags", () => {
  it("lists each segment with its time, language and text (dir=auto)", async () => {
    await open();
    const items = segmentItems();
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByRole("button", { name: "Play from 0:00" })).toBeTruthy();
    expect(within(items[0]!).getByText("English")).toBeTruthy();
    const arabic = within(items[2]!).getByText("مرحبا بكم");
    expect(arabic.closest("[dir=auto]")).toBeTruthy();
    expect(arabic.closest("[lang]")?.getAttribute("lang")).toBe("ar");
  });

  it("highlights a flagged segment with its flags in words, not by colour alone", async () => {
    await open();
    const items = segmentItems();
    expect(within(items[1]!).getByText(/Possibly invented text over silence/)).toBeTruthy();
    expect(within(items[1]!).getByText(/known to invent over silence/)).toBeTruthy();
    expect(within(items[2]!).getByText(/Repeated text/)).toBeTruthy();
    expect(within(items[0]!).queryByText(/Flagged/)).toBeNull();
    expect(items[1]!.className).toMatch(/flagged/);
  });

  it("an unknown flag gets a safe generic label and its raw name is not shown", async () => {
    await open({ transcripts: { v1: machineTranscript("v1", [{ start: 0, end: 2, lang: "en", text: "Hello and welcome.", flags: ["<img src=x>"] }]) } });
    const item = segmentItems()[0]!;
    expect(item.textContent).toMatch(/Flagged for review: Another check flagged this segment/);
    expect(item.textContent).not.toContain("<img");
    expect(item.querySelector("img")).toBeNull();
  });

  it("a person's edit (flags: null) shows no flags and says it was not checked", async () => {
    await open({ versions: [humanVersion("h0")], transcripts: { h0: humanTranscript("h0") } });
    expect(screen.getByText(/a person's edit was not checked/i)).toBeTruthy();
    expect(screen.queryByText(/Possibly invented text/)).toBeNull();
    expect(screen.queryByText(/Flagged/)).toBeNull();
  });
});

describe("TranscriptViewer — the player and its media ticket", () => {
  it("asks for a ticket when it opens, plays it, and revokes it when it closes; the address is never shown", async () => {
    const { svc, view } = await open();
    await waitFor(() => expect(svc.log.tickets).toHaveLength(1));
    expect(svc.log.tickets[0]).toMatchObject({ sid: "s1", aid: "m-s1" });
    const el = media()!;
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[0]!.path}`));
    expect(el.tagName).toBe("VIDEO");
    expect(el.getAttribute("crossorigin")).toBeNull();
    expect(document.body.textContent).not.toContain(svc.log.tickets[0]!.path.slice(7));
    expect(window.location.href).not.toContain("/media/");
    view.unmount();
    await waitFor(() => expect(svc.log.revoked).toEqual([svc.log.tickets[0]!.path]));
  });

  it("revokes the ticket and asks for a new one when the source changes", async () => {
    const { svc, view } = await open();
    await waitFor(() => expect(svc.log.tickets).toHaveLength(1));
    view.rerender(<TranscriptViewer api={api()} projectId="p1" sourceId="s2" />);
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    expect(svc.log.tickets[1]).toMatchObject({ sid: "s2", aid: "m-s2" });
    await waitFor(() => expect(svc.log.revoked).toContain(svc.log.tickets[0]!.path));
    await waitFor(() => expect(media()!.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
  });

  it("a ticket that ends mid-playback is renewed and playback resumes at the same position", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4.25);
    // The ticket ended (idle or revoked): the element's next range read fails.
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    expect(svc.log.revoked).toContain(svc.log.tickets[0]!.path);
    const before = played;
    el.currentTime = 0; // a new source starts at the beginning
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(4.25);
    expect(played).toBe(before + 1);
  });

  it("a paused recording whose ticket ended resumes paused at the same position", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    playTo(el, 3);
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    const before = played;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(3);
    expect(played).toBe(before);
  });

  it("a project locked during playback: renewal is refused, the transcript is hidden, and Try again brings it back after unlocking", async () => {
    const onLocked = vi.fn();
    const { svc } = await open({}, { onLocked });
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    server.use(http.post(url("/projects/:id/sources/:sid/assets/:aid/media-ticket"), () => serviceErrorBody(423, "PROJECT_LOCKED", "This project is locked.")));
    fireEvent(media()!, new Event("error"));
    expect(await screen.findByText(/This project is locked, so its transcript and recording are not shown/)).toBeTruthy();
    expect(onLocked).toHaveBeenCalled();
    expect(svc.log.tickets).toHaveLength(1);
    expect(screen.queryByText("Hello and welcome.")).toBeNull();
    expect(media()).toBeNull();
    // Unlocked elsewhere: Try again reads everything again and plays with a new ticket.
    server.use(...svc.handlers);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Hello and welcome.")).toBeTruthy();
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
  });

  it("a save refused because the project was locked keeps the edits for after unlocking", async () => {
    const { svc } = await open();
    const user = userEvent.setup();
    await user.click(within(segmentItems()[0]!).getByRole("button", { name: "Edit segment at 0:00" }));
    await user.type(screen.getByLabelText("Text of the segment at 0:00"), " Again.");
    server.use(http.post(url("/projects/:id/sources/:sid/transcripts"), () => serviceErrorBody(423, "PROJECT_LOCKED", "This project is locked.")));
    await user.click(screen.getByRole("button", { name: "Save edits as a new version" }));
    expect(await screen.findByText(/This project is locked/)).toBeTruthy();
    expect(screen.getByText(/edits that are not saved are kept here/)).toBeTruthy();
    server.use(...svc.handlers);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(((await screen.findByLabelText("Text of the segment at 0:00")) as HTMLTextAreaElement).value).toBe("Hello and welcome. Again.");
  });

  it("the library closed: the recording stops with the service's reason", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    server.use(http.post(url("/projects/:id/sources/:sid/assets/:aid/media-ticket"), () => serviceErrorBody(409, "LIBRARY_OFFLINE", "No library is open.")));
    fireEvent(media()!, new Event("error"));
    expect(await screen.findByText(/The recording stopped and could not be started again/)).toBeTruthy();
  });

  it("a recording that fails again straight after a renewal is not renewed in a loop", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    fireEvent(media()!, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(media()!.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    fireEvent(media()!, new Event("error"));
    expect(await screen.findByText(/The recording could not be played/)).toBeTruthy();
    expect(svc.log.tickets).toHaveLength(2);
  });

  it("a source with no recording still shows its transcript and asks for no ticket", async () => {
    const { svc } = await open({ media: "none" });
    expect(screen.getByText(/no recording to play/i)).toBeTruthy();
    expect(media()).toBeNull();
    expect(svc.log.tickets).toHaveLength(0);
    expect(segmentItems()).toHaveLength(3);
  });

  it("an audio recording plays in an audio element", async () => {
    await open({ media: "audio" });
    await waitFor(() => expect(media()?.tagName).toBe("AUDIO"));
  });
});

describe("TranscriptViewer — player and segments in step", () => {
  it("marks the segment playing and scrolls it into view without moving focus", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const picker = screen.getByLabelText("Version");
    picker.focus();
    playTo(media()!, 3);
    await waitFor(() => expect(segmentItems()[1]!.getAttribute("aria-current")).toBe("true"));
    expect(within(segmentItems()[1]!).getByText("Now playing")).toBeTruthy();
    expect(segmentItems()[0]!.getAttribute("aria-current")).toBeNull();
    expect(scrolled).toContain(segmentItems()[1]);
    expect(document.activeElement).toBe(picker);
    // Not announced: the list is not a live region.
    expect(segmentList().closest("[aria-live]")).toBeNull();
  });

  it("activating a segment from the keyboard seeks the player", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const user = userEvent.setup();
    const button = within(segmentItems()[2]!).getByRole("button", { name: "Play from 0:05" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(media()!.currentTime).toBe(5);
    expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(button);
  });
});

describe("TranscriptViewer — editing and versions", () => {
  it("saving an edit posts a new human-edit version, keeps the machine one, and the picker lists both", async () => {
    const { svc } = await open();
    const user = userEvent.setup();
    await user.click(within(segmentItems()[1]!).getByRole("button", { name: "Edit segment at 0:02" }));
    const field = screen.getByLabelText("Text of the segment at 0:02");
    await user.clear(field);
    await user.type(field, "Thank you for listening.");
    await user.click(screen.getByRole("button", { name: "Save edits as a new version" }));
    await waitFor(() => expect(svc.log.saved).toHaveLength(1));
    const body = svc.log.saved[0]!.body;
    expect(body.format).toBe("vtt");
    expect(body.basedOn).toBe("v1");
    expect(body.text).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello and welcome.\n\n00:00:02.000 --> 00:00:05.000\nThank you for listening.\n\n00:00:05.000 --> 00:00:08.000\nمرحبا بكم\n",
    );
    expect(await screen.findByText(/Saved as a new version/)).toBeTruthy();
    const picker = screen.getByLabelText("Version") as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(2));
    expect(picker.options[0]!.textContent).toMatch(/Speech recognition \(faster-whisper, model small\)/);
    expect(picker.options[1]!.textContent).toMatch(/Edited by a person/);
    expect(picker.value).toBe("h1");
    expect(await screen.findByText(/a person's edit was not checked/i)).toBeTruthy();
    // The machine version is still there to open.
    await user.selectOptions(picker, "v1");
    expect(await screen.findByText(/Possibly invented text over silence/)).toBeTruthy();
  });

  it("a failed save keeps the edited text and says why", async () => {
    await open();
    server.use(http.post(url("/projects/:id/sources/:sid/transcripts"), () => serviceErrorBody(409, "READ_ONLY", "The library is read-only.")));
    const user = userEvent.setup();
    await user.click(within(segmentItems()[0]!).getByRole("button", { name: "Edit segment at 0:00" }));
    const field = screen.getByLabelText("Text of the segment at 0:00");
    await user.type(field, " Again.");
    await user.click(screen.getByRole("button", { name: "Save edits as a new version" }));
    expect(await screen.findByText(/This library is read-only/)).toBeTruthy();
    expect((screen.getByLabelText("Text of the segment at 0:00") as HTMLTextAreaElement).value).toBe("Hello and welcome. Again.");
    expect(screen.getByRole("button", { name: "Save edits as a new version" })).toBeTruthy();
  });

  it("a save answer that arrives after the source changed is dropped", async () => {
    const { view } = await open();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcripts"), async () => {
        await gate;
        return HttpResponse.json({ id: "late", path: "x", derivation: {} });
      }),
    );
    const user = userEvent.setup();
    await user.click(within(segmentItems()[0]!).getByRole("button", { name: "Edit segment at 0:00" }));
    await user.type(screen.getByLabelText("Text of the segment at 0:00"), "!");
    await user.click(screen.getByRole("button", { name: "Save edits as a new version" }));
    view.rerender(<TranscriptViewer api={api()} projectId="p1" sourceId="s2" />);
    await screen.findByRole("heading", { name: /Second interview/ });
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByText(/Saved as a new version/)).toBeNull();
    expect((screen.getByLabelText("Version") as HTMLSelectElement).value).toBe("v1");
    expect([...(screen.getByLabelText("Version") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["v1"]);
  });

  it("a version list that arrives after the source changed is dropped", async () => {
    const svc = transcriptService();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(url("/projects/:id/sources/:sid/transcripts"), async ({ params }) => {
        if (params.sid === "s1") {
          await gate;
          return HttpResponse.json({ versions: [humanVersion("stale")] });
        }
        return HttpResponse.json({ versions: MACHINE_VERSIONS });
      }),
      ...svc.handlers,
    );
    const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByRole("heading", { name: /Interview with a baker/ });
    view.rerender(<TranscriptViewer api={api()} projectId="p1" sourceId="s2" />);
    await screen.findByText("Hello and welcome.");
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const picker = screen.getByLabelText("Version") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["v1"]);
  });

  it("a transcript that arrives after another version was chosen is dropped", async () => {
    const svc = transcriptService({ versions: [...MACHINE_VERSIONS, humanVersion("h0")], transcripts: { h0: humanTranscript("h0", [{ start: 0, end: 1, lang: "en", text: "Edited words.", flags: null }]) } });
    server.use(...svc.handlers);
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Edited words.");
    // Opened on the newest (h0); now v1 is slow and h0 is chosen again before it answers.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get(url("/projects/:id/sources/:sid/transcripts/:aid"), async ({ params }) => {
        if (params.aid === "v1") {
          await gate;
          return HttpResponse.json(machineTranscript("v1"));
        }
        return HttpResponse.json(svc.state.transcripts[String(params.aid)]);
      }),
    );
    const user = userEvent.setup();
    const picker = screen.getByLabelText("Version") as HTMLSelectElement;
    await user.selectOptions(picker, "v1");
    await user.selectOptions(picker, "h0");
    await screen.findByText("Edited words.");
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText("Edited words.")).toBeTruthy();
    expect(screen.queryByText("Thanks for watching.")).toBeNull();
  });

  it("guards unsaved edits: leaving, closing the window and switching versions are refused until saved or discarded", async () => {
    await open({ versions: [...MACHINE_VERSIONS, humanVersion("h0")], transcripts: { h0: humanTranscript("h0") } });
    const user = userEvent.setup();
    await user.click(within(segmentItems()[0]!).getByRole("button", { name: "Edit segment at 0:00" }));
    await user.type(screen.getByLabelText("Text of the segment at 0:00"), "!");
    act(() => navigate("/?project=p1"));
    expect(window.location.pathname).toBe("/transcript");
    expect(await screen.findByText(/edits that are not saved/)).toBeTruthy();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const picker = screen.getByLabelText("Version") as HTMLSelectElement;
    await user.selectOptions(picker, "v1");
    expect(picker.value).toBe("h0");
    await user.click(screen.getByRole("button", { name: "Discard edits" }));
    expect(screen.queryByLabelText("Text of the segment at 0:00")).toBeNull();
    act(() => navigate("/?project=p1"));
    expect(window.location.pathname).toBe("/");
  });
});

describe("TranscriptViewer — transcribe again", () => {
  it("re-transcribes with another model, shows that it is working, and the new version appears in the picker", async () => {
    const svc = transcriptService();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcribe"), async ({ request, params }) => {
        svc.log.transcribed.push({ sid: String(params.sid), body: (await request.json()) as Record<string, unknown> });
        await gate;
        const at = "2026-11-03T10:00:00.000Z";
        svc.state.versions.push(machineVersion("v2", "vtt", at, "medium"), machineVersion("j2", "json", at, "medium"));
        svc.state.transcripts.v2 = machineTranscript("v2", [{ start: 0, end: 2, lang: "en", text: "Hello, and welcome.", flags: [] }]);
        return HttpResponse.json({ sourceId: "s1", folder: "sources/s1", files: [svc.state.versions.at(-2)!.path, svc.state.versions.at(-1)!.path], flaggedSegments: 0 });
      }),
      ...svc.handlers,
    );
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Speech model"), "medium");
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    expect(await screen.findByText(/Transcribing with the medium model/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Transcription in progress" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement).disabled).toBe(true);
    expect(svc.log.transcribed[0]).toEqual({ sid: "s1", body: { model: "medium" } });
    release();
    expect(await screen.findByText(/The new transcript is ready/)).toBeTruthy();
    const picker = screen.getByLabelText("Version") as HTMLSelectElement;
    await waitFor(() => expect(picker.options).toHaveLength(2));
    expect(picker.value).toBe("v2");
    expect(picker.options[1]!.textContent).toMatch(/model medium/);
    expect(await screen.findByText("Hello, and welcome.")).toBeTruthy();
  });

  it("a missing speech model is explained in plain words with what the service reported", async () => {
    await open();
    server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(502, "INTERNAL", "The media helper could not finish the job.", "MODEL_UNAVAILABLE")));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Speech model"), "large-v3");
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    const alert = await screen.findByText(/speech model “large-v3” is not installed/);
    expect(alert.textContent).toMatch(/The media helper could not finish the job\./);
    expect(alert.textContent).not.toMatch(/MODEL_UNAVAILABLE|\{/);
  });

  it("a media helper that is not running is explained", async () => {
    await open();
    server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(503, "WORKER_UNAVAILABLE", "The media helper is not running.", "spawn python ENOENT")));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    expect(await screen.findByText(/The media helper is not running/)).toBeTruthy();
  });
});

describe("TranscriptViewer — a locked project", () => {
  it("opening a locked project's transcript says so and asks for no ticket", async () => {
    const onLocked = vi.fn();
    const svc = transcriptService();
    server.use(
      http.get(url("/projects/:id/sources/:sid"), () => serviceErrorBody(423, "PROJECT_LOCKED", "This project is locked.")),
      http.get(url("/projects/:id/sources/:sid/transcripts"), () => serviceErrorBody(423, "PROJECT_LOCKED", "This project is locked.")),
      ...svc.handlers,
    );
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" onLocked={onLocked} />);
    expect(await screen.findByText(/This project is locked/)).toBeTruthy();
    expect(onLocked).toHaveBeenCalled();
    expect(svc.log.tickets).toHaveLength(0);
  });
});
