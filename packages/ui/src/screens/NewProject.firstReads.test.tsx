/**
 * FR-756's remainder (R601 b, R617): the new-project flow reads the library's projects before it sends the create
 * ("Reading the library's projects…"); that read has the time limit. Given up, it says "The library service did not
 * answer in time." in the dialog's alert, nothing is sent, the form is usable again ("Create project" makes the read
 * again) and Cancel works. The check after a lost answer ("Checking whether the project was created…") has the limit
 * too: given up, it is the check that "cannot tell", with "Check again". The create itself (an act) has no limit.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client";
import type { ProjectSummary } from "../api/library";
import { NewProject } from "./NewProject";

const NO_ANSWER = "The library service did not answer in time.";
const LIMIT = 300;
const NEW_OPEN = { id: "p3", name: "Tide-line interviews", folder: "Projects/Tide-line interviews", encrypted: false, unlocked: true, profiles: [] as string[] } as unknown as ProjectSummary;
const never = <T,>() => new Promise<T>(() => undefined);

async function fillOpen(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole("dialog", { name: "New project" });
  await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Tide-line interviews");
  await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
  await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
  return dialog;
}

describe("the new-project flow: the read of the projects before sending has the limit (FR-756 remainder)", () => {
  it("a read that never settles is given up: the true sentence, nothing sent, the form usable; “Create project” reads again and creates", async () => {
    let answer = false;
    const signals: Array<AbortSignal | undefined> = [];
    const list = vi.fn((o?: { signal?: AbortSignal }) => {
      signals.push(o?.signal);
      return answer ? Promise.resolve({ projects: [] as ProjectSummary[] }) : never<{ projects: ProjectSummary[] }>();
    });
    const create = vi.fn(async () => ({ project: NEW_OPEN }));
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    render(<NewProject api={{ projects: { list, create } } as never} onCreated={onCreated} onCancel={onCancel} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    const dialog = await fillOpen(user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(within(dialog).getByText("Reading the library's projects…")).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe(NO_ANSWER), { timeout: 5000 });
    expect(within(dialog).queryByText("Reading the library's projects…")).toBeNull();
    expect(signals[0]?.aborted).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    answer = true;
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(NEW_OPEN));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a read that FAILS with no answer says what it said before", async () => {
    const list = vi.fn(async () => {
      throw new ApiClientError(0, { code: "UNAVAILABLE", message: "The library service could not be reached." });
    });
    render(<NewProject api={{ projects: { list, create: vi.fn() } } as never} onCreated={vi.fn()} onCancel={vi.fn()} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    const dialog = await fillOpen(user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("The library service could not be reached."));
  });

  it("closing the dialog cancels the read still out", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const list = vi.fn((o?: { signal?: AbortSignal }) => {
      signals.push(o?.signal);
      return never<{ projects: ProjectSummary[] }>();
    });
    const { unmount } = render(<NewProject api={{ projects: { list, create: vi.fn() } } as never} onCreated={vi.fn()} onCancel={vi.fn()} />);
    const user = userEvent.setup();
    const dialog = await fillOpen(user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("the check after a lost answer that never settles is given up: the app cannot tell, with “Check again”", async () => {
    let n = 0;
    const list = vi.fn(() => (n++ === 0 ? Promise.resolve({ projects: [] as ProjectSummary[] }) : never<{ projects: ProjectSummary[] }>()));
    const create = vi.fn(async () => {
      throw new ApiClientError(0, { code: "UNAVAILABLE", message: "The library service could not be reached." });
    });
    render(<NewProject api={{ projects: { list, create } } as never} onCreated={vi.fn()} onCancel={vi.fn()} firstReadMs={LIMIT} />);
    const user = userEvent.setup();
    const dialog = await fillOpen(user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await within(dialog).findByRole("button", { name: "Check again" }, { timeout: 5000 });
    expect(within(dialog).queryByText("Checking whether the project was created…")).toBeNull();
    expect(within(dialog).getByRole("alert").textContent).toContain("The app cannot tell whether the project was created");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
