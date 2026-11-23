import type { ToolsResponse } from "@ao/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolsApi } from "../api/tools";
import { PATHS, useLocation } from "../navigation";
import { ToolsSetupRoute } from "../screens/ToolsSetup";
import { catalogue, catalogueWithoutHosts, makeApi, makeClient, memoryStore, onComputer, server, toolsService, useMsw, withoutHostsFor } from "../test/msw-tools";
import { FIRST_USE_QUESTION, FirstUseTools, recordToolsScreenSeen } from "./FirstUseTools";

useMsw();

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const FFMPEG = "Video tools (ffmpeg)";

/** The library screen, reduced: a button, a text field, the header's tools link, and the question's place. */
function Page({ memory, svc = toolsService(), api, hidden, children }: { memory: ReturnType<typeof memoryStore>; svc?: ReturnType<typeof toolsService>; api?: ToolsApi; hidden?: boolean; children?: React.ReactNode }) {
  server.use(...svc.handlers);
  return (
    <>
      <main>
        <button type="button">Something in the app</button>
        <label>
          Search sources
          <input type="search" />
        </label>
        <a href={PATHS.tools}>Optional tools</a>
        <FirstUseTools api={api ?? makeApi()} memory={memory} {...(hidden !== undefined ? { hidden } : {})} />
      </main>
      {children}
    </>
  );
}

/** The banner's "Choose tools…" pressed: the dialogue is open with focus in it. */
async function opened(memory = memoryStore(), svc = toolsService()) {
  const user = userEvent.setup();
  const view = render(<Page memory={memory} svc={svc} />);
  const opener = await screen.findByRole("button", { name: "Choose tools…" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Optional tools" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return { user, view, dialog, opener, memory, svc };
}

/** A tools API whose catalogue answers at once with `answer` (or fails), for checks that nothing appears. */
const answering = (answer: ToolsResponse | Error): ToolsApi => ({ ...makeApi(), catalogue: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) });
/** Lets an answered promise reach the component. */
const flush = () => act(async () => {});

const activity = (name: RegExp) => screen.getByRole("checkbox", { name });
const toolBox = (name: string) => within(screen.getByRole("group", { name: "Tools to download" })).getByRole("checkbox", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) });
const banner = () => screen.queryByText(FIRST_USE_QUESTION);

