import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptApi } from "../api/transcripts";
import { setMedia } from "../test/media";
import { navigate } from "../navigation";
import { BASE, server, testClient, url, useMockService } from "../test/service";
import { humanTranscript, humanVersion, machineTranscript, sourceFile, machineVersion, MACHINE_VERSIONS, SEGMENTS, serviceErrorBody, transcriptService } from "../test/msw-transcripts";
import { resetTranscriptionRuns } from "./transcriptionRuns";
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
  resetTranscriptionRuns();
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

let windowScrolls = 0;

/**
 * Gives the segment list a layout (jsdom has none): 150 px visible, each segment 100 px high, and
 * counts any scrolling of the window.
 */
function layOut(): HTMLElement {
  const list = segmentList();
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 150 });
  segmentItems().forEach((li, i) => {
    Object.defineProperty(li, "offsetTop", { configurable: true, value: i * 100 });
    Object.defineProperty(li, "offsetHeight", { configurable: true, value: 100 });
  });
  windowScrolls = 0;
  window.scrollTo = (() => {
    windowScrolls++;
  }) as typeof window.scrollTo;
  window.scrollBy = (() => {
    windowScrolls++;
  }) as typeof window.scrollBy;
  return list;
}

/**
 * What a browser does when an element's source changes or it is emptied (the media element load
 * algorithm): the position goes back to 0 and `timeupdate` fires, before any seek. jsdom does not.
 */
function browserReset(el: HTMLMediaElement) {
  el.currentTime = 0;
  fireEvent(el, new Event("timeupdate"));
}

/** Moves the player to `t` seconds as a browser would report it. */
function playTo(el: HTMLMediaElement, t: number) {
  el.currentTime = t;
  fireEvent(el, new Event("timeupdate"));
}

