import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS } from "../navigation";
import { catalogue, catalogueWithoutHosts, makeApi, memoryStore, onComputer, server, toolsService, useMsw, withoutHostsFor } from "../test/msw-tools";
import { FirstUseTools } from "./FirstUseTools";

useMsw();

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const FFMPEG = "Video tools (ffmpeg)";

/** The library screen, reduced: a button, a text field, and the first-use question's place. */
function Page({ memory, svc = toolsService(), quietMs = 0, children }: { memory: ReturnType<typeof memoryStore>; svc?: ReturnType<typeof toolsService>; quietMs?: number; children?: React.ReactNode }) {
  server.use(...svc.handlers);
  return (
    <>
      <main>
        <button type="button">Something in the app</button>
        <label>
          Search sources
          <input type="search" />
        </label>
        <FirstUseTools api={makeApi()} memory={memory} quietMs={quietMs} />
      </main>
      {children}
    </>
  );
}

async function opened(memory = memoryStore(), svc = toolsService()) {
  const user = userEvent.setup();
  const view = render(<Page memory={memory} svc={svc} />);
  const opener = screen.getByRole("button", { name: "Something in the app" });
  opener.focus();
  const dialog = await screen.findByRole("dialog", { name: "Optional tools" });
  // Focus moves in from the shell's effect, just after the dialog is in the document.
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return { user, view, dialog, opener, memory, svc };
}

