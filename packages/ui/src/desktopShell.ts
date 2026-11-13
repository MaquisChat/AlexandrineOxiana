/**
 * The one bridge between the interface and the desktop shell (Task 37c, R155): native file and
 * folder pickers, and the paths of files dropped on the window. Used by LibraryChooser, DropZone
 * and FileDrop when the shell is present; outside the shell (tests, the end-to-end harness, a plain
 * browser) `desktopShell()` is undefined and nothing changes: the typed-path fields stay, and DOM
 * drops are read as before.
 *
 * A path from a picker or a drop is only ever handed to the component's own callback, which sends
 * it to the service; the service decides what may be read. The page has no file-system access of
 * its own: the shell grants it only "open a picker", "listen for drag-and-drop events" and "choose a
 * folder to watch" (`pickWatchFolder`, R207), which gives the page a grant id and a folder name,
 * never a path.
 *
 * Drops: the shell's web view reports drops for the whole window, with absolute paths and the
 * pointer position in physical pixels. The bridge finds the registered drop target under that
 * point (the innermost one) and gives it the paths; a drop anywhere else is ignored. The Tauri
 * modules are loaded only inside the shell, on first use.
 */
import { PhysicalPosition } from "@tauri-apps/api/dpi"; // plain value classes: no IPC, safe outside the shell

export interface DropHandlers {
  /** Paths dropped on this target. */
  onPaths(paths: string[]): void;
  /** Files are being dragged over this target (true), or no longer are (false). */
  onOver?(over: boolean): void;
}

export interface DesktopShell {
  /** The native folder picker: the chosen folder's absolute path, or null when cancelled. */
  pickFolder(title: string): Promise<string | null>;
  /** The native file picker: the chosen files' absolute paths ([] when cancelled). */
  pickFiles(title: string, multiple: boolean): Promise<string[]>;
  /** Makes `el` receive the paths of files dropped on it. Returns the function that undoes it. */
  dropTarget(el: HTMLElement, handlers: DropHandlers): () => void;
  /**
   * The native folder chooser for a watched folder (Task W6, R207): the shell hands the chosen
   * folder to the service as a single-use grant and gives the page only the grant's id and the
   * folder's last name. Null when cancelled or when the folder could not be handed over. The name is
   * outside text: it is shown only through `UserText`.
   */
  pickWatchFolder(title: string): Promise<{ grantId: string; name: string } | null>;
}

/** The longest title the page sends with a folder chooser (the shell bounds it too). */
const TITLE_MAX = 200;
const GRANT_ID = /^[0-9a-f]{32}$/;

async function invokePickWatchFolder(title: string): Promise<{ grantId: string; name: string } | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r: unknown = await invoke("pick_watch_folder", { title: String(title).slice(0, TITLE_MAX) });
    if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
    const { grantId, name } = r as { grantId?: unknown; name?: unknown };
    if (typeof grantId !== "string" || !GRANT_ID.test(grantId) || typeof name !== "string" || name === "") return null;
    return { grantId, name };
  } catch {
    return null;
  }
}

/**
 * The watched-folder chooser, or null without throwing outside the shell (a plain browser has no
 * chooser that can hand a folder to the service; the screen says so, Task W8).
 */
export async function pickWatchFolder(title: string): Promise<{ grantId: string; name: string } | null> {
  return inDesktopShell() ? invokePickWatchFolder(title) : null;
}

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/**
 * A drop event's position as the page's CSS pixels. Tauri types it as a PhysicalPosition but passes
 * on what the web view reports, unscaled (tauri-runtime-wry 2.12.3 lib.rs, `with_drag_drop_handler`):
 * wry 0.57.2 reports macOS drops in points (wkwebview/drag_drop.rs, `draggingLocation`) and Linux
 * drops in GTK logical pixels (webkitgtk/drag_drop.rs, `drag-motion`/`drag-drop`), which are the
 * page's CSS pixels already; only Windows (webview2/drag_drop.rs, `ScreenToClient`) reports physical
 * pixels. The app's origin tells them apart: `tauri:` on macOS and Linux, `http://tauri.localhost`
 * on Windows. Physical pixels are converted with Tauri's own `toLogical`.
 */
export function dropPointToCss(pos: { x: number; y: number }, page: { protocol: string; scaleFactor: number }): { x: number; y: number } {
  const physical = pos instanceof PhysicalPosition ? pos : new PhysicalPosition(pos.x, pos.y);
  const logical = physical.toLogical(page.protocol === "tauri:" ? 1 : page.scaleFactor);
  return { x: logical.x, y: logical.y };
}

/** Whether the page runs inside the desktop shell (Tauri sets `isTauri` before any app code). */
export function inDesktopShell(): boolean {
  return (globalThis as { isTauri?: unknown }).isTauri === true;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p !== "") : typeof v === "string" && v ? [v] : []);

function createShell(): DesktopShell {
  const targets = new Map<HTMLElement, DropHandlers>();
  let current: HTMLElement | undefined;
  let listening: Promise<unknown> | undefined;

  const targetAt = (pos: { x: number; y: number }): HTMLElement | undefined => {
    const at = dropPointToCss(pos, { protocol: window.location.protocol, scaleFactor: window.devicePixelRatio || 1 });
    let el: Element | null = document.elementFromPoint(at.x, at.y);
    while (el) {
      if (el instanceof HTMLElement && targets.has(el)) return el;
      el = el.parentElement;
    }
    return undefined;
  };
  const setCurrent = (el: HTMLElement | undefined) => {
    if (el === current) return;
    if (current) targets.get(current)?.onOver?.(false);
    current = el;
    if (el) targets.get(el)?.onOver?.(true);
  };
  const onEvent = (p: DragDropPayload) => {
    if (p.type === "enter" || p.type === "over") setCurrent(targetAt(p.position));
    else if (p.type === "leave") setCurrent(undefined);
    else {
      const el = targetAt(p.position);
      setCurrent(undefined);
      const paths = strings(p.paths);
      if (el && paths.length) targets.get(el)?.onPaths([...new Set(paths)]);
    }
  };
  const listen = () => {
    listening ??= import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((e) => onEvent(e.payload as DragDropPayload)))
      .catch(() => {
        listening = undefined;
      });
  };

  return {
    async pickFolder(title) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const r: unknown = await open({ directory: true, multiple: false, title });
      return strings(r)[0] ?? null;
    },
    async pickFiles(title, multiple) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return strings(await open({ directory: false, multiple, title }));
    },
    dropTarget(el, handlers) {
      targets.set(el, handlers);
      listen();
      return () => {
        if (current === el) setCurrent(undefined);
        targets.delete(el);
      };
    },
    pickWatchFolder: invokePickWatchFolder,
  };
}

let shell: DesktopShell | undefined;

/** The desktop shell's services, or undefined outside the shell. */
export function desktopShell(): DesktopShell | undefined {
  if (!inDesktopShell()) return undefined;
  shell ??= createShell();
  return shell;
}
