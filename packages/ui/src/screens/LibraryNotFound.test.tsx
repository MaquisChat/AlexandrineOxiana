import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { LIBRARIES, ndjson, server, serviceError, testApi, url, useMockService } from "../test/service";
import { LibraryNotFound } from "./LibraryNotFound";

useMockService();

const LIB = LIBRARIES.libraries[0]!;

describe("LibraryNotFound", () => {
  it("offers Locate, Search, Wait and Open different", () => {
    render(<LibraryNotFound api={testApi()} library={LIB} onOpened={vi.fn()} onOpenDifferent={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /Library not found/ })).toBeTruthy();
    for (const name of ["Locate library…", "Search for library", "Wait for the drive", "Open a different library"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByText(/Fieldwork SSD/)).toBeTruthy();
  });

  it("Search renders found paths as they stream in, and reconnects to the one chosen", async () => {
    let reconnect: unknown;
    server.use(
      http.post(url("/libraries/locate"), () => ndjson([{ found: { path: "/Volumes/Backup/Thesis library" } }, { found: { path: "/home/r/Thesis library", moved: true } }, { done: true }], 400)),
      http.post(url("/libraries/reconnect"), async ({ request }) => {
        reconnect = await request.json();
        return HttpResponse.json({ libraryId: "lib-1", name: "Thesis library", mode: "read-write", integrity: {}, rebuilt: false, warnings: [] });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryNotFound api={testApi()} library={LIB} onOpened={onOpened} onOpenDifferent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Search for library" }));
    const list = await screen.findByRole("list", { name: "Libraries found" });
    await within(list).findByText("/Volumes/Backup/Thesis library");
    // the second path has not arrived yet: the first is shown while the search goes on
    expect(within(list).queryByText("/home/r/Thesis library")).toBeNull();
    expect(screen.getByText(/Searching/)).toBeTruthy();
    await within(list).findByText("/home/r/Thesis library");
    await waitFor(() => expect(screen.queryByText(/Searching/)).toBeNull());
    await user.click(within(list).getAllByRole("button", { name: /Use this library/ })[0]!);
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(reconnect).toEqual({ path: "/Volumes/Backup/Thesis library", libraryId: "lib-1" });
  });

  it("Locate reconnects to a typed folder", async () => {
    let reconnect: unknown;
    server.use(
      http.post(url("/libraries/reconnect"), async ({ request }) => {
        reconnect = await request.json();
        return HttpResponse.json({ libraryId: "lib-1", name: "Thesis library", mode: "read-write", integrity: {}, rebuilt: true, warnings: [] });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryNotFound api={testApi()} library={LIB} onOpened={onOpened} onOpenDifferent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Locate library…" }));
    await user.type(screen.getByLabelText("Library folder"), "/mnt/usb/Thesis library");
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(reconnect).toEqual({ path: "/mnt/usb/Thesis library", libraryId: "lib-1" });
  });

  it("Locate shows the service's reason when the folder is a different library", async () => {
    server.use(http.post(url("/libraries/reconnect"), () => serviceError(400, "VALIDATION", "That folder holds a different library.")));
    const user = userEvent.setup();
    render(<LibraryNotFound api={testApi()} library={LIB} onOpened={vi.fn()} onOpenDifferent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Locate library…" }));
    await user.type(screen.getByLabelText("Library folder"), "/mnt/other");
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That folder holds a different library.");
  });

  it("Wait retries the last known place until the drive returns", async () => {
    let calls = 0;
    server.use(
      http.post(url("/libraries/open"), () => {
        calls++;
        return calls < 3 ? serviceError(404, "NOT_FOUND", "That folder is not a library.") : HttpResponse.json({ libraryId: "lib-1", name: "Thesis library", mode: "read-write" });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryNotFound api={testApi()} library={LIB} onOpened={onOpened} onOpenDifferent={vi.fn()} waitIntervalMs={30} />);
    await user.click(screen.getByRole("button", { name: "Wait for the drive" }));
    expect(screen.getByText(/Waiting for Fieldwork SSD/)).toBeTruthy();
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ libraryId: "lib-1", name: "Thesis library", mode: "read-write" }));
    expect(calls).toBe(3);
  });

  it("Open different goes back to the chooser", async () => {
    const onOpenDifferent = vi.fn();
    const user = userEvent.setup();
    render(<LibraryNotFound api={testApi()} library={LIB} onOpened={vi.fn()} onOpenDifferent={onOpenDifferent} />);
    await user.click(screen.getByRole("button", { name: "Open a different library" }));
    expect(onOpenDifferent).toHaveBeenCalled();
  });
});
