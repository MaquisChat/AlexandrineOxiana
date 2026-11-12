/**
 * The document drop target (protocol approvals, consent forms), outside and inside the desktop
 * shell (Task 37c): outside it, a typed path or a DOM drop of files that carry a path; inside it,
 * the native picker and the shell's drop event give paths. `single` takes one file only.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { FileDrop } from "./FileDrop";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => fake.shell !== undefined }));

afterEach(() => {
  fake.shell = undefined;
});

const SINGLE = { message: "Add one signed form at a time." };

describe("FileDrop outside the shell", () => {
  it("takes a typed path; has no picker", async () => {
    const onPaths = vi.fn();
    const user = userEvent.setup();
    render(<FileDrop prompt="Drop the approval here" fieldLabel="Approval document path" onPaths={onPaths} />);
    expect(screen.queryByRole("button", { name: "Choose file…" })).toBeNull();
    await user.type(screen.getByLabelText("Approval document path"), "/home/r/approval.pdf");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onPaths).toHaveBeenCalledWith(["/home/r/approval.pdf"]);
  });

  it("a DOM drop of files without a path says to type it instead", () => {
    const onPaths = vi.fn();
    render(<FileDrop prompt="Drop here" fieldLabel="Path" onPaths={onPaths} />);
    fireEvent.drop(screen.getByText("Drop here"), { dataTransfer: { files: [{ name: "a.pdf" }] } });
    expect(onPaths).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Type the full path below instead/);
  });
});

describe("FileDrop in the desktop shell", () => {
  it("the native picker chooses the file (several unless single)", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFiles.mockResolvedValueOnce(["/home/r/a.pdf", "/home/r/b.pdf"]);
    const onPaths = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<FileDrop prompt="Drop here" fieldLabel="Path" onPaths={onPaths} />);
    await user.click(screen.getByRole("button", { name: "Choose files…" }));
    expect(shell.pickFiles).toHaveBeenLastCalledWith("Drop here", true);
    await waitFor(() => expect(onPaths).toHaveBeenCalledWith(["/home/r/a.pdf", "/home/r/b.pdf"]));
    rerender(<FileDrop prompt="Drop here" fieldLabel="Path" onPaths={onPaths} single={SINGLE} />);
    shell.pickFiles.mockResolvedValueOnce(["/home/r/form.pdf"]);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(shell.pickFiles).toHaveBeenLastCalledWith("Drop here", false);
    await waitFor(() => expect(onPaths).toHaveBeenLastCalledWith(["/home/r/form.pdf"]));
    // The typed path stays.
    expect(screen.getByLabelText("Path")).toBeTruthy();
  });

  it("paths dropped on it (the shell's drop event) are added; several on a single target are refused", () => {
    const shell = (fake.shell = fakeShell());
    const onPaths = vi.fn();
    render(<FileDrop prompt="Drop the form here" fieldLabel="Path" onPaths={onPaths} single={SINGLE} />);
    act(() => shell.over(true));
    expect(screen.getByText("Drop the form here").className).toContain("ao-dropzone--over");
    act(() => shell.drop(["/home/r/a.pdf", "/home/r/b.pdf"]));
    expect(onPaths).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(SINGLE.message);
    act(() => shell.drop(["/home/r/form.pdf"]));
    expect(onPaths).toHaveBeenCalledExactlyOnceWith(["/home/r/form.pdf"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a DOM drop inside the shell adds nothing of its own; disabled takes nothing", () => {
    const shell = (fake.shell = fakeShell());
    const onPaths = vi.fn();
    const { rerender } = render(<FileDrop prompt="Drop here" fieldLabel="Path" onPaths={onPaths} />);
    fireEvent.drop(screen.getByText("Drop here"), { dataTransfer: { files: [{ name: "a.pdf", path: "/x/a.pdf" }] } });
    expect(onPaths).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<FileDrop prompt="Drop here" fieldLabel="Path" onPaths={onPaths} disabled />);
    act(() => shell.drop(["/home/r/a.pdf"]));
    expect(onPaths).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Choose files…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
