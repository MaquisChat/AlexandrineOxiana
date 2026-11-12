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

async function load() {
  vi.resetModules();
  return import("./desktopShell");
}

const g = globalThis as { isTauri?: unknown };

beforeEach(() => {
  open.mockReset();
  onDragDropEvent.mockClear();
  dragHandler = undefined;
});
afterEach(() => {
  delete g.isTauri;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
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

  it("gives dropped paths to the innermost drop target under the pointer (physical pixels), and to nothing else", async () => {
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
