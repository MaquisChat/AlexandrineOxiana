import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_TICKET_IDLE_MS } from "@ao/shared";
import { MEDIA_FILE_CHANGED_SENTENCE, NO_RECORDING_SENTENCE, REVOKE_WAIT_MS } from "../components/MediaTicketPlayer";
import { transcriptApi } from "../api/transcripts";
import { setMedia } from "../test/media";
import { navigate } from "../navigation";
import { BASE, server, testClient, url, useMockService } from "../test/service";
import { humanTranscript, humanVersion, job, machineTranscript, sourceFile, machineVersion, MACHINE_VERSIONS, SEGMENTS, serviceErrorBody, storedHumanTranscript, transcriptService } from "../test/msw-transcripts";
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

/**
 * Makes the element's read fail and waits for where the player then rests: the next ticket asked
 * for and put in the element ("renewed"), or the alert that it stopped ("stopped").
 */
async function failAndRest(el: HTMLMediaElement, tickets: Array<{ path: string }>): Promise<"renewed" | "stopped"> {
  const before = tickets.length;
  fireEvent(el, new Event("error"));
  return waitFor(() => {
    if (screen.queryByText(/The recording could not be played/)) return "stopped" as const;
    expect(tickets.length).toBe(before + 1);
    expect(el.getAttribute("src")).toBe(`${BASE}${tickets.at(-1)!.path}`);
    return "renewed" as const;
  });
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

  it("a person's edit shows the flags the service stored: unchanged segments keep the machine flags, edited and added ones are not checked (Task 62)", async () => {
    const segments = [
      { ...SEGMENTS[0]!, text: "Hello, and welcome.", flags: null, edit: "edited" as const },
      { ...SEGMENTS[1]!, edit: "unchanged" as const },
      { start: 9, end: 10, lang: "en", text: "A line the person heard.", flags: null, edit: "added" as const },
    ];
    const { svc } = await open({ versions: [...MACHINE_VERSIONS, humanVersion("h0")], transcripts: { h0: storedHumanTranscript("h0", segments) } }, { waitFor: "Hello, and welcome." });
    expect(segmentItems()[1]!.textContent).toMatch(/Flagged for review: Possibly invented text over silence/);
    expect(segmentItems()[1]!.textContent).not.toMatch(/not checked/);
    expect(segmentItems()[0]!.textContent).toMatch(/Edited by a person — not checked/);
    expect(segmentItems()[0]!.textContent).not.toMatch(/Flagged/);
    expect(segmentItems()[2]!.textContent).toMatch(/Added by a person — not checked/);
    expect(screen.getByText(/edited by a person/i, { selector: "p.ao-tx__note" }).textContent).toMatch(/left unchanged show the flags/);
    // No second version is read to work the flags out: they come with the edit.
    expect(svc.log.reads).toEqual(["h0"]);
  });

  it("an edit saved before flags were stored shows every segment as not checked, never as clean (Task 62)", async () => {
    await open({ versions: [...MACHINE_VERSIONS, humanVersion("h0")], transcripts: { h0: humanTranscript("h0") } });
    for (const item of segmentItems()) {
      expect(item.textContent).toMatch(/Not checked/);
      expect(item.textContent).not.toMatch(/Flagged/);
    }
    expect(screen.getByText(/edited by a person/i, { selector: "p.ao-tx__note" }).textContent).toMatch(/before the app recorded/);
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

  // R362 f: a recording never starts by itself. What the researcher does while a ticket is being renewed is kept.
  it("R362 f: playing, the ticket ends, the researcher pauses during the renewal: the renewal lands at the same place, PAUSED, and play() is not called", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4.25);
    fireEvent(el, new Event("error"));
    // The researcher presses pause while the new ticket is asked for.
    fireEvent(el, new Event("pause"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    // The browser's own pause as the source changes.
    fireEvent(el, new Event("pause"));
    const before = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(4.25);
    expect(played).toBe(before);
  });

  it("R362 f: paused, the ticket ends, the researcher presses play during the renewal: it plays when the renewal lands", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    playTo(el, 3);
    fireEvent(el, new Event("error"));
    fireEvent(el, new Event("play"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    const before = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(3);
    expect(played).toBe(before + 1);
  });

  it("R362 f: a seek by the researcher during the renewal keeps the place asked", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4.25);
    fireEvent(el, new Event("error"));
    // The researcher drags the element's own position control while the new ticket is asked for.
    el.currentTime = 30;
    fireEvent(el, new Event("seeking"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    const before = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(30);
    expect(played).toBe(before + 1);
  });

  // R371 b: what the researcher does between a renewal's metadata and its seek's landing is what the NEXT renewal resumes with.
  it("R371 b: a pause pressed after the renewal's metadata and before its seek lands holds for the next renewal: play() is not called again", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4.25);
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    fireEvent(el, new Event("pause")); // the browser's own, as the source changes
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    fireEvent(el, new Event("play")); // the player's own play()
    fireEvent(el, new Event("pause")); // the researcher's, before the seek lands
    fireEvent(el, new Event("seeked"));
    expect(el.currentTime).toBe(4.25);
    // The next ticket ends while paused.
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(3));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[2]!.path}`));
    fireEvent(el, new Event("pause"));
    const before = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(4.25);
    expect(played).toBe(before);
  });

  it("R371 b: the mirror — paused, a play pressed in that window holds for the next renewal: it plays", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    playTo(el, 3);
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    fireEvent(el, new Event("pause"));
    const first = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(played).toBe(first); // it lands paused, as it was
    fireEvent(el, new Event("play")); // the researcher's, before the seek lands
    fireEvent(el, new Event("seeked"));
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(3));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[2]!.path}`));
    fireEvent(el, new Event("pause"));
    const before = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(3);
    expect(played).toBe(before + 1);
  });

  it("R371 c: a seek made while playing, whose own read meets the expired ticket, resumes at the place asked", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4.25);
    // The researcher seeks to 30; the seek's range read fails: the ticket had ended.
    el.currentTime = 30;
    fireEvent(el, new Event("seeking"));
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    fireEvent(el, new Event("pause"));
    const before = played;
    el.currentTime = 0;
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(30);
    expect(played).toBe(before + 1);
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

  it("a resume seek that never lands: once the element is playing again its time is taken, so the playing segment follows (FR-259)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 1);
    fireEvent(el, new Event("error"));
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    browserReset(el);
    fireEvent(el, new Event("loadedmetadata"));
    expect(el.currentTime).toBe(1);
    // No `seeked` ever comes, and the element plays on from elsewhere.
    fireEvent(el, new Event("playing"));
    playTo(el, 5.2);
    playTo(el, 6);
    expect(segmentItems()[2]!.getAttribute("aria-current")).toBe("true");
    expect(segmentItems()[0]!.getAttribute("aria-current")).toBeNull();
  });

  it("three ticket expiries after long pauses near one spot are renewals, never 'may be damaged' (FR-260)", async () => {
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skipped);
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    for (const [i, at] of [50, 50.8, 51.5, 50.2].entries()) {
      playTo(el, at);
      // Paused here longer than a ticket lives without reads: the ticket ended on its own.
      skipped += MEDIA_TICKET_IDLE_MS + 60_000;
      fireEvent(el, new Event("error"));
      await waitFor(() => expect(svc.log.tickets).toHaveLength(i + 2));
      await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[i + 1]!.path}`));
      browserReset(el);
      fireEvent(el, new Event("loadedmetadata"));
      expect(el.currentTime).toBe(at);
      fireEvent(el, new Event("seeked"));
    }
    expect(screen.queryByText(/The recording could not be played/)).toBeNull();
    expect(svc.log.tickets).toHaveLength(5);
  });

  it("after a long pause the researcher presses play (or seeks) and only then the expired ticket fails: a renewal, never 'may be damaged'; a young ticket's failure still counts (FR-260, R467 I1)", async () => {
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skipped);
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    // The reviewer's probe: pause, 11 minutes, play (or a seek), then the element's read fails.
    for (const [i, at] of [50, 50.8, 51.5].entries()) {
      playTo(el, at);
      fireEvent(el, new Event("pause"));
      skipped += MEDIA_TICKET_IDLE_MS + 60_000;
      if (i === 1) {
        el.currentTime = at;
        fireEvent(el, new Event("seeking"));
      } else fireEvent(el, new Event("play"));
      fireEvent(el, new Event("error"));
      await waitFor(() => expect(svc.log.tickets).toHaveLength(i + 2));
      await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[i + 1]!.path}`));
      browserReset(el);
      fireEvent(el, new Event("loadedmetadata"));
      expect(el.currentTime).toBe(at);
      fireEvent(el, new Event("seeked"));
    }
    expect(screen.queryByText(/The recording could not be played/)).toBeNull();
    // A ticket that fails while young counts: it cannot renew for ever.
    for (let cycle = 0; cycle < 4; cycle++) {
      fireEvent(el, new Event("error"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      fireEvent(el, new Event("loadedmetadata"));
      playTo(el, 51.6);
    }
    expect(await screen.findByText(/The recording could not be played/)).toBeTruthy();
    // Four tickets for the three pauses, one renewal of a young ticket, then it stops.
    expect(svc.log.tickets).toHaveLength(5);
  });

  it("a ticket answer whose idle end is far shorter than the shared ten minutes cannot make every failure an expiry: the player still stops after its strikes (FR-260, R481 c)", async () => {
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skipped);
    // The reviewer's probe B: every ticket's idle end is 1 s after its issue.
    const { svc } = await open({ ticketIdleExpiresAt: "2026-11-11T10:00:01.000Z" });
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 50);
    let cycles = 0;
    while (cycles < 12) {
      cycles++;
      // Failures 2 s apart, at one place: older than the answer's 1 s, younger than MEDIA_TICKET_IDLE_MS.
      skipped += 2_000;
      const outcome = await failAndRest(el, svc.log.tickets);
      if (outcome === "stopped") break;
      browserReset(el);
      fireEvent(el, new Event("loadedmetadata"));
      fireEvent(el, new Event("seeked"));
    }
    expect(screen.getByRole("alert").textContent).toMatch(/^The recording could not be played: it stopped at the same place again\. Its file may be damaged/);
    // The lifetime is taken as MEDIA_TICKET_IDLE_MS: two young failures renew (MAX_RENEWALS_WITHOUT_PROGRESS), the third stops.
    expect(cycles).toBe(3);
    expect(svc.log.tickets).toHaveLength(3);
  });

  it("a recording whose file the service found changed outside the app says so at once, never 'may be damaged' after retries (FR-218, FR-219)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4);
    // The stream was cut where the service found the file changed.
    svc.state.fileChanged = true;
    fireEvent(el, new Event("error"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(MEDIA_FILE_CHANGED_SENTENCE);
    // R462 a: the ruled sentence, word for word.
    expect(MEDIA_FILE_CHANGED_SENTENCE).toBe("The recording stopped: its file is no longer as the app stored it — it was changed outside the app, or it is damaged — so it cannot be played from here. Check the verification report.");
    expect(alert.textContent).not.toMatch(/may be damaged|\//);
    // No new ticket was asked for, and the ended one was let go.
    expect(svc.log.tickets).toHaveLength(1);
    expect(svc.log.revoked).toEqual([svc.log.tickets[0]!.path]);
    expect(el.getAttribute("src")).toBeNull();
    // R467 M5: a retry cannot help, so none is offered: the sentence and the controls agree.
    expect(screen.queryByRole("button", { name: "Try the recording again" })).toBeNull();
  });

  it("a recording whose raw data the app destroyed while it played says what the app says of a destroyed recording, not 'changed outside the app', and offers no Try again (R467 M3)", async () => {
    const { svc } = await open();
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4);
    svc.state.fileDestroyed = true;
    fireEvent(el, new Event("error"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NO_RECORDING_SENTENCE);
    expect(NO_RECORDING_SENTENCE).toBe("This source has no recording to play. Its transcript is shown below.");
    expect(svc.log.tickets).toHaveLength(1);
    expect(el.getAttribute("src")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try the recording again" })).toBeNull();
  });

  it("a revoke that never answers is waited for no longer than REVOKE_WAIT_MS; then the player renews as if no code came, never 'Reconnecting' for ever (R467 M4)", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const limits: Array<() => void> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === REVOKE_WAIT_MS) {
        limits.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms, ...(rest as []));
    }) as typeof setTimeout);
    const { svc } = await open();
    let hang = true;
    server.use(http.post(url("/media-tickets/revoke"), async () => (hang ? new Promise<Response>(() => {}) : HttpResponse.json({ revoked: true }))));
    await waitFor(() => expect(media()?.getAttribute("src")).toBeTruthy());
    const el = media()!;
    fireEvent(el, new Event("play"));
    playTo(el, 4);
    fireEvent(el, new Event("error"));
    expect(await screen.findByText("Reconnecting the recording…")).toBeTruthy();
    await waitFor(() => expect(limits).toHaveLength(1));
    expect(svc.log.tickets).toHaveLength(1);
    hang = false;
    act(() => limits[0]!());
    await waitFor(() => expect(svc.log.tickets).toHaveLength(2));
    await waitFor(() => expect(el.getAttribute("src")).toBe(`${BASE}${svc.log.tickets[1]!.path}`));
    expect(screen.queryByText("Reconnecting the recording…")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
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

describe("TranscriptViewer — transcribe again (a job, Task 62)", () => {
  /** The viewer with the mocked service; resolves once the transcript and the event stream are open. */
  async function openJob(opts: Parameters<typeof transcriptService>[0] = {}) {
    const svc = transcriptService(opts);
    server.use(...svc.handlers);
    const view = render(<TranscriptViewer api={api()} projectId="p1" sourceId="s1" />);
    await screen.findByText("Hello and welcome.");
    await waitFor(() => expect(svc.streams()).toBe(1));
    return { svc, view };
  }
  const button = () => screen.getByRole("button", { name: "Re-transcribe" }) as HTMLButtonElement;
  const runStatus = () => document.querySelector(".ao-tx__progress")!;
  /** A finished run's new version, as the service stores it. */
  function newVersion(svc: ReturnType<typeof transcriptService>, model = "medium") {
    const at = new Date(Date.now() + 60_000).toISOString();
    svc.state.versions.push(machineVersion("v2", "vtt", at, model), machineVersion("j2", "json", at, model));
    svc.state.transcripts.v2 = machineTranscript("v2", [{ start: 0, end: 2, lang: "en", text: "Hello, and welcome.", flags: [] }]);
    return { files: [svc.state.versions.at(-2)!.path, svc.state.versions.at(-1)!.path], flaggedSegments: 0 };
  }

  it("starts a job with the model chosen, shows its progress from the job's events, and the new version appears when it is done", async () => {
    const { svc } = await openJob();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Speech model"), "medium");
    await user.click(button());
    expect(await screen.findByText(/Transcribing with the medium model/)).toBeTruthy();
    expect(svc.log.transcribed).toEqual([{ sid: "s1", body: { model: "medium" } }]);
    expect(button().disabled).toBe(true);
    const j = svc.state.job!;
    act(() => svc.update({ ...j, status: "running", progress: 0.4, updatedAt: new Date().toISOString() }));
    const bar = (await screen.findByRole("progressbar", { name: "Transcription in progress" })) as HTMLProgressElement;
    await waitFor(() => expect(bar.value).toBeCloseTo(0.4));
    const result = newVersion(svc);
    act(() => svc.update({ ...j, status: "done", progress: 1, result, updatedAt: new Date().toISOString() }));
    expect(await screen.findByText(/The new transcript is ready/)).toBeTruthy();
    const picker = screen.getByLabelText("Version") as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("v2"));
    expect(await screen.findByText("Hello, and welcome.")).toBeTruthy();
    expect(button().disabled).toBe(false);
  });

  it("progress is not announced on every event: the status text changes only with the job's status", async () => {
    const { svc } = await openJob();
    await userEvent.setup().click(button());
    await screen.findByText(/Transcribing with the medium model/);
    const j = svc.state.job!;
    act(() => svc.update({ ...j, status: "running", progress: 0.2, updatedAt: new Date().toISOString() }));
    const bar = (await screen.findByRole("progressbar", { name: "Transcription in progress" })) as HTMLProgressElement;
    await waitFor(() => expect(bar.value).toBeCloseTo(0.2));
    const live = screen.getAllByRole("status").find((el) => el.contains(screen.getByText(/Transcribing with the medium model/)))!;
    const said = live.textContent;
    expect(live.contains(bar)).toBe(false); // the bar is outside the live region
    act(() => svc.update({ ...j, status: "running", progress: 0.6, updatedAt: new Date().toISOString() }));
    await waitFor(() => expect(bar.value).toBeCloseTo(0.6));
    expect(live.textContent).toBe(said);
  });

  it("a run started before the screen opened is shown when it opens (its state is read), and Re-transcribe stays off until it ends", async () => {
    const running = job({ status: "running", progress: 0.5, model: "small" });
    const { svc } = await openJob({ job: running });
    expect(await screen.findByRole("progressbar", { name: "Transcription in progress" })).toBeTruthy();
    expect(screen.getByText(/Transcribing with the small model/)).toBeTruthy();
    expect(button().disabled).toBe(true);
    const result = newVersion(svc, "small");
    act(() => svc.update({ ...running, status: "done", progress: 1, result, updatedAt: new Date().toISOString() }));
    expect(await screen.findByText(/The new transcript is ready/)).toBeTruthy();
    expect(button().disabled).toBe(false);
    expect(svc.log.transcribed).toHaveLength(0);
  });

  it("after the event stream drops, the job's state is read again, so a run that ended meanwhile is not missed", async () => {
    const running = job({ status: "running", progress: 0.5 });
    const { svc } = await openJob({ job: running });
    await screen.findByRole("progressbar", { name: "Transcription in progress" });
    const reads = svc.log.jobReads;
    svc.state.job = { ...running, status: "done", progress: 1, result: newVersion(svc), updatedAt: new Date().toISOString() };
    svc.closeStreams(); // the done event was missed
    await waitFor(() => expect(svc.log.jobReads).toBeGreaterThan(reads), { timeout: 5000 });
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(await screen.findByText("Hello, and welcome.")).toBeTruthy();
  });

  it("Stop sends one request however often it is pressed; the run ends as stopped and focus returns to Re-transcribe", async () => {
    const { svc } = await openJob();
    const user = userEvent.setup();
    await user.click(button());
    const stop = await screen.findByRole("button", { name: "Stop transcribing" });
    await waitFor(() => expect(document.activeElement).toBe(stop)); // Re-transcribe is off now: focus is not left on it
    await user.dblClick(stop);
    await waitFor(() => expect(svc.log.cancelled).toHaveLength(1));
    expect(await screen.findByText(/Stopping/)).toBeTruthy();
    const j = svc.state.job!;
    act(() => svc.update({ ...j, status: "cancelled", error: { code: "CANCELLED", message: "The transcription was stopped before it finished. Nothing was saved." }, updatedAt: new Date().toISOString() }));
    expect(await screen.findByText(/was stopped before it finished/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop transcribing" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button()));
    expect(svc.log.cancelled).toEqual([j.jobId]);
  });

  it("a request refused because the source is already being transcribed shows that run instead of an error", async () => {
    const { svc } = await openJob();
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcribe"), () => {
        svc.state.job = job({ status: "running", progress: 0.3, model: "large-v3" });
        return serviceErrorBody(409, "CONFLICT", "This recording is already being transcribed.", "TRANSCRIPTION_RUNNING");
      }),
    );
    await userEvent.setup().click(button());
    expect(await screen.findByText(/Transcribing with the large-v3 model/)).toBeTruthy();
    expect(screen.getByText(/already being transcribed/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a start whose answer was lost reads the job's state, so the run it may have started is shown, not started twice", async () => {
    const { svc } = await openJob();
    let calls = 0;
    server.use(
      http.post(url("/projects/:id/sources/:sid/transcribe"), () => {
        calls++;
        svc.state.job = job({ status: "queued" });
        return HttpResponse.error();
      }),
    );
    await userEvent.setup().click(button());
    expect(await screen.findByText(/Transcribing with the medium model/)).toBeTruthy();
    expect(button().disabled).toBe(true);
    expect(calls).toBe(1);
    expect(screen.queryByText(/may still be going/)).toBeNull();
  });

  it("a double click starts one job", async () => {
    const { svc } = await openJob();
    await userEvent.setup().dblClick(button());
    await screen.findByText(/Transcribing with the medium model/);
    expect(svc.log.transcribed).toHaveLength(1);
  });

  it("a media helper that is not running is explained once, without the raw reason (review M2)", async () => {
    await openJob();
    server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(503, "WORKER_UNAVAILABLE", "The media helper is not running.", "spawn python ENOENT")));
    await userEvent.setup().click(button());
    const msg = await screen.findByText(/media helper that runs speech recognition is not running/);
    expect(msg.textContent!.match(/not running/g)).toHaveLength(1);
    expect(msg.textContent).not.toMatch(/ENOENT/);
    expect(button().disabled).toBe(false);
  });

  it("a run that fails is said in words with what the service reported, never as a raw code (review M2)", async () => {
    const { svc } = await openJob();
    for (const [code, words] of [
      ["MODEL_UNAVAILABLE", /speech model “medium” on this computer could not be loaded/],
      ["INTERRUPTED", /was interrupted before it finished/],
      ["ENCRYPTION_REQUIRED", /encrypted/],
      ["INPUT_NOT_DECRYPTABLE", /could not be decrypted/],
      ["TOOL_FAILED", /speech tool failed/],
      ["SOMETHING_NEW", /could not finish the transcription/],
    ] as const) {
      await userEvent.setup().click(button());
      await screen.findByText(/Transcribing with the medium model/);
      const j = svc.state.job!;
      act(() => svc.update({ ...j, status: "failed", error: { code: "INTERNAL", message: "The media helper could not finish the job.", reason: code }, updatedAt: new Date(Date.now() + 120_000).toISOString() }));
      const msg = await screen.findByText(words);
      expect(msg.textContent).not.toContain(code);
    }
  });

  it("a speech model the job found missing is named, with a link to install it", async () => {
    const { svc } = await openJob();
    await userEvent.setup().click(button());
    await screen.findByText(/Transcribing with the medium model/);
    const j = svc.state.job!;
    act(() => svc.update({ ...j, status: "failed", error: { code: "TOOL_NOT_INSTALLED", message: "A tool this needs is not installed on this computer.", reason: "speech-medium" }, updatedAt: new Date(Date.now() + 120_000).toISOString() }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/speech model “medium” is not installed/i);
    expect(alert.textContent).not.toMatch(/speech-medium|TOOL_NOT_INSTALLED/);
  });

  it("on opening, a failed run newer than the newest version is shown; an older one is not", async () => {
    const failed = job({ status: "failed", error: { code: "INTERNAL", message: "The media helper could not finish the job.", reason: "TOOL_FAILED" }, updatedAt: "2026-11-02T10:00:00.000Z" });
    const first = await openJob({ job: failed });
    expect(await screen.findByText(/speech tool failed/)).toBeTruthy();
    first.view.unmount();
    await openJob({ job: { ...failed, updatedAt: "2026-10-01T10:00:00.000Z" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/speech tool failed/)).toBeNull();
  });

  it("fix 1 I1: a start the project's rules forbid shows the reason where the researcher clicked", async () => {
    await openJob();
    server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(403, "POLICY_DENIED", "This project's rules do not allow that.")));
    await userEvent.setup().click(button());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rules do not allow/);
    expect(button().disabled).toBe(false);
  });

  it("fix 1 I3: a rerun the rules refused is shown with its reason on opening, and Re-transcribe is on", async () => {
    await openJob({ job: job({ status: "failed", error: { code: "POLICY_DENIED", message: "This project's rules do not allow that." }, updatedAt: "2026-11-05T10:00:00.000Z" }) });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rules do not allow/);
    expect(button().disabled).toBe(false);
  });

  it("fix 1 M3: a start refused as already running when no run is found says so instead of nothing", async () => {
    const { svc } = await openJob();
    server.use(http.post(url("/projects/:id/sources/:sid/transcribe"), () => serviceErrorBody(409, "CONFLICT", "This recording is already being transcribed. Wait until that has finished, or cancel it, before starting another.", "TRANSCRIPTION_RUNNING")));
    svc.state.job = null;
    await userEvent.setup().click(button());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already being transcribed/);
  });

  it("fix 1 M2: a run waiting to run again says so, not that it is transcribing", async () => {
    await openJob({ job: job({ status: "queued", waiting: true, model: "small" }) });
    expect(await screen.findByText(/not running in this session of the app: it was interrupted, or it is still finishing/)).toBeTruthy();
    expect(screen.queryByText(/Transcribing with the small model/)).toBeNull();
    expect(button().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Stop transcribing" })).toBeTruthy();
  });

  it("a bare end event for the run shown (a run that finished after a lock) reads the state again", async () => {
    const waiting = job({ status: "queued", waiting: true, model: "small" });
    const { svc } = await openJob({ job: waiting });
    await screen.findByText(/not running in this session/);
    const reads = svc.log.jobReads;
    svc.state.job = { ...waiting, status: "done", waiting: undefined, updatedAt: new Date().toISOString() } as never;
    act(() => svc.emit("job.progress", { kind: "transcription", jobId: waiting.jobId, done: 0, total: 100, finished: true }));
    await waitFor(() => expect(svc.log.jobReads).toBeGreaterThan(reads));
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("fix 1 M3: a run cancelled by a lock is pending: it says it runs at the unlock and Re-transcribe stays off", async () => {
    await openJob({ job: job({ status: "cancelled", error: { code: "PROJECT_LOCKED", message: "The project was locked before the transcription could finish, so nothing was saved. It runs again when the project is unlocked.", reason: "PROJECT_LOCKED" } }) });
    expect(await screen.findByText(/runs again when the project is unlocked/)).toBeTruthy();
    expect(button().disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an event for another source, and answers after the screen closed, are dropped", async () => {
    const { svc, view } = await openJob();
    act(() => svc.update(job({ sourceId: "s2", status: "running", progress: 0.5 })));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("progressbar", { name: "Transcription in progress" })).toBeNull();
    expect(button().disabled).toBe(false);
    view.unmount();
    act(() => svc.update(job({ status: "running", progress: 0.5 })));
    await waitFor(() => expect(svc.streams()).toBe(0));
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
