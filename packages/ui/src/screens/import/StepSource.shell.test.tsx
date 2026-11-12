/**
 * The import wizard's source fields inside the desktop shell (D12): each folder or file path field
 * has a native picker beside it that fills the field; Scan sends that path to the service, which
 * decides what may be read. Outside the shell there are no picker buttons.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeShell, type FakeShell } from "../../test/desktopShell";
import { mockService, server, P1 } from "../../test/importService";
import { ImportWizard } from "./ImportWizard";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => fake.shell !== undefined }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  fake.shell = undefined;
});

const CASES = [
  { source: "Folder", field: "Folder path", pick: "folder", chosen: "/Users/r/Papers", adapter: { kind: "folder", path: "/Users/r/Papers" } },
  { source: "ZIP archive", field: "ZIP file path", pick: "file", chosen: "/Users/r/papers.zip", adapter: { kind: "zip", path: "/Users/r/papers.zip" } },
  { source: "Zotero library", field: "Zotero data folder", pick: "folder", chosen: "/Users/r/Zotero", adapter: { kind: "zotero-local", dataDir: "/Users/r/Zotero" } },
  { source: "Reference file", field: "File path", pick: "file", chosen: "/Users/r/Desktop/titles.bib", adapter: { kind: "bibtex", path: "/Users/r/Desktop/titles.bib" } },
  { source: "Calibre library", field: "Calibre library folder", pick: "folder", chosen: "/Users/r/Calibre Library", adapter: { kind: "calibre", path: "/Users/r/Calibre Library" } },
] as const;

describe("the import wizard's path fields in the desktop shell (D12)", () => {
  it.each(CASES)("$source: the picker fills “$field”, and Scan sends that path", async ({ source, field, pick, chosen, adapter }) => {
    const shell = (fake.shell = fakeShell());
    if (pick === "folder") shell.pickFolder.mockResolvedValueOnce(chosen);
    else shell.pickFiles.mockResolvedValueOnce([chosen]);
    const m = mockService();
    const user = userEvent.setup();
    render(<ImportWizard client={m.client} />);
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: source }));
    await user.click(screen.getByRole("button", { name: pick === "folder" ? "Choose folder…" : "Choose file…" }));
    const box = screen.getByRole("textbox", { name: field }) as HTMLInputElement;
    await waitFor(() => expect(box.value).toBe(chosen));
    if (pick === "file") expect(shell.pickFiles).toHaveBeenCalledWith(expect.any(String), false);
    // Nothing is sent until Scan.
    expect(m.calls.filter((c) => c.path.endsWith("/import/dry-run"))).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("heading", { name: "Scan results" });
    expect(m.bodies(`POST /projects/${P1}/import/dry-run`)).toEqual([{ adapter }]);
  });

  it("Camera or phone folder: the folder picker fills the field", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Volumes/PHONE/DCIM");
    const m = mockService();
    const user = userEvent.setup();
    render(<ImportWizard client={m.client} />);
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Camera or phone folder" }));
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Camera or phone folder" }) as HTMLInputElement).value).toBe("/Volumes/PHONE/DCIM"));
  });

  it("outside the shell there is no picker button; the path is typed", async () => {
    const m = mockService();
    const user = userEvent.setup();
    render(<ImportWizard client={m.client} />);
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Folder" }));
    expect(screen.getByRole("textbox", { name: "Folder path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Choose (folder|file)…$/ })).toBeNull();
  });
});
