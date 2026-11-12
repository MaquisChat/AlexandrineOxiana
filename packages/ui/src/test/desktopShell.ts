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
import type { DesktopShell, DropHandlers } from "../desktopShell";

export interface FakeShell extends DesktopShell {
  pickFolder: ReturnType<typeof vi.fn<DesktopShell["pickFolder"]>>;
  pickFiles: ReturnType<typeof vi.fn<DesktopShell["pickFiles"]>>;
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
  return {
    pickFolder: vi.fn<DesktopShell["pickFolder"]>(async () => null),
    pickFiles: vi.fn<DesktopShell["pickFiles"]>(async () => []),
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