describe("the first-use question's banner (R164)", () => {
  it("asks in one sentence until answered, never opens the dialogue by itself, and never takes focus", async () => {
    const svc = toolsService();
    let release!: () => void;
    svc.state.holdCatalogue = new Promise((r) => (release = r));
    const user = userEvent.setup();
    render(<Page memory={memoryStore()} svc={svc} />);
    const field = screen.getByRole("searchbox", { name: "Search sources" });
    await user.click(field);
    await user.type(field, "river");
    release();
    expect(await screen.findByText(FIRST_USE_QUESTION)).toBeTruthy();
    await user.type(field, " bank");
    expect(document.activeElement).toBe(field);
    expect((field as HTMLInputElement).value).toBe("river bank");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose tools…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("is announced once: put into a polite live region that was there before it", async () => {
    const svc = toolsService();
    let release!: () => void;
    svc.state.holdCatalogue = new Promise((r) => (release = r));
    render(<Page memory={memoryStore()} svc={svc} />);
    const live = screen.getByRole("status");
    expect(live.textContent).toBe("");
    release();
    const sentence = await screen.findByText(FIRST_USE_QUESTION);
    expect(screen.getByRole("status")).toBe(live);
    expect(live.contains(sentence)).toBe(true);
    expect(screen.getAllByText(FIRST_USE_QUESTION)).toHaveLength(1);
  });

  it("its live region holds the sentence only: the buttons are outside it, so a screen reader does not read their labels with it (FR-316)", async () => {
    const svc = toolsService();
    let release!: () => void;
    svc.state.holdCatalogue = new Promise((r) => (release = r));
    render(<Page memory={memoryStore()} svc={svc} />);
    const live = screen.getByRole("status");
    release();
    await screen.findByText(FIRST_USE_QUESTION);
    expect(screen.getByRole("status")).toBe(live);
    expect(live.textContent).toBe(FIRST_USE_QUESTION);
    expect(live.contains(screen.getByRole("button", { name: "Choose tools…" }))).toBe(false);
    expect(live.contains(screen.getByRole("button", { name: "Not now" }))).toBe(false);
  });

  it("is hidden while the unlock screen is shown, and comes back without being announced again", async () => {
    const memory = memoryStore();
    const svc = toolsService();
    const api = makeApi(); // one client, as the library route keeps it
    const view = render(<Page memory={memory} svc={svc} api={api} />);
    await screen.findByText(FIRST_USE_QUESTION);
    view.rerender(<Page memory={memory} svc={svc} api={api} hidden />);
    expect(banner()).toBeNull();
    view.rerender(<Page memory={memory} svc={svc} api={api} hidden={false} />);
    const sentence = await screen.findByText(FIRST_USE_QUESTION);
    expect(screen.getByRole("status").contains(sentence)).toBe(false);
    expect(svc.state.requests.filter((r) => r === "GET /tools")).toHaveLength(1);
  });

  it("is keyboard-reachable in the normal reading order", async () => {
    const user = userEvent.setup();
    render(<Page memory={memoryStore()} />);
    await screen.findByText(FIRST_USE_QUESTION);
    screen.getByRole("link", { name: "Optional tools" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose tools…" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Not now" }));
  });

  it("Not now records the answer, removes the banner and moves focus to the library's Optional tools link; nothing is downloaded", async () => {
    const memory = memoryStore();
    const svc = toolsService();
    const user = userEvent.setup();
    render(<Page memory={memory} svc={svc} />);
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(memory.value).toBe("not-now");
    expect(banner()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Optional tools" })));
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("shows nothing once answered, by any answer, and does not even read the catalogue", () => {
    for (const answer of ["not-now", "chosen", "seen"] as const) {
      const svc = toolsService();
      const view = render(<Page memory={memoryStore(answer)} svc={svc} />);
      expect(banner()).toBeNull();
      expect(svc.state.requests).toEqual([]);
      view.unmount();
    }
  });

  it("reaching the Optional tools screen counts as an answer (R163); an earlier answer is kept", () => {
    const fresh = memoryStore();
    recordToolsScreenSeen(fresh);
    expect(fresh.value).toBe("seen");
    const chosen = memoryStore("chosen");
    recordToolsScreenSeen(chosen);
    expect(chosen.value).toBe("chosen");
  });

  it("shows nothing when the catalogue offers nothing for this computer", async () => {
    const svc = toolsService();
    const list = svc.state.tools.map((t) => ({ ...t, available: false, unavailableReason: "Not offered for this computer." }));
    render(<Page memory={memoryStore()} api={answering({ platform: null, tools: list, jobs: [] })} />);
    await flush();
    expect(banner()).toBeNull();
  });

  it("shows nothing when the catalogue cannot be read (the app is never blocked)", async () => {
    render(<Page memory={memoryStore()} api={answering(new Error("The tools are managed from the desktop app."))} />);
    await flush();
    expect(banner()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the first-use tools dialogue", () => {
  it("opens from Choose tools… and moves focus in", async () => {
    const { dialog } = await opened();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(activity(/recordings/i));
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

  it("traps focus with Tab and Shift+Tab and makes the background inert; its Not now records the answer and focus goes to the Optional tools link", async () => {
    const { user, memory } = await opened();
    const main = document.querySelector("main")!;
    expect(main.closest("[inert]")).not.toBeNull();
    const first = document.activeElement;
    await user.tab({ shift: true });
    const last = document.activeElement as HTMLElement;
    expect(last.textContent).toBe("Not now");
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(main.closest("[inert]")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Optional tools" })));
    expect(memory.value).toBe("not-now");
    expect(banner()).toBeNull();
  });

  it("Escape closes the dialogue only: focus returns to Choose tools…, the banner stays, nothing is recorded or downloaded", async () => {
    const { user, memory, svc, opener } = await opened();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(banner()).not.toBeNull();
    expect(memory.value).toBeNull();
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

  it("without hosts in the catalogue it names none and says the servers that host each tool, not its publisher (FR-291, R467 M7)", async () => {
    const { user } = await opened(memoryStore(), toolsService({ tools: catalogueWithoutHosts() }));
    await user.click(activity(/save videos/i));
    const line = screen.getByText(/nothing about your projects or about you/i);
    expect(line.textContent).toBe("Downloading contacts the servers that host each tool (the catalogue does not name them). Nothing about your projects or about you is sent.");
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
    const { user, svc, memory } = await opened();
    await user.click(activity(/save picture posts/i));
    await user.click(activity(/recordings/i));
    expect(svc.state.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    await user.dblClick(screen.getByRole("button", { name: /^Download 3 tools/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = svc.state.requests.filter((r) => r.startsWith("POST")).sort();
    expect(posts).toEqual(["POST /tools/ffmpeg/install", "POST /tools/image-downloader/install", "POST /tools/speech-medium/install"]);
    expect(memory.value).toBe("chosen");
    expect(window.location.pathname).toBe(PATHS.tools);
    expect(banner()).toBeNull(); // answered; the tools screen takes focus in the app
  });

  it("after the confirmation focus lands on a started tool on the Optional tools screen, never on the page body (FR-315)", async () => {
    // The app's route table, reduced: the library screen with the question, or the tools screen.
    function Routed({ memory, svc }: { memory: ReturnType<typeof memoryStore>; svc: ReturnType<typeof toolsService> }) {
      const loc = useLocation();
      return loc.pathname === PATHS.tools ? <ToolsSetupRoute client={makeClient()} loc={loc} memory={memory} /> : <Page memory={memory} svc={svc} />;
    }
    const memory = memoryStore();
    const svc = toolsService();
    const user = userEvent.setup();
    render(<Routed memory={memory} svc={svc} />);
    await user.click(await screen.findByRole("button", { name: "Choose tools…" }));
    await screen.findByRole("dialog", { name: "Optional tools" });
    await user.click(activity(/save picture posts/i));
    await user.click(screen.getByRole("button", { name: /^Download 1 tool/ }));
    const heading = await screen.findByRole("heading", { name: "Image downloader" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
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
