import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogue, makeApi, toolsService, server, useMsw } from "../test/msw-tools";
import { ToolsSetup } from "./ToolsSetup";

useMsw();

afterEach(() => {
  vi.useRealTimers();
});

const card = (name: string) => screen.getByRole("region", { name });

async function shown(svc = toolsService(), props: Partial<Parameters<typeof ToolsSetup>[0]> = {}) {
  server.use(...svc.handlers);
  const user = userEvent.setup();
  const view = render(<ToolsSetup api={makeApi()} pollMs={20} {...props} />);
  await screen.findByRole("region", { name: "Video downloader" });
  return { svc, user, view };
}

describe("the optional tools screen", () => {
  it("lists every tool with its purpose, what stops without it, its size and whether it is installed", async () => {
    await shown();
    for (const t of catalogue()) {
      const c = card(t.name);
      expect(within(c).getByText(t.purpose)).toBeTruthy();
      expect(within(c).getByText(new RegExp(t.without.replace(/[.()]/g, "\\$&")))).toBeTruthy();
    }
    expect(within(card("Speech model: small")).getByText(/484 MB/)).toBeTruthy();
    expect(within(card("Speech model: small")).getByText("Not installed")).toBeTruthy();
    expect(within(card("Speech model: small")).getByRole("button", { name: "Install Speech model: small" })).toBeTruthy();
  });

  it("gives each speech model a plain hint about speed and accuracy", async () => {
    await shown();
    expect(within(card("Speech model: tiny")).getByText(/fastest.*least accurate/i)).toBeTruthy();
    expect(within(card("Speech model: large-v3")).getByText(/slowest.*most accurate/i)).toBeTruthy();
  });

  it("offers the video downloader and its JavaScript runtime as one choice", async () => {
    const { user, svc } = await shown();
    const c = card("Video downloader");
    expect(within(c).getByText(/yt-dlp/)).toBeTruthy();
    expect(within(c).getByText(/Deno \(JavaScript runtime\)/)).toBeTruthy();
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

  it("says what going without ffmpeg means: located media stays proxy pending and is left out of exports", async () => {
    await shown();
    const c = card("ffmpeg (video and audio conversion)");
    expect(within(c).getByText(/proxy pending/)).toBeTruthy();
    expect(within(c).getByText(/left out of exports/)).toBeTruthy();
  });

  it("says downloading contacts only the publisher, sends nothing about projects, and names the hosts from the catalogue", async () => {
    await shown();
    expect(screen.getByText(/sends nothing about your projects or about you/i)).toBeTruthy();
    expect(within(card("Video downloader")).getByText(/github\.com/)).toBeTruthy();
    expect(within(card("Video downloader")).getByText(/dl\.deno\.land/)).toBeTruthy();
    expect(within(card("ffmpeg (video and audio conversion)")).getByText(/ffmpeg\.martin-riedl\.de/)).toBeTruthy();
  });

  it("shows install progress, announces start, a sparse milestone and the end, and then shows it installed", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install ffmpeg (video and audio conversion)" }));
    const bar = await screen.findByRole("progressbar", { name: /Installing ffmpeg/ });
    expect(bar).toBeTruthy();
    const live = screen.getByRole("status", { name: "Tool progress" });
    await waitFor(() => expect(live.textContent).toMatch(/Installing ffmpeg .* started/));
    const seen: string[] = [];
    const note = () => {
      if (live.textContent && seen[seen.length - 1] !== live.textContent) seen.push(live.textContent);
    };
    const job = svc.jobOf("ffmpeg")!;
    for (const p of [0.1, 0.2, 0.3, 0.4, 0.55, 0.6, 0.7, 0.8, 0.9]) {
      svc.progress(job.jobId, p);
      await waitFor(() => expect(Number(screen.getByRole("progressbar", { name: /Installing ffmpeg/ }).getAttribute("value"))).toBeCloseTo(p * 100, 0));
      note();
    }
    svc.finish(job.jobId);
    await waitFor(() => expect(within(card("ffmpeg (video and audio conversion)")).getByText("Installed")).toBeTruthy());
    await waitFor(() => expect(live.textContent).toMatch(/ffmpeg .* installed/i));
    note();
    // start, one milestone (half way), end: never every event.
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen.some((s) => /half/i.test(s))).toBe(true);
  });

  it("a double click sends one install request", async () => {
    const { user, svc } = await shown();
    await user.dblClick(screen.getByRole("button", { name: "Install Speech model: tiny" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: tiny/ });
    expect(svc.state.requests.filter((r) => r === "POST /tools/speech-tiny/install")).toHaveLength(1);
  });

  it("an install can be cancelled", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install Speech model: small" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: small/ });
    await user.click(within(card("Speech model: small")).getByRole("button", { name: "Cancel installing Speech model: small" }));
    const job = svc.jobOf("speech-small")!;
    await waitFor(() => expect(svc.state.requests).toContain(`POST /tools/jobs/${job.jobId}/cancel`));
    await waitFor(() => expect(within(card("Speech model: small")).getByText(/cancelled/i)).toBeTruthy());
    expect(within(card("Speech model: small")).queryByRole("progressbar")).toBeNull();
  });

  it("a running install is shown again after leaving the screen and coming back (or a reload)", async () => {
    const svc = toolsService();
    const { user, view } = await shown(svc);
    await user.click(screen.getByRole("button", { name: "Install Picture-post downloader" }));
    await screen.findByRole("progressbar", { name: /Installing Picture-post downloader/ });
    svc.progress(svc.jobOf("image-downloader")!.jobId, 0.4);
    view.unmount();
    render(<ToolsSetup api={makeApi()} pollMs={20} />);
    const bar = await screen.findByRole("progressbar", { name: /Installing Picture-post downloader/ });
    expect(Number(bar.getAttribute("value"))).toBeCloseTo(40, 0);
    svc.finish(svc.jobOf("image-downloader")!.jobId);
    await waitFor(() => expect(within(card("Picture-post downloader")).getByText("Installed")).toBeTruthy());
  });

  it("a failed install says why in plain words and can be tried again", async () => {
    const { user, svc } = await shown();
    await user.click(screen.getByRole("button", { name: "Install ffmpeg (video and audio conversion)" }));
    await screen.findByRole("progressbar", { name: /Installing ffmpeg/ });
    svc.finish(svc.jobOf("ffmpeg")!.jobId, "failed", { code: "TOOL_CHECKSUM_MISMATCH", message: "The downloaded file did not match its published checksum, so it was not installed. Try again later." });
    const alert = await within(card("ffmpeg (video and audio conversion)")).findByRole("alert");
    expect(alert.textContent).toMatch(/did not match its published checksum/);
    expect(alert.textContent).not.toMatch(/TOOL_/);
    await user.click(within(card("ffmpeg (video and audio conversion)")).getByRole("button", { name: "Try again: install ffmpeg (video and audio conversion)" }));
    await waitFor(() => expect(svc.state.requests.filter((r) => r === "POST /tools/ffmpeg/install")).toHaveLength(2));
    await screen.findByRole("progressbar", { name: /Installing ffmpeg/ });
  });

  it("a refused request says why in plain words and can be tried again", async () => {
    const { user, svc } = await shown();
    svc.state.failNextPost = { status: 503, code: "WORKER_UNAVAILABLE", message: "The media helper could not be started." };
    await user.click(screen.getByRole("button", { name: "Install Speech model: tiny" }));
    const alert = await within(card("Speech model: tiny")).findByRole("alert");
    expect(alert.textContent).toMatch(/media helper/);
    await user.click(within(card("Speech model: tiny")).getByRole("button", { name: "Try again: install Speech model: tiny" }));
    await screen.findByRole("progressbar", { name: /Installing Speech model: tiny/ });
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
    const tools = catalogue();
    const ff = tools.find((t) => t.id === "ffmpeg")!;
    Object.assign(ff, { installed: true, usable: true, managed: false, remainingSize: 0 });
    ff.components = ff.components.map((c) => ({ ...c, installed: true, usable: true, source: "system" as const }));
    await shown(toolsService({ tools }));
    const c = card("ffmpeg (video and audio conversion)");
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

  it("drops a catalogue answer that arrives after the screen was left", async () => {
    const svc = toolsService();
    let release!: () => void;
    svc.state.holdCatalogue = new Promise<void>((r) => (release = r));
    server.use(...svc.handlers);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<ToolsSetup api={makeApi()} pollMs={20} />);
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    view.unmount();
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("brings the named tool into view and focus when the address names one", async () => {
    await shown(toolsService(), { focusTool: "ffmpeg" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "ffmpeg (video and audio conversion)" })));
  });
});
