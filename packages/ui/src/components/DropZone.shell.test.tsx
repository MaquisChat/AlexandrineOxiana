/**
 * The attach drop area inside the desktop shell (Task 37c): files chosen in the native picker or
 * dropped on the area (paths from the shell's drop event) go to onPaths; outside the shell nothing
 * changes (DropZone.test.tsx).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { DropZone } from "./DropZone";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => fake.shell !== undefined }));

afterEach(() => {
  fake.shell = undefined;
});

describe("DropZone in the desktop shell", () => {
  it("has no file picker and registers no drop target outside the shell", () => {
    render(<DropZone onPaths={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Choose files…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach files…" })).toBeTruthy();
  });

  it("files chosen in the native picker are attached", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFiles.mockResolvedValueOnce(["/home/r/a.pdf", "/home/r/b c.epub"]);
    const onPaths = vi.fn();
    const user = userEvent.setup();
    render(<DropZone onPaths={onPaths} target="Coastal kinship" />);
    await user.click(screen.getByRole("button", { name: "Choose files…" }));
    expect(shell.pickFiles).toHaveBeenCalledWith("Attach files to Coastal kinship", true);
    await waitFor(() => expect(onPaths).toHaveBeenCalledExactlyOnceWith(["/home/r/a.pdf", "/home/r/b c.epub"]));
    // The typed-path way stays.
    expect(screen.getByRole("button", { name: "Attach files…" })).toBeTruthy();
  });

  it("a cancelled picker attaches nothing", async () => {
    const shell = (fake.shell = fakeShell());
    const onPaths = vi.fn();
    const user = userEvent.setup();
    render(<DropZone onPaths={onPaths} />);
    await user.click(screen.getByRole("button", { name: "Choose files…" }));
    await act(async () => {});
    expect(shell.pickFiles).toHaveBeenCalledTimes(1);
    expect(onPaths).not.toHaveBeenCalled();
  });

  it("paths dropped on the area (the shell's drop event) are attached, and the area shows the drag", () => {
    const shell = (fake.shell = fakeShell());
    const onPaths = vi.fn();
    render(<DropZone onPaths={onPaths} />);
    const zone = screen.getByRole("region", { name: /attach files/i });
    expect(shell.targets.map((t) => t.el)).toEqual([zone]);
    act(() => shell.over(true));
    expect(zone.className).toContain("ao-drop--over");
    act(() => shell.drop(["/home/r/x.pdf"]));
    expect(onPaths).toHaveBeenCalledExactlyOnceWith(["/home/r/x.pdf"]);
    expect(zone.className).not.toContain("ao-drop--over");
  });

  it("a DOM drop inside the shell adds nothing of its own (the shell's drop event carries the paths)", () => {
    fake.shell = fakeShell();
    const onPaths = vi.fn();
    render(<DropZone onPaths={onPaths} />);
    const zone = screen.getByRole("region", { name: /attach files/i });
    const dt = { types: ["text/uri-list"], getData: () => "file:///home/r/a.pdf", files: [] };
    fireEvent.dragOver(zone, { dataTransfer: dt });
    fireEvent.drop(zone, { dataTransfer: dt });
    expect(onPaths).not.toHaveBeenCalled();
  });

  it("while disabled, neither the picker nor a drop attaches anything", async () => {
    const shell = (fake.shell = fakeShell());
    const onPaths = vi.fn();
    render(<DropZone onPaths={onPaths} disabled disabledReason="This library is read-only." />);
    expect((screen.getByRole("button", { name: "Choose files…" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => shell.drop(["/home/r/x.pdf"]));
    expect(onPaths).not.toHaveBeenCalled();
  });

  it("stops receiving drops once it is gone", () => {
    const shell = (fake.shell = fakeShell());
    const { unmount } = render(<DropZone onPaths={vi.fn()} />);
    expect(shell.targets).toHaveLength(1);
    unmount();
    expect(shell.targets).toHaveLength(0);
  });
});
