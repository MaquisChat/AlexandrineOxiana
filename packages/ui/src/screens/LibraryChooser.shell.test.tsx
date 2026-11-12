/**
 * The library chooser inside the desktop shell (Task 37c): a native folder picker fills the folder
 * field; the typed path stays; the chosen path goes only to the service, when Open or Create is used.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { server, testApi, url, useMockService } from "../test/service";
import { LibraryChooser } from "./LibraryChooser";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => fake.shell !== undefined }));

useMockService();
afterEach(() => {
  fake.shell = undefined;
});

describe("LibraryChooser in the desktop shell", () => {
  it("has no folder picker outside the shell (the typed path is the way)", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })));
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
    expect(screen.getByLabelText("Library folder")).toBeTruthy();
  });

  it("the folder picker fills the folder field; Open sends that path to the service", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Users/r/Research library");
    let body: unknown;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/open"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ libraryId: "l1", name: "Research library", mode: "read-write" });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={onOpened} onNotFound={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Choose folder…" }));
    expect(shell.pickFolder).toHaveBeenCalledWith("Choose the library folder");
    await waitFor(() => expect((screen.getByLabelText("Library folder") as HTMLInputElement).value).toBe("/Users/r/Research library"));
    // Nothing is sent until the researcher opens it.
    expect(body).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Open library" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(body).toEqual({ path: "/Users/r/Research library" });
  });

  it("a cancelled picker leaves the field as it was; a failed one says so", async () => {
    const shell = (fake.shell = fakeShell());
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })));
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await user.type(screen.getByLabelText("Library folder"), "/typed");
    shell.pickFolder.mockResolvedValueOnce(null);
    await user.click(await screen.findByRole("button", { name: "Choose folder…" }));
    await act(async () => {});
    expect((screen.getByLabelText("Library folder") as HTMLInputElement).value).toBe("/typed");
    shell.pickFolder.mockRejectedValueOnce(new Error("portal gone"));
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The folder picker could not be opened. Type the folder's full path instead.");
  });
});
