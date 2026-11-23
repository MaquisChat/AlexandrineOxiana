/**
 * Every typed folder or file path outside the import wizard offers the native picker inside the
 * desktop shell (D12): Move library's destination, Missing files' folder to search, Locate library
 * on "Library not found", and the Appearance screen's font file. The chosen path is only put in the
 * field; it reaches the service when the screen's own button sends it. (The wizard's fields are in
 * screens/import/StepSource.shell.test.tsx, the chooser's in LibraryChooser.shell.test.tsx.)
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api/client";
import { MissingFiles } from "./screens/MissingFiles";
import { MoveLibrary } from "./screens/MoveLibrary";
import { LibraryNotFound } from "./screens/LibraryNotFound";
import { AppearanceSettingsScreen } from "./screens/AppearanceSettings";
import { fakeShell, type FakeShell } from "./test/desktopShell";
import { makeApi, server, url, useMsw } from "./test/msw-governance";
import { LIBRARIES, testApi } from "./test/service";
import { DEFAULT_APPEARANCE } from "./theme/appearance";
import { AppearanceProvider } from "./theme/AppearanceProvider";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("./desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => fake.shell !== undefined }));

useMsw();
afterEach(() => {
  fake.shell = undefined;
});

const integrity = () => http.get(url("/libraries/integrity"), () => HttpResponse.json({ report: { checked: 1, hashed: 0, hashedAssetIds: [], presenceOnly: 0, missing: [{ assetId: null, path: "Projects/P/sources/s1/a.pdf" }], mismatched: [], placeholders: [], errors: [] }, integrityWarnings: [], projectWarnings: {} }));

function appearance() {
  const request = vi.fn(async (method: string) => (method === "GET" ? { fonts: [] } : { id: "0190f0f0-0000-7000-8000-0000000000f1", name: "Junicode", format: "woff2", size: 4, addedAt: "2026-11-11T10:00:00.000Z" }));
  const client = { appearance: { get: vi.fn(async () => DEFAULT_APPEARANCE), put: vi.fn(async (s: unknown) => s) }, request, bytes: vi.fn() } as unknown as ApiClient;
  render(
    <AppearanceProvider client={client} initial={DEFAULT_APPEARANCE}>
      <AppearanceSettingsScreen />
    </AppearanceProvider>,
  );
  return request;
}

describe("path fields outside the import wizard, in the desktop shell (D12)", () => {
  it("Move library: the folder picker fills Destination folder; Check destination sends it", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Volumes/Field SSD/Library");
    let body: unknown;
    server.use(
      http.post(url("/libraries/move/plan"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ destination: { kind: "removable" }, perProject: [], projectsMovedAway: [], totalBytes: 1, fileCount: 1 });
      }),
    );
    const user = userEvent.setup();
    render(<MoveLibrary api={makeApi()} />);
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect(shell.pickFolder).toHaveBeenCalledWith("Choose an empty folder for the library");
    // Beside the field: the folder must be new or empty, and how to make one in the dialog.
    const field = screen.getByRole("textbox", { name: "Destination folder" });
    const hint = screen.getByText("The folder must be new or empty. In the dialog you can make one with New Folder.");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Destination folder" }) as HTMLInputElement).value).toBe("/Volumes/Field SSD/Library"));
    expect(body).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Check destination" }));
    await waitFor(() => expect(body).toEqual({ dest: "/Volumes/Field SSD/Library" }));
  });

  it("Missing files: the folder picker fills Folder to search", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Users/r/Old drive");
    server.use(integrity());
    const user = userEvent.setup();
    render(<MissingFiles api={makeApi()} />);
    await user.click(await screen.findByRole("button", { name: "Search a folder…" }));
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Folder to search" }) as HTMLInputElement).value).toBe("/Users/r/Old drive"));
  });

  it("Library not found → Locate library…: the folder picker fills Library folder", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Users/r/Thesis library (renamed)");
    const user = userEvent.setup();
    render(<LibraryNotFound api={testApi()} library={LIBRARIES.libraries[0]!} onOpened={vi.fn()} onOpenDifferent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Locate library…" }));
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Library folder" }) as HTMLInputElement).value).toBe("/Users/r/Thesis library (renamed)"));
  });

  it("Appearance → Your own font files: the file picker fills Font file path; Add font file sends it", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFiles.mockResolvedValueOnce(["/Users/r/Fonts/Junicode.woff2"]);
    const request = appearance();
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Your own font files" });
    await user.click(within(region).getByRole("button", { name: "Choose file…" }));
    expect(shell.pickFiles).toHaveBeenCalledWith("Choose a font file", false);
    await waitFor(() => expect((within(region).getByRole("textbox", { name: "Font file path" }) as HTMLInputElement).value).toBe("/Users/r/Fonts/Junicode.woff2"));
    await user.click(within(region).getByRole("button", { name: "Add font file" }));
    await waitFor(() => expect(request.mock.calls.filter((c) => c[0] === "POST")).toEqual([["POST", "/settings/fonts", { body: { path: "/Users/r/Fonts/Junicode.woff2" } }]]));
  });

  it("outside the shell none of them has a picker button", async () => {
    server.use(integrity());
    const user = userEvent.setup();
    const a = render(<MoveLibrary api={makeApi()} />);
    expect(screen.getByRole("textbox", { name: "Destination folder" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Choose/ })).toBeNull();
    // No dialog here, so the hint says only what the folder must be (FR-391).
    expect(screen.getByText("The folder must be new or empty.")).toBeTruthy();
    expect(screen.queryByText(/In the dialog/)).toBeNull();
    a.unmount();
    const b = render(<LibraryNotFound api={testApi()} library={LIBRARIES.libraries[0]!} onOpened={vi.fn()} onOpenDifferent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Locate library…" }));
    expect(screen.queryByRole("button", { name: /^Choose/ })).toBeNull();
    b.unmount();
    appearance();
    await screen.findByRole("region", { name: "Your own font files" });
    expect(screen.queryByRole("button", { name: /^Choose/ })).toBeNull();
  });
});
