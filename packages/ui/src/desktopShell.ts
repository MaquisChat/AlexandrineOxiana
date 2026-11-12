/**
 * The one bridge between the interface and the desktop shell (Task 37c, R155): native file and
 * folder pickers, and the paths of files dropped on the window. Used by LibraryChooser, DropZone
 * and FileDrop when the shell is present; outside the shell (tests, the end-to-end harness, a plain
 * browser) `desktopShell()` is undefined and nothing changes: the typed-path fields stay, and DOM
 * drops are read as before.
 *
 * A path from a picker or a drop is only ever handed to the component's own callback, which sends
 * it to the service; the service decides what may be read. The page has no file-system access of
 * its own: the shell grants it only "open a picker" and "listen for drag-and-drop events".
 *
 * Drops: the shell's web view reports drops for the whole window, with absolute paths and the
 * pointer position in physical pixels. The bridge finds the registered drop target under that
 * point (the innermost one) and gives it the paths; a drop anywhere else is ignored. The Tauri
 * modules are loaded only inside the shell, on first use.
 */

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
}

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

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
    const ratio = window.devicePixelRatio || 1;
    let el: Element | null = document.elementFromPoint(pos.x / ratio, pos.y / ratio);
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
  };
}

let shell: DesktopShell | undefined;

/** The desktop shell's services, or undefined outside the shell. */
export function desktopShell(): DesktopShell | undefined {
  if (!inDesktopShell()) return undefined;
  shell ??= createShell();
  return shell;
}
