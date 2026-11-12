import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS } from "../navigation";
import { catalogue, makeApi, memoryStore, server, toolsService, useMsw } from "../test/msw-tools";
import { FirstUseTools } from "./FirstUseTools";

useMsw();

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function Page({ memory, svc = toolsService() }: { memory: ReturnType<typeof memoryStore>; svc?: ReturnType<typeof toolsService> }) {
  server.use(...svc.handlers);
  return (
    <>
      <main>
        <button type="button">Something in the app</button>
      </main>
      <FirstUseTools api={makeApi()} memory={memory} pathname="/" />
    </>
  );
}

async function opened(memory = memoryStore(), svc = toolsService()) {
  const user = userEvent.setup();
  screen.queryByRole("button", { name: "Something in the app" });
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

describe("the first-use tools dialogue", () => {
  it("opens the first time, with no tool installed and the question not yet answered, and moves focus in", async () => {
    const { dialog } = await opened();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(activity(/recordings/i));
  });

  it("does not open once answered", async () => {
    const svc = toolsService();
    render(<Page memory={memoryStore("not-now")} svc={svc} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(svc.state.requests).toEqual([]); // not even asked
  });

  it("does not open when some optional tool is already installed", async () => {
    const tools = catalogue();
    Object.assign(tools.find((t) => t.id === "ffmpeg")!, { installed: true, usable: true });
    const svc = toolsService({ tools });
    render(<Page memory={memoryStore()} svc={svc} />);
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open when the catalogue cannot be read (the app is never blocked)", async () => {
    const svc = toolsService();
    svc.state.failCatalogue = { status: 403, code: "FORBIDDEN", message: "The tools are managed from the desktop app." };
    render(<Page memory={memoryStore()} svc={svc} />);
    await waitFor(() => expect(svc.state.requests).toContain("GET /tools"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open over the tools screen itself", async () => {
    const svc = toolsService();
    server.use(...svc.handlers);
    render(<FirstUseTools api={makeApi()} memory={memoryStore()} pathname={PATHS.tools} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("Escape is Not now: remembered, nothing downloaded", async () => {
    const { user, memory, svc } = await opened();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(memory.value).toBe("not-now");
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("offers the matching tools pre-selected with the total download size, and the hosts it contacts", async () => {
    const { user } = await opened();
    expect(screen.queryByRole("group", { name: "Tools to download" })).toBeNull();
    await user.click(activity(/recordings/i));
    expect((toolBox("Speech model: small") as HTMLInputElement).checked).toBe(true);
    expect((toolBox("ffmpeg (video and audio conversion)") as HTMLInputElement).checked).toBe(true);
    // 484 MB + 30 MB
    expect(screen.getByText(/Total download: 514 MB/)).toBeTruthy();
    await user.click(activity(/save videos/i));
    expect((toolBox("Video downloader") as HTMLInputElement).checked).toBe(true);
    // ffmpeg is counted once: 484 + 30 + 78 (about)
    expect(screen.getByText(/Total download: about 592 MB/)).toBeTruthy();
    expect(screen.getByText(/dl\.deno\.land/)).toBeTruthy();
    expect(screen.getByText(/nothing about your projects or about you/i)).toBeTruthy();
    // Unticking a tool lowers the total.
    await user.click(toolBox("Speech model: small"));
    expect(screen.getByText(/Total download: about 108 MB/)).toBeTruthy();
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
    const { user, svc, memory } = await opened();
    await user.click(activity(/save picture posts/i));
    await user.click(activity(/recordings/i));
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    await user.dblClick(screen.getByRole("button", { name: /^Download 3 tools/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = svc.state.requests.filter((r) => r.startsWith("POST")).sort();
    expect(posts).toEqual(["POST /tools/ffmpeg/install", "POST /tools/image-downloader/install", "POST /tools/speech-small/install"]);
    expect(memory.value).toBe("chosen");
    expect(window.location.pathname).toBe(PATHS.tools);
  });

  it("a refused install keeps the dialogue open with a plain message and a way to retry", async () => {
    const { user, svc } = await opened();
    await user.click(activity(/save picture posts/i));
    svc.state.failNextPost = { status: 503, code: "WORKER_UNAVAILABLE", message: "The media helper could not be started." };
    await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert.textContent).toMatch(/media helper/i);
    await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(svc.state.requests.filter((r) => r === "POST /tools/image-downloader/install")).toHaveLength(2);
  });
});