const activity = (name: RegExp) => screen.getByRole("checkbox", { name });
const toolBox = (name: string) => within(screen.getByRole("group", { name: "Tools to download" })).getByRole("checkbox", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) });
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("the first-use tools dialogue", () => {
  it("opens the first time, while the question is not yet answered, and moves focus in", async () => {
    const { dialog } = await opened();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(activity(/recordings/i));
  });

  it("does not open once answered", async () => {
    const svc = toolsService();
    render(<Page memory={memoryStore("not-now")} svc={svc} />);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(svc.state.requests).toEqual([]); // not even asked
  });

  it("still asks when a tool is already on this computer (R158); that tool is shown as available, not ticked and not downloaded", async () => {
    const { user, svc } = await opened(memoryStore(), toolsService({ tools: onComputer(catalogue(), "ffmpeg") }));
    await user.click(activity(/recordings/i));
    const ff = toolBox(FFMPEG) as HTMLInputElement;
    expect(ff.checked).toBe(false);
    expect(ff.disabled).toBe(true);
    expect(screen.getByText(/Already on this computer/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual(["POST /tools/speech-medium/install"]);
  });

  it("does not open when the catalogue offers nothing for this computer", async () => {
    const svc = toolsService();
    svc.state.platform = null;
    svc.state.tools = svc.state.tools.map((t) => ({ ...t, available: false, unavailableReason: "Not offered for this computer." }));
    render(<Page memory={memoryStore()} svc={svc} />);
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open when the catalogue cannot be read (the app is never blocked)", async () => {
    const svc = toolsService();
    svc.state.failCatalogue = { status: 403, code: "FORBIDDEN", message: "The tools are managed from the desktop app." };
    render(<Page memory={memoryStore()} svc={svc} />);
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open while a text field has focus; opens once the field is left and the app has been quiet, and focus then returns to where it was", async () => {
    const svc = toolsService();
    const user = userEvent.setup();
    render(<Page memory={memoryStore()} svc={svc} quietMs={300} />);
    const field = screen.getByRole("searchbox", { name: "Search sources" });
    field.focus();
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field); // never taken from the field
    const opener = screen.getByRole("button", { name: "Something in the app" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Optional tools" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("waits while the researcher keeps typing or clicking, and opens after a quiet moment", async () => {
    const svc = toolsService();
    render(<Page memory={memoryStore()} svc={svc} quietMs={400} />);
    const button = screen.getByRole("button", { name: "Something in the app" });
    button.focus();
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    const started = Date.now();
    while (Date.now() - started < 1200) {
      fireEvent.keyDown(button, { key: "a" });
      fireEvent.pointerDown(button);
      await new Promise((r) => setTimeout(r, 100));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    const quietFrom = Date.now();
    await screen.findByRole("dialog", { name: "Optional tools" });
    expect(Date.now() - quietFrom).toBeGreaterThanOrEqual(300);
  });

  it("shows a quiet line with a link to the Optional tools screen until the question is answered", async () => {
    const { user } = await opened();
    // Behind the open dialogue, the line is on the page (not a dialog, not an alert).
    const line = screen.getByText(/optional tools that are not included with the app/i);
    expect(line.closest('[role="dialog"], [role="alert"], [role="alertdialog"]')).toBeNull();
    const link = within(line).getByRole("link", { name: "Set up optional tools" });
    expect(link.getAttribute("href")).toBe(PATHS.tools);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText(/optional tools that are not included with the app/i)).toBeNull();
  });

  it("the line is there before the question opens, and its link goes to the Optional tools screen at once", async () => {
    const svc = toolsService();
    const user = userEvent.setup();
    render(<Page memory={memoryStore()} svc={svc} quietMs={60_000} />);
    const link = await screen.findByRole("link", { name: "Set up optional tools" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(link);
    expect(window.location.pathname).toBe(PATHS.tools);
  });

  it("shows no line once answered", async () => {
    render(<Page memory={memoryStore("chosen")} />);
    await settle();
    expect(screen.queryByRole("link", { name: "Set up optional tools" })).toBeNull();
  });

  it("waits while another dialog is open, and opens once it has closed", async () => {
    const svc = toolsService();
    const other = (
      <div role="dialog" aria-label="Recovery code">
        <button type="button">Saved it</button>
      </div>
    );
    const { rerender } = render(
      <Page memory={memoryStore()} svc={svc}>
        {other}
      </Page>,
    );
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("dialog", { name: "Optional tools" })).toBeNull();
    rerender(<Page memory={memoryStore()} svc={svc} />);
    expect(await screen.findByRole("dialog", { name: "Optional tools" }, { timeout: 5000 })).toBeTruthy();
  });

  it("traps focus with Tab and Shift+Tab, makes the background inert, and restores focus after Not now", async () => {
    const { user, opener, memory } = await opened();
    const main = document.querySelector("main")!;
    expect(main.closest("[inert]")).not.toBeNull();
    const first = document.activeElement;
    await user.tab({ shift: true });
    const last = document.activeElement as HTMLElement;
    expect(last.textContent).toBe("Not now");
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(main.closest("[inert]")).toBeNull();
    expect(memory.value).toBe("not-now");
  });

  it("Escape is Not now: remembered, focus restored, nothing downloaded", async () => {
    const { user, memory, svc, opener } = await opened();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(memory.value).toBe("not-now");
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("pre-selects the app's default speech model (R158), with the total download size and the hosts it contacts", async () => {
    const { user } = await opened();
    expect(screen.queryByRole("group", { name: "Tools to download" })).toBeNull();
    await user.click(activity(/recordings/i));
    expect((toolBox("Speech model: medium") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("checkbox", { name: /Speech model: (tiny|small|large)/ })).toBeNull();
    expect((toolBox(FFMPEG) as HTMLInputElement).checked).toBe(true);
    // 1528 MB + 30 MB
    expect(screen.getByText(/Total download: 1\.6 GB/)).toBeTruthy();
    await user.click(activity(/save videos/i));
    expect((toolBox("Video downloader") as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByRole("checkbox", { name: new RegExp(`^${FFMPEG.replace(/[()]/g, "\\$&")}`) })).toHaveLength(1); // once
    expect(screen.getByText(/Total download: about 1\.6 GB/)).toBeTruthy();
    expect(screen.getByText(/dl\.deno\.land/)).toBeTruthy();
    expect(screen.getByText(/nothing about your projects or about you/i)).toBeTruthy();
    await user.click(toolBox("Speech model: medium"));
    expect(screen.getByText(/Total download: about 108 MB/)).toBeTruthy();
  });

  it("names every host of the ticked tools, the pattern in plain words, and claims 'only' when every tool lists its hosts (N1)", async () => {
    const { user } = await opened();
    await user.click(activity(/recordings/i));
    expect(screen.getByText(/nothing about your projects or about you/i).textContent).toBe(
      "Downloading contacts only these addresses: huggingface.co, any server under hf.co, ffmpeg.martin-riedl.de. Nothing about your projects or about you is sent.",
    );
  });

  it("when one ticked tool lists no hosts, it says so for that tool and makes no 'only' claim (N1)", async () => {
    const { user } = await opened(memoryStore(), toolsService({ tools: withoutHostsFor(catalogue(), "image-downloader") }));
    await user.click(activity(/recordings/i));
    await user.click(activity(/save picture posts/i));
    const line = screen.getByText(/nothing about your projects or about you/i);
    expect(line.textContent).not.toMatch(/\bonly\b/);
    expect(line.textContent).toMatch(/Speech model: medium: huggingface\.co, any server under hf\.co/);
    expect(line.textContent).toMatch(/Image downloader: its publisher's servers \(the catalogue does not name them\)/);
  });

  it("without hosts in the catalogue it names none and says only 'each tool's publisher'", async () => {
    const { user } = await opened(memoryStore(), toolsService({ tools: catalogueWithoutHosts() }));
    await user.click(activity(/save videos/i));
    const line = screen.getByText(/nothing about your projects or about you/i);
    expect(line.textContent).toMatch(/each tool's publisher/);
    expect(line.textContent).not.toMatch(/github|deno\.land/);
  });

  it("a tool already being installed (from the tools screen) is not offered again or counted", async () => {
    const svc = toolsService({ jobs: [{ jobId: "j9", toolId: "ffmpeg", action: "install", status: "running", progress: 0.3, startedAt: "2026-11-12T10:00:00Z" }] });
    const { user } = await opened(memoryStore(), svc);
    await user.click(activity(/recordings/i));
    const ff = toolBox(FFMPEG) as HTMLInputElement;
    expect(ff.checked).toBe(false);
    expect(ff.disabled).toBe(true);
    expect(screen.getByText(/Being installed/)).toBeTruthy();
    expect(screen.getByText(/Total download: 1\.5 GB/)).toBeTruthy();
  });

  it("shows OCR as unavailable with its reason when scanned documents are chosen; it cannot be ticked", async () => {
    const { user } = await opened();
    await user.click(activity(/scanned documents/i));
    const box = toolBox("Text recognition (OCR)") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(screen.getByText(/No signed build of tesseract/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^Download/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("downloads nothing until the explicit confirmation, then starts one install per tool and opens the tools screen", async () => {
    const { user, svc, memory, opener } = await opened();
    await user.click(activity(/save picture posts/i));
    await user.click(activity(/recordings/i));
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    await user.dblClick(screen.getByRole("button", { name: /^Download 3 tools/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = svc.state.requests.filter((r) => r.startsWith("POST")).sort();
    expect(posts).toEqual(["POST /tools/ffmpeg/install", "POST /tools/image-downloader/install", "POST /tools/speech-medium/install"]);
    expect(memory.value).toBe("chosen");
    expect(window.location.pathname).toBe(PATHS.tools);
    expect(document.activeElement).toBe(opener); // focus restored (the tools screen then takes it in the app)
  });

  it("a refused install keeps the dialogue open with a plain message (no start-up text) and a way to retry", async () => {
    const { user, svc } = await opened();
    await user.click(activity(/save picture posts/i));
    svc.state.failNextPost = { status: 503, code: "WORKER_UNAVAILABLE", message: "The media helper is not running.", reason: "spawn /Users/ana/app/python ENOENT" };
    await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert.textContent).toMatch(/media helper/i);
    expect(alert.textContent).not.toMatch(/ENOENT|\/Users/);
    await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(svc.state.requests.filter((r) => r === "POST /tools/image-downloader/install")).toHaveLength(2);
  });
});
