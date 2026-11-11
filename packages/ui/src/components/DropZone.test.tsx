import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DropZone, pathsFromDataTransfer } from "./DropZone";

function dataTransfer(uriList: string, files: Array<{ name: string; path?: string }> = []) {
  return { types: uriList ? ["text/uri-list", "Files"] : ["Files"], getData: (t: string) => (t === "text/uri-list" ? uriList : ""), files };
}

describe("DropZone", () => {
  it("dropping file URLs calls onPaths with the decoded paths", () => {
    const onPaths = vi.fn();
    render(<DropZone onPaths={onPaths} />);
    const zone = screen.getByRole("region", { name: /attach files/i });
    fireEvent.dragOver(zone, { dataTransfer: dataTransfer("file:///home/r/a.pdf") });
    fireEvent.drop(zone, { dataTransfer: dataTransfer("# comment\r\nfile:///home/r/My%20notes.pdf\r\nfile:///C:/Data/b.epub\r\nhttps://example.org/x") });
    expect(onPaths).toHaveBeenCalledWith(["/home/r/My notes.pdf", "C:/Data/b.epub"]);
  });

  it("uses the files' own paths when the desktop shell supplies them", () => {
    expect(pathsFromDataTransfer(dataTransfer("", [{ name: "a.pdf", path: "/x/a.pdf" }, { name: "b.pdf" }]) as unknown as DataTransfer)).toEqual(["/x/a.pdf"]);
  });

  it("can be operated from the keyboard: paths typed one per line", async () => {
    const onPaths = vi.fn();
    const user = userEvent.setup();
    render(<DropZone onPaths={onPaths} />);
    await user.click(screen.getByRole("button", { name: "Attach files…" }));
    await user.type(screen.getByLabelText("File paths, one per line"), "/home/r/a.pdf{enter}/home/r/b.pdf");
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(onPaths).toHaveBeenCalledWith(["/home/r/a.pdf", "/home/r/b.pdf"]);
  });

  it("disabled: drops are ignored and the button is off, with the reason shown", () => {
    const onPaths = vi.fn();
    render(<DropZone onPaths={onPaths} disabled disabledReason="This library is read-only." />);
    const zone = screen.getByRole("region", { name: /attach files/i });
    expect(zone.getAttribute("aria-disabled")).toBe("true");
    fireEvent.drop(zone, { dataTransfer: dataTransfer("file:///home/r/a.pdf") });
    expect(onPaths).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Attach files…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(zone.textContent).toContain("This library is read-only.");
  });
});
