import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { PendingWrite } from "../api/library";
import { server, testApi, url, useMockService } from "../test/service";
import { PendingWritesDialog } from "./PendingWritesDialog";

useMockService();

const T1 = "019a7000-0000-7000-8000-0000000000c1";
const pw = (o: Partial<PendingWrite>): PendingWrite => ({ txn: T1, projectId: "p1", project: "Dissertation", status: "uncommitted", canKeep: false, canRollBack: true, steps: 3, ...o });

function serve(lists: PendingWrite[][], resolve?: () => Response) {
  let calls = 0;
  const posted: unknown[] = [];
  server.use(
    http.get(url("/libraries/pending-writes"), () => HttpResponse.json({ pendingWrites: lists[Math.min(calls++, lists.length - 1)] })),
    http.post(url("/libraries/pending-writes/:txn/resolve"), async ({ request }) => {
      posted.push(await request.json());
      return resolve ? resolve() : HttpResponse.json({ txn: T1, choice: "roll-back", projectId: "p1" });
    }),
  );
  return { lists: () => calls, posted };
}

function show(props: Partial<Parameters<typeof PendingWritesDialog>[0]> = {}) {
  return render(<PendingWritesDialog api={testApi()} readOnly={false} onClose={() => {}} {...props} />);
}

describe("PendingWritesDialog", () => {
  it("after the service refuses a choice, reloads what it now allows and says so in plain words (41b2 I2)", async () => {
    const svc = serve([[pw({})], [pw({ status: "unverifiable", canRollBack: false })]], () =>
      HttpResponse.json({ error: { code: "CONFLICT", message: "That choice is not allowed for this change.", reason: "allowed: none" } }, { status: 409 }),
    );
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    await user.click(await within(dialog).findByRole("button", { name: "Roll it back" }));
    await user.click(within(dialog).getByRole("button", { name: "Yes, roll it back" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).not.toMatch(/allowed:/);
    expect(alert.textContent).toMatch(/no longer possible/);
    await waitFor(() => expect(svc.lists()).toBe(2));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Roll it back" })).toBeNull());
    expect(within(dialog).queryByRole("button", { name: "Keep it" })).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("a held or repeated Enter on \"Roll it back\" opens the question and rolls nothing back; Tab then Enter rolls back once (R376 c)", async () => {
    const svc = serve([[pw({})], []]);
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const open = await within(dialog).findByRole("button", { name: "Roll it back" });
    open.focus();
    await user.keyboard("{Enter>4}{/Enter}{Enter}");
    const yes = within(dialog).getByRole("button", { name: "Yes, roll it back" });
    expect(svc.posted).toHaveLength(0);
    expect(document.activeElement).not.toBe(yes);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toMatch(/Roll this change back\?/);
    await user.tab();
    expect(document.activeElement).toBe(yes);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(svc.posted).toHaveLength(1));
  });

  it("an unconfirmable change: the question has focus first, then the acknowledgement; nothing is acknowledged by the key that opened it (R376 c)", async () => {
    serve([[pw({ status: "unverifiable", canRollBack: true, canKeep: false })], []]);
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const open = await within(dialog).findByRole("button", { name: "Roll it back" });
    open.focus();
    await user.keyboard("[Space]{Enter>3}{/Enter}[Space]");
    const box = within(dialog).getByRole("checkbox", { name: /I understand/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.activeElement).not.toBe(box);
    await user.tab();
    expect(document.activeElement).toBe(box);
  });

  it("reloads the list when the library's state changes while it is open", async () => {
    const svc = serve([[pw({})], []]);
    const api = testApi();
    const onClose = () => {};
    const { rerender } = render(<PendingWritesDialog api={api} readOnly={false} onClose={onClose} changed={0} />);
    await screen.findByRole("button", { name: "Roll it back" });
    rerender(<PendingWritesDialog api={api} readOnly={false} onClose={onClose} changed={1} />);
    expect(await screen.findByText(/Nothing is waiting/)).toBeTruthy();
    expect(svc.lists()).toBe(2);
  });

  it("an item with no allowed choices offers no buttons, never says it was not finished, and points to a backup (R131, 41b2 I3)", async () => {
    serve([[pw({ status: "unverifiable", canRollBack: false, canKeep: false, steps: 4, detail: "audit tail unreadable" }), pw({ txn: "019a7000-0000-7000-8000-00000000bad1", project: "library", status: "invalid", canRollBack: false, steps: 0 })]]);
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const first = await within(dialog).findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(first.textContent).not.toMatch(/was not finished/);
    expect(first.textContent).toMatch(/cannot confirm whether this change was finished/);
    expect(first.textContent).toMatch(/will not change anything itself/);
    expect(first.textContent).toMatch(/restore the project from a backup/);
    expect(within(first).getByText("audit tail unreadable").getAttribute("dir")).toBe("auto");
    expect(within(first).queryByRole("button")).toBeNull();
    const second = within(dialog).getByRole("group", { name: "Interrupted change in library" });
    expect(second.textContent).toMatch(/restore the project from a backup/);
    expect(within(second).queryByRole("button")).toBeNull();
  });

  it("if the service does offer roll-back for an unverifiable change, warns that it may undo a finished change and needs an explicit confirmation (41b2 I3)", async () => {
    const svc = serve([[pw({ status: "unverifiable", canRollBack: true, canKeep: false })], []]);
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "Interrupted changes" });
    const item = await within(dialog).findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(item.textContent).not.toMatch(/was not finished/);
    expect(within(item).queryByRole("button", { name: "Keep it" })).toBeNull();
    await user.click(within(item).getByRole("button", { name: "Roll it back" }));
    expect(item.textContent).toMatch(/may undo a change that was finished/);
    const yes = within(item).getByRole("button", { name: "Yes, roll it back" }) as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    await user.click(yes);
    expect(svc.posted).toEqual([]);
    await user.click(within(item).getByRole("checkbox", { name: /I understand/ }));
    expect(yes.disabled).toBe(false);
    await user.click(yes);
    await waitFor(() => expect(svc.posted).toEqual([{ choice: "roll-back" }]));
  });

  it("offers only the choices the service lists: no Keep for a change that cannot be kept (41b2 M4)", async () => {
    serve([[pw({ status: "uncommitted", canRollBack: true, canKeep: false }), pw({ txn: "019a7000-0000-7000-8000-0000000000c2", project: "Second", status: "committed", canKeep: true, canRollBack: false })]]);
    show();
    const first = await screen.findByRole("group", { name: "Interrupted change in Dissertation" });
    expect(within(first).queryByRole("button", { name: "Keep it" })).toBeNull();
    expect(within(first).getByRole("button", { name: "Roll it back" })).toBeTruthy();
    const second = screen.getByRole("group", { name: "Interrupted change in Second" });
    expect(within(second).getByRole("button", { name: "Keep it" })).toBeTruthy();
    expect(within(second).queryByRole("button", { name: "Roll it back" })).toBeNull();
  });

  it("is modal: the page behind it is inert while it is open (41b2 M5)", async () => {
    serve([[]]);
    const page = document.createElement("div");
    page.id = "page";
    document.body.appendChild(page);
    const onClose = vi.fn();
    const { unmount } = show({ onClose });
    await screen.findByText(/Nothing is waiting/);
    expect(page.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    unmount();
    expect(page.hasAttribute("inert")).toBe(false);
    page.remove();
  });
});
