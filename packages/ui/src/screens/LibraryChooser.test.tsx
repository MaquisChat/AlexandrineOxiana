import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { LIBRARIES, server, serviceError, testApi, url, useMockService } from "../test/service";
import { LibraryChooser } from "./LibraryChooser";

useMockService();

describe("LibraryChooser", () => {
  it("lists the registered libraries with where they were last seen", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)));
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Libraries" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Thesis library");
    expect(items[0]!.textContent).toContain("/Volumes/Fieldwork SSD/Thesis library");
    expect(within(items[1]!).getByRole("button", { name: "Open Grant 2025" })).toBeTruthy();
  });

  it("opens a library at its last known path", async () => {
    let body: unknown;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
      http.post(url("/libraries/open"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ libraryId: "lib-2", name: "Grant 2025", mode: "read-write" });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={onOpened} onNotFound={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Open Grant 2025" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ libraryId: "lib-2", name: "Grant 2025", mode: "read-write" }));
    expect(body).toEqual({ path: "/home/r/Grant 2025" });
  });

  it("a library that is not where it was goes to the not-found screen", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
      http.post(url("/libraries/open"), () => serviceError(404, "NOT_FOUND", "That folder is not a library.")),
    );
    const onNotFound = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={onNotFound} />);
    await user.click(await screen.findByRole("button", { name: "Open Thesis library" }));
    await waitFor(() => expect(onNotFound).toHaveBeenCalledWith(LIBRARIES.libraries[0]));
  });

  it("opens a library at a typed path", async () => {
    let body: unknown;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/open"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ libraryId: "lib-3", name: "Other", mode: "read-write" });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={onOpened} onNotFound={vi.fn()} />);
    expect(await screen.findByText(/No libraries yet/)).toBeTruthy();
    await user.type(screen.getByLabelText("Library folder"), "/home/r/Other");
    await user.click(screen.getByRole("button", { name: "Open library" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(body).toEqual({ path: "/home/r/Other" });
  });
});
