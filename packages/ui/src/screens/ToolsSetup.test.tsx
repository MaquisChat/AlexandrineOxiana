import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPEECH_MODEL, SPEECH_MODELS } from "@ao/shared";
import { catalogue, catalogueWithoutHosts, makeApi, onComputer, server, toolsService, useMsw, withoutHostsFor } from "../test/msw-tools";
import { ToolsSetup } from "./ToolsSetup";

useMsw();

afterEach(() => {
  vi.useRealTimers();
});

const FFMPEG = "Video tools (ffmpeg)";
const card = (name: string) => screen.getByRole("region", { name });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function shown(svc = toolsService(), props: Partial<Parameters<typeof ToolsSetup>[0]> = {}) {
  server.use(...svc.handlers);
  const user = userEvent.setup();
  const view = render(<ToolsSetup api={makeApi()} pollMs={20} {...props} />);
  await screen.findByRole("region", { name: "Video downloader" });
  return { svc, user, view };
}

describe("the optional tools screen", () => {
  it("lists every tool the app can use with its purpose, what stops without it, its size and whether it is installed", async () => {
    await shown();
    for (const t of catalogue()) {
      const c = card(t.name);
      expect(within(c).getByText(t.purpose)).toBeTruthy();
      expect(within(c).getByText(new RegExp(escape(t.without)))).toBeTruthy();
    }
    expect(within(card("Speech model: small")).getByText(/484 MB/)).toBeTruthy();
    expect(within(card("Speech model: small")).getByText("Not installed")).toBeTruthy();
    expect(within(card("Speech model: small")).getByRole("button", { name: "Install Speech model: small" })).toBeTruthy();
  });

  it("offers exactly the speech models of the shared definition (R158), the default among them", async () => {
    await shown();
    const offered = screen.getAllByRole("region", { name: /^Speech model: / }).map((r) => r.getAttribute("aria-labelledby") && within(r).getByRole("heading").textContent);
    expect(offered).toEqual(SPEECH_MODELS.map((m) => `Speech model: ${m}`));
    expect(within(card(`Speech model: ${DEFAULT_SPEECH_MODEL}`)).getByText(/the app's default/i)).toBeTruthy();
  });

  it("gives each speech model a plain hint about speed and accuracy, and names the app's default", async () => {
    await shown();
    expect(within(card("Speech model: tiny")).getByText(/quickest.*least accurate/i)).toBeTruthy();
    expect(within(card("Speech model: medium")).getByText(/the app's default/i)).toBeTruthy();
    expect(within(card("Speech model: large-v3")).getByText(/slowest.*most accurate/i)).toBeTruthy();
  });

  it("offers the video downloader and its JavaScript runtime as one choice", async () => {
    const { user, svc } = await shown();
    const c = card("Video downloader");
    expect(within(c).getByText("Video downloader (yt-dlp)")).toBeTruthy();
    expect(within(c).getByText("JavaScript runtime (deno)")).toBeTruthy();
    expect(within(c).getAllByRole("button", { name: /^Install/ })).toHaveLength(1);
    await user.click(within(c).getByRole("button", { name: "Install Video downloader" }));
    await waitFor(() => expect(svc.state.requests).toContain("POST /tools/video-downloader/install"));
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual(["POST /tools/video-downloader/install"]);
  });

  it("shows OCR as unavailable on this computer with its reason, and offers no install", async () => {
    await shown();
    const c = card("Text recognition (OCR)");
    expect(within(c).getByText(/Not available on this computer/)).toBeTruthy();
    expect(within(c).getAllByText(/No signed build of tesseract/).length).toBeGreaterThan(0);
    expect(within(c).queryByRole("button", { name: /Install/ })).toBeNull();
  });

  it("says once what going without ffmpeg means: located media stays proxy pending and is left out of exports", async () => {
    await shown();
    const c = card(FFMPEG);
    expect(within(c).getAllByText(/proxy pending/)).toHaveLength(1);
    expect(within(c).getAllByText(/left out of exports/)).toHaveLength(1);
  });

  it("says it if the catalogue's text does not (an older worker)", async () => {
    const tools = catalogue().map((t) => (t.id === "ffmpeg" ? { ...t, without: "Videos get no viewing copies." } : t));
    await shown(toolsService({ tools }));
    expect(within(card(FFMPEG)).getAllByText(/proxy pending/)).toHaveLength(1);
  });

  it("names every host entry from the catalogue; a *.domain pattern in plain words, never dropped (N1)", async () => {
    await shown();
    expect(screen.getByText(/sends nothing about your projects or about you/i).textContent).toMatch(/addresses listed with the tool/);
    expect(within(card("Speech model: medium")).getByText("Downloads from: huggingface.co, any server under hf.co")).toBeTruthy();
    expect(within(card("Video downloader")).getByText("Downloads from: github.com, objects.githubusercontent.com, release-assets.githubusercontent.com, api.github.com, dl.deno.land")).toBeTruthy();
    expect(within(card(FFMPEG)).getByText("Downloads from: ffmpeg.martin-riedl.de")).toBeTruthy();
  });

  it("a tool that lists no hosts says its publisher's servers are contacted, and the screen claims no complete list", async () => {
    await shown(toolsService({ tools: withoutHostsFor(catalogue(), "image-downloader") }));
    expect(within(card("Image downloader")).getByText("Downloads from: its publisher's servers (the catalogue does not name them).")).toBeTruthy();
    expect(screen.getByText(/sends nothing about your projects or about you/i).textContent).not.toMatch(/addresses listed/);
  });

  it("the screen's general sentence says the servers that host each tool, not its publisher (some are hosted by a third party) (FR-291)", async () => {
    const { view } = await shown();
    const listed = screen.getByText(/sends nothing about your projects or about you/i).textContent!;
    expect(listed).not.toMatch(/publisher/);
    expect(listed).toMatch(/^Each download contacts only the addresses listed with the tool and sends nothing about your projects or about you\./);
    view.unmount();
    await shown(toolsService({ tools: catalogueWithoutHosts() }));
    const unlisted = screen.getByText(/sends nothing about your projects or about you/i).textContent!;
    expect(unlisted).not.toMatch(/publisher/);
    expect(unlisted).toMatch(/^Each download contacts only the servers that host the tool and sends nothing about your projects or about you\./);
  });

  it("without hosts anywhere in the catalogue it names none and claims no list", async () => {
    await shown(toolsService({ tools: catalogueWithoutHosts() }));
    expect(screen.getByText(/sends nothing about your projects or about you/i).textContent).not.toMatch(/addresses listed/);
    expect(within(card(FFMPEG)).getByText("Downloads from: its publisher's servers (the catalogue does not name them).")).toBeTruthy();
  });

  it("shows install progress, announces start, a sparse milestone and the end, and then shows it installed", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: `Install ${FFMPEG}` }));
    expect(await screen.findByRole("progressbar", { name: /Installing Video tools/ })).toBeTruthy();
    const live = screen.getByRole("status", { name: "Tool progress" });
    await waitFor(() => expect(live.textContent).toMatch(/Installing Video tools \(ffmpeg\) started/));
    expect(live.querySelector("[dir=auto]")?.textContent).toBe(FFMPEG); // the name is catalogue text
    const seen: string[] = [];
    const note = () => {
      if (live.textContent && seen[seen.length - 1] !== live.textContent) seen.push(live.textContent);
    };
    const job = svc.jobOf("ffmpeg")!;
    for (const p of [0.1, 0.2, 0.3, 0.4, 0.55, 0.6, 0.7, 0.8, 0.9]) {
      svc.progress(job.jobId, p);
      await waitFor(() => expect(Number(screen.getByRole("progressbar", { name: /Installing Video tools/ }).getAttribute("value"))).toBeCloseTo(p * 100, 0));
      note();
    }
    svc.finish(job.jobId);
    await waitFor(() => expect(within(card(FFMPEG)).getByText("Installed")).toBeTruthy());
    await waitFor(() => expect(live.textContent).toMatch(/Video tools \(ffmpeg\) is installed/i));
    note();
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen.some((s) => /half/i.test(s))).toBe(true);
  });

  it("two jobs ending in the same reading are both announced", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: `Install ${FFMPEG}` }));
    await user.click(screen.getByRole("button", { name: "Install Image downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Image downloader/ });
    svc.finish(svc.jobOf("ffmpeg")!.jobId);
    svc.finish(svc.jobOf("image-downloader")!.jobId);
    const live = screen.getByRole("status", { name: "Tool progress" });
    await waitFor(() => expect(live.textContent).toMatch(/Video tools \(ffmpeg\) is installed/));
    expect(live.textContent).toMatch(/Image downloader is installed/);
  });

  it("a double click sends one install request", async () => {
    const { user, svc } = await shown();
    await user.dblClick(screen.getByRole("button", { name: "Install Speech model: small" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: small/ });
    expect(svc.state.requests.filter((r) => r === "POST /tools/speech-small/install")).toHaveLength(1);
  });

  it("after a cancel it re-reads the catalogue and says what is installed now, never 'nothing was changed'", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Video downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Video downloader/ });
    // yt-dlp arrived before the cancel; deno did not.
    const vd = svc.state.tools.find((t) => t.id === "video-downloader")!;
    vd.managed = true;
    vd.remainingSize = 40_000_000;
    vd.components = vd.components.map((c) => (c.id === "yt-dlp" ? { ...c, installed: true, usable: true, source: "managed" as const } : c));
    const reads = svc.state.requests.filter((r) => r === "GET /tools").length;
    const live = screen.getByRole("status", { name: "Tool progress" });
    // Every time the live region is written, note it: "Stopping" must be said once, not on every poll (N3).
    const spoken: string[] = [];
    const watch = new MutationObserver(() => spoken.push(live.textContent ?? ""));
    watch.observe(live, { childList: true, subtree: true, characterData: true });
    await user.click(within(card("Video downloader")).getByRole("button", { name: "Cancel installing Video downloader" }));
    // Until the media helper answers: "Stopping…", announced once, and no second Cancel.
    await waitFor(() => expect(within(card("Video downloader")).getByText("Stopping…")).toBeTruthy());
    expect(within(card("Video downloader")).queryByRole("button", { name: /Cancel/ })).toBeNull();
    await waitFor(() => expect(live.textContent).toBe("Stopping Video downloader."));
    const polls = svc.state.requests.length;
    await waitFor(() => expect(svc.state.requests.length).toBeGreaterThan(polls + 8)); // several polls while stopping
    watch.disconnect();
    expect(spoken.filter((t) => t === "Stopping Video downloader.")).toHaveLength(1);
    svc.finish(svc.jobOf("video-downloader")!.jobId, "cancelled");
    await waitFor(() => expect(svc.state.requests.filter((r) => r === "GET /tools").length).toBeGreaterThan(reads));
    const c = card("Video downloader");
    await waitFor(() => expect(within(c).getByText(/Stopped/)).toBeTruthy());
    const said = within(c).getByText(/Stopped/).textContent!;
    expect(said).not.toMatch(/Nothing was changed/i);
    expect(said).toMatch(/Video downloader \(yt-dlp\) is installed/);
    expect(said).toMatch(/JavaScript runtime \(deno\) is not/);
    // The leftover part can be removed, and the rest installed.
    expect(within(c).getByRole("button", { name: "Remove Video downloader" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Install Video downloader" })).toBeTruthy();
  });

  it("a cancel that left nothing behind says so from the catalogue", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Speech model: small" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: small/ });
    await user.click(within(card("Speech model: small")).getByRole("button", { name: "Cancel installing Speech model: small" }));
    const job = svc.jobOf("speech-small")!;
    await waitFor(() => expect(svc.state.requests).toContain(`POST /tools/jobs/${job.jobId}/cancel`));
    svc.finish(job.jobId, "cancelled");
    await waitFor(() => expect(within(card("Speech model: small")).getByText(/Stopped.*is not installed/)).toBeTruthy());
    expect(within(card("Speech model: small")).queryByRole("progressbar")).toBeNull();
  });

  it("an install that completed before the stop took effect says it is installed and offers Remove", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Image downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Image downloader/ });
    await user.click(within(card("Image downloader")).getByRole("button", { name: "Cancel installing Image downloader" }));
    await waitFor(() => expect(within(card("Image downloader")).getByText("Stopping…")).toBeTruthy());
    svc.finish(svc.jobOf("image-downloader")!.jobId, "done");
    const c = () => card("Image downloader");
    await waitFor(() => expect(within(c()).getByText(/It finished before the stop took effect\. Image downloader is installed\./)).toBeTruthy());
    expect(within(c()).getByText("Installed")).toBeTruthy();
    expect(within(c()).getByRole("button", { name: "Remove Image downloader" })).toBeTruthy();
    // The live region is written by an effect, one render after the card's own sentence: wait for it.
    await waitFor(() => expect(screen.getByRole("status", { name: "Tool progress" }).textContent).toMatch(/finished before the stop took effect/));
  });

  it("a stop the media helper did not confirm is said plainly, with what the catalogue shows, and nothing is retried", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Speech model: small" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: small/ });
    await user.click(within(card("Speech model: small")).getByRole("button", { name: "Cancel installing Speech model: small" }));
    svc.finish(svc.jobOf("speech-small")!.jobId, "failed", { code: "CANCEL_UNCONFIRMED", message: "The media helper did not confirm that it stopped. Check the tools list to see whether the tool is installed." });
    const alert = await within(card("Speech model: small")).findByRole("alert");
    expect(alert.textContent).toMatch(/did not confirm that it stopped/);
    await waitFor(() => expect(alert.textContent).toMatch(/Speech model: small is not installed/));
    expect(within(alert).queryByRole("button")).toBeNull();
    expect(svc.state.requests.filter((r) => r === "POST /tools/speech-small/install")).toHaveLength(1);
  });

  it("a media helper that stops after a stop was asked for: the stop is acknowledged, with what is installed, and no install retry (N2)", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Video downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Video downloader/ });
    await user.click(within(card("Video downloader")).getByRole("button", { name: "Cancel installing Video downloader" }));
    await waitFor(() => expect(within(card("Video downloader")).getByText("Stopping…")).toBeTruthy());
    const vd = svc.state.tools.find((t) => t.id === "video-downloader")!;
    vd.managed = true;
    vd.components = vd.components.map((c) => (c.id === "yt-dlp" ? { ...c, installed: true, usable: true, source: "managed" as const } : c));
    svc.finish(svc.jobOf("video-downloader")!.jobId, "failed", { code: "WORKER_UNAVAILABLE", message: "The media helper stopped before the job finished. Nothing was left half-installed; try again." });
    const c = () => card("Video downloader");
    await waitFor(() => expect(within(c()).getByText(/^The stop was asked for, and the job ended without finishing\./)).toBeTruthy());
    const said = within(c()).getByText(/^The stop was asked for/).textContent!;
    expect(said).toMatch(/Video downloader \(yt-dlp\) is installed; JavaScript runtime \(deno\) is not installed\./);
    expect(within(c()).queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(within(c()).getByRole("button", { name: "Remove Video downloader" })).toBeTruthy();
  });

  it("a remove offers no Cancel (it cannot be stopped)", async () => {
    const tools = catalogue().map((t) => (t.id === "image-downloader" ? { ...t, installed: true, usable: true, managed: true, remainingSize: 0 } : t));
    const { user } = await shown(toolsService({ tools }));
    await user.click(within(card("Image downloader")).getByRole("button", { name: "Remove Image downloader" }));
    await screen.findByRole("progressbar", { name: /Removing Image downloader/ });
    expect(within(card("Image downloader")).queryByRole("button", { name: /Cancel/ })).toBeNull();
  });

  it("a failed cancel's Try again retries the cancel, never the install (I4)", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Speech model: medium" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: medium/ });
    const job = svc.jobOf("speech-medium")!;
    svc.state.failNextCancel = { status: 503, code: "WORKER_UNAVAILABLE", message: "The media helper is not running." };
    await user.click(within(card("Speech model: medium")).getByRole("button", { name: "Cancel installing Speech model: medium" }));
    const alert = await within(card("Speech model: medium")).findByRole("alert");
    expect(alert.textContent).toMatch(/could not be stopped/i);
    await user.click(within(alert).getByRole("button", { name: "Try again: cancel installing Speech model: medium" }));
    await waitFor(() => expect(svc.state.requests.filter((r) => r === `POST /tools/jobs/${job.jobId}/cancel`)).toHaveLength(2));
    expect(svc.state.requests.filter((r) => r === "POST /tools/speech-medium/install")).toHaveLength(1);
  });

  it("a cancel of a job that had already ended re-reads the catalogue and starts nothing", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Speech model: medium" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: medium/ });
    svc.state.failNextCancel = { status: 404, code: "NOT_FOUND", message: "That tool job was not found." };
    await user.click(within(card("Speech model: medium")).getByRole("button", { name: "Cancel installing Speech model: medium" }));
    const alert = await within(card("Speech model: medium")).findByRole("alert");
    expect(alert.textContent).toMatch(/had already ended/);
    expect(within(alert).queryByRole("button")).toBeNull();
    expect(svc.state.requests.filter((r) => r.startsWith("POST /tools/speech-medium"))).toHaveLength(1);
  });

  it("a running install is shown again after leaving the screen and coming back (or a reload)", async () => {
    const svc = toolsService();
    const { user, view } = await shown(svc);
    await user.click(screen.getByRole("button", { name: "Install Image downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Image downloader/ });
    svc.progress(svc.jobOf("image-downloader")!.jobId, 0.4);
    view.unmount();
    render(<ToolsSetup api={makeApi()} pollMs={20} />);
    const bar = await screen.findByRole("progressbar", { name: /Installing Image downloader/ });
    expect(Number(bar.getAttribute("value"))).toBeCloseTo(40, 0);
    svc.finish(svc.jobOf("image-downloader")!.jobId);
    await waitFor(() => expect(within(card("Image downloader")).getByText("Installed")).toBeTruthy());
  });

  it("a failed install says why in plain words and Try again repeats the install", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: `Install ${FFMPEG}` }));
    await screen.findByRole("progressbar", { name: /Installing Video tools/ });
    svc.finish(svc.jobOf("ffmpeg")!.jobId, "failed", { code: "TOOL_CHECKSUM_MISMATCH", message: "The downloaded file did not match its published checksum, so it was not installed. Try again later." });
    const alert = await within(card(FFMPEG)).findByRole("alert");
    expect(alert.textContent).toMatch(/did not match its published checksum/);
    expect(alert.textContent).not.toMatch(/TOOL_/);
    await user.click(within(card(FFMPEG)).getByRole("button", { name: `Try again: install ${FFMPEG}` }));
    await waitFor(() => expect(svc.state.requests.filter((r) => r === "POST /tools/ffmpeg/install")).toHaveLength(2));
    await screen.findByRole("progressbar", { name: /Installing Video tools/ });
  });

  it("a refused request says why in plain words, without the helper's start-up text, and Try again repeats it", async () => {
    const { user, svc } = await shown();
    svc.state.failNextPost = { status: 503, code: "WORKER_UNAVAILABLE", message: "The media helper is not running.", reason: "spawn /Users/ana/app/python ENOENT" };
    await user.click(screen.getByRole("button", { name: "Install Speech model: small" }));
    const alert = await within(card("Speech model: small")).findByRole("alert");
    expect(alert.textContent).toMatch(/media helper/);
    expect(alert.textContent).not.toMatch(/ENOENT|\/Users/);
    await user.click(within(card("Speech model: small")).getByRole("button", { name: "Try again: install Speech model: small" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: small/ });
  });

  it("an installed tool the app manages offers Update and Remove", async () => {
    const tools = catalogue();
    Object.assign(tools.find((t) => t.id === "video-downloader")!, { installed: true, usable: true, managed: true, remainingSize: 0 });
    const { user, svc } = await shown(toolsService({ tools }));
    const c = card("Video downloader");
    expect(within(c).getByText("Installed")).toBeTruthy();
    expect(within(c).queryByRole("button", { name: /^Install/ })).toBeNull();
    await user.click(within(c).getByRole("button", { name: "Update Video downloader" }));
    await waitFor(() => expect(svc.state.requests).toContain("POST /tools/video-downloader/update"));
    svc.finish(svc.jobOf("video-downloader")!.jobId);
    await waitFor(() => expect(within(card("Video downloader")).getByRole("button", { name: "Remove Video downloader" })).toBeTruthy());
    await user.click(within(card("Video downloader")).getByRole("button", { name: "Remove Video downloader" }));
    await waitFor(() => expect(svc.state.requests).toContain("POST /tools/video-downloader/remove"));
  });

  it("a tool found on this computer (not the app's own copy) is shown installed with no Remove", async () => {
    await shown(toolsService({ tools: onComputer(catalogue(), "ffmpeg") }));
    const c = card(FFMPEG);
    expect(within(c).getByText("Installed")).toBeTruthy();
    expect(within(c).getByText(/found on this computer/i)).toBeTruthy();
    expect(within(c).queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("a catalogue that cannot be read says so in plain words and offers to try again", async () => {
    const svc = toolsService();
    svc.state.failCatalogue = { status: 503, code: "WORKER_UNAVAILABLE", message: "The media helper could not be started." };
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ToolsSetup api={makeApi()} pollMs={20} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/media helper/i);
    delete svc.state.failCatalogue;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Video downloader" });
  });

  it("an older catalogue reading that answers after a newer one is dropped (it would undo 'Installed')", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: `Install ${FFMPEG}` }));
    await user.click(screen.getByRole("button", { name: "Install Image downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Image downloader/ });
    // The reading that follows ffmpeg's end is held, and answers late with what was true before.
    let release!: () => void;
    const before = catalogue().map((t) => (t.id === "ffmpeg" ? { ...t, installed: true, usable: true, managed: true, remainingSize: 0 } : t));
    svc.state.gates.push({ wait: new Promise<void>((r) => (release = r)), body: { platform: "linux-x64", tools: before, jobs: [] } });
    svc.finish(svc.jobOf("ffmpeg")!.jobId);
    await waitFor(() => expect(svc.state.gates).toHaveLength(0));
    svc.finish(svc.jobOf("image-downloader")!.jobId);
    await waitFor(() => expect(within(card("Image downloader")).getByText("Installed")).toBeTruthy());
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(within(card("Image downloader")).getByText("Installed")).toBeTruthy();
    expect(within(card("Image downloader")).queryByRole("progressbar")).toBeNull();
  });

  it("brings the named tool into view and focus when the address names one", async () => {
    await shown(toolsService(), { focusTool: "ffmpeg" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: FFMPEG })));
  });
});
