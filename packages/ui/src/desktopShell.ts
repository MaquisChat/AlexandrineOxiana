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
 * never a path; and the library sign-in window's six commands and its `library-window` event
 * (Task F16, R325), which give the page yes or no and a state, never a cookie, a path or a file.
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
  /**
   * The library sign-in window (Task F16, R325): opens the ONE separate window at an https address
   * for a ticket the service gave (32 lower-case hex); the shell, never the page, then fetches the PDF
   * the window reaches and hands it to the service. Only the ticket, the address and the kind of start are passed
   * (R347 a: `from` "library" for the library's start and the settings screen's Test, "link" for an entry's link).
   * False when the shell refused (a ticket already open, a bad ticket or address) or is not there.
   */
  openLibraryWindow(ticket: string, url: string, from: LibraryWindowFrom): Promise<boolean>;
  /** "Add the PDF showing in the sign-in window": the shell fetches the window's current address. */
  libraryWindowTakePdf(): Promise<boolean>;
  /**
   * Closes the sign-in window (its ticket ends). R477 b: with `ticket` (the open that made the window), only that open's
   * window is closed; without one, whatever sign-in window is open.
   */
  closeLibraryWindow(ticket?: string): Promise<void>;
  /** "Sign out of my library": the window's cookies and storage are emptied now. */
  signOutOfLibrary(): Promise<boolean>;
  /** "Stay signed in to my library" (macOS only: false elsewhere). */
  setStaySignedIn(on: boolean): Promise<boolean>;
  /** Opens an https address in the researcher's own browser. */
  openInBrowser(url: string): Promise<boolean>;
  /** Hears the sign-in window's state. Returns the function that stops listening. */
  onLibraryWindow(handler: (e: LibraryWindowEvent) => void): Promise<() => void>;
}

/** Which kind of start opened the sign-in window (R347 a): the library's (or its Test), or one of an entry's links. */
export type LibraryWindowFrom = "library" | "link";

/** The sign-in window's states, as the shell sends them (event `library-window`, to the main window only). */
export type LibraryWindowState = "opened" | "fetching" | "handed-over" | "not-a-pdf" | "failed" | "closed";
/** Why the shell fetched nothing, when it refused before any request. */
export type LibraryWindowReason = "no-ticket" | "busy" | "pause" | "sign-in-address" | "not-https" | "stopping";
export interface LibraryWindowEvent {
  /** The ticket the event is about; null when none was open. */
  ticket: string | null;
  state: LibraryWindowState;
  reason?: LibraryWindowReason;
}

const LIBRARY_STATES: readonly string[] = ["opened", "fetching", "handed-over", "not-a-pdf", "failed", "closed"];
const LIBRARY_REASONS: readonly string[] = ["no-ticket", "busy", "pause", "sign-in-address", "not-https", "stopping"];

/** The event's payload when it is exactly what the shell sends; null otherwise. */
function libraryWindowEvent(p: unknown): LibraryWindowEvent | null {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const { ticket, state, reason } = p as { ticket?: unknown; state?: unknown; reason?: unknown };
  if (!(ticket === null || (typeof ticket === "string" && GRANT_ID.test(ticket)))) return null;
  if (typeof state !== "string" || !LIBRARY_STATES.includes(state)) return null;
  const e: LibraryWindowEvent = { ticket, state: state as LibraryWindowState };
  if (typeof reason === "string" && LIBRARY_REASONS.includes(reason)) e.reason = reason as LibraryWindowReason;
  return e;
}

/** Invokes a shell command whose answer is a yes or no: only `true` counts; a refusal or an error is false. */
async function invokeYes(command: string, args: Record<string, unknown>): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke(command, args)) === true;
  } catch {
    return false;
  }
}

const libraryWindow = {
  openLibraryWindow: (ticket: string, url: string, from: LibraryWindowFrom) => invokeYes("open_library_window", { ticket, url, from }),
  libraryWindowTakePdf: () => invokeYes("library_window_take_pdf", {}),
  closeLibraryWindow: async (ticket?: string) => {
    // Only a non-empty ticket is sent: a null or absent one means "whatever is open".
    await invokeYes("close_library_window", typeof ticket === "string" && ticket !== "" ? { ticket } : {});
  },
  signOutOfLibrary: () => invokeYes("sign_out_of_library", {}),
  setStaySignedIn: (on: boolean) => invokeYes("set_stay_signed_in", { on }),
  openInBrowser: (url: string) => invokeYes("open_in_browser", { url }),
  onLibraryWindow: async (handler: (e: LibraryWindowEvent) => void): Promise<() => void> => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen("library-window", (e) => {
        const ev = libraryWindowEvent(e.payload);
        if (ev) handler(ev);
      });
      return () => {
        void stop();
      };
    } catch {
      return () => {};
    }
  },
};

/** Outside the desktop shell (a plain browser, tests, the end-to-end harness) none of these is available: they answer false and load nothing. */
export async function openLibraryWindow(ticket: string, url: string, from: LibraryWindowFrom): Promise<boolean> {
  return inDesktopShell() ? libraryWindow.openLibraryWindow(ticket, url, from) : false;
}
export async function libraryWindowTakePdf(): Promise<boolean> {
  return inDesktopShell() ? libraryWindow.libraryWindowTakePdf() : false;
}
export async function closeLibraryWindow(ticket?: string): Promise<void> {
  if (inDesktopShell()) await libraryWindow.closeLibraryWindow(ticket);
}
export async function signOutOfLibrary(): Promise<boolean> {
  return inDesktopShell() ? libraryWindow.signOutOfLibrary() : false;
}
export async function setStaySignedIn(on: boolean): Promise<boolean> {
  return inDesktopShell() ? libraryWindow.setStaySignedIn(on) : false;
}
export async function openInBrowser(url: string): Promise<boolean> {
  return inDesktopShell() ? libraryWindow.openInBrowser(url) : false;
}
export async function onLibraryWindow(handler: (e: LibraryWindowEvent) => void): Promise<() => void> {
  return inDesktopShell() ? libraryWindow.onLibraryWindow(handler) : () => {};
}

/** The longest title the page sends with a folder chooser, in characters (the shell bounds it too). */
const TITLE_MAX = 200;
const GRANT_ID = /^[0-9a-f]{32}$/;

async function invokePickWatchFolder(title: string): Promise<{ grantId: string; name: string } | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // Cut by characters (code points), never inside one: half an emoji cannot be sent to the shell.
    const r: unknown = await invoke("pick_watch_folder", { title: Array.from(String(title)).slice(0, TITLE_MAX).join("") });
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
    ...libraryWindow,
  };
}

let shell: DesktopShell | undefined;

/** The desktop shell's services, or undefined outside the shell. */
export function desktopShell(): DesktopShell | undefined {
  if (!inDesktopShell()) return undefined;
  shell ??= createShell();
  return shell;
}
