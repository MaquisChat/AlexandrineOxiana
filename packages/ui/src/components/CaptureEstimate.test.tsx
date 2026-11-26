import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CaptureEstimate as Estimate, DownloadQuality } from "@ao/shared";
import { PATHS } from "../navigation";
import { CaptureEstimate, initialQuality } from "./CaptureEstimate";

/** The spec's channel: 412 videos, 310 hours, 380 GB free on "Macintosh HD", Video tools installed. */
const channel = (over: Partial<Estimate> = {}): Estimate => ({
  kind: "channel",
  platform: "youtube",
  title: "Example Channel",
  count: 412,
  alreadyInProject: 0,
  soundSeconds: 310 * 3600,
  unknownLengths: 0,
  listComplete: true,
  freeBytes: 380_000_000_000,
  diskName: "Macintosh HD",
  videoToolsInstalled: true,
  speechModel: "medium",
  metadataOnly: false,
  ...over,
});

/** The component with its quality and transcription held as the screen holds them. */
function Holder({ estimate, transcribe: t0 = false, onStart = () => {}, onCancel = () => {} }: { estimate: Estimate; transcribe?: boolean; onStart?: () => void; onCancel?: () => void }) {
  const [quality, setQuality] = useState<DownloadQuality>(initialQuality(estimate));
  const [transcribe, setTranscribe] = useState(t0);
  return <CaptureEstimate estimate={estimate} quality={quality} onQuality={setQuality} transcribe={transcribe} onTranscribe={setTranscribe} onStart={onStart} onCancel={onCancel} busy={false} />;
}

