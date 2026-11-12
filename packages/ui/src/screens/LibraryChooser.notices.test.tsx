/**
 * This computer's own notices on the library chooser too (Task 68 fix round 1, M1): a researcher
 * who cannot open any library still sees them, in the same words, with the same "Got it".
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { LIBRARIES, server, testApi, url, useMockService } from "../test/service";
import { LibraryChooser } from "./LibraryChooser";

useMockService();

const AT = "2026-11-12T10:15:30.000Z";

describe("device-level notices on the library chooser", () => {
  it("no notice, no banner", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, notices: [] })));
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByRole("list", { name: "Libraries" });
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
  });

  it("shown in the same words as in a library; “Got it” asks once, the banner goes, focus stays on the page's heading", async () => {
    const dismissed: unknown[] = [];
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, notices: [{ kind: "device-identity-renewed", at: AT }, { kind: "something-new", at: AT }] })),
      http.post(url("/settings/notices/dismiss"), async ({ request }) => {
        dismissed.push(await request.json());
        return HttpResponse.json({ notices: [] });
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    const banner = (await screen.findByText(/identity for the app could not be read and had to be renewed/)).closest("[role=status]") as HTMLElement;
    expect(banner.textContent).toMatch(/Your libraries are not affected/);
    expect(screen.getAllByRole("button", { name: "Got it" })).toHaveLength(1); // the unknown kind is not shown
    await user.dblClick(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByText(/had to be renewed/)).toBeNull());
    expect(dismissed).toEqual([{ kind: "device-identity-renewed" }]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a library" }));
  });

  it("a refused “Got it” keeps the banner and says why", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, notices: [{ kind: "old-copies-list-set-aside", at: AT }] })),
      http.post(url("/settings/notices/dismiss"), () => HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The app's list of notices on this computer could not be read, so it was not changed." } }, { status: 503 })),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Got it" }));
    expect(await screen.findByText(/could not be read, so it was not changed/)).toBeTruthy();
    expect(screen.getByText(/old library copies awaiting deletion was damaged/)).toBeTruthy();
  });
});
