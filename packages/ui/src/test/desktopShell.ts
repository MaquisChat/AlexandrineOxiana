/**
 * A stand-in for the desktop shell bridge (src/desktopShell.ts) in component tests:
 *
 *   const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
 *   vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));
 *   fake.shell = fakeShell();
 *
 * `drop(paths)` and `over(true|false)` deliver to the most recently registered drop target, as the
 * shell does for the target under the pointer.
 */
import { vi } from "vitest";
import type { DesktopShell, DropHandlers, LibraryWindowEvent } from "../desktopShell";

export interface FakeShell extends DesktopShell {
  pickFolder: ReturnType<typeof vi.fn<DesktopShell["pickFolder"]>>;
  pickFiles: ReturnType<typeof vi.fn<DesktopShell["pickFiles"]>>;
  /** The watched-folder chooser: resolves null (cancelled) unless a test says otherwise. */
  pickWatchFolder: ReturnType<typeof vi.fn<DesktopShell["pickWatchFolder"]>>;
  /** The library sign-in window's commands (Task F16): each resolves false unless a test says otherwise. */
  openLibraryWindow: ReturnType<typeof vi.fn<DesktopShell["openLibraryWindow"]>>;
  libraryWindowTakePdf: ReturnType<typeof vi.fn<DesktopShell["libraryWindowTakePdf"]>>;
  closeLibraryWindow: ReturnType<typeof vi.fn<DesktopShell["closeLibraryWindow"]>>;
  signOutOfLibrary: ReturnType<typeof vi.fn<DesktopShell["signOutOfLibrary"]>>;
  setStaySignedIn: ReturnType<typeof vi.fn<DesktopShell["setStaySignedIn"]>>;
  openInBrowser: ReturnType<typeof vi.fn<DesktopShell["openInBrowser"]>>;
  onLibraryWindow: ReturnType<typeof vi.fn<DesktopShell["onLibraryWindow"]>>;
  /** Delivers a `library-window` event to every handler still listening, as the shell does. */
  libraryWindow(e: LibraryWindowEvent): void;
  /** Registered drop targets (element and handlers), in order. */
  targets: Array<{ el: HTMLElement; handlers: DropHandlers }>;
  drop(paths: string[]): void;
  over(over: boolean): void;
}

export function fakeShell(): FakeShell {
  const targets: FakeShell["targets"] = [];
  const last = () => {
    const t = targets.at(-1);
    if (!t) throw new Error("no drop target is registered");
    return t;
  };
  const listeners = new Set<(e: LibraryWindowEvent) => void>();
  return {
    pickFolder: vi.fn<DesktopShell["pickFolder"]>(async () => null),
    pickFiles: vi.fn<DesktopShell["pickFiles"]>(async () => []),
    pickWatchFolder: vi.fn<DesktopShell["pickWatchFolder"]>(async () => null),
    openLibraryWindow: vi.fn<DesktopShell["openLibraryWindow"]>(async () => false),
    libraryWindowTakePdf: vi.fn<DesktopShell["libraryWindowTakePdf"]>(async () => false),
    closeLibraryWindow: vi.fn<DesktopShell["closeLibraryWindow"]>(async () => {}),
    signOutOfLibrary: vi.fn<DesktopShell["signOutOfLibrary"]>(async () => false),
    setStaySignedIn: vi.fn<DesktopShell["setStaySignedIn"]>(async () => false),
    openInBrowser: vi.fn<DesktopShell["openInBrowser"]>(async () => false),
    onLibraryWindow: vi.fn<DesktopShell["onLibraryWindow"]>(async (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    }),
    libraryWindow(e) {
      for (const h of [...listeners]) h(e);
    },
    targets,
    dropTarget(el, handlers) {
      const entry = { el, handlers };
      targets.push(entry);
      return () => {
        const i = targets.indexOf(entry);
        if (i !== -1) targets.splice(i, 1);
      };
    },
    drop(paths) {
      last().handlers.onPaths(paths);
    },
    over(over) {
      last().handlers.onOver?.(over);
    },
  };
}