async function open(opts: Parameters<typeof transcriptService>[0] = {}, props: { sourceId?: string; onLocked?: () => void; waitFor?: string; select?: string } = {}) {
  const svc = transcriptService(opts);
  server.use(...svc.handlers);
  const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId={props.sourceId ?? "s1"} {...(props.onLocked ? { onLocked: props.onLocked } : {})} />);
  if (props.select) {
    const picker = (await screen.findByLabelText("Version")) as HTMLSelectElement;
    await waitFor(() => expect([...picker.options].some((o) => o.value === props.select)).toBe(true));
    await userEvent.setup().selectOptions(picker, props.select);
  }
  await screen.findByText(props.waitFor ?? "Hello and welcome.");
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

  it("a person's edit keeps the machine flags on segments the person did not change, and marks changed or re-timed ones (review I3)", async () => {
    const edited = [
      { ...SEGMENTS[0]!, text: "Hello, and welcome." },
      { ...SEGMENTS[1]! },
      { ...SEGMENTS[2]!, end: 8.5 },
    ];
    await open({ versions: [...MACHINE_VERSIONS, humanVersion("h0")], transcripts: { h0: humanTranscript("h0", edited) } }, { waitFor: "Hello, and welcome." });
    await waitFor(() => expect(segmentItems()[1]!.textContent).toMatch(/Flagged for review: Possibly invented text over silence/));
    expect(segmentItems()[0]!.textContent).toMatch(/Edited by a person — not checked/);
    expect(segmentItems()[0]!.textContent).not.toMatch(/Flagged/);
    expect(segmentItems()[2]!.textContent).toMatch(/Edited by a person — not checked/);
    expect(segmentItems()[2]!.textContent).not.toMatch(/Repeated text/);
    expect(segmentItems()[1]!.textContent).not.toMatch(/not checked/);
    expect(screen.getByText(/edited by a person/i, { selector: "p.ao-tx__note" }).textContent).toMatch(/speech recognition version of/);
  });

  it("a person's edit whose machine version cannot be read says flags are not available, rather than showing none", async () => {
    const svc = transcriptService({ versions: [...MACHINE_VERSIONS, humanVersion("h0")], transcripts: { h0: humanTranscript("h0") } });
    server.use(
      http.get(url("/projects/:id/sources/:sid/transcripts/:aid"), ({ params }) =>
        params.aid === "h0" ? HttpResponse.json(svc.state.transcripts.h0) : serviceErrorBody(404, "NOT_FOUND", "That transcript was not found."),
      ),
      ...svc.handlers,
    );
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    expect(await screen.findByText(/Flags are not available for this version/)).toBeTruthy();
    expect(screen.queryByText(/Flagged/)).toBeNull();
  });

  it("a person's edit that does not name its base uses the newest machine version made before it, and says so", async () => {
    const h = humanVersion("h0", "2026-11-05T09:00:00.000Z");
    (h.derivation as { params: Record<string, unknown> }).params = {};
    const later = machineVersion("v9", "vtt", "2026-11-06T09:00:00.000Z", "large-v3");
    await open({
      versions: [...MACHINE_VERSIONS, h, later],
      transcripts: { h0: { ...humanTranscript("h0"), basedOn: undefined } as never, v9: machineTranscript("v9", SEGMENTS.map((x) => ({ ...x, flags: [] }))) },
    }, { waitFor: "Thanks for watching.", select: "h0" });
    await waitFor(() => expect(segmentItems()[1]!.textContent).toMatch(/Possibly invented text over silence/));
    expect(screen.getByText(/does not record which version it was edited from/)).toBeTruthy();
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

  it("a recording that keeps failing at the same place is renewed at most twice, then says so and offers Try again (review I1)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4);
    // The reviewer's probe: each renewed ticket loads (metadata and first data) and fails again at the same place.
    for (let cycle = 0; cycle < 6; cycle++) {
      fireEvent(el, new Event("error"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      fireEvent(el, new Event("loadedmetadata"));
      fireEvent(el, new Event("loadeddata"));
      playTo(el, 4.5);
    }
    expect(await screen.findByText(/The recording could not be played/)).toBeTruthy();
    expect(svc.log.tickets).toHaveLength(3);
    // Every ticket asked for is revoked once it is replaced or given up.
    await waitFor(() => expect([...svc.log.revoked].sort()).toEqual(svc.log.tickets.map((t) => t.path).sort()));
    expect(el.getAttribute("src")).toBeNull();
    // The researcher chooses to try again: a new ticket, resumed where it stopped.
    await userEvent.setup().click(screen.getByRole("button", { name: "Try the recording again" }));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(4));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[3]!.path}`));
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(4.5);
    expect(screen.queryByText(/The recording could not be played/)).toBeNull();
  });

  it("a recording damaged at the resume point: the browser's reset to 0 is ignored, every resume is at the kept position, and it ends in the plain message (review I1b, M13)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    const list = layOut();
    fireEvent(el, new Event("play"));
    playTo(el, 6);
    await waitFor(() => expect(list.scrollTop).toBe(150));
    const renewed = async (n: number) => {
      await waitFor(() => expect(svc.log.tickets).toHaveLength(n));
      await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[n - 1]!.path}`));
    };
    // The first failure at 6 s: a new ticket; the browser reports 0 as the new source loads.
    fireEvent(el, new Event("error"));
    await renewed(2);
    browserReset(el);
    // That 0 is not taken as the position: segment 1 is not marked and the list does not jump (M13).
    expect(segmentItems()[0]!.getAttribute("aria-current")).toBeNull();
    expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true");
    expect(list.scrollTop).toBe(150);
    // Damaged right at the resume point: it fails again before the resume seek.
    fireEvent(el, new Event("error"));
    await renewed(3);
    browserReset(el);
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(6);
    fireEvent(el, new Event("seeked"));
    // Playback runs on a little, reaches the damage again: the third failure there ends it.
    playTo(el, 6.4);
    fireEvent(el, new Event("error"));
    expect(screen.getByText(/The recording could not be played/)).toBeTruthy();
    expect(svc.log.tickets).toHaveLength(3);
    // The first segment was never marked as playing and the list never jumped to the top.
    expect(segmentItems()[0]!.getAttribute("aria-current")).toBeNull();
    expect(list.scrollTop).toBe(150);
  });

  it("a failure at the same place counts against the limit however much was played elsewhere in between (review I1b)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    for (let cycle = 0; cycle < 5 && !screen.queryByText(/The recording could not be played/); cycle++) {
      playTo(el, 40);
      const before = svc.log.tickets.length;
      fireEvent(el, new Event("error"));
      if (screen.queryByText(/The recording could not be played/)) break;
      await waitFor(() => expect(svc.log.tickets.length).toBe(before + 1));
      await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets.at(-1)!.path}`));
      browserReset(el);
      fireEvent(el, new Event("loadedmetadata"));
      fireEvent(el, new Event("seeked"));
      // A long stretch played well past the damage, then the researcher goes back to it.
      playTo(el, 41);
      playTo(el, 90);
    }
    expect(screen.getByText(/The recording could not be played/)).toBeTruthy();
    expect(svc.log.tickets).toHaveLength(3);
  });

  it("Try the recording again resumes at the kept position, not at the 0 the browser reports after giving up (review I1b)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    playTo(el, 40);
    for (let i = 0; i < 3; i++) {
      const before = svc.log.tickets.length;
      fireEvent(el, new Event("error"));
      if (i < 2) {
        await waitFor(() => expect(svc.log.tickets.length).toBe(before + 1));
        await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets.at(-1)!.path}`));
        browserReset(el);
      }
    }
    expect(await screen.findByText(/The recording could not be played/)).toBeTruthy();
    // Giving up empties the element: the browser reports 0 again.
    browserReset(el);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try the recording again" }));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(4));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[3]!.path}`));
    browserReset(el);
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(40);
  });

  it("a recording that plays on after a renewal still gets renewals later", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    for (let cycle = 0; cycle < 4; cycle++) {
      const at = 10 + cycle * 60;
      playTo(el, at);
      fireEvent(el, new Event("error"));
      await waitFor(() => expect(svc.log.tickets).toHaveLength(cycle + 2));
      await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[cycle + 1]!.path}`));
      browserReset(el);
      fireEvent(el, new Event("loadedmetadata"));
      expect(el.currentTime).toBe(at);
      fireEvent(el, new Event("seeked"));
      // Real progress: the position moves well past where it failed.
      playTo(el, at + 30);
    }
    expect(svc.log.tickets).toHaveLength(5);
    expect(screen.queryByText(/The recording could not be played/)).toBeNull();
  });

  it("too many recordings open at once is said in one plain sentence (review M3)", async () => {
    const svc = transcriptService();
    server.use(http.post(url("/projects/:id/sources/:sid/assets/:aid/media-ticket"), () => serviceErrorBody(429, "RATE_LIMITED", "Too many recordings are open at once. Close one, then try again.")), ...svc.handlers);
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    const msg = await screen.findByText(/recording could not be opened/);
    expect(msg.textContent).toBe("The recording could not be opened: too many recordings are open at once. Close another recording, then choose Try the recording again.");
  });

  it("a source with no recording still shows its transcript and asks for no ticket", async () => {
    const { svc } = await open({ media: "none" });
    expect(screen.getByText(/no recording to play/i)).toBeTruthy();
    expect(media()).toBeNull();
    expect(svc.log.tickets).toHaveLength(0);
    expect(segmentItems()).toHaveLength(3);
  });

  it("a recording known only by its kind (no recorded type) still plays; a destroyed one is not offered (review M8)", async () => {
    const svc = transcriptService();
    let destroyed = false;
    server.use(
      http.get(url("/projects/:id/sources/:sid"), () => {
        const f = sourceFile("s1");
        const rec = f.assets[0]! as Record<string, unknown>;
        delete rec.mime;
        if (destroyed) rec.status = "destroyed";
        return HttpResponse.json(f);
      }),
      ...svc.handlers,
    );
    const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    await waitFor(() => expect(media()?.tagName).toBe("VIDEO"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(1));
    view.unmount();
    destroyed = true;
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    expect(await screen.findByText(/no recording to play/i)).toBeTruthy();
    expect(media()).toBeNull();
  });

  it("an audio recording plays in an audio element", async () => {
    await open({ media: "audio" });
    await waitFor(() => expect(media()?.tagName).toBe("AUDIO"));
  });
});

describe("TranscriptViewer — player and segments in step", () => {
  it("marks the segment playing and scrolls only the segment list to it, never the window, without moving focus (review I4)", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const list = layOut();
    const picker = screen.getByLabelText("Version");
    picker.focus();
    playTo(media()!, 6);
    await waitFor(() => expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true"));
    expect(within(segmentItems()[2]!).getByText("Now playing")).toBeTruthy();
    expect(segmentItems()[0]!.getAttribute("aria-current")).toBeNull();
    await waitFor(() => expect(list.scrollTop).toBe(200 + 100 - 150));
    expect(scrolled).toEqual([]);
    expect(windowScrolls).toBe(0);
    expect(document.activeElement).toBe(picker);
    // Not announced: the list is not a live region.
    expect(segmentList().closest("[aria-live]")).toBeNull();
  });

  it("smooth scrolling unless reduced motion is asked for", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const list = layOut();
    const smooth: unknown[] = [];
    list.scrollTo = ((o: ScrollToOptions) => {
      smooth.push(o);
      list.scrollTop = o.top ?? 0;
    }) as typeof list.scrollTo;
    playTo(media()!, 6);
    await waitFor(() => expect(smooth).toEqual([{ top: 150, behavior: "smooth" }]));
    act(() => setMedia({ reducedMotion: true }));
    list.scrollTop = 0;
    playTo(media()!, 3);
    await waitFor(() => expect(segmentItems()[1]!.getAttribute("aria-current")).toBe("true"));
    // Segment 1 (100-200) is below a list scrolled to 0 with 150 visible: brought into view at once.
    await waitFor(() => expect(list.scrollTop).toBe(50));
    expect(smooth).toHaveLength(1);
  });

  it("Follow playback can be turned off", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const list = layOut();
    const toggle = screen.getByRole("checkbox", { name: "Follow playback" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await userEvent.setup().click(toggle);
    expect(toggle.checked).toBe(false);
    playTo(media()!, 6);
    await waitFor(() => expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true"));
    expect(list.scrollTop).toBe(0);
  });

  it("following pauses while the researcher scrolls the list, and Back to the playing segment resumes it", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const list = layOut();
    fireEvent.wheel(list, { deltaY: 40 });
    list.scrollTop = 7;
    playTo(media()!, 6);
    await waitFor(() => expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true"));
    expect(list.scrollTop).toBe(7);
    await userEvent.setup().click(screen.getByRole("button", { name: "Back to the playing segment" }));
    await waitFor(() => expect(list.scrollTop).toBe(150));
    expect(screen.queryByRole("button", { name: "Back to the playing segment" })).toBeNull();
    playTo(media()!, 0.5);
    await waitFor(() => expect(list.scrollTop).toBe(0));
  });

  it("following pauses while focus is inside the list or a segment is being edited", async () => {
    await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const list = layOut();
    const user = userEvent.setup();
    act(() => within(segmentItems()[0]!).getByRole("button", { name: "Play from 0:00" }).focus());
    playTo(media()!, 6);
    await waitFor(() => expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true"));
    expect(list.scrollTop).toBe(0);
    expect(screen.getByRole("button", { name: "Back to the playing segment" })).toBeTruthy();
    await user.click(within(segmentItems()[0]!).getByRole("button", { name: "Edit segment at 0:00" }));
    act(() => screen.getByLabelText("Version").focus());
    playTo(media()!, 3);
    await waitFor(() => expect(segmentItems()[1]!.getAttribute("aria-current")).toBe("true"));
    expect(list.scrollTop).toBe(0);
    // Not offered while the editor is open: it would scroll the list away from it (review M11).
    expect(screen.queryByRole("button", { name: "Back to the playing segment" })).toBeNull();
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
    await waitFor(() => expect(document.activeElement).toBe(picker));
    await waitFor(() => expect(picker.options).toHaveLength(2));
    expect(picker.options[0]!.textContent).toMatch(/Speech recognition \(faster-whisper, model small\)/);
    expect(picker.options[1]!.textContent).toMatch(/Edited by a person/);
    expect(picker.value).toBe("h1");
    // Untouched machine-flagged text keeps its flag in the new version (review I3).
    await waitFor(() => expect(segmentItems()[2]!.textContent).toMatch(/Repeated text/));
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
    // Focus does not fall to the page when the button goes (review M5).
    expect(document.activeElement).toBe(screen.getByLabelText("Version"));
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
    const alert = await screen.findByText(/speech model “large-v3” on this computer could not be loaded; it may be damaged\. Remove it and install it again from the optional tools screen/);
    expect(alert.textContent).toMatch(/The media helper could not finish the job\./);
    expect(alert.textContent).not.toMatch(/MODEL_UNAVAILABLE|\{/);
  });

  it("a media helper that is not running is explained once, without the raw reason (review M2)", async () => {
    await open();
    server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(503, "WORKER_UNAVAILABLE", "The media helper is not running.", "spawn python ENOENT")));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Re-transcribe" }));
    const msg = await screen.findByText(/media helper that runs speech recognition is not running/);
    expect(msg.textContent!.match(/not running/g)).toHaveLength(1);
    expect(msg.textContent).not.toMatch(/ENOENT/);
    expect((screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an interrupted run and other worker codes are said in words, never as a raw code (review M2)", async () => {
    await open();
    for (const [code, words] of [
      ["INTERRUPTED", /was interrupted before it finished/],
      ["CANCELLED", /was stopped before it finished/],
      ["ENCRYPTION_REQUIRED", /encrypted/],
      ["INPUT_NOT_DECRYPTABLE", /could not be decrypted/],
      ["TOOL_FAILED", /speech tool failed/],
      ["SOMETHING_NEW", /could not finish the transcription/],
    ] as const) {
      server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(502, "INTERNAL", "The media helper could not finish the job.", code)));
      await userEvent.setup().click(screen.getByRole("button", { name: "Re-transcribe" }));
      const msg = await screen.findByText(words);
      expect(msg.textContent).not.toContain(code);
    }
  });

  it("a connection lost while transcribing says the run may still be going, offers Check for new versions, and keeps Re-transcribe off for this source (review I2)", async () => {
    const svc = transcriptService();
    let calls = 0;
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcribe"), () => {
        calls++;
        return HttpResponse.error();
      }),
      ...svc.handlers,
    );
    const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    expect(screen.getByText(/Leaving this screen does not stop it/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Re-transcribe" }));
    const msg = await screen.findByText(/may still be going/);
    expect(msg.textContent).not.toMatch(/could not be reached/);
    expect(screen.queryByText(/could not be reached/)).toBeNull();
    const button = screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent).toMatch(/off for this source/);
    // Leaving and coming back in the same session: still off, still explained.
    view.unmount();
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    expect((screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/may still be going/)).toBeTruthy();
    // Nothing new yet.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check for new versions" }));
    expect(await screen.findByText(/No new version yet/)).toBeTruthy();
    // The run finished on the service: the check finds it.
    const at = new Date(Date.now() + 60_000).toISOString();
    svc.state.versions.push(machineVersion("v2", "vtt", at, "medium"));
    svc.state.transcripts.v2 = machineTranscript("v2", [{ start: 0, end: 2, lang: "en", text: "Hello, and welcome.", flags: [] }]);
    await user.click(screen.getByRole("button", { name: "Check for new versions" }));
    expect(await screen.findByText(/The new transcript is ready/)).toBeTruthy();
    expect(await screen.findByText("Hello, and welcome.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls).toBe(1);
  });

  it("leaving while a transcription runs and coming back shows it still running, then its new version (review I2)", async () => {
    const svc = transcriptService();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcribe"), async () => {
        calls++;
        await gate;
        const at = new Date(Date.now() + 60_000).toISOString();
        svc.state.versions.push(machineVersion("v2", "vtt", at, "small"));
        svc.state.transcripts.v2 = machineTranscript("v2", [{ start: 0, end: 2, lang: "en", text: "Hello, and welcome.", flags: [] }]);
        return HttpResponse.json({ sourceId: "s1", folder: "sources/s1", files: [svc.state.versions.at(-1)!.path], flaggedSegments: 0 });
      }),
      ...svc.handlers,
    );
    const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Re-transcribe" }));
    await screen.findByRole("progressbar", { name: "Transcription in progress" });
    view.unmount();
    render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    expect(screen.getByRole("progressbar", { name: "Transcription in progress" })).toBeTruthy();
    expect(screen.getByText(/You can leave this screen/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    expect(await screen.findByText(/The new transcript is ready/)).toBeTruthy();
    expect(await screen.findByText("Hello, and welcome.")).toBeTruthy();
    expect((screen.getByLabelText("Version") as HTMLSelectElement).value).toBe("v2");
    expect((screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls).toBe(1);
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
