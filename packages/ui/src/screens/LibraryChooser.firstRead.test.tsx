/**
 * FR-756 I3 (R602): the chooser's own read of the list of libraries has the time limit. Given up, it says "The library
 * service did not answer in time." with "Try again"; failed for want of an answer, "The library service could not be
 * reached." with "Try again"; refused with an answer, its sentence as before.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { hang, LIBRARIES, server, serviceError, testApi, url, useMockService } from "../test/service";
import { LibraryChooser } from "./LibraryChooser";

useMockService();

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);
const show = () => render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} firstReadMs={300} />);

describe("LibraryChooser: its own read of the list has the time limit (FR-756 I3)", () => {
  it("a list that never settles is given up at the limit: the alert and “Try again” in place of “Loading libraries…”; pressing it reads again, focus not lost", async () => {
    let answer = false;
    let asked = 0;
    const gate = hang();
    server.use(
      http.get(url("/libraries"), async () => {
        asked++;
        if (!answer) await gate;
        return HttpResponse.json(LIBRARIES);
      }),
    );
    show();
    expect(screen.getByText("Loading libraries…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Loading libraries…")).toBeNull();
    expect(screen.queryByText(/No libraries yet/)).toBeNull();
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    expect(await screen.findByRole("button", { name: "Open Grant 2025" })).toBeTruthy();
    await waitFor(() => expect(tryAgain()).toBeNull());
    expect(alerts()).toEqual([]);
    expect(asked).toBe(2);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Choose a library" }));
  });

  it("a list that fails for want of an answer says “could not be reached”, with “Try again”", async () => {
    let failing = true;
    server.use(http.get(url("/libraries"), () => (failing ? HttpResponse.error() : HttpResponse.json(LIBRARIES))));
    show();
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    failing = false;
    await userEvent.setup().click(tryAgain()!);
    expect(await screen.findByRole("button", { name: "Open Grant 2025" })).toBeTruthy();
    await waitFor(() => expect(alerts()).toEqual([]));
  });

  it("a list refused with an answer shows its sentence as before, with no “Try again”", async () => {
    server.use(http.get(url("/libraries"), () => serviceError(500, "INTERNAL", "The list could not be read.")));
    show();
    await screen.findByText("The list could not be read.");
    expect(tryAgain()).toBeNull();
  });
});
