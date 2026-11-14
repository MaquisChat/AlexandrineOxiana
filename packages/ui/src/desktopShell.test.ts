/**
 * The bridge to the desktop shell (Task 37c): pickers through the Tauri dialog plugin, dropped paths
 * routed to the drop target under the pointer, and nothing at all outside the shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.fn();
let dragHandler: ((e: { payload: unknown }) => void) | undefined;
const onDragDropEvent = vi.fn(async (h: (e: { payload: unknown }) => void) => {
  dragHandler = h;
  return () => {};
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => open(...a) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent }) }));
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const listen = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...a) }));

async function load() {
  vi.resetModules();
  return import("./desktopShell");
}

const g = globalThis as { isTauri?: unknown };

beforeEach(() => {
  open.mockReset();
  invoke.mockReset();
  listen.mockReset();
  onDragDropEvent.mockClear();
  dragHandler = undefined;
});
afterEach(() => {
  delete g.isTauri;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("dropPointToCss: where a drop lands in the page (Tauri 2.12.5 / wry 0.57.2 sources)", () => {
  // wry reports macOS drops in points (NSDraggingInfo) and Linux drops in GTK logical pixels, both
  // already the page's CSS pixels; only Windows (WebView2, the http://tauri.localhost origin) reports
  // physical client pixels. Tauri passes them all on unscaled, typed as a PhysicalPosition.
  it("macOS and Linux (tauri: pages): the position is used as it is, at scale 1 and at scale 2", async () => {
    const { dropPointToCss } = await load();
    const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
    for (const scale of [1, 2]) expect(dropPointToCss(new PhysicalPosition(300, 500), { protocol: "tauri:", scaleFactor: scale })).toEqual({ x: 300, y: 500 });
  });

  it("Windows (http://tauri.localhost): physical pixels converted with Tauri's toLogical, at scale 1 and at scale 2", async () => {
    const { dropPointToCss } = await load();
    const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
    expect(dropPointToCss(new PhysicalPosition(300, 500), { protocol: "http:", scaleFactor: 1 })).toEqual({ x: 300, y: 500 });
    expect(dropPointToCss(new PhysicalPosition(300, 500), { protocol: "http:", scaleFactor: 2 })).toEqual({ x: 150, y: 250 });
    // A plain {x, y} (as the event's JSON carries it) is read the same way.
    expect(dropPointToCss({ x: 300, y: 500 }, { protocol: "http:", scaleFactor: 2 })).toEqual({ x: 150, y: 250 });
  });
});

describe("desktopShell", () => {
  it("is absent outside the shell, and loads no Tauri module", async () => {
    const m = await load();
    expect(m.inDesktopShell()).toBe(false);
    expect(m.desktopShell()).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    expect(onDragDropEvent).not.toHaveBeenCalled();
  });

  it("opens the native folder picker and returns the chosen folder, or null when cancelled", async () => {
    g.isTauri = true;
    const shell = (await load()).desktopShell()!;
    open.mockResolvedValueOnce("/Users/r/Research library");
    expect(await shell.pickFolder("Choose the library folder")).toBe("/Users/r/Research library");
    expect(open).toHaveBeenLastCalledWith({ directory: true, multiple: false, title: "Choose the library folder" });
    open.mockResolvedValueOnce(null);
    expect(await shell.pickFolder("x")).toBeNull();
  });

  it("opens the native file picker for one or several files", async () => {
    g.isTauri = true;
    const shell = (await load()).desktopShell()!;
    open.mockResolvedValueOnce(["/a.pdf", "/b c.epub"]);
    expect(await shell.pickFiles("Attach files", true)).toEqual(["/a.pdf", "/b c.epub"]);
    expect(open).toHaveBeenLastCalledWith({ directory: false, multiple: true, title: "Attach files" });
    open.mockResolvedValueOnce("/one.pdf");
    expect(await shell.pickFiles("One", false)).toEqual(["/one.pdf"]);
    expect(open).toHaveBeenLastCalledWith({ directory: false, multiple: false, title: "One" });
    open.mockResolvedValueOnce(null);
    expect(await shell.pickFiles("x", true)).toEqual([]);
  });

  it("gives dropped paths to the innermost drop target under the pointer, and to nothing else (jsdom is an http: page: physical pixels)", async () => {
    g.isTauri = true;
    vi.stubGlobal("devicePixelRatio", 2);
    const outer = document.createElement("section");
    const inner = document.createElement("div");
    const label = document.createElement("span");
    const elsewhere = document.createElement("p");
    inner.append(label);
    outer.append(inner);
    document.body.append(outer, elsewhere);
    const at = vi.fn((x: number, y: number) => (x === 10 && y === 20 ? label : x === 50 ? outer : elsewhere));
    document.elementFromPoint = at as unknown as typeof document.elementFromPoint;

    const shell = (await load()).desktopShell()!;
    const outerH = { onPaths: vi.fn(), onOver: vi.fn() };
    const innerH = { onPaths: vi.fn(), onOver: vi.fn() };
    shell.dropTarget(outer, outerH);
    const undo = shell.dropTarget(inner, innerH);
    await vi.waitFor(() => expect(dragHandler).toBeDefined());
    expect(onDragDropEvent).toHaveBeenCalledTimes(1); // one listener for all targets

    dragHandler!({ payload: { type: "enter", paths: ["/x.pdf"], position: { x: 20, y: 40 } } });
    expect(at).toHaveBeenLastCalledWith(10, 20);
    expect(innerH.onOver).toHaveBeenLastCalledWith(true);
    dragHandler!({ payload: { type: "over", position: { x: 100, y: 0 } } });
    expect(innerH.onOver).toHaveBeenLastCalledWith(false);
    expect(outerH.onOver).toHaveBeenLastCalledWith(true);
    dragHandler!({ payload: { type: "drop", paths: ["/x.pdf", "/x.pdf", "/y z.png"], position: { x: 20, y: 40 } } });
    expect(innerH.onPaths).toHaveBeenCalledExactlyOnceWith(["/x.pdf", "/y z.png"]);
    expect(outerH.onPaths).not.toHaveBeenCalled();
    expect(outerH.onOver).toHaveBeenLastCalledWith(false);

    // A drop on no target goes nowhere.
    dragHandler!({ payload: { type: "drop", paths: ["/z.pdf"], position: { x: 2, y: 2 } } });
    expect(innerH.onPaths).toHaveBeenCalledTimes(1);
    expect(outerH.onPaths).not.toHaveBeenCalled();

    // Once undone, the inner target no longer receives drops; the outer one does.
    undo();
    dragHandler!({ payload: { type: "drop", paths: ["/w.pdf"], position: { x: 20, y: 40 } } });
    expect(innerH.onPaths).toHaveBeenCalledTimes(1);
    expect(outerH.onPaths).toHaveBeenCalledExactlyOnceWith(["/w.pdf"]);
  });

  it("a leave clears the hover; an empty drop gives nothing", async () => {
    g.isTauri = true;
    const el = document.createElement("div");
    document.body.append(el);
    document.elementFromPoint = (() => el) as unknown as typeof document.elementFromPoint;
    const shell = (await load()).desktopShell()!;
    const h = { onPaths: vi.fn(), onOver: vi.fn() };
    shell.dropTarget(el, h);
    await vi.waitFor(() => expect(dragHandler).toBeDefined());
    dragHandler!({ payload: { type: "enter", paths: [], position: { x: 1, y: 1 } } });
    dragHandler!({ payload: { type: "leave" } });
    expect(h.onOver.mock.calls).toEqual([[true], [false]]);
    dragHandler!({ payload: { type: "drop", paths: [], position: { x: 1, y: 1 } } });
    expect(h.onPaths).not.toHaveBeenCalled();
  });
});

describe("pickWatchFolder (Task W6, R207): the shell's chooser hands the service a grant; the page gets only its id and the folder's name", () => {
  const GRANT = "0123456789abcdef0123456789abcdef";

  it("pickWatchFolder returns the grant and the name", async () => {
    g.isTauri = true;
    const m = await load();
    invoke.mockResolvedValueOnce({ grantId: GRANT, name: "Fieldwork <b>2026</b>" });
    expect(await m.desktopShell()!.pickWatchFolder("Choose a folder to watch")).toEqual({ grantId: GRANT, name: "Fieldwork <b>2026</b>" });
    expect(invoke).toHaveBeenLastCalledWith("pick_watch_folder", { title: "Choose a folder to watch" });
    // The same through the module's own function.
    invoke.mockResolvedValueOnce({ grantId: GRANT, name: "x" });
    expect(await m.pickWatchFolder("t")).toEqual({ grantId: GRANT, name: "x" });
    // The plain dialog is not used: a path never reaches the page.
    expect(open).not.toHaveBeenCalled();
  });

  it("answers null when cancelled, when the shell fails, or when the answer is not exactly a grant and a name", async () => {
    g.isTauri = true;
    const m = await load();
    for (const answer of [null, undefined, "/Users/r/x", { grantId: GRANT }, { grantId: GRANT.toUpperCase(), name: "x" }, { grantId: "abc", name: "x" }, { grantId: GRANT, name: "" }, { grantId: GRANT, name: 3 }, [GRANT, "x"]]) {
      invoke.mockResolvedValueOnce(answer);
      expect(await m.pickWatchFolder("t"), JSON.stringify(answer)).toBeNull();
    }
    invoke.mockRejectedValueOnce(new Error("pick_watch_folder not allowed"));
    expect(await m.pickWatchFolder("t")).toBeNull();
    // Only the grant and the name are passed on, whatever else the answer carries.
    invoke.mockResolvedValueOnce({ grantId: GRANT, name: "x", path: "/Users/r/x" });
    expect(await m.pickWatchFolder("t")).toEqual({ grantId: GRANT, name: "x" });
  });

  it("answers null in a plain browser, without throwing and without loading Tauri", async () => {
    const m = await load();
    expect(await m.pickWatchFolder("Choose a folder to watch")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends a bounded title", async () => {
    g.isTauri = true;
    const m = await load();
    invoke.mockResolvedValueOnce(null);
    await m.pickWatchFolder("t".repeat(5000));
    expect((invoke.mock.calls.at(-1)![1] as { title: string }).title.length).toBeLessThanOrEqual(200);
  });

  it("cuts the title by characters, never inside one (250 emoji)", async () => {
    g.isTauri = true;
    const m = await load();
    invoke.mockResolvedValueOnce(null);
    await m.pickWatchFolder("📁".repeat(250));
    const sent = (invoke.mock.calls.at(-1)![1] as { title: string }).title;
    expect(sent).toBe("📁".repeat(200));
    // No lone surrogate (which serde_json would refuse).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(sent)).toBe(false);
  });
});

describe("the library sign-in window (Task F16): six commands and one event, through the shell only", () => {
  const TICKET = "0123456789abcdef0123456789abcdef";
  const URL_ = "https://ezproxy.lib.example/login?url=https://doi.org/10.1038/171737a0";

  it("openLibraryWindow passes ticket, url and the kind of start (R347 a) only", async () => {
    g.isTauri = true;
    const m = await load();
    for (const from of ["library", "link"] as const) {
      invoke.mockClear();
      invoke.mockResolvedValueOnce(true);
      expect(await m.openLibraryWindow(TICKET, URL_, from)).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenLastCalledWith("open_library_window", { ticket: TICKET, url: URL_, from });
      expect(Object.keys(invoke.mock.calls[0]![1] as object)).toEqual(["ticket", "url", "from"]);
      // The same through the shell object.
      invoke.mockResolvedValueOnce(true);
      expect(await m.desktopShell()!.openLibraryWindow(TICKET, URL_, from)).toBe(true);
      expect(invoke).toHaveBeenLastCalledWith("open_library_window", { ticket: TICKET, url: URL_, from });
      expect(Object.keys(invoke.mock.calls[1]![1] as object)).toEqual(["ticket", "url", "from"]);
    }
  });

  it("each command is invoked by its own name with only its own arguments, and only `true` counts as done", async () => {
    g.isTauri = true;
    const m = await load();
    const calls: Array<[() => Promise<unknown>, string, Record<string, unknown>]> = [
      [() => m.libraryWindowTakePdf(), "library_window_take_pdf", {}],
      [() => m.signOutOfLibrary(), "sign_out_of_library", {}],
      [() => m.setStaySignedIn(true), "set_stay_signed_in", { on: true }],
      [() => m.setStaySignedIn(false), "set_stay_signed_in", { on: false }],
      [() => m.openInBrowser("https://doi.org/10.1038/171737a0"), "open_in_browser", { url: "https://doi.org/10.1038/171737a0" }],
    ];
    for (const [call, name, args] of calls) {
      invoke.mockResolvedValueOnce(true);
      expect(await call(), name).toBe(true);
      expect(invoke).toHaveBeenLastCalledWith(name, args);
      for (const answer of [false, null, undefined, "true", 1, {}]) {
        invoke.mockResolvedValueOnce(answer);
        expect(await call(), `${name} ${JSON.stringify(answer)}`).toBe(false);
      }
      invoke.mockRejectedValueOnce(new Error(`${name} not allowed`));
      expect(await call()).toBe(false);
    }
    invoke.mockResolvedValueOnce(null);
    await m.closeLibraryWindow();
    expect(invoke).toHaveBeenLastCalledWith("close_library_window", {});
    invoke.mockRejectedValueOnce(new Error("x"));
    await expect(m.closeLibraryWindow()).resolves.toBeUndefined();
    invoke.mockResolvedValueOnce(false);
    expect(await m.openLibraryWindow(TICKET, URL_, "library")).toBe(false);
  });

  it("outside the desktop shell nothing is available: false, nothing invoked, no Tauri module loaded", async () => {
    const m = await load();
    expect(await m.openLibraryWindow(TICKET, URL_, "library")).toBe(false);
    expect(await m.libraryWindowTakePdf()).toBe(false);
    expect(await m.closeLibraryWindow()).toBeUndefined();
    expect(await m.signOutOfLibrary()).toBe(false);
    expect(await m.setStaySignedIn(true)).toBe(false);
    expect(await m.openInBrowser("https://doi.org/x")).toBe(false);
    const handler = vi.fn();
    const stop = await m.onLibraryWindow(handler);
    stop();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("onLibraryWindow hears the window's state, typed, and drops anything else", async () => {
    g.isTauri = true;
    const m = await load();
    const handler = vi.fn();
    const unlisten = vi.fn();
    let deliver: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementationOnce(async (name: string, h: (e: { payload: unknown }) => void) => {
      expect(name).toBe("library-window");
      deliver = h;
      return unlisten;
    });
    const stop = await m.onLibraryWindow(handler);
    const states = ["opened", "fetching", "handed-over", "not-a-pdf", "failed", "closed"];
    for (const state of states) deliver!({ payload: { ticket: TICKET, state } });
    deliver!({ payload: { ticket: null, state: "failed", reason: "no-ticket" } });
    deliver!({ payload: { ticket: TICKET, state: "failed", reason: "pause" } });
    // R347 d: the shell's two refusals of a page reach the row with their reason.
    deliver!({ payload: { ticket: TICKET, state: "not-a-pdf", reason: "sign-in-address" } });
    deliver!({ payload: { ticket: TICKET, state: "not-a-pdf", reason: "not-https" } });
    expect(handler.mock.calls.map((c) => c[0])).toEqual([
      ...states.map((state) => ({ ticket: TICKET, state })),
      { ticket: null, state: "failed", reason: "no-ticket" },
      { ticket: TICKET, state: "failed", reason: "pause" },
      { ticket: TICKET, state: "not-a-pdf", reason: "sign-in-address" },
      { ticket: TICKET, state: "not-a-pdf", reason: "not-https" },
    ]);
    handler.mockClear();
    for (const payload of [null, "opened", { state: "opened" }, { ticket: "x", state: "opened" }, { ticket: TICKET.toUpperCase(), state: "opened" }, { ticket: TICKET, state: "added" }, [TICKET, "opened"]]) {
      deliver!({ payload });
    }
    expect(handler).not.toHaveBeenCalled();
    // An unknown reason is left out; the rest is kept.
    deliver!({ payload: { ticket: TICKET, state: "failed", reason: "because", extra: "x" } });
    expect(handler.mock.calls.map((c) => c[0])).toEqual([{ ticket: TICKET, state: "failed" }]);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    // A listener that cannot be registered gives a stop that does nothing.
    listen.mockRejectedValueOnce(new Error("event.listen not allowed"));
    const none = await m.onLibraryWindow(handler);
    expect(() => none()).not.toThrow();
  });
});
