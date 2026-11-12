/**
 * This computer's own notices in the library's banner area (Task 68, R154, R178): from the
 * `library.state` event, in plain words keyed by the kind, gone only by the researcher's "Got it".
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { CURRENT_RW, libraryHandlers, server, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

const AT = "2026-11-12T10:15:30.000Z";
const withNotices = (notices: Array<{ kind: string; at: string }>) => ({ open: true, ...CURRENT_RW, integrityWarnings: [], projectWarnings: {}, notices });

describe("device-level notices in the banner area", () => {
  it("no notice, no banner", async () => {
    server.use(...libraryHandlers({ state: withNotices([]) }));
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await screen.findByRole("heading", { name: "Thesis library" });
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
  });

  it("each kind in plain words; an unknown kind is not shown", async () => {
    server.use(...libraryHandlers({ state: withNotices([{ kind: "device-identity-renewed", at: AT }, { kind: "old-copies-list-set-aside", at: AT }, { kind: "something-new", at: AT }]) }));
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const identity = (await screen.findByText(/identity for the app .* had to be renewed/)).closest("[role=status]")!;
    expect(identity.textContent).toMatch(/locked by another device/);
    expect(identity.textContent).toMatch(/Read-only \(locked by/);
    const copies = screen.getByText(/old library copies awaiting deletion was damaged/).closest("[role=status]")!;
    expect(copies.textContent).toMatch(/may still be on this computer/);
    expect(copies.textContent).toMatch(/kept beside the app's settings/);
    expect(screen.getAllByRole("button", { name: "Got it" })).toHaveLength(2);
  });

  it("“Got it” asks the service once to remove that notice; the banner goes; focus does not fall to the page", async () => {
    const dismissed: unknown[] = [];
    server.use(
      http.post(url("/settings/notices/dismiss"), async ({ request }) => {
        dismissed.push(await request.json());
        return HttpResponse.json({ notices: [{ kind: "old-copies-list-set-aside", at: AT }] });
      }),
      ...libraryHandlers({ state: withNotices([{ kind: "device-identity-renewed", at: AT }, { kind: "old-copies-list-set-aside", at: AT }]) }),
    );
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const banner = (await screen.findByText(/had to be renewed/)).closest("[role=status]") as HTMLElement;
    const gotIt = banner.querySelector("button")!;
    gotIt.focus();
    await user.dblClick(gotIt);
    await waitFor(() => expect(screen.queryByText(/had to be renewed/)).toBeNull());
    expect(dismissed).toEqual([{ kind: "device-identity-renewed" }]);
    expect(screen.getByText(/old library copies awaiting deletion was damaged/)).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".ao-library")).toBeTruthy();
  });

  it("a “Got it” the service refuses keeps the banner and says why", async () => {
    server.use(
      http.post(url("/settings/notices/dismiss"), () => HttpResponse.json({ error: { code: "UNAVAILABLE", message: "The app's list of notices on this computer could not be read, so it was not changed." } }, { status: 503 })),
      ...libraryHandlers({ state: withNotices([{ kind: "old-copies-list-set-aside", at: AT }]) }),
    );
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await user.click(await screen.findByRole("button", { name: "Got it" }));
    expect(await screen.findByText(/could not be read, so it was not changed/)).toBeTruthy();
    expect(screen.getByText(/old library copies awaiting deletion was damaged/)).toBeTruthy();
  });
});