const region = () => screen.getByRole("region", { name: 'Capture channel: "Example Channel"' });
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("CaptureEstimate", () => {
  it('the estimate shows "412 videos, about 310 hours." and "Roughly 150–250 GB at this quality. 380 GB are free on "Macintosh HD"."', () => {
    render(<Holder estimate={channel()} />);
    const r = region();
    expect(within(r).getByRole("heading", { level: 3, name: 'Capture channel: "Example Channel"' })).toBeTruthy();
    expect(within(r).getByText("412 videos, about 310 hours.")).toBeTruthy();
    expect(within(r).getByText('Roughly 150–250 GB at this quality. 380 GB are free on "Macintosh HD".')).toBeTruthy();
    // The sketch's order and words: Best available, Up to 720p, Up to 1080p, Audio only; Up to 720p chosen.
    const quality = within(r).getByRole("group", { name: "Quality" });
    expect(within(quality).getAllByRole("radio").map((x) => x.closest("label")!.textContent!.trim())).toEqual(["Best available", "Up to 720p", "Up to 1080p", "Audio only"]);
    expect(radio("Up to 720p").checked).toBe(true);
    expect(within(r).getByRole("group", { name: "Transcribe" })).toBeTruthy();
    expect(within(r).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(r).getByRole("button", { name: "Cancel" })).toBeTruthy();
    // The title, from the platform, is shown as user text.
    expect(within(r).getByRole("heading", { level: 3 }).querySelector("[dir=auto]")).not.toBeNull();
  });

  it("the counts already in the project and a list cut short are said", () => {
    render(<Holder estimate={channel({ alreadyInProject: 5, listComplete: false })} />);
    expect(screen.getByText("5 more are already in this project and are not downloaded again.")).toBeTruthy();
    expect(screen.getByText("YouTube stopped listing part-way, so this may not be the whole channel.")).toBeTruthy();
  });

  it("changing the quality changes the size", async () => {
    const user = userEvent.setup();
    render(<Holder estimate={channel()} />);
    await user.click(radio("Audio only"));
    expect(radio("Audio only").checked).toBe(true);
    expect(screen.getByText('Roughly 13–22 GB at this quality. 380 GB are free on "Macintosh HD".')).toBeTruthy();
    expect(screen.queryByText(/150–250 GB/)).toBeNull();
  });

  it("unknown lengths say size unknown and do not guess", () => {
    render(<Holder estimate={channel({ soundSeconds: 0, unknownLengths: 412 })} />);
    expect(screen.getByText("412 videos; their lengths are not known.")).toBeTruthy();
    expect(screen.getByText(`Size unknown: YouTube did not give the videos' lengths. 380 GB are free on "Macintosh HD".`)).toBeTruthy();
    expect(screen.queryByText(/Roughly/)).toBeNull();
  });

  it('an estimate larger than the free space says so and Start reads "Start anyway — it will pause when the disk is nearly full"', () => {
    render(<Holder estimate={channel({ freeBytes: 200_000_000_000 })} />);
    expect(screen.getByText("This may need more space than the disk has free, less the 10 GB the app keeps free.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start anyway — it will pause when the disk is nearly full" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it('without Video tools the four choices are disabled with "These need Video tools." and an Install Video tools link, and Ready-made file is chosen', () => {
    render(<Holder estimate={channel({ videoToolsInstalled: false })} />);
    for (const name of ["Best available", "Up to 720p", "Up to 1080p", "Audio only"]) {
      expect(radio(name).disabled).toBe(true);
      expect(radio(name).checked).toBe(false);
    }
    const ready = radio("Ready-made file (lower quality)");
    expect(ready.disabled).toBe(false);
    expect(ready.checked).toBe(true);
    const note = screen.getByText(/These need Video tools\./);
    expect(radio("Best available").getAttribute("aria-describedby")).toBe(note.id);
    const link = screen.getByRole("link", { name: "Install Video tools" });
    expect(link.getAttribute("href")!.startsWith(PATHS.tools)).toBe(true);
  });

  it("with Video tools installed the ready-made choice is not shown", () => {
    render(<Holder estimate={channel({ videoToolsInstalled: true })} />);
    expect(screen.queryByRole("radio", { name: "Ready-made file (lower quality)" })).toBeNull();
    expect(screen.queryByText(/These need Video tools/)).toBeNull();
    expect(initialQuality(channel({ videoToolsInstalled: null }))).toBe("720p");
    expect(initialQuality(channel({ videoToolsInstalled: false }))).toBe("ready");
  });

  it("metadata only hides Quality and says almost no disk space is needed", () => {
    render(<Holder estimate={channel({ metadataOnly: true })} />);
    expect(screen.queryByRole("group", { name: "Quality" })).toBeNull();
    expect(screen.getByText("Metadata only: almost no disk space is needed.")).toBeTruthy();
  });

  it("the Transcribe box names the speech model and follows its value", async () => {
    const user = userEvent.setup();
    render(<Holder estimate={channel({ speechModel: "small" })} transcribe />);
    const box = screen.getByRole("checkbox", { name: "Transcribe each video on this Mac (speech model: small)" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    expect(box.checked).toBe(false);
  });

  it('the time lines read "Downloading: some hours; it depends on YouTube." and the unmeasured transcribing sentence', async () => {
    const user = userEvent.setup();
    render(<Holder estimate={channel()} />);
    const UNMEASURED = "Transcribing: days rather than hours. The app will say more exactly once it has transcribed the first video on this Mac.";
    expect(screen.getByText("Downloading: some hours; it depends on YouTube.")).toBeTruthy();
    // Said only while Transcribe is ticked.
    expect(screen.queryByText(UNMEASURED)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /Transcribe each video/ }));
    expect(screen.getByText(UNMEASURED)).toBeTruthy();
  });

  it("nothing new still offers Start, for the check of changes and removals", () => {
    const onStart = vi.fn();
    render(<Holder estimate={channel({ count: 0, soundSeconds: 0, alreadyInProject: 412 })} onStart={onStart} />);
    expect(screen.getByText("Nothing new to download: every video listed is already in this project. Starting checks the listed videos for changes and removals.")).toBeTruthy();
    expect(screen.getByText("Nothing new will be downloaded, so no disk space is needed.")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    start.click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("Start and Cancel are disabled while busy", () => {
    render(<CaptureEstimate estimate={channel()} quality="720p" onQuality={() => {}} transcribe={false} onTranscribe={() => {}} onStart={() => {}} onCancel={() => {}} busy />);
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
