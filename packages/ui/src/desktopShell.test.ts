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

async function load() {
  vi.resetModules();
  return import("./desktopShell");
}

const g = globalThis as { isTauri?: unknown };

beforeEach(() => {
  open.mockReset();
  invoke.mockReset();
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
});
